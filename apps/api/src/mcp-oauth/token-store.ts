import { randomUUID } from 'node:crypto';
import { OaxError } from '@openagentix/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { connections, mcpOauthClients, mcpOauthTokens } from '../db/schema.js';
import type { BindingContext } from './envelope.js';
import type { KeyService } from './key-service.js';
import { assertHttpsUrl, canonicalResource } from './resource.js';
import type { SecretRegistry } from './secret-registry.js';
import { assertTokenShape } from './token-shape.js';

export type TokenStatus = 'active' | 'refresh_failed' | 'reauthorization_required' | 'revoked';

export interface TokenBinding {
  tenantId: string;
  connectionId: string;
  credentialVersion: number;
  issuer: string;
  /** Canonical URI of the MCP server (RFC 8707). */
  resource: string;
}

export interface TokenWrite extends TokenBinding {
  clientRef: string;
  scopes: readonly string[];
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: Date | undefined;
  authorizedBy?: string | undefined;
  /** Defaults to `client_credentials`. */
  grantType?: 'client_credentials' | 'authorization_code' | undefined;
  /** Authorization server endpoints pinned with the tokens (URLs only). */
  endpoints?: Record<string, string> | undefined;
}

/** Everything about a stored token except its values (safe to show in an API response). */
export interface TokenMeta extends TokenBinding {
  scopes: string[];
  clientRef: string;
  status: TokenStatus;
  expiresAt: Date | null;
  authorizedBy: string | null;
  authorizedAt: Date;
  updatedAt: Date;
  grantType: string;
  endpoints: Record<string, string>;
  lastError: string | null;
  /** Scopes the server asked for (step-up); empty when none. */
  requiredScopes: string[];
}

export interface StoredTokens {
  meta: TokenMeta;
  accessToken: string;
  refreshToken: string | null;
}

/** The part of a connection the credentials service reads from the database, never from a caller. */
export interface McpConnectionInfo {
  credentialVersion: number;
  /** Canonical URI derived from the stored URL. */
  resource: string;
}

/** Lock namespace of the per-credential advisory lock (renewal, disconnect, configuration change). */
export const CREDENTIAL_LOCK_NS = 0x6f617831;

/**
 * Takes the transaction-scoped advisory lock of one credential (connection and credential version).
 * A renewal holds it across the network call; anything that deletes the tokens takes the same lock,
 * so a renewal can neither overlap a deletion nor bring the token back afterwards.
 */
