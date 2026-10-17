import { canonicalJson, sha256Hex } from '../canonical.js';

/**
 * Digests an approval binds to (ADR 0017 section 4.2). Each one has a domain tag and a version, so
 * a digest of one kind can never be mistaken for another, and is computed over canonical JSON (sorted
 * keys, no whitespace) over sorted, de-duplicated lists, so equal inputs always give equal digests and
 * different inputs never share a serialisation.
 */

/**
 * Digest of the secret resolution of a revision that references **legacy** secrets only: the names
 * (`status: names-only`). It is kept byte-for-byte so that approvals given before slice S4 stay valid
 * for every definition without a scoped reference.
 */
export function secretResolutionDigest(references: readonly string[]): string {
  return sha256Hex(
    canonicalJson({
      kind: 'oax.secret-resolution',
      v: 1,
      status: 'names-only',
      references: [...new Set(references)].sort(),
    }),
  );
}

/**
 * What one reference of a revision resolves to (ADR 0017 section 13.3). A scoped reference is bound
 * to the **owning node and the secret id** the nearest-owner rule picks (never to a version: a
 * rotation keeps the binding), so a secret created later at a nearer node changes the digest and
 * leaves the approval stale instead of silently replacing the credential. A reference that does not
 * resolve is part of the digest with its reason; publish refuses it.
 */
export type SecretPin =
  | { ref: string; state: 'legacy' }
  | { ref: string; state: 'resolved'; scope: string; ownerNode: string; secretId: string }
  | { ref: string; state: 'unresolved'; code: string };

/**
 * Digest of a resolution. Without a scoped reference it is the names-only digest above; with one it
 * covers every reference with its pin (`v: 2`, `status: resolved`).
 */
export function secretResolutionDigestOf(pins: readonly SecretPin[]): string {
  if (pins.every((p) => p.state === 'legacy'))
    return secretResolutionDigest(pins.map((p) => p.ref));
  const byRef = new Map(pins.map((p) => [p.ref, p]));
  return sha256Hex(
    canonicalJson({
      kind: 'oax.secret-resolution',
      v: 2,
      status: 'resolved',
      pins: [...byRef.keys()].sort().map((r) => byRef.get(r)),
    }),
  );
}

/** The secret references a definition declares in its steps (`credentials[].secret`). */
export function declaredSecretReferences(def: {
  agents: readonly { credentials?: readonly { secret: string }[] | undefined }[];
}): string[] {
  return [...new Set(def.agents.flatMap((a) => (a.credentials ?? []).map((c) => c.secret)))].sort();
}
