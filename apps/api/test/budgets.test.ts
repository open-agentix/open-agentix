import { BUDGET_ALERT_EVENT_TYPE } from '@openagentix/core';
import {
  McpServerConfigSchema,
  ToolGateway,
  demoServerFactories,
  inMemoryServers,
  type Ticket,
} from '@openagentix/mcp';
import { ProviderRegistry, SimulatedProvider } from '@openagentix/providers';
import { HttpControlPlane, InProcessRunner } from '@openagentix/runners';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costLedger, events, runs, DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { CVE_TRIAGE, TRIVY_EVENT } from './fixtures.js';
import { injectFetch, testNode, testSecrets, type TestNode } from './helpers.js';

const USE_CASE = 'vulnerability-management';
let n: TestNode;
let operator: string;
let agentId: string;
const store = new Map<string, Ticket>();

async function execute(runId: string) {
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
    })
    .where(eq(runs.id, runId));
  const prepared = await n.services.control.prepare(runId);
  const control = new HttpControlPlane({
    baseUrl: 'http://localhost:8080',
    runToken: n.services.control.issueToken(runId, 'w1'),
    fetchImpl: injectFetch(n.app),
    approvalPollMs: 10,
  });
  const tools = new ToolGateway(
    [
      McpServerConfigSchema.parse({ name: 'cve-db', transport: 'in-memory' }),
      McpServerConfigSchema.parse({ name: 'tickets', transport: 'in-memory' }),
    ],
    { secrets: testSecrets, inMemory: inMemoryServers(demoServerFactories(store)) },
  );
  try {
    return await new InProcessRunner().execute(prepared, {
      providers: ProviderRegistry.of([new SimulatedProvider({ name: 'simulated' })]),
      tools,
      control,
      costModel: n.ctx.costModel,
    });
  } finally {
    await tools.close();
  }
}

const start = async () =>
  (
    await n.req({
      method: 'POST',
      url: `/v1/agents/${agentId}/runs`,
      payload: { data: TRIVY_EVENT },
    })
  ).json();
const put = (useCase: string, monthlyBudgetUsd: number, token?: string) =>
  n.req({
    method: 'PUT',
    url: `/v1/budgets/use-cases/${useCase}`,
    payload: { monthlyBudgetUsd },
    ...(token ? { token } : {}),
  });
const overview = async () => (await n.req({ method: 'GET', url: '/v1/budgets' })).json();
const auditActions = async (action: string) =>
  (await n.req({ method: 'GET', url: `/v1/audit?action=${action}&limit=200` })).json().items as {
    runId: string | null;
    payload: Record<string, unknown>;
  }[];
const alertEvents = () =>
  n.ctx.db.select().from(events).where(eq(events.type, BUDGET_ALERT_EVENT_TYPE));

beforeAll(async () => {
  n = await testNode({
    OAX_PRICE_TABLE: JSON.stringify([
      { provider: 'simulated', model: 'sim-1', inputPerMTok: 10, outputPerMTok: 20 },
    ]),
  });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-security', name: 'S' } });
  const teams = (await n.req({ method: 'GET', url: '/v1/teams' })).json().items as {
    id: string;
  }[];
  const op = (
    await n.req({
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'op@example.com', displayName: 'Op', password: 'operator-password' },
    })
  ).json().id;
  await n.req({
    method: 'PUT',
    url: `/v1/teams/${teams[0]!.id}/members`,
    payload: { members: [{ userId: op, role: 'operator' }] },
  });
  operator = await n.login('op@example.com', 'operator-password');
  agentId = (
    await n.req({ method: 'POST', url: '/v1/agents', payload: { source: CVE_TRIAGE } })
  ).json().id;
  await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
});
afterAll(async () => n.close());

