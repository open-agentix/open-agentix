import type { McpServerConfig } from './config.js';

type HttpConfig = Extract<McpServerConfig, { transport: 'streamable-http' }>;

/**
 * Where an HTTP connection with `auth.kind: oauth` gets its access token (ADR 0016 section 7.5).
 *
 * The implementation lives in the trusted processes (control node, trusted worker); this package
 * only sees the interface, so it can neither read the token store nor decrypt anything. The token
 * is asked for before EVERY request (refresh happens behind this call), is registered with the
 * guards of the run by the implementation before it is returned, and comes with the resource it
 * was issued for: the transport sends it only to a request whose connection url has that canonical
 * URI (RFC 8707).
 */
export interface McpTokenSource {
  accessToken(): Promise<{ token: string; resource: string }>;
  /** The server answered 401 to the token it was just given: the next call must not reuse it. */
  rejected?(token: string): void;
  /**
   * The server answered 403 `insufficient_scope` to the token it was just given. `needed` is the
   * `scope` of its challenge (possibly empty). An authorization-code connection then needs a new
   * consent for the union of scopes (step-up) and fails closed until an administrator gives it.
   */
  insufficientScope?(token: string, needed: readonly string[]): void;
}

/**
 * Scopes a connection asks for (ADR 0016 section 7.7). An explicit list wins. `from-profiles`
 * (the default) is the union of the scopes declared on the tools the connection's profiles contain,
 * so a connection whose profiles hold only read tools asks only for what those tools need. The
 * result is empty when nothing is declared: the caller then falls back to the scope of the
 * server's challenge and to the `scopes_supported` of its protected resource metadata.
 */
export function requestedScopes(cfg: Pick<HttpConfig, 'auth' | 'tools' | 'profiles'>): string[] {
  const auth = cfg.auth;
  if (auth?.kind !== 'oauth') return [];
  if (Array.isArray(auth.scopes)) return [...new Set(auth.scopes)].sort();
  const out = new Set<string>();
  for (const members of Object.values(cfg.profiles))
    for (const tool of members) for (const s of cfg.tools[tool]?.scopes ?? []) out.add(s);
  return [...out].sort();
}

/**
 * Every scope any declared tool of the connection could need; the console compares it with the
 * granted scopes to warn when the grant is wider than the profiles (`mcp_scope_wider`).
 */
export function scopesNeededByProfiles(cfg: Pick<HttpConfig, 'tools' | 'profiles'>): string[] {
  const out = new Set<string>();
  for (const members of Object.values(cfg.profiles))
    for (const tool of members) for (const s of cfg.tools[tool]?.scopes ?? []) out.add(s);
  return [...out].sort();
}
