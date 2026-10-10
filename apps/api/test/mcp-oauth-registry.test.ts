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
import { RegistryGuard } from '../src/mcp-oauth/telemetry-guard.js';

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

  it('matches percent-encoded spellings in either case', () => {
    const r = new SecretRegistry();
    const value = 'ab+cd/efGHijKLmnOP12==';
    r.register(value);
    expect(r.scrub(`q=${encodeURIComponent(value)}`)).toBe('q=[REDACTED]');
    expect(
      r.scrub(`q=${encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`),
    ).toContain('[REDACTED]');
  });
});

/** Hard time budgets: values are chosen by other parties, text by anyone. */
describe('SecretRegistry adversarial performance', () => {
  const BUDGET_MS = 1500;
  const timed = <T>(f: () => T): { out: T; ms: number } => {
    const t0 = performance.now();
    const out = f();
    return { out, ms: performance.now() - t0 };
  };

  it('periodic tokens that share a long prefix, against 1 MB of the same pattern', () => {
    const r = new SecretRegistry({ maxFormChars: 5_000_000 });
    for (let i = 0; i < 10; i++)
      r.register(`${'abcdefghij'.repeat(399)}${randomUUID().replace(/-/g, '')}`, { tenant: 't' });
    const text = 'abcdefghij'.repeat(100_000);
    const { out, ms } = timed(() => r.scrub(text));
    expect(out).toBe(text);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('500 JWTs with the same header, against 1 MB of JWT headers', () => {
    const r = new SecretRegistry();
    const header = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9';
    for (let i = 0; i < 500; i++)
      r.register(`${header}.${randomUUID()}${randomUUID()}.${randomUUID()}`);
    const text = `${header}.`.repeat(28_000);
    const { out, ms } = timed(() => r.scrub(text));
    expect(out).toBe(text);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('thousands of secrets and a 1 MB response, plus a hit at the end', () => {
    const r = new SecretRegistry();
    for (let i = 0; i < 3000; i++)
      r.register(`secret-${i}-${randomUUID().replace(/-/g, '')}`, { tenant: `t${i % 40}` });
    r.register(T1);
    const text = 'x'.repeat(1_000_000) + T1;
    const { out, ms } = timed(() => r.scrub(text));
    expect(out.endsWith('[REDACTED]')).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
    const line = `${'log line with ordinary words '.repeat(35)} ${T1}`;
    r.scrub(line);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) r.scrub(line);
    expect((performance.now() - t0) / 200).toBeLessThan(5);
  });
});

describe('SecretRegistry tenant scoping and quotas', () => {
  it('scrubs a tenant-scoped text with the values of that tenant only', () => {
    const r = new SecretRegistry();
    r.register(T1, { tenant: 'a' });
    r.register(T2, { tenant: 'b' });
    expect(r.scrub(`${T1} ${T2}`, 'a')).toBe(`[REDACTED] ${T2}`);
    expect(r.scrub(`${T1} ${T2}`, 'b')).toBe(`${T1} [REDACTED]`);
    expect(r.scrub(`${T1} ${T2}`, 'nobody')).toBe(`${T1} ${T2}`);
    expect(r.scrub(`${T1} ${T2}`)).toBe('[REDACTED] [REDACTED]'); // logs: tenant unknown
    expect(scrubPayloadWith(r, { t: T2 }, 'a')).toEqual({ t: T2 });
    expect(scrubPayloadWith(r, { t: T2 }, null)).toEqual({ t: T2 });
  });

  it('a tenant over its quota only pushes out its own values, and the handler is told', () => {
    const evicted: number[] = [];
    const r = new SecretRegistry({ maxPerTenant: 3, onLiveEviction: (n) => evicted.push(n) });
    r.register(T2, { tenant: 'victim' });
    const mine = Array.from({ length: 5 }, (_, i) => `attackerToken${i}-Kq72LmXz9PaRt4Yc`);
    for (const v of mine) r.register(v, { tenant: 'attacker' });
    expect(r.has(T2)).toBe(true);
    expect(mine.filter((v) => r.has(v))).toHaveLength(3);
    expect(evicted.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('under global pressure the tenant with the most values loses first', () => {
    const r = new SecretRegistry({ maxEntries: 6 });
    r.register(T2, { tenant: 'small' });
    for (let i = 0; i < 6; i++) r.register(`bulkToken${i}-Kq72LmXz9PaRt4YcWe`, { tenant: 'bulk' });
    expect(r.has(T2)).toBe(true);
    expect(r.size).toBe(6);
  });
});

describe('RegistryGuard (span attributes)', () => {
  it('scrubs registered values from guarded text and reports it', () => {
    const r = new SecretRegistry();
    const guard = new RegistryGuard(r);
    expect(guard.text(`x ${T1}`).text).toBe(`x ${T1}`);
    r.register(T1);
    const out = guard.text(`x ${T1}`);
    expect(out.text).toBe('x [REDACTED]');
    expect(out.report.secrets.kinds['known-secret']).toBe(1);
    r.clear();
    expect(guard.text(`x ${T1}`).text).toBe(`x ${T1}`); // forgotten: nothing is kept for the process lifetime
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
  r.register(T1, { tenant: 'x' });

  it('keeps JSON valid and scrubs string leaves and keys of payloads', () => {
    const text = JSON.stringify({ a: `x ${T1} y`, [T1]: 1, list: [T1] });
    const out = scrubJsonText(r, text);
    expect(JSON.parse(out)).toEqual({ a: 'x [REDACTED] y', '[REDACTED]': 1, list: ['[REDACTED]'] });
    expect(scrubPayloadWith(r, { n: 1, d: [{ t: T1 }] }, 'x')).toEqual({
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

  it('keeps both values when two keys scrub to the same text', () => {
    const out = scrubLeaves(r, { [T1]: 1, [`${T1}`.toUpperCase()]: 2, '[REDACTED]': 3 }) as Record<
      string,
      number
    >;
    expect(Object.values(out).sort()).toEqual([1, 2, 3]);
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
