import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertTokenShape, isGlobalSafe } from '../src/mcp-oauth/token-shape.js';
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
/** Milliseconds the calibration loop takes on the reference machine (set from a measured run). */
const CALIBRATION_MS = 80;
const T1 = 'tokenOne-Zk29xQ7mLp3Vw8Rn5TbY1uHsJd4Ge';
const T2 = 'tokenTwo-Hb41yUe6Cd0Fs5AjXq8NmW2tKr7Pv';

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};

describe('SecretRegistry matching', () => {
  it('replaces every spelling: plain, URL-encoded, base64 and base64url (hex is not indexed)', () => {
    const r = new SecretRegistry();
    r.register(T1);
    const b64 = Buffer.from(T1).toString('base64');
    for (const form of [T1, encodeURIComponent(T1), b64, Buffer.from(T1).toString('base64url')]) {
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
    r.register(value, { tenant: 't' });
    const lower = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    expect(r.scrub(`q=${encodeURIComponent(value)}`, 't')).toBe('q=[REDACTED]');
    expect(r.scrub(`q=${lower}`, 't')).toBe('q=[REDACTED]');
  });

  it('does not index hex spellings, and keeps values that fail the tenant-less rule out of the global scope', () => {
    const r = new SecretRegistry();
    const shortValue = 'Zk29xQ7mLp3Vw8Rn5TbY1uHs'; // 24 characters: fine per tenant, too short for logs
    r.register(shortValue, { tenant: 't' });
    r.register(T1, { tenant: 't' });
    expect(r.scrub(Buffer.from(T1).toString('hex'), 't')).toBe(Buffer.from(T1).toString('hex'));
    expect(r.scrub(shortValue, 't')).toBe('[REDACTED]');
    expect(r.scrub(shortValue)).toBe(shortValue); // global scope (logs, spans)
    expect(r.scrub(T1)).toBe('[REDACTED]');
  });
});

/**
 * CPU speed of this machine relative to the one the budgets were set on, so that a slow runner
 * widens the budgets instead of failing them (never narrows them).
 */
const speedFactor = (() => {
  const t0 = performance.now();
  let x = 0;
  for (let i = 0; i < 20_000_000; i++) x = (x + i * 7) % 1_000_003;
  const ms = performance.now() - t0 + x * 0;
  return Math.min(8, Math.max(1, ms / CALIBRATION_MS));
})();

const randomToken = (n: number) =>
  randomBytes(Math.ceil((n * 3) / 4))
    .toString('base64')
    .slice(0, n);

/** Hard time budgets: values are chosen by other parties, text by anyone. */
describe('SecretRegistry adversarial performance', () => {
  const budget = (ms: number) => ms * speedFactor;
  const timed = <T>(f: () => T): { out: T; ms: number } => {
    const t0 = performance.now();
    const out = f();
    return { out, ms: performance.now() - t0 };
  };

  it('periodic tokens that share a long prefix, against 1 MB of the same pattern', () => {
    const r = new SecretRegistry();
    for (let i = 0; i < 10; i++)
      r.register(`${'abcdefghij'.repeat(399)}${randomUUID().replace(/-/g, '')}`, { tenant: 't' });
    const text = 'abcdefghij'.repeat(100_000);
    r.scrub('warm up the build', 't');
    const { out, ms } = timed(() => r.scrub(text, 't'));
    expect(out).toBe(text);
    expect(ms).toBeLessThan(budget(400));
  });

  it('500 JWTs with the same header, against 1 MB of JWT headers', () => {
    const r = new SecretRegistry();
    const header = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9';
    for (let i = 0; i < 500; i++)
      r.register(`${header}.${randomUUID()}${randomUUID()}.${randomUUID()}`, { tenant: 't' });
    const text = `${header}.`.repeat(28_000);
    r.scrub('warm up the build', 't');
    const { out, ms } = timed(() => r.scrub(text, 't'));
    expect(out).toBe(text);
    expect(ms).toBeLessThan(budget(400));
  });

  it('many secrets and a 1 MB response with a hit at the end (build and scan measured apart)', () => {
    const r = new SecretRegistry();
    for (let i = 0; i < 40; i++) r.register(randomToken(48), { tenant: `t${i % 8}` });
    r.register(T1, { tenant: 'x' });
    const build = timed(() => r.scrub('warm up the build', 'x'));
    const text = 'x'.repeat(1_000_000) + T1;
    const scan = timed(() => r.scrub(text, 'x'));
    expect(scan.out.endsWith('[REDACTED]')).toBe(true);
    expect(build.ms).toBeLessThan(budget(100));
    expect(scan.ms).toBeLessThan(budget(300));
  });

  it('churn at the caps: unchanged tokens cost nothing, a new token costs one bounded rebuild', () => {
    const r = new SecretRegistry();
    const PER_TENANT = 3; // 3 x 1500 characters fill most of a tenant's share of indexed text
    const owner = (k: number) => `c${Math.floor(k / PER_TENANT)}-${k % PER_TENANT}:1`;
    const tenant = (k: number) => `t${Math.floor(k / PER_TENANT)}`;
    const tokens: string[] = [];
    for (let k = 0; k < 4 * PER_TENANT; k++) {
      tokens.push(randomToken(1500));
      r.register(tokens[k] as string, { tenant: tenant(k), owner: owner(k) });
    }
    expect(r.size).toBe(tokens.length); // all of them fit, so re-registering is a refresh
    const line = `${'log line with ordinary words '.repeat(35)} end`;
    r.scrub(line); // builds the global automaton once
    // Every tool use re-registers its token: no rebuild, so the loop is as fast as scrubbing.
    const same = timed(() => {
      for (let i = 0; i < 200; i++) {
        const k = i % tokens.length;
        r.register(tokens[k] as string, { tenant: tenant(k), owner: owner(k) });
        r.scrub(line);
      }
    });
    expect(same.ms).toBeLessThan(budget(150));
    // A rotated token (the tenant is at its share, so it also evicts) rebuilds once per log line after it.
    const rotated = timed(() => {
      for (let i = 0; i < 10; i++) {
        r.register(randomToken(1500), { tenant: 't0', owner: `rot${i}:1` });
        r.scrub(line);
      }
    });
    expect(rotated.ms / 10).toBeLessThan(budget(60));
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
    expect(evicted.length).toBe(1); // reported once; later drops wait for the next minute
  });

  it('under global pressure the tenant with the most values loses first', () => {
    const r = new SecretRegistry({ maxEntries: 6 });
    r.register(T2, { tenant: 'small' });
    for (let i = 0; i < 6; i++) r.register(`bulkToken${i}-Kq72LmXz9PaRt4YcWe`, { tenant: 'bulk' });
    expect(r.has(T2)).toBe(true);
    expect(r.size).toBe(6);
  });
});

describe('SecretRegistry bookkeeping', () => {
  it('re-registering the same token only refreshes it (nothing is rebuilt, nothing is lost)', () => {
    const c = clock();
    const r = new SecretRegistry({ now: c.now });
    r.register(T1, { tenant: 't', owner: 'c:1', ttlMs: 1000 });
    r.scrub(T1, 't');
    c.advance(EXPIRY_GRACE_MS + 500);
    r.register(T1, { tenant: 't', owner: 'c:1', ttlMs: 60_000 }); // lifetime extended
    c.advance(EXPIRY_GRACE_MS);
    expect(r.scrub(T1, 't')).toBe('[REDACTED]');
    expect(r.size).toBe(1);
  });

  it('reports evictions at most once a minute, with the number dropped since', () => {
    const c = clock();
    const calls: number[] = [];
    const r = new SecretRegistry({
      now: c.now,
      maxPerTenant: 1,
      onLiveEviction: (n) => calls.push(n),
    });
    const tok = (i: number) => `evictTok${i}-Kq72LmXz9PaRt4YcWe8NhB1vSd`;
    for (let i = 0; i < 4; i++) r.register(tok(i), { tenant: 't' });
    expect(calls).toEqual([1]); // the first drop is reported at once, the next two are held back
    c.advance(61_000);
    r.register(tok(9), { tenant: 't' });
    expect(calls).toEqual([1, 3]);
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
    // A value this short and structural cannot be stored (token rules); the guarantee must not depend on it.
    hostile.register('"b":"2-pad-pad"}', { tenant: 'x' });
    const doc = JSON.stringify({ a: 'x', b: '2-pad-pad' }); // {"a":"x","b":"2-pad-pad"}
    expect(() => JSON.parse(hostile.scrub(doc, 'x'))).toThrow(); // the plain replacement would break it
    const out = scrubJsonText(hostile, doc, 'x');
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

describe('token shape: tenant-less scopes', () => {
  it('uses only long, high-entropy values that are not the shape of a UUID or a digest', () => {
    expect(isGlobalSafe(randomBytes(30).toString('base64url'))).toBe(true);
    expect(isGlobalSafe(randomBytes(24).toString('hex'))).toBe(true); // 48 hex characters
    for (const hex of [16, 20, 32])
      expect(isGlobalSafe(randomBytes(hex).toString('hex')), `${hex * 2} hex`).toBe(false); // UUID, SHA-1, SHA-256
    expect(isGlobalSafe(randomBytes(12).toString('base64url'))).toBe(false); // 16 characters
    expect(isGlobalSafe('eyJhbGciOiJSUzI1NiJ9')).toBe(false);
    // accepted per tenant, though: a 32-hex opaque key is a legitimate credential
    expect(() => assertTokenShape(randomBytes(16).toString('hex'))).not.toThrow();
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
