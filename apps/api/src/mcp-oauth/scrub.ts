import type { SecretRegistry } from './secret-registry.js';

/**
 * Removes registered secrets from text that is, or may be, JSON, without ever making valid JSON
 * invalid: the text is scrubbed directly (cheap, and safe because stored values only contain
 * `b64token` characters, see `token-shape.ts`); if that changed a text that was valid JSON before,
 * the result must still parse, otherwise the string leaves are scrubbed instead.
 */
export function scrubJsonText(registry: SecretRegistry, text: string, tenant?: string): string {
  const scrubbed = registry.scrub(text, tenant);
  if (scrubbed === text) return text;
  let before: unknown;
  try {
    before = JSON.parse(text);
  } catch {
    return scrubbed; // not JSON (HTML, plain text, an SSE frame): text scrubbing is all there is
  }
  try {
    JSON.parse(scrubbed);
    return scrubbed;
  } catch {
    return JSON.stringify(scrubLeaves(registry, before, tenant));
  }
}

/**
 * Deep copy with every string (and object key) scrubbed; structure is never touched. Keys that
 * scrub to the same text stay distinct (`[REDACTED]`, `[REDACTED]#2`, ...), so no value is lost.
 */
export function scrubLeaves(registry: SecretRegistry, value: unknown, tenant?: string): unknown {
  if (typeof value === 'string') return registry.scrub(value, tenant);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => scrubLeaves(registry, v, tenant));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    let key = registry.scrub(k, tenant);
    for (let n = 2; key in out; n++) key = `${registry.scrub(k, tenant)}#${n}`;
    out[key] = scrubLeaves(registry, v, tenant);
  }
  return out;
}

/**
 * Scrubs an audit payload by its string leaves (the payload is hashed afterwards). Only the values
 * of `tenant` are used, so one tenant's token cannot alter another tenant's evidence; an entry
 * without a tenant is not scrubbed (names and ids only, by convention).
 */
export function scrubPayloadWith(
  registry: SecretRegistry,
  payload: unknown,
  tenant: string | null | undefined,
): unknown {
  if (!tenant || registry.size === 0 || payload === null || payload === undefined) return payload;
  return scrubLeaves(registry, payload, tenant);
}

/** `JSON.stringify` for hand-written streams (SSE frames) that bypass the response hook. */
export function stringifyScrubbed(
  registry: SecretRegistry,
  value: unknown,
  tenant: string | undefined,
): string {
  const text = JSON.stringify(value);
  return tenant ? scrubJsonText(registry, text, tenant) : text;
}

/** What `scrubStdio` needs of a stream (a test double has just `write`). */
interface WritableLike {
  write: (...args: never[]) => boolean;
}

/**
 * Wraps `write` of the given streams (default stdout and stderr) so that console output, uncaught
 * exception traces and anything else printed by the process pass the registry. Strings only
 * (a Buffer is passed through), one write at a time: a value split across two writes is not found,
 * which is why the logger scrubs whole lines itself. Idempotent per stream.
 */
export function scrubStdio(
  registry: SecretRegistry,
  streams: WritableLike[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    const marked = stream as WritableLike & { __oaxScrub?: boolean };
    if (marked.__oaxScrub) continue;
    marked.__oaxScrub = true;
    const original = (stream.write as (...args: unknown[]) => boolean).bind(stream);
    (stream as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) =>
      original(typeof chunk === 'string' ? registry.scrub(chunk) : chunk, ...rest);
  }
}
