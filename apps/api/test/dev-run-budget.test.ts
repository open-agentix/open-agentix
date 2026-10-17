import { randomUUID } from 'node:crypto';
import { CostModel } from '@openagentix/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { costLedger, runs, DEFAULT_TENANT_ID } from '../src/db/schema.js';
import {
  ModelAccountingService,
  type AccountingScope,
  type ReserveRequest,
} from '../src/services/model-accounting.js';
import { monthOf } from '../src/services/runs.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0017 S5, decision 9: development runs have a budget of their own (explicit, else 10 % of the
 * monthly cap of the node, hard stop) and never touch the production budgets.
 */
const PRICE = [{ provider: 'simulated', model: 'sim-1', inputPerMTok: 10, outputPerMTok: 20 }];
/** 1000 input + 1000 output tokens at 10 / 20 USD per MTok. */
const CALL = 30_000;
const scope: AccountingScope = { tenantId: DEFAULT_TENANT_ID };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let n: TestNode;
let acc: ModelAccountingService;
let seq = 0;

const source = (name: string) => `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: ${name}
version: 1.0.0
owner: nobody
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Summarise the event.
---
`;
const reserveReq = (runId: string): ReserveRequest => ({
  runId,
  agentId: 'a',
  inputTokens: 1000,
  maxOutputTokens: 1000,
});
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};
const setCap = (micros: number | null) =>
  n.ctx.db.execute(
    sql`update tenants set monthly_budget_micros = ${micros} where id = ${DEFAULT_TENANT_ID}`,
  );
const setDevBudget = (micros: number | null) =>
  n.ctx.db.execute(
    sql`update tenants set dev_monthly_budget_micros = ${micros} where id = ${DEFAULT_TENANT_ID}`,
  );
const ledger = (runId: string) =>
  n.ctx.db.select().from(costLedger).where(eq(costLedger.runId, runId));