describe('budgets API', () => {
  it('sets, reads and removes use case budgets; only admins may write', async () => {
    expect((await put(USE_CASE, 5)).statusCode).toBe(204);
    expect((await put(USE_CASE, 5, operator)).statusCode).toBe(403);
    expect((await put(USE_CASE, -1)).statusCode).toBe(400);
    const o = await overview();
    expect(o.month).toMatch(/^\d{4}-\d{2}-01$/);
    expect(o.tenant).toMatchObject({ scope: 'tenant', limitUsd: null, spentUsd: 0 });
    expect(o.useCases).toEqual([
      { scope: 'use_case', key: USE_CASE, limitUsd: 5, spentUsd: 0, percentUsed: 0, alerts: [] },
    ]);
    // Operators may read the budgets (costs:read) but not change them.
    expect((await n.req({ method: 'GET', url: '/v1/budgets', token: operator })).statusCode).toBe(
      200,
    );
    expect((await put(USE_CASE, 7)).statusCode).toBe(204);
    expect((await overview()).useCases[0].limitUsd).toBe(7);
    expect(
      (await n.req({ method: 'DELETE', url: `/v1/budgets/use-cases/${USE_CASE}` })).statusCode,
    ).toBe(204);
    expect(
      (await n.req({ method: 'DELETE', url: `/v1/budgets/use-cases/${USE_CASE}` })).statusCode,
    ).toBe(404);
    expect((await overview()).useCases).toEqual([]);
    expect((await auditActions('budget.set')).length).toBe(2);
    expect((await auditActions('budget.removed')).length).toBe(1);
  });

  it('reports the tenant limit set through the tenant API', async () => {
    await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${DEFAULT_TENANT_ID}`,
      payload: { monthlyBudgetUsd: 100 },
    });
    expect((await overview()).tenant).toMatchObject({ limitUsd: 100, spentUsd: 0 });
    await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${DEFAULT_TENANT_ID}`,
      payload: { monthlyBudgetUsd: null },
    });
  });
});

describe('hard stop', () => {
  it('blocks a run at admission when the use case budget is zero and audits it', async () => {
    await put(USE_CASE, 0);
    const run = await start();
    expect(run).toMatchObject({
      status: 'blocked_by_policy',
      errorCode: 'use_case_budget_exceeded',
    });
    const blocked = (await auditActions('run.blocked')).find((e) => e.runId === run.id);
    expect(blocked?.payload).toMatchObject({
      breaches: [{ scope: 'use_case', key: USE_CASE }],
    });
    await n.req({ method: 'DELETE', url: `/v1/budgets/use-cases/${USE_CASE}` });
  });

  it('blocks a run at admission when the tenant budget is reached', async () => {
    await n.ctx.db.execute(
      `update tenants set monthly_budget_micros = 0 where id = '${DEFAULT_TENANT_ID}'` as never,
    );
    expect(await start()).toMatchObject({
      status: 'blocked_by_policy',
      errorCode: 'tenant_budget_exceeded',
    });
    await n.ctx.db.execute(
      `update tenants set monthly_budget_micros = null where id = '${DEFAULT_TENANT_ID}'` as never,
    );
  });

  it('stops a running run mid-run once the budget is spent and audits the stop', async () => {
    const baseline = await start();
    expect((await execute(baseline.id)).status).toBe('succeeded');
    const spent = (await n.req({ method: 'GET', url: `/v1/runs/${baseline.id}` })).json()
      .costMicros as number;
    const steps = (await n.req({ method: 'GET', url: `/v1/runs/${baseline.id}/steps` })).json()
      .items as { kind: string; costMicros: number }[];
    const first = steps.find((s) => s.kind === 'model_call')!.costMicros;
    expect(first).toBeGreaterThan(0);

    // Room for exactly one more model call: the run starts, then hits the limit after step one.
    await put(USE_CASE, (spent + first) / 1_000_000);
    const run = await start();
    expect(run.status).toBe('queued');
    const result = await execute(run.id);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('control_budget_use_case');
    const record = (await n.req({ method: 'GET', url: `/v1/runs/${run.id}` })).json();
    expect(record).toMatchObject({ status: 'failed', errorCode: 'control_budget_use_case' });
    expect(record.costMicros).toBe(first);
    const stop = (await auditActions('budget.blocked')).find((e) => e.runId === run.id);
    expect(stop?.payload).toMatchObject({ stage: 'run' });
    expect(['100']).toEqual(
      (await alertEvents())
        .map((e) =>
          String((e.payload as { data: { thresholdPercent: number } }).data.thresholdPercent),
        )
        .slice(-1),
    );
    await n.req({ method: 'DELETE', url: `/v1/budgets/use-cases/${USE_CASE}` });
  });

  it('a second run of the same month is stopped by the spend of the first', async () => {
    const [{ total }] = await n.ctx.db
      .select({ total: sql<number>`coalesce(sum(${costLedger.costMicros}), 0)::int` })
      .from(costLedger);
    await put(USE_CASE, total / 1_000_000);
    expect(await start()).toMatchObject({ errorCode: 'use_case_budget_exceeded' });
    await n.req({ method: 'DELETE', url: `/v1/budgets/use-cases/${USE_CASE}` });
  });
});

