import { randomUUID } from 'node:crypto';
import { OaxError } from '@openagentix/core';
import { and, count, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { mcpOauthPending } from '../db/schema.js';
import type { BindingContext } from './envelope.js';
import type { KeyService } from './key-service.js';
import { stateHash } from './pkce.js';

/** A pending authorization request lives this long (ADR 0016 section 7.2). */
export const PENDING_TTL_MS = 10 * 60_000;
/** Pending requests per tenant: a stuck client cannot fill the table. */
const MAX_PENDING_PER_TENANT = 200;

export interface PendingWrite {
  state: string;
  verifier: string;
  tenantId: string;
  connectionId: string;
  credentialVersion: number;
  userId: string;
  issuer: string;
  resource: string;
  redirectUri: string;
  clientRef: string;
  registration: 'preregistered' | 'cimd' | 'dcr';
  scopes: readonly string[];
  endpoints: Record<string, string>;
  signingAlgs?: readonly string[] | undefined;
  issAdvertised: boolean;
}

export interface PendingRequest extends Omit<PendingWrite, 'state' | 'verifier' | 'scopes'> {
  id: string;
  scopes: string[];
  verifier: string;
  createdAt: Date;
  expiresAt: Date;
}

const bindingOf = (p: {
  tenantId: string;
  connectionId: string;
  credentialVersion: number;
  issuer: string;
  resource: string;
}): BindingContext => ({
  // Domain separation from stored tokens: the same ciphertext cannot be moved between the tables.
  tenantId: p.tenantId,
  connectionId: `pending:${p.connectionId}`,
  issuer: p.issuer,
  resource: p.resource,
  credentialVersion: p.credentialVersion,
});

/**
 * Persistence of pending authorization requests (table `mcp_oauth_pending`). The state is stored as
 * its SHA-256 only; the PKCE verifier is sealed under the tenant data key with the request's
 * binding, so a row copied to another tenant, connection or issuer does not open. {@link consume}
 * deletes the row in the same statement that returns it: a state works exactly once, whatever the
 * outcome of the callback.
 */
export class McpOauthPendingStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Stores a request. An older request of the same user for the same connection is replaced (one
   * open consent per user and connection), expired rows of the tenant are removed first.
   */
  async create(w: PendingWrite): Promise<Date> {
    const at = this.now();
    const expiresAt = new Date(at.getTime() + PENDING_TTL_MS);
    await this.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await tx.delete(mcpOauthPending).where(lt(mcpOauthPending.expiresAt, at));
      await tx
        .delete(mcpOauthPending)
        .where(
          and(
            eq(mcpOauthPending.connectionId, w.connectionId),
            eq(mcpOauthPending.userId, w.userId),
          ),
        );
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(mcpOauthPending)
        .where(eq(mcpOauthPending.tenantId, w.tenantId));
      if (n >= MAX_PENDING_PER_TENANT)
        throw new OaxError(
          'rate_limited',
          'too many open authorizations, try again in a few minutes',
        );
      const sealed = await this.keys.seal(w.verifier, bindingOf(w), tx);
      await tx.insert(mcpOauthPending).values({
        id: randomUUID(),
        stateHash: stateHash(w.state),
        tenantId: w.tenantId,
        connectionId: w.connectionId,
        credentialVersion: w.credentialVersion,
        userId: w.userId,
        issuer: w.issuer,
        resource: w.resource,
        redirectUri: w.redirectUri,
        clientRef: w.clientRef,
        registration: w.registration,
        scopes: w.scopes.join(' '),
        keyVersion: sealed.keyVersion,
        verifierEnc: sealed.ciphertext,
        endpoints: w.endpoints,
        signingAlgs: w.signingAlgs?.join(' ') ?? null,
        issAdvertised: w.issAdvertised,
        createdAt: at,
        expiresAt,
      });
    });
    return expiresAt;
  }

  /**
   * Takes the request of `state` (deleting it). `null` for an unknown state; `expired` rows are
   * deleted too and reported as such. The verifier is opened only for a live request.
   */
  async consume(
    state: string,
  ): Promise<
    { request: PendingRequest } | { expired: { tenantId: string; connectionId: string } } | null
  > {
    const [row] = await this.db
      .delete(mcpOauthPending)
      .where(eq(mcpOauthPending.stateHash, stateHash(state)))
      .returning();
    if (!row) return null;
    if (row.expiresAt.getTime() <= this.now().getTime())
      return { expired: { tenantId: row.tenantId, connectionId: row.connectionId } };
    const verifier = await this.keys.open(row.keyVersion, row.verifierEnc, bindingOf(row), this.db);
    return {
      request: {
        id: row.id,
        tenantId: row.tenantId,
        connectionId: row.connectionId,
        credentialVersion: row.credentialVersion,
        userId: row.userId,
        issuer: row.issuer,
        resource: row.resource,
        redirectUri: row.redirectUri,
        clientRef: row.clientRef,
        registration: row.registration as PendingRequest['registration'],
        scopes: row.scopes.split(' ').filter(Boolean),
        verifier,
        endpoints: row.endpoints,
        signingAlgs: row.signingAlgs ? row.signingAlgs.split(' ') : undefined,
        issAdvertised: row.issAdvertised,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      },
    };
  }

  /** Whether the user has a request that has not expired for the connection (status display). */
  async openFor(
    tenantId: string,
    connectionId: string,
    userId?: string,
  ): Promise<{ expiresAt: Date } | null> {
    const rows = await this.db
      .select({ expiresAt: mcpOauthPending.expiresAt, userId: mcpOauthPending.userId })
      .from(mcpOauthPending)
      .where(
        and(eq(mcpOauthPending.tenantId, tenantId), eq(mcpOauthPending.connectionId, connectionId)),
      );
    const now = this.now().getTime();
    const live = rows.filter(
      (r) => r.expiresAt.getTime() > now && (!userId || r.userId === userId),
    );
    live.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
    return live[0] ? { expiresAt: live[0].expiresAt } : null;
  }

  /** Removes every request of a connection (disconnect, configuration change). */
  async deleteFor(tenantId: string, connectionId: string): Promise<void> {
    await this.db
      .delete(mcpOauthPending)
      .where(
        and(eq(mcpOauthPending.tenantId, tenantId), eq(mcpOauthPending.connectionId, connectionId)),
      );
  }
}
