import type { Principal } from '@openagentix/core';
import { createEvent } from '@openagentix/events';
import { schema } from '@openagentix/api';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSource } from '../../api/test/fixtures.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { RunQueue } from '../src/index.js';

/**
 * Enqueue, claim and disable on a real PostgreSQL with several connections (PGlite runs one
 * transaction at a time and cannot show lock contention). Opt in with OAX_TEST_DATABASE_URL, for
 * example `postgres://postgres:test@127.0.0.1:55432/postgres` of a throwaway container.
 */
const URL = process.env.OAX_TEST_DATABASE_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const event = () => createEvent({ source: '/test', type: 'io.openagentix.test', data: null });

describe.skipIf(!URL)('agent disable on PostgreSQL', () => {
  let n: TestNode;
  let principal: Principal;
  let agentId: string;
  let seq = 0;
  const run = randomUUID().slice(0, 8); // the database may be reused between runs

  const newAgent = async () => {
    const name = `pg-disable-${run}-${seq++}`;
    const id = (
      await n.req({
        method: 'POST',
        url: '/v1/agents',
        payload: { source: agentSource(name, 'team-ops') },
      })
    ).json().id as string;
    await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
    return id;
  };
  const count = async (id: string, status: string) =>
    Number(
      (
        (await n.ctx.db.execute(
          sql`select count(*)::int as c from runs where agent_id = ${id} and status = ${status}`,
        )) as unknown as { rows: { c: number }[] }
      ).rows[0]!.c,
    );

  beforeAll(async () => {
    n = await testNode({ OAX_DATABASE_URL: URL! });
    await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
    const me = (await n.req({ method: 'GET', url: '/v1/me' })).json();
    principal = {
      kind: 'user',
      userId: me.user.id,
      tenantId: me.tenant.id,
      displayName: 'admin',
      platformAdmin: true,
      bindings: [{ role: 'admin', teamId: null }],
    };
    agentId = await newAgent();
  }, 60_000);
  afterAll(async () => n.close());

  it('makes disable wait for an enqueue in flight, whose run then is never claimed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = n.ctx.db.transaction(async (tx) => {
      await n.services.runs.enqueue({
        agentId,
        event: event(),
        triggeredBy: 'test:holder',
        tx: tx as never,
      });
      entered();
      await gate;
    });
    await inside;
    let returned = false;
    const disabling = n.services.agents.disable(principal, agentId, 'race').then(() => {
      returned = true;
    });
    await sleep(400);
    expect(returned).toBe(false); // blocked on the row lock the enqueue holds
    release();
    await holder;
    await disabling;
    expect(returned).toBe(true);
    // The run was admitted before disable returned; it is queued and must never start.
    expect(await count(agentId, 'queued')).toBe(1);
    expect(await new RunQueue(n.ctx, 'w-pg').claim(10)).toEqual([]);
    expect(await count(agentId, 'queued')).toBe(1);
  }, 30_000);

  it('makes an enqueue wait for an uncommitted disable and refuse afterwards', async () => {
    const id = await newAgent();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = n.ctx.db.transaction(async (tx) => {
      await tx
        .update(schema.agents)
        .set({ disabledAt: new Date() })
        .where(eq(schema.agents.id, id));
      entered();
      await gate;
    });
    await inside;
    let settled = false;
    const admission = n.services.runs
      .enqueue({ agentId: id, event: event(), triggeredBy: 'test:late' })
      .then(
        () => 'admitted',
        (e: { code?: string }) => e.code,
      )
      .finally(() => (settled = true));
    await sleep(400);
    expect(settled).toBe(false); // blocked on the FOR SHARE of the agent row
    release();
    await holder;
    expect(await admission).toBe('agent_disabled');
    expect(
      await n.ctx.db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.agentId, id))),
    ).toHaveLength(0);
  }, 30_000);

  it('never starts a run after disable returned, with claims racing the disable', async () => {
    for (let round = 0; round < 12; round++) {
      const id = await newAgent();
      for (let i = 0; i < 6; i++)
        await n.services.runs.enqueue({ agentId: id, event: event(), triggeredBy: 'test:round' });
      const queues = [0, 1, 2].map((i) => new RunQueue(n.ctx, `w-${round}-${i}`));
      let stop = false;
      const claimers = queues.map(async (q) => {
        while (!stop) {
          await q.claim(1);
          await sleep(1);
        }
      });
      await sleep(round % 4 === 0 ? 0 : 5);
      await n.services.agents.disable(principal, id, `round ${round}`);
      const runningAtReturn = await count(id, 'running');
      await sleep(80); // claimers keep polling
      stop = true;
      await Promise.all(claimers);
      expect(await count(id, 'running')).toBe(runningAtReturn);
      expect((await count(id, 'running')) + (await count(id, 'queued'))).toBe(6);
    }
  }, 120_000);
});