/** A running development run and a running production run of two fresh agents. */
async function mkRun(stage: 'development' | 'production'): Promise<string> {
  const create = await n.req({
    method: 'POST',
    url: '/v1/agents',
    payload: { source: source(`bud-agent-${++seq}`) },
  });
  const agentId = create.json().id as string;
  let runId: string;
  if (stage === 'development') {
    const res = await n.req({
      method: 'POST',
      url: `/v1/agents/${agentId}/dev-runs`,
      payload: { data: {} },
    });
    expect(res.statusCode, res.body).toBe(202);
    runId = res.json().id;
  } else {
    expect((await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` })).statusCode).toBe(
      201,
    );
    runId = (
      await n.req({ method: 'POST', url: `/v1/agents/${agentId}/runs`, payload: { data: {} } })
    ).json().id;
  }
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 600_000),
    })
    .where(eq(runs.id, runId));
  return runId;
}
const finish = (runId: string) =>
  n.ctx.db
    .update(runs)
    .set({ status: 'succeeded', finishedAt: new Date(), lockedBy: null })
    .where(eq(runs.id, runId));
const spend = (stage: 'development' | 'production', micros: number) =>
  n.ctx.db.insert(costLedger).values({
    runId: randomUUID(),
    tenantId: DEFAULT_TENANT_ID,
    agentId: randomUUID(),
    month: monthOf(new Date()),
    costMicros: micros,
    stage,
  });
const overview = async () => (await n.req({ method: 'GET', url: '/v1/budgets' })).json() as Json;

beforeAll(async () => {
  n = await testNode({ OAX_PRICE_TABLE: JSON.stringify(PRICE) });
  acc = new ModelAccountingService(
    n.ctx,
    n.services.audit,
    n.services.agents,
    n.services.budgets,
    undefined,
    {
      maxConcurrentPerSession: 1000,
      maxConcurrentPerTenant: 1000,
      graceMs: 60_000,
      defaultDeadlineMs: 600_000,
    },
  );
});
afterAll(async () => n.close());
afterEach(async () => {
  n.ctx.costModel = CostModel.fromJson(JSON.stringify(PRICE));
  await n.ctx.db.execute(sql`delete from model_reservations`);
  await n.ctx.db.execute(sql`delete from cost_ledger`);
  await n.ctx.db.execute(sql`delete from budget_alerts`);
  await setCap(null);
  await setDevBudget(null);
  await n.ctx.db.execute(
    sql`update runs set status = 'succeeded' where stage = 'development' and status in ('queued', 'running')`,
  );
});

describe('the development budget of a node', () => {
  it('is 10 % of the monthly cap until an administrator sets one', async () => {
    await setCap(500_000);
    const o = await overview();
    expect(o.development).toMatchObject({
      scope: 'development',
      limitUsd: 0.05,
      spentUsd: 0,
      source: 'default',
    });
    const put = await n.req({
      method: 'PUT',
      url: '/v1/budgets/development',
      payload: { monthlyBudgetUsd: 2 },
    });
    expect(put.statusCode, put.body).toBe(204);
    expect((await overview()).development).toMatchObject({ limitUsd: 2, source: 'explicit' });
    const del = await n.req({ method: 'DELETE', url: '/v1/budgets/development' });
    expect(del.statusCode).toBe(204);
    expect((await overview()).development).toMatchObject({ limitUsd: 0.05, source: 'default' });
  });

  it('has no limit without a cap and without an explicit budget', async () => {
    expect((await overview()).development).toMatchObject({ limitUsd: null, source: 'none' });
    const runId = await mkRun('development');
    await spend('development', 50_000_000);
    expect((await acc.reserve(scope, reserveReq(runId))).reservationId).toBeTruthy();
  });

  it('is set by an administrator only', async () => {
    const res = await n.req({
      method: 'PUT',
      url: '/v1/budgets/development',
      payload: { monthlyBudgetUsd: 2 },
      token: null,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('admission and hard stop', () => {
  it('blocks a new development run once the development spend reaches the default limit', async () => {
    await setCap(1_000_000); // default development budget: 100 000
    const agent = (
      await n.req({
        method: 'POST',
        url: '/v1/agents',
        payload: { source: source(`bud-agent-${++seq}`) },
      })
    ).json().id;
    const start = () =>
      n.req({ method: 'POST', url: `/v1/agents/${agent}/dev-runs`, payload: { data: {} } });
    await spend('development', 99_999);
    const ok = await start();
    expect(ok.json().status).toBe('queued');
    await spend('development', 1);
    const blocked = await start();
    expect(blocked.statusCode, blocked.body).toBe(202);
    expect(blocked.json()).toMatchObject({
      status: 'blocked_by_policy',
      errorCode: 'development_budget_exceeded',
      stage: 'development',
    });
    expect(blocked.json().errorMessage).toContain('development');
  });

  it('stops a development run in the middle (mid-run verdict) at the development limit', async () => {
    await setDevBudget(100_000);
    const runId = await mkRun('development');
    expect((await n.services.budgets.verdictForRun(runId)).blocked).toBe(false);
    await spend('development', 100_000);
    const verdict = await n.services.budgets.verdictForRun(runId);
    expect(verdict.blocked).toBe(true);
    expect(verdict.breaches.map((b) => b.scope)).toEqual(['development']);
  });

  it('refuses a model call at the development limit with its own code', async () => {
    await setDevBudget(CALL);
    const runId = await mkRun('development');
    await acc.reserve(scope, reserveReq(runId));
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe('control_budget_development');
  });

  it('counts development reservations and spend against the development budget only', async () => {
    await setDevBudget(10 * CALL);
    await setCap(CALL); // production budget fits exactly one call
    const dev = await mkRun('development');
    const prod = await mkRun('production');
    await acc.reserve(scope, reserveReq(dev));
    await acc.reserve(scope, reserveReq(dev));
    // the development reservations do not eat the production budget ...
    expect((await acc.reserve(scope, reserveReq(prod))).reservationId).toBeTruthy();
    // ... and a production reservation does not eat the development budget
    expect(await code(acc.reserve(scope, reserveReq(prod)))).toBe('control_budget_tenant');
    await finish(dev);
    await finish(prod);
  });

  it('keeps development spend out of production budgets, and production spend out of the development one', async () => {
    await setCap(1_000_000);
    await spend('development', 5_000_000);
    expect((await overview()).tenant.spentUsd).toBe(0);
    const prod = await mkRun('production');
    expect((await n.services.budgets.verdictForRun(prod)).blocked).toBe(false);
    await n.ctx.db.execute(sql`delete from cost_ledger`);
    await spend('production', 1_000_000);
    await setDevBudget(10_000);
    const dev = await mkRun('development');
    expect((await n.services.budgets.verdictForRun(dev)).blocked).toBe(false);
    const o = await overview();
    expect(o.tenant.spentUsd).toBe(1);
    expect(o.development.spentUsd).toBe(0);
  });
});

describe('cost lines carry the stage of their run', () => {
  it('books a settled development call as development, a production call as production', async () => {
    await setDevBudget(10 * CALL);
    const dev = await mkRun('development');
    const prod = await mkRun('production');
    for (const runId of [dev, prod]) {
      const r = await acc.reserve(scope, reserveReq(runId));
      await acc.settle(scope, r.reservationId, {
        usage: { inputTokens: 1000, outputTokens: 1000 },
      });
    }
    expect((await ledger(dev)).map((l) => l.stage)).toEqual(['development']);
    expect((await ledger(prod)).map((l) => l.stage)).toEqual(['production']);
    const csv = await n.req({ method: 'GET', url: '/v1/costs/export?format=csv' });
    expect(csv.body.split('\r\n')[0]).toContain(',stage,');
    const by = await n.req({ method: 'GET', url: '/v1/costs/summary?groupBy=stage' });
    expect(by.statusCode, by.body).toBe(200);
    expect(
      by
        .json()
        .items.map((i: Json) => i.key)
        .sort(),
    ).toEqual(['development', 'production']);
  });

  it('raises the alerts of the development budget under their own scope', async () => {
    await setDevBudget(2 * CALL);
    const dev = await mkRun('development');
    const r = await acc.reserve(scope, reserveReq(dev));
    await acc.settle(scope, r.reservationId, { usage: { inputTokens: 1000, outputTokens: 1000 } });
    const alerts = (await overview()).development.alerts;
    expect(alerts).toEqual([50]);
  });
});
