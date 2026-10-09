import { createHash } from 'node:crypto';

/**
 * Fixed namespace of the demo ids (a random UUID chosen once; never change it, or every link to a
 * demo run or agent breaks). Ids are UUIDv5 (RFC 4122, SHA-1) of `kind:name` in this namespace.
 */
export const DEMO_ID_NAMESPACE = '6f0d6c0e-3b1c-4c52-9a53-0a6d1e5b7e21';

/** UUIDv5 of `name` in `namespace` (no dependency: the algorithm is 15 lines). */
export function uuidV5(name: string, namespace: string = DEMO_ID_NAMESPACE): string {
  const ns = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * Stable id of a demo entity. The nightly reset drops the database and seeds it again; because the
 * ids derive from fixed names, bookmarked links to demo tenants, agents and runs keep working.
 * Names must be unique per kind and never reused for something else.
 */
export function demoId(kind: 'tenant' | 'agent' | 'run', name: string): string {
  return uuidV5(`${kind}:${name}`);
}
