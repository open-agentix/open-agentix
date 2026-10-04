import { describe, expect, it } from 'vitest';
import { MemoryCache, ValkeyCache, cached, createCache, type ValkeyLike } from '../src/cache.js';
import { Metrics } from '../src/metrics.js';
import {
  decodeSeqCursor,
  decodeTimeCursor,
  encodeSeqCursor,
  encodeTimeCursor,
  page,
} from '../src/pagination.js';
import { initTelemetry, withSpan } from '../src/telemetry.js';

describe('MemoryCache', () => {
  it('stores with TTL, deletes and invalidates by prefix', async () => {
    const c = new MemoryCache(10);
    await c.set('a:1', { x: 1 }, 1000);
    await c.set('a:2', 2, 1000);
    await c.set('b:1', 3, 1000);
    await c.set('zero', 1, 0);
    expect(await c.get('a:1')).toEqual({ x: 1 });
    expect(await c.get('zero')).toBeUndefined();
    await c.delPrefix('a:');
    expect(await c.get('a:2')).toBeUndefined();
    expect(await c.get('b:1')).toBe(3);
    await c.del('b:1');
    expect(await c.get('b:1')).toBeUndefined();
    await c.set('t', 1, 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await c.get('t')).toBeUndefined();
    await c.close();
  });

  it('cache-aside loads once', async () => {
    const c = new MemoryCache();
    let loads = 0;
    const load = async () => ++loads;
    expect(await cached(c, 'k', 1000, load)).toBe(1);
    expect(await cached(c, 'k', 1000, load)).toBe(1);
    expect(await cached(c, 'n', 1000, async () => null)).toBeNull();
    expect(await createCache(undefined, 5)).toBeInstanceOf(MemoryCache);
  });
});

describe('ValkeyCache with a fake client', () => {
  it('namespaces keys, uses PX TTL and SCAN-based invalidation', async () => {
    const store = new Map<string, string>();
    const log: string[] = [];
    const fake: ValkeyLike = {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v, mode, ttl) => {
        log.push(`set ${k} ${mode} ${ttl}`);
        store.set(k, v);
      },
      del: async (...keys) => {
        keys.forEach((k) => store.delete(k));
        return keys.length;
      },
      scan: async (cursor, _m, pattern) => {
        const prefix = pattern.slice(0, -1);
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        return cursor === '0' ? ['7', keys.slice(0, 1)] : ['0', keys];
      },
      quit: async () => log.push('quit'),
    };
    const c = new ValkeyCache(fake);
    await c.set('x:1', { a: 1 }, 1500);
    await c.set('x:2', 2, 10);
    await c.set('skip', 1, 0);
    expect(await c.get('x:1')).toEqual({ a: 1 });
    expect(await c.get('missing')).toBeUndefined();
    await c.delPrefix('x:');
    expect(store.size).toBe(0);
    await c.set('y', 1, 10);
    await c.del('y');
    await c.close();
    expect(log).toEqual(['set oax:x:1 PX 1500', 'set oax:x:2 PX 10', 'set oax:y PX 10', 'quit']);
  });
});

describe('pagination', () => {
  it('round-trips cursors and pages', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    expect(decodeTimeCursor(encodeTimeCursor(t, 'id-1'))).toEqual({ t, id: 'id-1' });
    expect(decodeTimeCursor(undefined)).toBeNull();
    expect(() => decodeTimeCursor('garbage')).toThrow(/cursor/);
    expect(() => decodeTimeCursor(Buffer.from('["nope","x"]').toString('base64url'))).toThrow(
      /cursor/,
    );
    expect(decodeSeqCursor(encodeSeqCursor(42))).toBe(42);
    expect(decodeSeqCursor(undefined)).toBeNull();
    expect(() => decodeSeqCursor(Buffer.from('-1').toString('base64url'))).toThrow(/cursor/);
    expect(page([1, 2, 3], 2, String)).toEqual({ items: [1, 2], nextCursor: '2' });
    expect(page([1], 2, String)).toEqual({ items: [1], nextCursor: null });
  });
});

describe('telemetry and metrics', () => {
  it('is a no-op without endpoint and wraps spans', async () => {
    const t = await initTelemetry(undefined, 'x');
    expect(t.enabled).toBe(false);
    await t.shutdown();
    expect(await withSpan('ok', { a: 1 }, async () => 5)).toBe(5);
    await expect(
      withSpan('fail', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('registers an OTLP exporter when configured (no spans exported)', async () => {
    const t = await initTelemetry('http://127.0.0.1:4318', 'oax-test');
    expect(t.enabled).toBe(true);
    await t.shutdown();
  });

  it('exposes prometheus metrics', async () => {
    const m = new Metrics('oaxtest_');
    m.runsFinished.inc({ status: 'succeeded' });
    expect(await m.registry.metrics()).toContain(
      'oaxtest_runs_finished_total{status="succeeded"} 1',
    );
  });
});

describe('cost CSV', () => {
  it('quotes special characters and neutralises formulas', async () => {
    const { costLinesToCsv } = await import('../src/services/costs.js');
    const line = {
      id: 1,
      createdAt: 't',
      month: '2026-10-01',
      tenantId: 'x',
      teamId: null,
      agentId: 'a',
      agentName: '=cmd()',
      useCase: 'a,b "c"',
      runId: 'r',
      stepSeq: 1,
      provider: null,
      model: 'm',
      tokensIn: 1,
      tokensOut: 2,
      costMicros: 3,
      costUsd: 0.000003,
    };
    const csv = costLinesToCsv([line]).split('\r\n');
    expect(csv[1]).toBe(`1,t,2026-10-01,x,,a,'=cmd(),"a,b ""c""",r,1,,m,1,2,3,0.000003`);
  });
});
