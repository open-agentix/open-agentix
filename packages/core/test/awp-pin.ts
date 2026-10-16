import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';

/**
 * Offline check against the vendored AWP copy (`packages/awp/vendor/awp-v1alpha1/`): the pinned
 * JSON Schema through the repository's own ajv (same options as the vendored checker) plus the
 * vendored semantic rules and digest function. Nothing is fetched.
 */
const VENDOR = fileURLToPath(new URL('../../awp/vendor/awp-v1alpha1/', import.meta.url));

interface Semantic {
  semanticCheck(
    doc: unknown,
    opts: { profiles?: string[]; verifyDigest?: boolean },
  ): { severity: string; code: string; path: string; message: string }[];
  manifestDigest(doc: unknown, algorithm?: string): string;
}

export const pinnedSchema = JSON.parse(
  readFileSync(`${VENDOR}schema/awp.v1alpha1.json`, 'utf8'),
) as Record<string, unknown>;
const validateSchema = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
}).compile(pinnedSchema);
const semantic = (await import(
  /* @vite-ignore */ pathToFileURL(`${VENDOR}conformance/semantic.mjs`).href
)) as Semantic;

/** Digest computed by the vendored reference implementation (spec 9.1). */
export const referenceDigest = (manifest: unknown): string => semantic.manifestDigest(manifest);

/** Errors of the pinned schema and semantic rules, with digest verification; empty = accepted. */
export function pinErrors(manifest: unknown, profiles: string[]): string[] {
  if (!validateSchema(manifest))
    return (validateSchema.errors ?? []).map((e) => `schema ${e.instancePath} ${e.message}`);
  return semantic
    .semanticCheck(manifest, { profiles, verifyDigest: true })
    .filter((d) => d.severity === 'error')
    .map((d) => `${d.code} ${d.path}: ${d.message}`);
}