describe('alerts', () => {
  it('raises 50, 80 and 100 % once each as events and audit entries', async () => {
    await n.ctx.db.delete(events).where(eq(events.type, BUDGET_ALERT_EVENT_TYPE));
    await put('alerting', 0.0001); // 100 micro-USD
    const target = { tenantId: DEFAULT_TENANT_ID, teamId: null, useCase: 'alerting' };
    const spend = async (micros: number) => {
      await n.ctx.db.insert(costLedger).values({
        runId: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        useCase: 'alerting',
        month: new Date().toISOString().slice(0, 7) + '-01',
        costMicros: micros,
      });
      await n.services.budgets.raiseAlerts(n.ctx.db, target, micros);
    };
    const percents = async () =>
      (await alertEvents()).map(
        (e) => (e.payload as { data: { thresholdPercent: number } }).data.thresholdPercent,
      );
    await spend(49);
    expect(await percents()).toEqual([]);
    await spend(1);
    expect(await percents()).toEqual([50]);
    await spend(20);
    expect(await percents()).toEqual([50]);
    await spend(10);
    expect(await percents()).toEqual([50, 80]);
    await spend(30);
    await spend(5);
    expect(await percents()).toEqual([50, 80, 100]);
    const [last] = await alertEvents();
    expect(last).toMatchObject({ type: BUDGET_ALERT_EVENT_TYPE, subject: 'use_case/alerting' });
    expect((last!.payload as { data: unknown }).data).toMatchObject({
      scope: 'use_case',
      key: 'alerting',
      limitUsd: 0.0001,
    });
    expect(
      (await auditActions('budget.alert')).filter((e) => e.payload.key === 'alerting'),
    ).toHaveLength(3);
    expect((await overview()).useCases.find((u) => u.key === 'alerting')?.alerts).toEqual([
      50, 80, 100,
    ]);
    await n.services.budgets.raiseAlerts(n.ctx.db, target, 0);
    expect((await alertEvents()).length).toBe(3);
  });
});

describe('worker budget route', () => {
  it('needs a run token and answers with the verdict', async () => {
    const run = await start();
    await n.ctx.db
      .update(runs)
      .set({ status: 'running', lockedBy: 'w1' })
      .where(eq(runs.id, run.id));
    const token = n.services.control.issueToken(run.id, 'w1');
    const res = await n.req({
      method: 'GET',
      url: `/v1/worker/runs/${run.id}/budget`,
      token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blocked: false, breaches: [] });
    expect(
      (await n.req({ method: 'GET', url: `/v1/worker/runs/${run.id}/budget`, token: null }))
        .statusCode,
    ).toBe(401);
  });
});
