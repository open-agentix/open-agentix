import { randomUUID } from 'node:crypto';
import { OaxError } from '@openagentix/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { connections, mcpOauthClients, mcpOauthTokens } from '../db/schema.js';
import type { BindingContext } from './envelope.js';
import type { KeyService } from './key-service.js';

/** Shorter values cannot be recognised by the redactors, so they are not accepted as tokens. */
export const MIN_TOKEN_LENGTH = 16;

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
}

/** Everything about a stored token except its values (safe to show in an API response). */
export interface TokenMeta extends TokenBinding {
  scopes: string[];
  status: TokenStatus;
  expiresAt: Date | null;
  authorizedBy: string | null;
  authorizedAt: Date;
}

export interface StoredTokens {
  meta: TokenMeta;
  accessToken: string;
  refreshToken: string | null;
}

const bindingOf = (b: TokenBinding): BindingContext => ({ ...b });
const splitScopes = (s: string) => s.split(' ').filter(Boolean);

/**
 * Persistence of OAuth tokens of MCP connections (table `mcp_oauth_tokens`). Values are sealed by
 * the {@link KeyService} on the way in and opened on the way out; nothing else in the code base
 * selects the ciphertext columns. Only `McpCredentials` calls {@link open}.
 */
export class McpOauthTokenStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async put(w: TokenWrite): Promise<void> {
    for (const v of [w.accessToken, w.refreshToken])
      if (v !== undefined && v.length < MIN_TOKEN_LENGTH)
        throw new OaxError('token_invalid', 'the token is too short to be a credential');
    await this.assertConnectionOf(w.tenantId, w.connectionId);
    const binding = bindingOf(w);
    const sealed = await this.keys.sealAll(
      w.refreshToken ? [w.accessToken, w.refreshToken] : [w.accessToken],
      binding,
    );
    const at = this.now();
    const values = {
      issuer: w.issuer,
      clientRef: w.clientRef,
      resource: w.resource,
      scopes: w.scopes.join(' '),
      // Both values are sealed in one call under the same key, so one version describes both.
      keyVersion: sealed.keyVersion,
      accessTokenEnc: sealed.ciphertexts[0] as string,
      refreshTokenEnc: sealed.ciphertexts[1] ?? null,
      expiresAt: w.expiresAt ?? null,
      status: 'active',
      authorizedBy: w.authorizedBy ?? null,
      authorizedAt: at,
      updatedAt: at,
    };
    await this.db
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
      });
  }

  /** Metadata only; never touches the ciphertext columns. */
  async meta(
    tenantId: string,
    connectionId: string,
    credentialVersion: number,
  ): Promise<TokenMeta | null> {
    const row = await this.row(tenantId, connectionId, credentialVersion);
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
  ): Promise<StoredTokens | null> {
    const row = await this.row(tenantId, connectionId, credentialVersion);
    if (!row) return null;
    const meta = metaOf(row);
    const binding = bindingOf(meta);
    return {
      meta,
      accessToken: await this.keys.open(row.keyVersion, row.accessTokenEnc, binding),
      refreshToken: row.refreshTokenEnc
        ? await this.keys.open(row.keyVersion, row.refreshTokenEnc, binding)
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
  }

  /** Deletes the tokens of a connection (disconnect, revocation, URL or issuer change). */
  async delete(tenantId: string, connectionId: string): Promise<number> {
    const rows = await this.db
      .delete(mcpOauthTokens)
      .where(
        and(eq(mcpOauthTokens.tenantId, tenantId), eq(mcpOauthTokens.connectionId, connectionId)),
      )
      .returning({ id: mcpOauthTokens.id });
    return rows.length;
  }

  private where(tenantId: string, connectionId: string, credentialVersion: number) {
    return and(
      eq(mcpOauthTokens.tenantId, tenantId),
      eq(mcpOauthTokens.connectionId, connectionId),
      eq(mcpOauthTokens.credentialVersion, credentialVersion),
    );
  }

  private async row(tenantId: string, connectionId: string, credentialVersion: number) {
    const [row] = await this.db
      .select()
      .from(mcpOauthTokens)
      .where(this.where(tenantId, connectionId, credentialVersion));
    return row ?? null;
  }

  private async assertConnectionOf(tenantId: string, connectionId: string): Promise<void> {
    const [c] = await this.db
      .select({ t: connections.tenantId })
      .from(connections)
      .where(eq(connections.id, connectionId));
    if (!c || c.t !== tenantId)
      throw new OaxError('not_found', 'connection not found for this tenant');
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
    status: r.status as TokenStatus,
    expiresAt: r.expiresAt,
    authorizedBy: r.authorizedBy,
    authorizedAt: r.authorizedAt,
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

  async put(w: {
    tenantId: string;
    issuer: string;
    clientId: string;
    clientSecret?: string | undefined;
    createdBy?: string | undefined;
  }): Promise<string> {
    const id = randomUUID();
    const sealed = w.clientSecret
      ? await this.keys.seal(w.clientSecret, this.binding(w.tenantId, id, w.issuer))
      : null;
    await this.db.insert(mcpOauthClients).values({
      id,
      tenantId: w.tenantId,
      issuer: w.issuer,
      clientId: w.clientId,
      keyVersion: sealed?.keyVersion ?? null,
      clientSecretEnc: sealed?.ciphertext ?? null,
      createdBy: w.createdBy ?? null,
    });
    return id;
  }

  async clientSecret(tenantId: string, issuer: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(mcpOauthClients)
      .where(and(eq(mcpOauthClients.tenantId, tenantId), eq(mcpOauthClients.issuer, issuer)));
    if (!row?.clientSecretEnc || row.keyVersion === null) return null;
    return this.keys.open(
      row.keyVersion,
      row.clientSecretEnc,
      this.binding(tenantId, row.id, issuer),
    );
  }
}
