import { readFile } from 'node:fs/promises';
import { OaxError, canonicalJson, sha256Hex } from '@openagentix/core';
import { z } from 'zod';

/**
 * Deterministic, LLM-free change gate for schedule sources: a probe is fetched, normalised and
 * hashed; a run is only started (and an event only emitted) when the digest changed.
 */
export const ProbeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('http'),
    url: z.string().url(),
    method: z.enum(['GET', 'HEAD']).default('GET'),
    /** Header name -> value (no secrets; use a connection for authenticated probes, v0.3). */
    headers: z.record(z.string(), z.string()).default({}),
    /** JSON pointer into a JSON response (e.g. `/items/0/version`); whole body otherwise. */
    jsonPointer: z.string().startsWith('/').optional(),
    /** Response headers whose values form the digest instead of the body (e.g. `etag`). */
    useHeaders: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().max(60_000).default(10_000),
  }),
  z.strictObject({
    type: z.literal('file'),
    path: z.string().min(1),
  }),
]);
export type Probe = z.infer<typeof ProbeSchema>;

export const ChangeCheckSchema = z.strictObject({ probe: ProbeSchema });
export type ChangeCheck = z.infer<typeof ChangeCheckSchema>;

export interface ProbeDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readFile?: (path: string) => Promise<Buffer>;
}

export function jsonPointer(value: unknown, pointer: string): unknown {
  let cur = value;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Fetches the probe and returns the SHA-256 digest of its normalised content. */
export async function probeDigest(probe: Probe, deps: ProbeDeps = {}): Promise<string> {
  if (probe.type === 'file') {
    const data = await (deps.readFile ?? ((p: string) => readFile(p)))(probe.path);
    return sha256Hex(data);
  }
  const doFetch = deps.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const res = await doFetch(probe.url, {
    method: probe.method,
    headers: probe.headers,
    signal: AbortSignal.timeout(probe.timeoutMs),
  });
  if (!res.ok) throw new OaxError('probe_failed', `probe ${probe.url} answered HTTP ${res.status}`);
  if (probe.useHeaders) {
    return sha256Hex(
      canonicalJson(
        Object.fromEntries(probe.useHeaders.map((h) => [h.toLowerCase(), res.headers.get(h)])),
      ),
    );
  }
  const text = await res.text();
  if (probe.jsonPointer) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new OaxError('probe_failed', `probe ${probe.url} did not return JSON`);
    }
    return sha256Hex(canonicalJson(jsonPointer(json, probe.jsonPointer) ?? null));
  }
  return sha256Hex(text);
}

export interface ChangeDecision {
  changed: boolean;
  digest: string;
  previousDigest: string | null;
}

/** Compares a new digest with the stored one (first check counts as a change). */
export function decideChange(digest: string, previousDigest: string | null): ChangeDecision {
  return { changed: digest !== previousDigest, digest, previousDigest };
}
