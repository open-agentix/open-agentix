import { OaxError, type ContextGuard } from '@openagentix/core';
import type { SecretRegistry } from './secret-registry.js';
import type { McpOauthTokenStore } from './token-store.js';

/**
 * The only way to obtain the value of an MCP OAuth access token (ADR 0016 section 7.5).
 *
 * Trust boundary: the object is built by the api or by the trusted worker, the two processes that
 * hold the key-encryption key. Run nodes, harnesses and models never get one (they have neither
 * the key nor a database connection; a test pins that no run-node package imports this module).
 * `role` is checked at construction so that a wiring mistake fails at start-up, not on the first
 * token.
 */
export type TrustedRole = 'api' | 'worker';
const TRUSTED_ROLES: ReadonlySet<string> = new Set<TrustedRole>(['api', 'worker']);

export interface ConnectionRef {
  id: string;
  tenantId: string;
  credentialVersion: number;
  /** Canonical URI of the MCP server; a token is only used for this exact resource. */
  resource: string;
}

/** Where a token value must be registered before the caller may use it. */
export interface SecretSinks {
  /** The guard of the run (or relay session) the token is used for. */
  guard: ContextGuard;
}

export class McpCredentials {
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

  /**
   * Returns the access token of a connection for the requested scopes. The value is registered
   * with the run's {@link ContextGuard} and the process log/audit redactor BEFORE it is returned,
   * so no code path can hold an unregistered token. Refresh is not part of this slice: an
   * expired token fails closed with `mcp_auth_required`.
   */
  async accessToken(
    connection: ConnectionRef,
    scope: readonly string[],
    sinks: SecretSinks,
  ): Promise<string> {
    const stored = await this.store.open(
      connection.tenantId,
      connection.id,
      connection.credentialVersion,
    );
    if (!stored || stored.meta.status !== 'active')
      throw new OaxError('mcp_auth_required', 'the connection needs to be authorized');
    // A changed server URL means the token was issued for another resource (RFC 8707).
    if (stored.meta.resource !== connection.resource)
      throw new OaxError('mcp_resource_mismatch', 'the stored token belongs to another resource');
    const missing = scope.filter((s) => !stored.meta.scopes.includes(s));
    if (missing.length > 0)
      throw new OaxError('mcp_insufficient_scope', 'the stored token does not cover the scopes');
    if (stored.meta.expiresAt && stored.meta.expiresAt.getTime() <= this.now().getTime())
      throw new OaxError('mcp_auth_required', 'the stored token has expired');
    this.registry.register(stored.accessToken);
    sinks.guard.addSecret(stored.accessToken);
    return stored.accessToken;
  }
}
