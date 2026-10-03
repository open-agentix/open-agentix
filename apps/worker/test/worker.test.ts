import { schema } from '@openagentix/api';
import { demoServerFactories, inMemoryServers } from '@openagentix/mcp';
import type { Runner } from '@openagentix/runners';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSource } from '../../api/test/fixtures.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { RunQueue, Worker } from '../src/index.js';

let n: TestNode;
let agentId: string;

beforeAll(async () => {
  n = await testNode({
    OAX_WORKER_CONCURRENCY: '2',
    OAX_WORKER_POLL_MS: '50',
    OAX_WORKER_MAX_ATTEMPTS: '2',
    OAX_WORKER_LEASE_SECONDS: '10',
  });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  const src = agentSource(
    'cron-agent',
    'team-ops',
    '1.0.0',
    'triggers:\n  - type: cron\n    schedule: "0 3 * * *"\n    timezone: UTC',
  );
  agentId = (await n.req({ method: 'POST', url: '/v1/agents', payload: { source: src } })).json()
    .id;
  await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
});
afterAll(async () => n.close());

const enqueue = async () =>
  (
    await n.req({ method: 'POST', url: `/v1/agents/${agentId}/runs`, payload: { data: { n: 1 } } })
  ).json().id as string;
const status = async (id: string) =>
  (await n.req({ method: 'GET', url: `/v1/runs/${id}` })).json().status as string;

describe('RunQueue', () => {
  it('claims queued runs exactly once across workers', async () => {
    const ids = [await enqueue(), await enqueue(), await enqueue()];
    const a = new RunQueue(n.ctx, 'wa');
    const b = new RunQueue(n.ctx, 'wb');
    const [ca, cb] = await Promise.all([a.claim(2), b.claim(2)]);
    const all = [...ca, ...cb].map((c) => c.id).sort();
    expect(all).toEqual([...ids].sort());
    expect(await a.claim(0)).toEqual([]);
    await a.heartbeat(ca.map((c) => c.id));
    await a.heartbeat([]);
  });

  it('requeues expired leases with backoff and fails them after max attempts', async () => {
    const id = await enqueue();
    const q = new RunQueue(n.ctx, 'wc');
    await q.claim(10);
    await n.ctx.db
      .update(schema.runs)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.runs.id, id));
    expect(await q.reapExpired()).toBeGreaterThanOrEqual(1);
    expect(await status(id)).toBe('queued');
    await n.ctx.db
      .update(schema.runs)
      .set({ status: 'running', attempts: 2, leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.runs.id, id));
    await q.reapExpired();
    const run = (await n.req({ method: 'GET', url: `/v1/runs/${id}` })).json();
    expect(run).toMatchObject({ status: 'failed', errorCode: 'lease_expired' });
  });
});

describe('Worker', () => {
  it('executes queued runs via the run-token control plane', async () => {
    await n.ctx.db
      .update(schema.runs)
      .set({ status: 'cancelled' })
      .where(eq(schema.runs.status, 'running'));
    const id = await enqueue();
    const w = new Worker(n.ctx, {
      workerId: 'w-test',
      inMemoryMcp: inMemoryServers(demoServerFactories()),
    });
    const claimed = await w.tick();
    expect(claimed).toContain(id);
    await w.drain();
    expect(await status(id)).toBe('succeeded');
    expect(w.activeRuns).toBe(0);
  });

  it('runs the polling loop and stops gracefully', async () => {
    const id = await enqueue();
    const w = new Worker(n.ctx, { workerId: 'w-loop' });
    w.start();
    w.start();
    for (let i = 0; i < 100 && (await status(id)) !== 'succeeded'; i++)
      await new Promise((r) => setTimeout(r, 20));
    await w.stop();
    expect(await status(id)).toBe('succeeded');
  });

  it('marks runs failed when the runner crashes', async () => {
    const id = await enqueue();
    const crashing: Runner = {
      kind: 'in-process',
      execute: async () => {
        throw new Error('boom');
      },
    };
    const w = new Worker(n.ctx, { workerId: 'w-crash', runner: crashing });
    await w.tick();
    await w.drain();
    const run = (await n.req({ method: 'GET', url: `/v1/runs/${id}` })).json();
    expect(run).toMatchObject({ status: 'failed', errorCode: 'worker_error' });
  });

  it('aborts running runs on hard stop', async () => {
    const id = await enqueue();
    const slow: Runner = {
      kind: 'in-process',
      execute: (_run, ctx) =>
        new Promise((_res, rej) =>
          ctx.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
        ),
    };
    const w = new Worker(n.ctx, { workerId: 'w-abort', runner: slow });
    w.start();
    for (let i = 0; i < 100 && w.activeRuns === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await w.stop(true);
    expect(await status(id)).toBe('failed');
  });
});
