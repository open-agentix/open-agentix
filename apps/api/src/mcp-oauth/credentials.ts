import { OaxError, type ContextGuard } from '@openagentix/core';
import type { SecretRegistry } from './secret-registry.js';
import { assertTokenShape } from './token-shape.js';
import { ownerKey, type McpOauthTokenStore } from './token-store.js';

/**
 * The only way to obtain the value of an MCP OAuth access token (ADR 0016 section 7.5).
 *
 * Trust boundary: the object is built by the api or by the trusted worker, the two processes that
 * hold the key-encryption key. Run nodes, harnesses and models never get one (they have neither
 * the key nor a database connection; tests pin that no run-node code reaches this module). `role`
 * is checked at construction so that a wiring mistake fails at start-up, not on the first token.
 */
export type TrustedRole = 'api' | 'worker';
const TRUSTED_ROLES: ReadonlySet<string> = new Set<TrustedRole>(['api', 'worker']);
/** Used when the authorization server gave no expiry. */
const UNKNOWN_EXPIRY_TTL_MS = 60 * 60_000;

/** A connection by identity only; URL, version and owner come from the database. */
export interface ConnectionRef {
  id: string;
  tenantId: string;
}

/** Where a token value must be registered before the caller may use it. */
export interface SecretSinks {
  /** The guard of the run (or relay session) the token is used for. */
  guard: ContextGuard;
}

/** Process-wide guards that must know the token too (the telemetry guard of span attributes). */
export type ExtraGuards = () => readonly ContextGuard[];

export class McpCredentials {
  constructor(
    private readonly store: McpOauthTokenStore,
    private readonly registry: SecretRegistry,
    private readonly now: () => Date,
    role: TrustedRole,
    private readonly extraGuards: ExtraGuards = () => [],
  ) {
    if (!TRUSTED_ROLES.has(role))
      throw new OaxError(
        'forbidden',
        'MCP credentials are only available to the api and the trusted worker',
      );
  }

  /**
   * Returns the access token of a connection for the requested scopes. The connection's URL and
   * credential version are read from the database, never taken from the caller. The value is
   * registered with the run's {@link ContextGuard}, the telemetry guard and the process redactor
   * BEFORE it is returned, so no code path can hold an unregistered token. Refresh is not part of
   * this slice: an expired token fails closed with `mcp_auth_required`.
   */
  async accessToken(
    connection: ConnectionRef,
    scope: readonly string[],
    sinks: SecretSinks,
  ): Promise<string> {
    const info = await this.store.connection(connection.tenantId, connection.id);
    if (!info) throw new OaxError('mcp_auth_required', 'the connection needs to be authorized');
    const stored = await this.open(connection, info.credentialVersion);
    if (!stored || stored.meta.status !== 'active')
      throw new OaxError('mcp_auth_required', 'the connection needs to be authorized');
    // A changed server URL means the token was issued for another resource (RFC 8707).
    if (stored.meta.resource !== info.resource)
      throw new OaxError('mcp_resource_mismatch', 'the stored token belongs to another resource');
    const missing = scope.filter((s) => !stored.meta.scopes.includes(s));
    if (missing.length > 0)
      throw new OaxError('mcp_insufficient_scope', 'the stored token does not cover the scopes');
    const nowMs = this.now().getTime();
    const expiresAt = stored.meta.expiresAt?.getTime();
    if (expiresAt !== undefined && expiresAt <= nowMs)
      throw new OaxError('mcp_auth_required', 'the stored token has expired');
    assertTokenShape(stored.accessToken);
    const ttlMs = expiresAt === undefined ? UNKNOWN_EXPIRY_TTL_MS : expiresAt - nowMs;
    this.registry.register(stored.accessToken, {
      owner: ownerKey(connection.id, info.credentialVersion),
      ttlMs,
    });
    sinks.guard.addSecret(stored.accessToken);
    for (const g of this.extraGuards()) g.addSecret(stored.accessToken);
    return stored.accessToken;
  }

  private async open(connection: ConnectionRef, credentialVersion: number) {
    try {
      return await this.store.open(connection.tenantId, connection.id, credentialVersion);
    } catch (e) {
      // A destroyed or unavailable tenant key means the credential is gone: authorize again.
      if (e instanceof OaxError && e.code === 'key_destroyed')
        throw new OaxError('mcp_auth_required', 'the stored credential is no longer readable');
      throw e;
    }
  }
}
