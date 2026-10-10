import { OaxError, type ContextGuard } from '@openagentix/core';
import type { SecretRegistry } from './secret-registry.js';
import { assertTokenShape } from './token-shape.js';
import { ownerKey, type McpOauthTokenStore } from './token-store.js';

/**
 * The only way to obtain the value of an MCP OAuth access token (ADR 0016 section 7.5).
 *
 * Trust boundary: the object is built by the api or by the trusted worker, the two processes that
 * hold the key-encryption key. Run nodes, harnesses and models never get one: they have neither
 * the key nor a database connection, and tests follow the imports of the run-node entry point.
 * `role` documents and checks the wiring at start-up; it is not a security boundary by itself (any
 * code in the same process could pass either value).
 */
export type TrustedRole = 'api' | 'worker';
const TRUSTED_ROLES: ReadonlySet<string> = new Set<TrustedRole>(['api', 'worker']);
/** Used when the authorization server gave no expiry. */
const UNKNOWN_EXPIRY_TTL_MS = 60 * 60_000;

/** A connection by identity only; URL and credential version come from the database. */
export interface ConnectionRef {
  id: string;
  tenantId: string;
}

/** Where a token value must be registered before the caller may use it. */
export interface SecretSinks {
  /** The guard of the run (or relay session) the token is used for. */
  guard: ContextGuard;
}

/** A token together with the only destination it may be sent to. */
export interface AccessToken {
  token: string;
  /** Canonical URI of the MCP server the token was issued for (RFC 8707). */
  resource: string;
}

/** Renews the tokens of a connection (the OAuth service); the credentials re-read afterwards. */
export interface TokenRefresher {
  refresh(connection: ConnectionRef): Promise<void>;
}

/** Tokens are renewed this long before they expire (ADR 0016 section 7.5). */
export const REFRESH_SKEW_MS = 60_000;

/**
 * How long before expiry a token is renewed: a minute, but never more than half of its lifetime
 * (a 30 s token would otherwise be renewed on every use).
 */
export function refreshSkewMs(issuedAt: Date, expiresAt: Date): number {
  return Math.min(REFRESH_SKEW_MS, Math.max(0, expiresAt.getTime() - issuedAt.getTime()) / 2);
}
/** After a failed refresh the next attempt waits this long (the failure is recorded, not hammered). */
export const REFRESH_RETRY_MS = 30_000;

export class McpCredentials {
  private refresher: TokenRefresher | undefined;

  constructor(
    private readonly store: McpOauthTokenStore,
    private readonly registry: SecretRegistry,
    private readonly now: () => Date,
    role: TrustedRole,
  ) {
    if (!TRUSTED_ROLES.has(role))
      throw new OaxError(
        'forbidden',
        'MCP credentials are only available to the api and the trusted worker',
      );
  }

  /** Wires the OAuth service that renews tokens (same trusted process). */
  useRefresher(refresher: TokenRefresher): void {
    this.refresher = refresher;
  }

  /**
   * Returns the access token of a connection for the requested scopes and the resource it is bound
   * to. The caller must send the token to that resource only (compare, or build the request from
   * it): the connection's URL may change between this call and the request. The URL and credential
   * version are read from the database, never taken from the caller. The value is registered with
   * the run's {@link ContextGuard} and the tenant-scoped registry BEFORE it is returned, so no code
   * path can hold an unregistered token. A token that expires within a minute is renewed first
   * (single flight, see the OAuth service); when the renewal fails and the stored token is still
   * valid it is used, otherwise the call fails closed with `mcp_auth_required`.
   */
  async accessToken(
    connection: ConnectionRef,
    scope: readonly string[],
    sinks: SecretSinks,
  ): Promise<AccessToken> {
    let refreshed = false;
    for (;;) {
      const info = await this.store.connection(connection.tenantId, connection.id);
      if (!info) throw new OaxError('mcp_auth_required', 'the connection needs to be authorized');
      const stored = await this.open(connection, info.credentialVersion);
      const status = stored?.meta.status;
      if (!stored || (status !== 'active' && status !== 'refresh_failed'))
        throw new OaxError('mcp_auth_required', 'the connection needs to be authorized');
      // A changed server URL means the token was issued for another resource (RFC 8707).
      if (stored.meta.resource !== info.resource)
        throw new OaxError('mcp_resource_mismatch', 'the stored token belongs to another resource');
      const missing = scope.filter((s) => !stored.meta.scopes.includes(s));
      if (missing.length > 0)
        throw new OaxError('mcp_insufficient_scope', 'the stored token does not cover the scopes');
      const nowMs = this.now().getTime();
      const expiresAt = stored.meta.expiresAt?.getTime();
      const usable = status === 'active' && (expiresAt === undefined || expiresAt > nowMs);
      const stale =
        expiresAt !== undefined &&
        expiresAt - nowMs <= refreshSkewMs(stored.meta.updatedAt, new Date(expiresAt));
      const retryAfter = stored.meta.lastError
        ? stored.meta.updatedAt.getTime() + REFRESH_RETRY_MS
        : 0;
      if ((stale || !usable) && this.refresher && !refreshed && nowMs >= retryAfter) {
        refreshed = true;
        try {
          await this.refresher.refresh(connection);
          continue;
        } catch (e) {
          // Rejected credentials are final; any other failure may pass while the token still works.
          if (!usable || (e instanceof OaxError && e.code === 'mcp_auth_required')) throw e;
          // The old token still works for a moment: use it, the next call tries again.
        }
      }
      if (!usable) throw new OaxError('mcp_auth_required', 'the stored token has expired');
      assertTokenShape(stored.accessToken);
      this.registry.register(stored.accessToken, {
        owner: ownerKey(connection.id, info.credentialVersion),
        tenant: connection.tenantId,
        ttlMs: expiresAt === undefined ? UNKNOWN_EXPIRY_TTL_MS : expiresAt - nowMs,
      });
      sinks.guard.addSecret(stored.accessToken);
      return { token: stored.accessToken, resource: stored.meta.resource };
    }
  }

  private async open(connection: ConnectionRef, credentialVersion: number) {
    try {
      return await this.store.open(connection.tenantId, connection.id, credentialVersion);
    } catch (e) {
      // A destroyed tenant key means the credential is gone: authorize again.
      if (e instanceof OaxError && e.code === 'key_destroyed')
        throw new OaxError('mcp_auth_required', 'the stored credential is no longer readable');
      throw e;
    }
  }
}
