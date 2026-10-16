import { sha256Hex } from '../canonical.js';
import { jcs } from '../jcs.js';
import type { JsonObject } from './types.js';

/** Metadata members that are not covered by the digest (AWP spec 9.1). */
const EXCLUDED_METADATA = ['integrity', 'signature', 'provenance'] as const;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Digest of an AWP manifest (spec 9.1): SHA-256 over the RFC 8785 form of the manifest without
 * `metadata.integrity`, `metadata.signature` and `metadata.provenance`. Extensions are covered, so
 * changing any `x-openagentix-*` value changes the digest. Throws `JcsError` for values outside
 * the JSON data model.
 */
export function awpManifestDigest(manifest: JsonObject): string {
  const metadata = manifest.metadata;
  const copy: JsonObject = { ...manifest };
  if (isJsonObject(metadata)) {
    const rest: JsonObject = { ...metadata };
    for (const key of EXCLUDED_METADATA) delete rest[key];
    copy.metadata = rest;
  }
  return `sha256:${sha256Hex(jcs(copy))}`;
}
