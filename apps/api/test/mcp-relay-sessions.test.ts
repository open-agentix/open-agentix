import type { ToolGateway } from '@openagentix/mcp';
import { describe, expect, it, vi } from 'vitest';
import { RelaySessions, relaySessionKey } from '../src/services/mcp-relay-sessions.js';

/** ADR 0016 section 6: relay sessions are keyed, limited and bounded. */
const limits = { concurrency: 2, ratePerMinute: 3, maxSessions: 2, idleMs: 1000 };
function make(now = { t: 0 }) {
  const sizes: number[] = [];
  const sessions = new RelaySessions(
    limits,
    () => now.t,
    (n) => sizes.push(n),
  );
  const gateway = () => {
    const close = vi.fn(async () => undefined);
    return { gateway: { close } as unknown as ToolGateway, close };
  };
  return { sessions, now, sizes, gateway };
}

describe('relaySessionKey', () => {
  it('differs in each of tenant, connection, credential version and run', () => {
    const base = ['t', 'c', 'v1', 'r'] as const;
    const keys = new Set([
      relaySessionKey(...base),
      relaySessionKey('t2', 'c', 'v1', 'r'),
      relaySessionKey('t', 'c2', 'v1', 'r'),
      relaySessionKey('t', 'c', 'v2', 'r'),
      relaySessionKey('t', 'c', 'v1', 'r2'),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe('RelaySessions', () => {
  it('creates one session per key even when requests race', async () => {
    const { sessions, gateway } = make();
    let created = 0;
    const create = async () => (created++, gateway().gateway);
    const [a, b] = await Promise.all([
      sessions.getOrCreate('k', 'run', create),
      sessions.getOrCreate('k', 'run', create),
    ]);
    expect(a).toBe(b);
    expect(created).toBe(1);
  });

  it('limits calls in flight and gives the slot back', async () => {
    const { sessions, gateway } = make();
    const s = await sessions.getOrCreate('k', 'run', async () => gateway().gateway);
    const r1 = sessions.acquire(s);
    const r2 = sessions.acquire(s);
    expect(() => sessions.acquire(s)).toThrow(expect.objectContaining({ code: 'mcp_relay_busy' }));
    r1();
    r1(); // releasing twice must not free a second slot
    const r3 = sessions.acquire(s);
    expect(() => sessions.acquire(s)).toThrow(/concurrent/);
    r2();
    r3();
    expect(s.inflight).toBe(0);
  });

  it('limits calls per minute with a sliding window', async () => {
    const { sessions, gateway, now } = make();
    const s = await sessions.getOrCreate('k', 'run', async () => gateway().gateway);
    for (let i = 0; i < 3; i++) sessions.acquire(s)();
    expect(() => sessions.acquire(s)).toThrow(expect.objectContaining({ code: 'rate_limited' }));
    now.t += 60_001;
    expect(() => sessions.acquire(s)()).not.toThrow();
    expect(s.hits.length).toBe(1);
  });

  it('closes idle sessions, keeps busy ones, and makes room by evicting the least recently used', async () => {
    const { sessions, gateway, now } = make();
    const a = gateway();
    const b = gateway();
    const sa = await sessions.getOrCreate('a', 'r1', async () => a.gateway);
    now.t += 10;
    await sessions.getOrCreate('b', 'r2', async () => b.gateway);
    expect(sessions.size).toBe(2);
    // full: a third session evicts the least recently used idle one (a)
    const c = gateway();
    await sessions.getOrCreate('c', 'r3', async () => c.gateway);
    expect(a.close).toHaveBeenCalled();
    expect(sessions.size).toBe(2);
    // everything in flight: no room, and a clear refusal
    const [sb, sc] = [
      await sessions.getOrCreate('b', 'r2', async () => b.gateway),
      await sessions.getOrCreate('c', 'r3', async () => c.gateway),
    ];
    const rel = [sessions.acquire(sb), sessions.acquire(sc)];
    await expect(
      sessions.getOrCreate('d', 'r4', async () => gateway().gateway),
    ).rejects.toMatchObject({
      statusCode: 503,
    });
    rel.forEach((r) => r());
    // idle past the limit: swept, closed
    now.t += 5000;
    sessions.sweep();
    expect(sessions.size).toBe(0);
    expect(b.close).toHaveBeenCalled();
    expect(c.close).toHaveBeenCalled();
    expect(sa.inflight).toBe(0);
  });

  it('drops every session of a run and reports sizes for the gauge', async () => {
    const { sessions, gateway, sizes } = make();
    const x = gateway();
    await sessions.getOrCreate('x', 'run-1', async () => x.gateway);
    await sessions.getOrCreate('y', 'run-2', async () => gateway().gateway);
    sessions.dropRun('run-1');
    expect(x.close).toHaveBeenCalled();
    expect(sessions.size).toBe(1);
    await sessions.closeAll();
    expect(sizes.at(-1)).toBe(0);
  });
});
