import { schema } from '@openagentix/api';
import { createEvent } from '@openagentix/events';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentSource } from '../../api/test/fixtures.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { CronScheduler, RunQueue } from '../src/index.js';

/** Slice A7 on the worker side: claim, cron and cron sources never start a disabled agent. */
let n: TestNode;
let agentId: string;
let otherId: string;

const call = (method: 'POST' | 'GET', url: string, payload?: unknown) =>
  n.req({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
const manual = async (id: string) =>
  (await call('POST', `/v1/agents/${id}/runs`, { data: { n: 1 } })).json().id as string;
const status = async (id: string) => (await call('GET', `/v1/runs/${id}`)).json().status as string;
const tick = (iso: string) =>
  createEvent({ source: '/sources/cron/x', type: 'io.openagentix.cron.tick', time: new Date(iso) });

beforeAll(async () => {
  n = await testNode({ OAX_WORKER_LEASE_SECONDS: '10' });
  await call('POST', '/v1/teams', { slug: 'team-ops', name: 'Ops' });
  const cron = 'triggers:\n  - type: cron\n    schedule: "0 3 * * *"\n    timezone: UTC';
  const mk = async (name: string, extra = '') => {
    const id = (
      await call('POST', '/v1/agents', { source: agentSource(name, 'team-ops', '1.0.0', extra) })
    ).json().id as string;
    await call('POST', `/v1/agents/${id}/publish`);
    return id;
  };
  agentId = await mk('cron-off-agent', cron);
  otherId = await mk('other-agent');
});
afterAll(async () => n.close());

describe('claim', () => {
  it('does not claim queued runs of a disabled agent until it is enabled again', async () => {
    const queued = await manual(agentId);
    const other = await manual(otherId);
    expect((await call('POST', `/v1/agents/${agentId}/disable`, { reason: 'x' })).statusCode).toBe(
      200,
    );
    const q = new RunQueue(n.ctx, 'w-disabled');
    const claimed = await q.claim(10);
    // The enabled agent's run is claimed, the disabled one's stays queued.
    expect(claimed.map((c) => c.id)).toContain(other);
    expect(claimed.map((c) => c.id)).not.toContain(queued);
    expect(await status(queued)).toBe('queued');
    expect(await q.claim(10)).toEqual([]);
    await call('POST', `/v1/agents/${agentId}/enable`, {});
    expect((await q.claim(10)).map((c) => c.id)).toEqual([queued]);
    expect(await status(queued)).toBe('running');
  });

  it('lets a running run finish and keeps it cancellable while its agent is disabled', async () => {
    await call('POST', `/v1/agents/${agentId}/enable`, {});
    const id = await manual(agentId);
    const q = new RunQueue(n.ctx, 'w-running');
    expect((await q.claim(1)).map((c) => c.id)).toEqual([id]);
    await call('POST', `/v1/agents/${agentId}/disable`, {});
    // Not touched by disable: still running, heartbeat and reaping behave as before.
    expect(await status(id)).toBe('running');
    await q.heartbeat([id]);
    expect(await status(id)).toBe('running');
    const cancel = await call('POST', `/v1/runs/${id}/cancel`);
    expect(cancel.statusCode).toBeLessThan(300);
    await call('POST', `/v1/agents/${agentId}/enable`, {});
  });

  it('does not claim a run requeued after a lost lease while the agent is disabled', async () => {
    const id = await manual(agentId);
    const q = new RunQueue(n.ctx, 'w-lease');
    await q.claim(10);
    await call('POST', `/v1/agents/${agentId}/disable`, {});
    await n.ctx.db
      .update(schema.runs)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.runs.id, id));
    expect(await q.reapExpired()).toBe(1);
    await n.ctx.db
      .update(schema.runs)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(eq(schema.runs.id, id));
    expect(await q.claim(10)).toEqual([]);
    expect(await status(id)).toBe('queued');
    await call('POST', `/v1/agents/${agentId}/enable`, {});
    expect((await q.claim(10)).map((c) => c.id)).toEqual([id]);
  });
});

describe('cron', () => {
  it('drops the cron job of a disabled agent and refuses a tick that is already in flight', async () => {
    await call('POST', `/v1/agents/${agentId}/enable`, {});
    const s = new CronScheduler(n.ctx, n.services);
    expect(await s.reload()).toHaveLength(1);
    await call('POST', `/v1/agents/${agentId}/disable`, {});
    // The next reload stops the job (stale for at most one reload interval).
    expect(await s.reload()).toEqual([]);
    // A tick that fires between disable and the reload is refused, audited, and not an error.
    const before = await n.ctx.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.agentId, agentId));
    expect(await s.fire(agentId, '0 3 * * *', tick('2026-10-06T03:00:00Z'))).toBeNull();
    const after = await n.ctx.db.select().from(schema.runs).where(eq(schema.runs.agentId, agentId));
    expect(after).toHaveLength(before.length);
    const refused = await n.ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'run.refused'), eq(schema.auditLog.target, agentId)));
    expect(refused.some((r) => r.actor === 'cron:0 3 * * *')).toBe(true);
    // Enabling brings the job back with the next reload and ticks create runs again.
    await call('POST', `/v1/agents/${agentId}/enable`, {});
    expect(await s.reload()).toHaveLength(1);
    expect(await s.fire(agentId, '0 3 * * *', tick('2026-10-07T03:00:00Z'))).toBeTruthy();
    s.stop();
  });

  it('does not schedule or probe a cron event source of a disabled agent, keeping the source', async () => {
    const src = await call('POST', '/v1/event-sources', {
      name: `nightly-${randomUUID().slice(0, 8)}`,
      kind: 'cron',
      agentId: otherId,
      config: { schedule: '30 2 * * *', timezone: 'UTC' },
    });
    const sourceId = src.json().id as string;
    const key = (keys: string[]) => keys.some((k) => k.startsWith(`source|${sourceId}`));
    const s = new CronScheduler(n.ctx, n.services);
    expect(key(await s.reload())).toBe(true);
    await call('POST', `/v1/agents/${otherId}/disable`, {});
    // The next reload stops the job: no event, no audit entry and no change probe per tick.
    expect(key(await s.reload())).toBe(false);
    // The source itself stays bound and enabled.
    const kept = (await call('GET', `/v1/event-sources/${sourceId}`)).json();
    expect(kept).toMatchObject({ agentId: otherId, enabled: true });
    const events = async () =>
      (await n.ctx.db.select().from(schema.events).where(eq(schema.events.sourceId, sourceId)))
        .length;
    const runsBefore = (
      await n.ctx.db.select().from(schema.runs).where(eq(schema.runs.agentId, otherId))
    ).length;
    // A tick already in flight is refused and audited without running the change probe.
    const probe = vi.spyOn(n.services.ingest, 'changeGate');
    expect(await s.fire(otherId, '30 2 * * *', tick('2026-10-08T02:30:00Z'), sourceId)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    expect(await events()).toBe(1);
    expect(
      (await n.ctx.db.select().from(schema.runs).where(eq(schema.runs.agentId, otherId))).length,
    ).toBe(runsBefore);
    await call('POST', `/v1/agents/${otherId}/enable`, {});
    expect(key(await s.reload())).toBe(true);
    expect(
      await s.fire(otherId, '30 2 * * *', tick('2026-10-09T02:30:00Z'), sourceId),
    ).toBeTruthy();
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockRestore();
    s.stop();
  });
});
