import { OaxError } from './errors.js';
import type { SecretResolver } from './secrets.js';

/**
 * Credential broker building blocks (ADR 0008, section 2). The control node hands out the secret
 * values of exactly the references a step declares, once per step and session. Values live only in
 * memory of the receiving run node; they never enter steps, logs or audit payloads.
 */

/** What a credential is issued for. Sources can use it to scope dynamic credentials. */
export interface CredentialScope {
  runId: string;
  tenantId: string;
  agentId: string;
  /** Run node (token worker id) that receives the value. */
  nodeId: string;
}

export interface IssuedCredential {
  value: string;
  /** Hard end of validity of the value itself (dynamic sources); static values have none. */
  expiresAt?: Date;
  /** Opaque handle for {@link CredentialSource.revoke} (dynamic sources). */
  handle?: string;
}

export interface CredentialSource {
  /** Source name written to the audit entry `credential.issued`. */
  readonly name: string;
  issue(ref: string, scope: CredentialScope): Promise<IssuedCredential>;
  /**
   * Recalls a dynamic credential. Static secrets have nothing to recall: for them revocation means
   * that the session is revoked, the node destroyed and the token useless (the value itself stays
   * valid, see ADR 0008).
   */
  revoke?(handle: string): Promise<void>;
}

/** The `static` source: the existing env/file secret resolver. */
export class StaticCredentialSource implements CredentialSource {
  readonly name = 'static';

  constructor(private readonly resolver: SecretResolver) {}

  async issue(ref: string): Promise<IssuedCredential> {
    return { value: await this.resolver.resolve(ref) };
  }
}

/**
 * Matches a secret reference against a tenant allowlist pattern. `*` matches any run of
 * characters; there is no other syntax (no regular expressions), so patterns cannot backtrack.
 */
export function matchSecretGlob(pattern: string, ref: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === ref;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (!ref.startsWith(first) || !ref.endsWith(last)) return false;
  if (ref.length < first.length + last.length) return false;
  let pos = first.length;
  const end = ref.length - last.length;
  for (const mid of parts.slice(1, -1)) {
    if (mid === '') continue;
    const at = ref.indexOf(mid, pos);
    if (at < 0 || at + mid.length > end) return false;
    pos = at + mid.length;
  }
  return true;
}

/** `true` when at least one pattern allows the reference. An empty list allows nothing. */
export function secretRefAllowed(patterns: readonly string[], ref: string): boolean {
  return patterns.some((p) => matchSecretGlob(p, ref));
}

const PATTERN = /^[a-zA-Z0-9*][a-zA-Z0-9_.*-]{0,127}$/;

/** Validates the patterns of `tenants.secret_refs` (references plus `*`; at most 64 entries). */
export function parseSecretRefPatterns(input: readonly string[]): string[] {
  if (input.length > 64)
    throw new OaxError('config_invalid', 'a tenant can allow at most 64 secret patterns');
  for (const p of input)
    if (!PATTERN.test(p))
      throw new OaxError('config_invalid', `invalid secret reference pattern "${p}"`);
  return [...new Set(input)].sort();
}

/** One MCP connection as delivered to a run node: resolved env/headers for exactly this step. */
export interface StepConnectionCredentials {
  server: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Response of the broker endpoint (`Cache-Control: no-store`, never logged). */
export interface StepCredentials {
  agentId: string;
  expiresAt: string;
  credentials: { secret: string; env: string; value: string }[];
  connections: StepConnectionCredentials[];
}
