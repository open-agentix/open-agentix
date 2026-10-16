import { canonicalJson, sha256Hex } from '../canonical.js';

/**
 * Digests an approval binds to (ADR 0017 section 4.2). Each one has a domain tag and a version, so
 * a digest of one kind can never be mistaken for another, and is computed over canonical JSON (sorted
 * keys, no whitespace) over sorted, de-duplicated lists, so equal inputs always give equal digests and
 * different inputs never share a serialisation.
 */

/**
 * Digest of the secret resolution of a revision. Until slice S4 builds the secret store the
 * resolution of a reference is its name only; the digest covers the sorted, distinct references the
 * revision declares. S4 replaces `status` and adds scope, owning node and secret id per reference.
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

/** The secret references a definition declares in its steps (`credentials[].secret`). */
export function declaredSecretReferences(def: {
  agents: readonly { credentials?: readonly { secret: string }[] | undefined }[];
}): string[] {
  return [...new Set(def.agents.flatMap((a) => (a.credentials ?? []).map((c) => c.secret)))].sort();
}
