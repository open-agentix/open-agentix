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
 * The canonical form of a secret reference: exactly what the default resolver maps it to
 * (`OAX_SECRET_<NAME>`, see `envNameForSecret`): lower case, every character outside `[a-z0-9]`
 * becomes `_`. `acme.corp.db-password` and `acme-corp.db-password` are the SAME secret for the
 * resolver, so every comparison (tenant allowlists, tenant prefixes, deny lists) must use this form.
 */
export function canonicalSecretRef(ref: string): string {
  return ref.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/**
 * Matches a secret reference against a tenant allowlist pattern, both in canonical form. `*` matches
 * any run of characters; there is no other syntax (no regular expressions), so patterns cannot
 * backtrack. Because `.`, `-` and `_` canonicalise to the same character, a pattern can never tell
 * them apart, which is what makes the comparison sound.
 */
export function matchSecretGlob(pattern: string, ref: string): boolean {
  const pat = canonicalSecretRefPattern(pattern);
  const name = canonicalSecretRef(ref);
  const parts = pat.split('*');
  if (parts.length === 1) return pat === name;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (!name.startsWith(first) || !name.endsWith(last)) return false;
  if (name.length < first.length + last.length) return false;
  let pos = first.length;
  const end = name.length - last.length;
  for (const mid of parts.slice(1, -1)) {
    if (mid === '') continue;
    const at = name.indexOf(mid, pos);
    if (at < 0 || at + mid.length > end) return false;
    pos = at + mid.length;
  }
  return true;
}

function canonicalSecretRefPattern(pattern: string): string {
  return pattern.toLowerCase().replace(/[^a-z0-9*]/g, '_');
}

/** `true` when at least one pattern allows the reference. An empty list allows nothing. */
export function secretRefAllowed(patterns: readonly string[], ref: string): boolean {
  return patterns.some((p) => matchSecretGlob(p, ref));
}

/** True when `ref` lies under the tenant prefix `<slug>.` in canonical form. */
export function hasTenantPrefix(slug: string, ref: string): boolean {
  return canonicalSecretRef(ref).startsWith(`${canonicalSecretRef(slug)}_`);
}

/**
 * `true` when two tenant slugs would share secret names: one canonical prefix (`acme_`) is a prefix
 * of the other (`acme_corp_`). Such tenants must not coexist (`acme.corp.x` would be inside both).
 */
export function slugsCollide(a: string, b: string): boolean {
  const x = `${canonicalSecretRef(a)}_`;
  const y = `${canonicalSecretRef(b)}_`;
  return x.startsWith(y) || y.startsWith(x);
}

const PATTERN = /^[a-z0-9][a-z0-9_.-]{1,127}\*?$/;

/**
 * Validates the patterns of `tenants.secret_refs`: lower case references, at most one `*` and only
 * at the end, directly after a separator (`acme.*`, never `acme*`), at least two literal characters,
 * at most 64 entries. A bare `*` is not allowed.
 */
export function parseSecretRefPatterns(input: readonly string[]): string[] {
  if (input.length > 64)
    throw new OaxError('config_invalid', 'a tenant can allow at most 64 secret patterns');
  for (const p of input) {
    if (!PATTERN.test(p) || (p.endsWith('*') && !/[._-]\*$/.test(p)))
      throw new OaxError(
        'config_invalid',
        `invalid secret reference pattern "${p}" (lower case, optional trailing "*" after . _ or -)`,
      );
  }
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
