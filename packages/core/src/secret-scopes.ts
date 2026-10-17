/**
 * Scoped secret references, names and resolution rules (ADR 0017 section 13, slice S4). Pure
 * functions: no database, no key material. The api resolves a reference against rows with them.
 *
 * A reference is either **legacy** (`jira-token`: operator environment or files, the tenant
 * `secret_refs` allowlist, unchanged) or **scoped** (`personal:`, `team:` or `tenant:` plus a name).
 * The prefix IS the scope; there is no fallback between scopes.
 */

export const SECRET_SCOPES = ['personal', 'team', 'tenant'] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

/** Secret names are lower case so that two spellings never name two secrets (and one env variable). */
export const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
export const SCOPED_REF_PATTERN = /^(?:personal|team|tenant):[a-z0-9][a-z0-9_.-]{0,127}$/;

/** Values shorter than this cannot be redacted reliably (`MIN_KNOWN_SECRET_LENGTH`); they are refused. */
export const MIN_SECRET_VALUE_LENGTH = 8;
/** Upper bound of a stored value, in bytes (ADR 0017 section 13.4). */
export const MAX_SECRET_VALUE_BYTES = 64 * 1024;
/** Upper bound of `allowedDestinations` and of `blockInherited` entries. */
export const MAX_SECRET_PATTERNS = 64;

export type ParsedSecretRef =
  | { kind: 'legacy'; ref: string }
  | { kind: 'scoped'; scope: SecretScope; name: string; ref: string };

/**
 * Splits a reference. A reference with a colon must be a well-formed scoped one; anything else with
 * a colon is `null` (invalid), so a typo such as `Team:x` or `group:x` is never read as a legacy name.
 */
export function parseSecretRef(ref: string): ParsedSecretRef | null {
  const colon = ref.indexOf(':');
  if (colon < 0) return { kind: 'legacy', ref };
  if (!SCOPED_REF_PATTERN.test(ref)) return null;
  return {
    kind: 'scoped',
    scope: ref.slice(0, colon) as SecretScope,
    name: ref.slice(colon + 1),
    ref,
  };
}

export const isScopedRef = (ref: string): boolean => ref.includes(':');

/** `scope:name`. */
export const scopedRef = (scope: SecretScope, name: string): string => `${scope}:${name}`;

/** Why a pinned or resolved secret cannot be used; stable codes shown to clients and in audit. */
export const SECRET_RESOLUTION_CODES = [
  'secret_not_found',
  'secret_unavailable',
  'secret_out_of_chain',
  'secret_not_usable',
  'secret_scope_not_usable',
  'secret_destination_denied',
  'personal_secret_in_version',
  'secret_owner_unavailable',
] as const;
export type SecretResolutionCode = (typeof SECRET_RESOLUTION_CODES)[number];

// ---------------------------------------------------------------- name globs (blockInherited)

const NAME_GLOB = /^[a-z0-9*][a-z0-9_.*-]{0,127}$/;

/** `*` matches any run of characters (including none); there is no other syntax. */
export function matchNameGlob(pattern: string, name: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === name;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (name.length < first.length + last.length) return false;
  if (!name.startsWith(first) || !name.endsWith(last)) return false;
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

/** Validates `settings.secrets.blockInherited`: name globs, sorted and unique. `null` when invalid. */
export function parseNameGlobs(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > MAX_SECRET_PATTERNS) return null;
  for (const p of input) if (typeof p !== 'string' || !NAME_GLOB.test(p)) return null;
  return [...new Set(input as string[])].sort();
}

export const nameBlocked = (globs: readonly string[], name: string): boolean =>
  globs.some((g) => matchNameGlob(g, name));

// ---------------------------------------------------------------- destinations

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Validates `allowedDestinations`: lower case host names (`api.example.org`) or suffix patterns
 * (`*.example.org`). No ports, no IPs, no bare `*`. `null` when invalid.
 */
export function parseDestinations(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > MAX_SECRET_PATTERNS) return null;
  for (const p of input) {
    if (typeof p !== 'string' || p.length > 253) return null;
    const host = p.startsWith('*.') ? p.slice(2) : p;
    if (!HOST.test(host) || /^\d+(\.\d+){3}$/.test(host)) return null;
  }
  return [...new Set(input as string[])].sort();
}

/**
 * Whether one egress entry of a step (`runtime.egress` or an MCP connection: host, `*.suffix`,
 * `.suffix`, each with an optional port, or an IP/CIDR) lies inside the destinations of a secret.
 * An exact host needs an equal pattern or a suffix pattern above it; a suffix entry needs an equal
 * or wider suffix pattern; an address (IP, CIDR, anything unparsable) is never inside: fail closed.
 */
export function destinationAllowed(patterns: readonly string[], entry: string): boolean {
  const e = entry.toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
  const suffix = e.startsWith('*.') ? e.slice(2) : e.startsWith('.') ? e.slice(1) : null;
  const host = suffix ?? e;
  if (!HOST.test(host) || /^\d+(\.\d+){3}$/.test(host)) return false;
  return patterns.some((p) => {
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return host === base ? suffix !== null : host.endsWith(`.${base}`);
    }
    return suffix === null && p === host;
  });
}

/** `true` when every entry is allowed (an empty list has no destination and is allowed). */
export const destinationsAllowed = (
  patterns: readonly string[],
  entries: readonly string[],
): boolean => entries.every((e) => destinationAllowed(patterns, e));

// ---------------------------------------------------------------- tenant chain resolution

export interface ChainNode {
  id: string;
  /** `settings.secrets.blockInherited` of the node (own list; the union comes from walking up). */
  blockInherited: readonly string[];
}

export interface TenantSecretCandidate {
  ownerId: string;
  inherit: boolean;
}

/**
 * The tenant secret a `tenant:<name>` reference resolves to (ADR 0017 section 13.3): the secret of
 * that name on the **nearest** node of the chain with `inherit: true` (or `inherit: false` on the
 * node of the agent itself). `chain` is nearest first (the agent's node, its parent, ..., the root).
 * A node's `blockInherited` hides names owned ABOVE it, never its own nor those below. A candidate
 * that exists wins even when it is revoked or expired: the caller then fails closed instead of
 * silently falling back to a farther credential.
 */
export function nearestTenantSecret<T extends TenantSecretCandidate>(
  chain: readonly ChainNode[],
  candidates: readonly T[],
  name: string,
): T | null {
  const byOwner = new Map(candidates.map((c) => [c.ownerId, c]));
  let blocked = false;
  for (const [i, node] of chain.entries()) {
    const own = byOwner.get(node.id);
    if (own && !blocked && (own.inherit || i === 0)) return own;
    if (nameBlocked(node.blockInherited, name)) blocked = true;
  }
  return null;
}
