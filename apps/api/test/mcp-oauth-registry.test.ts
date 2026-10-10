import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertTokenShape } from '../src/mcp-oauth/token-shape.js';
import { canonicalResource } from '../src/mcp-oauth/resource.js';
import {
  scrubJsonText,
  scrubLeaves,
  scrubPayloadWith,
  scrubStdio,
} from '../src/mcp-oauth/scrub.js';
import { EXPIRY_GRACE_MS, SecretRegistry } from '../src/mcp-oauth/secret-registry.js';

/** The process-wide redactor registry (ADR 0016 section 7.5): matching, lifetime and safety. */
const T1 = 'tokenOne-Zk29xQ7mLp3Vw8Rn';
const T2 = 'tokenTwo-Hb41yUe6Cd0Fs5Aj';

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};

describe('SecretRegistry matching', () => {
  it('replaces every spelling: plain, URL-encoded, base64, base64url and hex', () => {
    const r = new SecretRegistry();
    r.register(T1);
    const b64 = Buffer.from(T1).toString('base64');
    for (const form of [
      T1,
      encodeURIComponent(T1),
      b64,
      Buffer.from(T1).toString('base64url'),
      Buffer.from(T1).toString('hex'),
    ]) {
      // base64 spellings are matched by their stable core (the guard's rule); padding may remain
      const out = r.scrub(`a ${form} b`);
      expect(out, form).toContain('[REDACTED]');
      expect(out, form).not.toContain(form.slice(2, -4));
    }
    expect(r.scrub('nothing here at all, really')).toBe('nothing here at all, really');
  });

  it('finds several secrets and the longer of two overlapping ones as a whole', () => {
    const r = new SecretRegistry();
    r.register(T1);
    r.register(`${T1}-extended`);
    r.register(T2);
    expect(r.scrub(`${T1}-extended|${T2}|${T1}`)).toBe('[REDACTED]|[REDACTED]|[REDACTED]');
  });

  it('is fast with thousands of secrets (cost follows the text, not the secret count)', () => {
    const r = new SecretRegistry({ maxEntries: 5000 });
    for (let i = 0; i < 4096; i++) r.register(`secret-${i}-${randomUUID().replace(/-/g, '')}`);
    r.register(T1);
    const line = `${'log line with ordinary words '.repeat(35)} ${T1}`; // about 1 KB
    r.scrub(line); // builds the index
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) expect(r.scrub(line)).toContain('[REDACTED]');
    expect((performance.now() - t0) / 200).toBeLessThan(2);
    const big = 'x'.repeat(1_000_000) + T1;
    const t1 = performance.now();
    expect(r.scrub(big)).toMatch(/\[REDACTED\]$/);
    expect(performance.now() - t1).toBeLessThan(300);
  });
});

describe('SecretRegistry lifetime', () => {
  it('drops a token after it expired plus the grace period', () => {
    const c = clock();
    const r = new SecretRegistry({ now: c.now });
    r.register(T1, { ttlMs: 60_000 });
    c.advance(60_000 + EXPIRY_GRACE_MS - 1);
    expect(r.scrub(T1)).toBe('[REDACTED]');
    c.advance(2000);
    expect(r.scrub(T1)).toBe(T1);
    expect(r.size).toBe(0);
  });

  it('forgets the values of one credential', () => {
    const r = new SecretRegistry();
    r.register(T1, { owner: 'c1:1' });
    r.register(T2, { owner: 'c2:1' });
    r.forgetOwner('c1:1');
    expect(r.scrub(`${T1} ${T2}`)).toBe(`${T1} [REDACTED]`);
  });

  it('evicts the least recently used value, and a reused value stays', () => {
    const evicted: number[] = [];
    const r = new SecretRegistry({ maxEntries: 2, onLiveEviction: (n) => evicted.push(n) });
    r.register(T1);
    r.register(T2);
    r.register(T1); // reuse refreshes T1
    r.register('tokenThree-Qw93kLm2Xz7Pa4Rt');
    expect(r.has(T1)).toBe(true);
    expect(r.has(T2)).toBe(false);
    expect(evicted).toEqual([1]);
  });

  it('prefers to drop expired entries before live ones', () => {
    const c = clock();
    const evicted: number[] = [];
    const r = new SecretRegistry({
      now: c.now,
      maxEntries: 2,
      onLiveEviction: (n) => evicted.push(n),
    });
    r.register(T1, { ttlMs: 1 });
    c.advance(EXPIRY_GRACE_MS + 10);
    r.register(T2);
    r.register('tokenThree-Qw93kLm2Xz7Pa4Rt');
    expect(r.has(T1)).toBe(false);
    expect(r.has(T2)).toBe(true);
    expect(evicted).toEqual([]);
  });
});

describe('scrubbing never damages structure', () => {
  const r = new SecretRegistry();
  r.register(T1);

  it('keeps JSON valid and scrubs string leaves and keys of payloads', () => {
    const text = JSON.stringify({ a: `x ${T1} y`, [T1]: 1, list: [T1] });
    const out = scrubJsonText(r, text);
    expect(JSON.parse(out)).toEqual({ a: 'x [REDACTED] y', '[REDACTED]': 1, list: ['[REDACTED]'] });
    expect(scrubPayloadWith(r, { n: 1, d: [{ t: T1 }] })).toEqual({
      n: 1,
      d: [{ t: '[REDACTED]' }],
    });
    expect(scrubLeaves(r, null)).toBeNull();
  });

  it('falls back to leaf scrubbing if text scrubbing would break the JSON', () => {
    // A registered value that is a JSON structure character sequence (cannot be stored via the
    // token store, but the guarantee must not depend on that): text replacement alone breaks it.
    const hostile = new SecretRegistry();
    hostile.register('"b":"2-pad-pad"}');
    const doc = JSON.stringify({ a: 'x', b: '2-pad-pad' }); // {"a":"x","b":"2-pad-pad"}
    expect(() => JSON.parse(hostile.scrub(doc))).toThrow(); // the plain replacement would break it
    const out = scrubJsonText(hostile, doc);
    expect(JSON.parse(out)).toEqual({ a: 'x', b: '2-pad-pad' });
  });

  it('leaves non-JSON text alone except for the secret', () => {
    expect(scrubJsonText(r, `<html>${T1}</html>`)).toBe('<html>[REDACTED]</html>');
  });

  it('scrubs strings written to wrapped streams, once per stream', () => {
    const written: unknown[] = [];
    const fake = { write: (c: unknown) => (written.push(c), true) };
    scrubStdio(r, [fake]);
    scrubStdio(r, [fake]);
    fake.write(`oops ${T1}`);
    fake.write(Buffer.from(T1));
    expect(written[0]).toBe('oops [REDACTED]');
    expect(Buffer.isBuffer(written[1])).toBe(true);
  });
});

describe('token shape', () => {
  it('canonicalises resource URIs', () => {
    expect(canonicalResource('HTTPS://MCP.Example.org:443/mcp#frag')).toBe(
      'https://mcp.example.org/mcp',
    );
    expect(canonicalResource('https://mcp.example.org/')).toBe('https://mcp.example.org');
    expect(canonicalResource('https://mcp.example.org/a/')).toBe('https://mcp.example.org/a/');
  });

  it('accepts RFC 6750 shapes and rejects everything else without echoing it', () => {
    expect(() => assertTokenShape(T1)).not.toThrow();
    try {
      assertTokenShape('bad value "with" quotes and spaces 1234');
    } catch (e) {
      expect((e as Error).message).not.toContain('quotes');
    }
    expect(() => assertTokenShape('bad value "with" quotes and spaces 1234')).toThrow(/token/);
  });
});
