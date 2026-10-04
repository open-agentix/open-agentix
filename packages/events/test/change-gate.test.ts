import { describe, expect, it } from 'vitest';
import {
  ChangeCheckSchema,
  decideChange,
  jsonPointer,
  probeDigest,
  type Probe,
} from '../src/index.js';

const fetchOf =
  (body: string, status = 200, headers: Record<string, string> = {}) =>
  async () =>
    new Response(body, { status, headers });

describe('change gate', () => {
  it('hashes HTTP bodies, JSON pointers and selected headers deterministically', async () => {
    const http = ChangeCheckSchema.parse({
      probe: { type: 'http', url: 'https://status.example.org/api' },
    }).probe as Extract<Probe, { type: 'http' }>;
    const a = await probeDigest(http, { fetch: fetchOf('{"v":1}') });
    expect(a).toBe(await probeDigest(http, { fetch: fetchOf('{"v":1}') }));
    expect(a).not.toBe(await probeDigest(http, { fetch: fetchOf('{"v":2}') }));
    const ptr = { ...http, jsonPointer: '/release/version' };
    const p1 = await probeDigest(ptr, {
      fetch: fetchOf('{"release":{"version":"1.2","date":"x"}}'),
    });
    const p2 = await probeDigest(ptr, {
      fetch: fetchOf('{"release":{"date":"y","version":"1.2"}}'),
    });
    expect(p1).toBe(p2);
    const hdr = { ...http, useHeaders: ['ETag'] };
    expect(await probeDigest(hdr, { fetch: fetchOf('a', 200, { etag: '"1"' }) })).toBe(
      await probeDigest(hdr, { fetch: fetchOf('b', 200, { etag: '"1"' }) }),
    );
  });

  it('fails on HTTP errors and non-JSON responses', async () => {
    const http = ChangeCheckSchema.parse({
      probe: { type: 'http', url: 'https://x.example.org', jsonPointer: '/a' },
    }).probe as Extract<Probe, { type: 'http' }>;
    await expect(probeDigest(http, { fetch: fetchOf('nope', 500) })).rejects.toThrow(/HTTP 500/);
    await expect(probeDigest(http, { fetch: fetchOf('nope') })).rejects.toThrow(
      /did not return JSON/,
    );
    await expect(
      probeDigest({ ...http, jsonPointer: '/missing/deep' }, { fetch: fetchOf('{"a":1}') }),
    ).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes files and decides on changes', async () => {
    const file = ChangeCheckSchema.parse({
      probe: { type: 'file', path: '/data/report.csv' },
    }).probe;
    const d = await probeDigest(file, { readFile: async () => Buffer.from('x') });
    expect(decideChange(d, null)).toEqual({ changed: true, digest: d, previousDigest: null });
    expect(decideChange(d, d).changed).toBe(false);
    expect(jsonPointer({ 'a/b': { '~c': 1 } }, '/a~1b/~0c')).toBe(1);
    expect(() => ChangeCheckSchema.parse({ probe: { type: 'shell', cmd: 'x' } })).toThrow();
  });
});