export async function lockCredential(
  tx: Db,
  connectionId: string,
  credentialVersion: number,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${CREDENTIAL_LOCK_NS}::int, hashtext(${`${connectionId}:${credentialVersion}`}))`,
  );
}

export const ownerKey = (connectionId: string, credentialVersion: number) =>
  `${connectionId}:${credentialVersion}`;

const bindingOf = (b: TokenBinding): BindingContext => ({ ...b });
const splitScopes = (s: string) => s.split(' ').filter(Boolean);

/**
 * Persistence of OAuth tokens of MCP connections (table `mcp_oauth_tokens`). Values are sealed by
 * the {@link KeyService} on the way in and opened on the way out; nothing else in the code base
 * selects the ciphertext columns. Only `McpCredentials` calls {@link open}. Leaving the `active`
 * state (and deleting) forgets the value in the redactor registry.
 */
export class McpOauthTokenStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyService,
    private readonly registry: SecretRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The connection as stored: owner check included. Null for anything but an HTTP MCP connection. */
  async connection(
    tenantId: string,
    connectionId: string,
    db: Db = this.db,
    lock = false,
  ): Promise<McpConnectionInfo | null> {
    const query = db
      .select({
        config: connections.config,
        kind: connections.kind,
        v: connections.credentialVersion,
      })
      .from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.tenantId, tenantId)));
    const [c] = await (lock ? query.for('update') : query);
    const url = (c?.config as { url?: unknown } | undefined)?.url;
    if (!c || c.kind !== 'mcp' || typeof url !== 'string') return null;
    try {
      return { credentialVersion: c.v, resource: canonicalResource(url) };
    } catch {
      return null;
    }
  }

  async put(w: TokenWrite): Promise<void> {
    await this.db.transaction(async (tx) => this.write(tx as unknown as Db, w));
  }

  /**
   * Seals and writes the tokens inside the caller's transaction (the refresh holds an advisory
   * lock across the network call and writes the rotated pair before it commits). The connection
   * row is locked for the check and the write: a URL change (which bumps the credential version
   * and deletes the tokens in one transaction) either happens before and fails this write, or
   * after and deletes the row written here. No orphan survives a bump.
   */
  async write(tx: Db, w: TokenWrite, replace?: { updatedAt: Date }): Promise<void> {
    assertTokenShape(w.accessToken, [w.tenantId, w.connectionId]);
    if (w.refreshToken !== undefined)
      assertTokenShape(w.refreshToken, [w.tenantId, w.connectionId]);
    assertHttpsUrl(w.issuer, 'the issuer');
    assertHttpsUrl(w.resource, 'the resource');
    const conn = await this.connection(w.tenantId, w.connectionId, tx, true);
    if (!conn) throw new OaxError('not_found', 'connection not found for this tenant');
    if (w.resource !== conn.resource)
      throw new OaxError(
        'mcp_resource_mismatch',
        'the resource is not the canonical URI of the connection',
      );
    if (w.credentialVersion !== conn.credentialVersion)
      throw new OaxError('conflict', 'the credential version of the connection has changed');
    // Both values are sealed in one call under the same key, so one version describes both.
    const sealed = await this.keys.sealAll(
      w.refreshToken ? [w.accessToken, w.refreshToken] : [w.accessToken],
      bindingOf(w),
      tx,
    );
    const at = this.now();
    const values = {
      issuer: w.issuer,
      clientRef: w.clientRef,
      resource: w.resource,
      scopes: w.scopes.join(' '),
      keyVersion: sealed.keyVersion,
      accessTokenEnc: sealed.ciphertexts[0] as string,
      refreshTokenEnc: sealed.ciphertexts[1] ?? null,
      expiresAt: w.expiresAt ?? null,
      status: 'active',
      grantType: w.grantType ?? 'client_credentials',
      endpoints: w.endpoints ?? {},
      lastError: null,
      requiredScopes: '',
      authorizedBy: w.authorizedBy ?? null,
      authorizedAt: at,
      updatedAt: at,
    };
    if (replace) {
      // A renewal only ever replaces the row it read under the lock; it never inserts. A row that
      // was deleted (disconnect, configuration change) or rewritten meanwhile stays as it is.
      const updated = await tx
        .update(mcpOauthTokens)
        .set(values)
        .where(
          and(
            this.where(w.tenantId, w.connectionId, w.credentialVersion),
            eq(mcpOauthTokens.updatedAt, replace.updatedAt),
          ),
        )
        .returning({ id: mcpOauthTokens.id });
      if (updated.length === 0)
        throw new OaxError('mcp_auth_required', 'the stored tokens changed during the renewal');
      return;
    }
    const written = await tx
      .insert(mcpOauthTokens)
      .values({
        id: randomUUID(),
        tenantId: w.tenantId,
        connectionId: w.connectionId,
        credentialVersion: w.credentialVersion,
        ...values,
      })
      .onConflictDoUpdate({
        target: [mcpOauthTokens.connectionId, mcpOauthTokens.credentialVersion],
        set: values,
        setWhere: eq(mcpOauthTokens.tenantId, w.tenantId),
      })
      .returning({ id: mcpOauthTokens.id });
    if (written.length === 0)
      throw new OaxError('conflict', 'the stored tokens belong to another tenant');
  }

  /** Metadata only; never touches the ciphertext columns. */
  async meta(
    tenantId: string,
    connectionId: string,
    credentialVersion: number,
    db: Db = this.db,
  ): Promise<TokenMeta | null> {
    const row = await this.row(tenantId, connectionId, credentialVersion, db);
    return row ? metaOf(row) : null;
  }

  /**
   * Decrypts the stored values. Internal to the credentials service: the result must be
   * registered with the redactors before it is used (see `McpCredentials`).
   */
  async open(
    tenantId: string,
    connectionId: string,
    credentialVersion: number,
    db: Db = this.db,
  ): Promise<StoredTokens | null> {
    const row = await this.row(tenantId, connectionId, credentialVersion, db);
    if (!row) return null;
    const meta = metaOf(row);
    const binding = bindingOf(meta);
    return {
      meta,
      accessToken: await this.keys.open(row.keyVersion, row.accessTokenEnc, binding, db),
      refreshToken: row.refreshTokenEnc
        ? await this.keys.open(row.keyVersion, row.refreshTokenEnc, binding, db)
        : null,
    };
  }

  async setStatus(
    tenantId: string,
    connectionId: string,
    credentialVersion: number,
    status: TokenStatus,
  ): Promise<void> {
    await this.db
      .update(mcpOauthTokens)
      .set({ status, updatedAt: this.now() })
      .where(this.where(tenantId, connectionId, credentialVersion));
    if (status !== 'active') this.registry.forgetOwner(ownerKey(connectionId, credentialVersion));
  }

  /**
   * Records a failed refresh by its closed code. `status` stays `active` while the stored access
   * token can still be used; a token that is expired (or credentials rejected for good) changes it.
   */
  async recordFailure(
    tenantId: string,
    connectionId: string,
    credentialVersion: number,
    status: TokenStatus,
    lastError: string,
  ): Promise<void> {
    await this.db
      .update(mcpOauthTokens)
      .set({ status, lastError, updatedAt: this.now() })
      .where(this.where(tenantId, connectionId, credentialVersion));
    if (status !== 'active') this.registry.forgetOwner(ownerKey(connectionId, credentialVersion));
  }

  /**
   * The server answered `insufficient_scope` to `token` of an authorization-code connection: the
   * connection needs a new consent for the union of scopes and fails closed until it is given
   * (status `reauthorization_required`). Only if `token` is still the stored one.
   */
  async requireStepUp(
    tenantId: string,
    connectionId: string,
    credentialVersion: number,
    token: string,
    needed: readonly string[],
  ): Promise<boolean> {
    const stored = await this.open(tenantId, connectionId, credentialVersion).catch(() => null);
    if (!stored || stored.accessToken !== token || stored.meta.grantType !== 'authorization_code')
      return false;
    const union = [...new Set([...stored.meta.requiredScopes, ...needed])].sort();
    await this.db
      .update(mcpOauthTokens)
      .set({
        status: 'reauthorization_required',
        lastError: 'insufficient_scope',
        requiredScopes: union.join(' '),
        updatedAt: this.now(),
      })
      .where(
        and(
          this.where(tenantId, connectionId, credentialVersion),
          eq(mcpOauthTokens.updatedAt, stored.meta.updatedAt),
        ),
      );
    // The token is still valid at the server until the new consent replaces and revokes it, so it
    // stays known to the redactors.
    return true;
  }

  /**
   * The server rejected `token`: treat it as expired so that the next use renews it. Only if it is
   * still the stored token: another replica may have renewed it meanwhile.
   */
  async expireIfCurrent(
    tenantId: string,
    connectionId: string,
    credentialVersion: number,
    token: string,
  ): Promise<void> {
    const stored = await this.open(tenantId, connectionId, credentialVersion).catch(() => null);
    if (!stored || stored.accessToken !== token) return;
    await this.db
      .update(mcpOauthTokens)
      .set({ expiresAt: this.now() })
      .where(
        and(
          this.where(tenantId, connectionId, credentialVersion),
          eq(mcpOauthTokens.updatedAt, stored.meta.updatedAt),
        ),
      );
    // Not forgotten in the registry: the rejected value must stay scrubbed until its time is up.
  }

  /** Credential versions that have a stored row for the connection. */
  async versions(tenantId: string, connectionId: string): Promise<number[]> {
    const rows = await this.db
      .select({ v: mcpOauthTokens.credentialVersion })
      .from(mcpOauthTokens)
      .where(
        and(eq(mcpOauthTokens.tenantId, tenantId), eq(mcpOauthTokens.connectionId, connectionId)),
      );
    return rows.map((r) => r.v);
  }

  /**
   * Deletes the tokens of a connection (disconnect, revocation, URL or issuer change) under the
   * credential locks, so a renewal in flight finishes first and cannot write afterwards.
   */
  async delete(tenantId: string, connectionId: string): Promise<number> {
    const versions = (await this.versions(tenantId, connectionId)).sort((a, b) => a - b);
    const rows = await this.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      for (const v of versions) await lockCredential(tx, connectionId, v);
      return tx
        .delete(mcpOauthTokens)
        .where(
          and(eq(mcpOauthTokens.tenantId, tenantId), eq(mcpOauthTokens.connectionId, connectionId)),
        )
        .returning({ v: mcpOauthTokens.credentialVersion });
    });
    for (const r of rows) this.registry.forgetOwner(ownerKey(connectionId, r.v));
    return rows.length;
  }

  private where(tenantId: string, connectionId: string, credentialVersion: number) {
    return and(
      eq(mcpOauthTokens.tenantId, tenantId),
      eq(mcpOauthTokens.connectionId, connectionId),
      eq(mcpOauthTokens.credentialVersion, credentialVersion),
    );
  }

  private async row(
    tenantId: string,
    connectionId: string,
    credentialVersion: number,
    db: Db = this.db,
  ) {
    const [row] = await db
      .select()
      .from(mcpOauthTokens)
      .where(this.where(tenantId, connectionId, credentialVersion));
    return row ?? null;
  }
}

function metaOf(r: typeof mcpOauthTokens.$inferSelect): TokenMeta {
  return {
    tenantId: r.tenantId,
    connectionId: r.connectionId,
    credentialVersion: r.credentialVersion,
    issuer: r.issuer,
    resource: r.resource,
    scopes: splitScopes(r.scopes),
    clientRef: r.clientRef,
    status: r.status as TokenStatus,
    expiresAt: r.expiresAt,
    authorizedBy: r.authorizedBy,
    authorizedAt: r.authorizedAt,
    updatedAt: r.updatedAt,
    grantType: r.grantType,
    endpoints: (r.endpoints ?? {}) as Record<string, string>,
    lastError: r.lastError,
    requiredScopes: splitScopes(r.requiredScopes),
  };
}

/** Client secrets of dynamically registered clients, sealed like tokens (one per tenant and issuer). */
export class McpOauthClientStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyService,
  ) {}

  private binding(tenantId: string, id: string, issuer: string): BindingContext {
    return { tenantId, connectionId: `client:${id}`, issuer, resource: '', credentialVersion: 1 };
  }

  /**
   * Stores a dynamically registered client. One client per tenant and issuer (unique index): the
   * caller that loses a registration race gets `null` and reads the winner's row.
   */
  async put(w: {
    tenantId: string;
    issuer: string;
    clientId: string;
    clientSecret?: string | undefined;
    redirectUri?: string | undefined;
    registration?: 'dcr' | 'cimd' | undefined;
    createdBy?: string | undefined;
  }): Promise<string | null> {
    assertHttpsUrl(w.issuer, 'the issuer');
    if (w.clientSecret !== undefined) assertTokenShape(w.clientSecret, [w.tenantId]);
    const id = randomUUID();
    const sealed = w.clientSecret
      ? await this.keys.seal(w.clientSecret, this.binding(w.tenantId, id, w.issuer))
      : null;
    const inserted = await this.db
      .insert(mcpOauthClients)
      .values({
        id,
        tenantId: w.tenantId,
        issuer: w.issuer,
        registration: w.registration ?? 'dcr',
        clientId: w.clientId,
        keyVersion: sealed?.keyVersion ?? null,
        clientSecretEnc: sealed?.ciphertext ?? null,
        redirectUri: w.redirectUri ?? null,
        createdBy: w.createdBy ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: mcpOauthClients.id });
    return inserted[0]?.id ?? null;
  }

  /** The client registered for the tenant at the issuer, with its secret opened; null when none. */
  async get(
    tenantId: string,
    issuer: string,
  ): Promise<{
    id: string;
    clientId: string;
    clientSecret: string | null;
    redirectUri: string | null;
  } | null> {
    const [row] = await this.db
      .select()
      .from(mcpOauthClients)
      .where(and(eq(mcpOauthClients.tenantId, tenantId), eq(mcpOauthClients.issuer, issuer)));
    if (!row) return null;
    const clientSecret =
      row.clientSecretEnc && row.keyVersion !== null
        ? await this.keys.open(
            row.keyVersion,
            row.clientSecretEnc,
            this.binding(tenantId, row.id, issuer),
          )
        : null;
    return { id: row.id, clientId: row.clientId, clientSecret, redirectUri: row.redirectUri };
  }

  /** Drops the registration (the redirect URI changed, or the authorization server forgot it). */
  async delete(tenantId: string, id: string): Promise<void> {
    await this.db
      .delete(mcpOauthClients)
      .where(and(eq(mcpOauthClients.tenantId, tenantId), eq(mcpOauthClients.id, id)));
  }

  async clientSecret(tenantId: string, issuer: string): Promise<string | null> {
    return (await this.get(tenantId, issuer))?.clientSecret ?? null;
  }
}
