import { schema } from '@openagentix/api';
import { createEvent, type ConsumerLike, type KafkaMessageLike } from '@openagentix/events';
import { demoServerFactories, inMemoryServers } from '@openagentix/mcp';
import type { Runner } from '@openagentix/runners';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSource } from '../../api/test/fixtures.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { CronScheduler, KafkaSources, RunQueue, Worker } from '../src/index.js';

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

describe('CronScheduler', () => {
  it('loads cron triggers and creates one run per tick', async () => {
    const s = new CronScheduler(n.ctx, n.services);
    const jobs = await s.reload();
    expect(jobs).toHaveLength(1);
    expect(await s.reload()).toEqual(jobs);
    const event = createEvent({
      source: '/sources/cron/x',
      type: 'io.openagentix.cron.tick',
      time: new Date('2026-10-04T03:00:00Z'),
    });
    const first = await s.fire(agentId, '0 3 * * *', event);
    const second = await s.fire(agentId, '0 3 * * *', event);
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    s.start(1_000_000);
    s.stop();
    await n.ctx.db
      .update(schema.agents)
      .set({ latestVersionId: null })
      .where(eq(schema.agents.id, agentId));
    await n.ctx.cache.delPrefix('');
    const s2 = new CronScheduler(n.ctx, n.services);
    await s2.reload();
    // a scheduler that had the job drops it when the agent no longer has the trigger
    expect(await s.reload()).toEqual([]);
    s2.stop();
    const [v] = await n.ctx.db
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.agentId, agentId));
    await n.ctx.db
      .update(schema.agents)
      .set({ latestVersionId: v!.id })
      .where(eq(schema.agents.id, agentId));
    await n.ctx.cache.delPrefix('');
  });
});

describe('KafkaSources', () => {
  it('ingests records from enabled Kafka sources', async () => {
    await n.req({
      method: 'POST',
      url: '/v1/event-sources',
      payload: {
        name: 'jira-kafka',
        kind: 'kafka',
        agentId,
        config: { brokers: ['kafka:9092'], groupId: 'oax', topics: ['jira'] },
      },
    });
    let each:
      | ((p: { topic: string; partition: number; message: KafkaMessageLike }) => Promise<void>)
      | undefined;
    const consumer: ConsumerLike = {
      connect: async () => undefined,
      subscribe: async () => undefined,
      run: async (o) => {
        each = o.eachMessage;
      },
      disconnect: async () => undefined,
    };
    const k = new KafkaSources(n.ctx, n.services, () => consumer);
    expect(await k.start()).toBe(1);
    await each!({
      topic: 'jira',
      partition: 0,
      message: { value: Buffer.from('{"key":"SEC-1"}'), offset: '3' },
    });
    const events = (await n.req({ method: 'GET', url: '/v1/events?limit=1' })).json().items;
    expect(events[0]).toMatchObject({
      cloudEventId: 'jira-0-3',
      type: 'io.openagentix.kafka.message',
    });
    await k.stop();
  });
});

describe('cron event sources', () => {
  it('schedules cron sources bound to an agent and dedupes ticks', async () => {
    const bad = await n.req({
      method: 'POST',
      url: '/v1/event-sources',
      payload: { name: 'bad-cron', kind: 'cron', agentId, config: {} },
    });
    expect(bad.statusCode).toBe(400);
    const src = await n.req({
      method: 'POST',
      url: '/v1/event-sources',
      payload: {
        name: 'nightly',
        kind: 'cron',
        agentId,
        config: { schedule: '30 2 * * *', timezone: 'UTC' },
      },
    });
    expect(src.json()).toMatchObject({ kind: 'cron', ingestUrl: null });
    const s = new CronScheduler(n.ctx, n.services);
    const keys = await s.reload();
    expect(keys.some((k) => k.startsWith(`source|${src.json().id}`))).toBe(true);
    const event = createEvent({
      source: '/sources/cron/nightly',
      type: 'io.openagentix.cron.tick',
      time: new Date('2026-10-05T02:30:00Z'),
    });
    const runId = await s.fire(agentId, '30 2 * * *', event, src.json().id);
    expect(runId).toBeTruthy();
    expect(await s.fire(agentId, '30 2 * * *', event, src.json().id)).toBeNull();
    expect(
      (await n.req({ method: 'DELETE', url: `/v1/event-sources/${src.json().id}` })).statusCode,
    ).toBe(204);
    expect((await s.reload()).some((k) => k.startsWith('source|'))).toBe(false);
    expect(
      (await n.req({ method: 'DELETE', url: `/v1/event-sources/${src.json().id}` })).statusCode,
    ).toBe(404);
    s.stop();
  });
});

describe('change gate on schedule sources', () => {
  it('starts a run only when the probe digest changes', async () => {
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/event-sources',
          payload: {
            name: 'gate-webhook',
            kind: 'webhook',
            config: { changeCheck: { probe: { type: 'file', path: '/x' } } },
          },
        })
      ).statusCode,
    ).toBe(400);
    const src = (
      await n.req({
        method: 'POST',
        url: '/v1/event-sources',
        payload: {
          name: 'release-watch',
          kind: 'cron',
          agentId,
          config: {
            schedule: '*/15 * * * *',
            changeCheck: {
              probe: {
                type: 'http',
                url: 'https://releases.example.org/latest.json',
                jsonPointer: '/version',
              },
            },
          },
        },
      })
    ).json();
    let body = '{"version":"1.0.0"}';
    n.services.ingest.probeDeps = { fetch: async () => new Response(body) };
    const s = new CronScheduler(n.ctx, n.services);
    const tick = (min: number) =>
      createEvent({
        source: '/sources/cron/release-watch',
        type: 'io.openagentix.cron.tick',
        time: new Date(Date.UTC(2026, 9, 6, 10, min)),
      });
    const first = await s.fire(agentId, '*/15 * * * *', tick(0), src.id);
    expect(first).toBeTruthy();
    expect(await s.fire(agentId, '*/15 * * * *', tick(15), src.id)).toBeNull();
    body = '{"version":"1.1.0"}';
    const third = await s.fire(agentId, '*/15 * * * *', tick(30), src.id);
    expect(third).toBeTruthy();
    const ev = (await n.req({ method: 'GET', url: `/v1/runs/${third}` })).json().eventId;
    const event = (await n.req({ method: 'GET', url: `/v1/events/${ev}` })).json();
    expect(event.payload.data.change).toMatchObject({ changed: true });
    const actions = (await n.req({ method: 'GET', url: '/v1/audit?limit=200' }))
      .json()
      .items.map((e: { action: string }) => e.action);
    expect(actions).toContain('change_check.unchanged');
    expect(actions).toContain('change_check.changed');
    s.stop();
  });
});
