import { randomUUID } from 'node:crypto';
import { CostModel } from '@openagentix/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  costLedger,
  events,
  modelReservations,
  runs,
  DEFAULT_TENANT_ID,
} from '../src/db/schema.js';
import {
  ACCOUNTING_LOCK_NS,
  ModelAccountingService,
  priceMicros,
  ratesOf,
  type AccountingScope,
  type ReserveRequest,
} from '../src/services/model-accounting.js';
import { testNode, type TestNode } from './helpers.js';

const PW = 'long-password-123';
let n: TestNode;
let acc: ModelAccountingService;
const scope: AccountingScope = { tenantId: DEFAULT_TENANT_ID };
let counter = 0;

interface Opts {
  provider?: string;
  model?: string;
  runBudget?: string;
  agentBudget?: string;
  useCase?: string;
  status?: string;
}

function source(name: string, o: Opts): string {
  const labels = o.useCase ? `labels:\n  useCase: ${o.useCase}\n` : '';
  const budget = o.runBudget ? `budget:\n${o.runBudget}\n` : '';
  const agentBudget = o.agentBudget ? `    budget:\n${o.agentBudget}\n` : '';
  return `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: 1.0.0
owner: team-security
${labels}${budget}agents:
  - id: a
    provider: ${o.provider ?? 'simulated'}
    model: ${o.model ?? 'sim-1'}
${agentBudget}    instructions: Summarise the event.
---
`;
}

/** A running run of a fresh published agent. */
async function mkRun(
  o: Opts = {},
  request: TestNode['req'] = n.req,
): Promise<{ runId: string; teamId: string | null }> {
  const id = (
    await request({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: source(`acc-agent-${++counter}`, o) },
    })
  ).json().id as string;
  expect((await request({ method: 'POST', url: `/v1/agents/${id}/publish` })).statusCode).toBe(201);
  const run = (
    await request({ method: 'POST', url: `/v1/agents/${id}/runs`, payload: { data: { x: 1 } } })
  ).json();
  await n.ctx.db
    .update(runs)
    .set({
      status: o.status ?? 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 600_000),
    })
    .where(eq(runs.id, run.id));
  return { runId: run.id as string, teamId: run.teamId ?? null };
}

const reserveReq = (runId: string, extra: Partial<ReserveRequest> = {}): ReserveRequest => ({
  runId,
  agentId: 'a',
  inputTokens: 1000,
  maxOutputTokens: 1000,
  ...extra,
});
/** 1000 input + 1000 output tokens at 10 / 20 USD per MTok = 30 000 micro-USD. */
const CALL = 30_000;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};
const auditActions = async (action: string) =>
  (await n.req({ method: 'GET', url: `/v1/audit?action=${action}&limit=200` })).json().items as {
    runId: string | null;
    payload: Record<string, unknown>;
  }[];
const ledgerOf = (runId: string) =>
  n.ctx.db.select().from(costLedger).where(eq(costLedger.runId, runId));
const runRow = async (runId: string) =>
  (await n.ctx.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
const setTenantBudget = (micros: number | null) =>
  n.ctx.db.execute(
    sql`update tenants set monthly_budget_micros = ${micros} where id = ${DEFAULT_TENANT_ID}`,
  );
const setTeamBudget = (teamId: string, micros: number | null) =>
  n.ctx.db.execute(sql`update teams set monthly_budget_micros = ${micros} where id = ${teamId}`);

beforeAll(async () => {
  n = await testNode({
    OAX_PRICE_TABLE: JSON.stringify([
      { provider: 'simulated', model: 'sim-1', inputPerMTok: 10, outputPerMTok: 20 },
    ]),
  });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-security', name: 'S' } });
  // Concurrency caps are not under test in the budget tests.
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
  vi.restoreAllMocks();
  n.ctx.now = () => new Date();
  n.ctx.costModel = CostModel.fromJson(
    JSON.stringify([
      { provider: 'simulated', model: 'sim-1', inputPerMTok: 10, outputPerMTok: 20 },
    ]),
  );
  await n.ctx.db.execute(sql`delete from model_reservations`);
  await n.ctx.db.execute(sql`delete from cost_ledger`);
  await n.ctx.db.execute(sql`delete from budget_alerts`);
  await n.ctx.db.execute(sql`delete from use_case_budgets`);
  await setTenantBudget(null);
  await n.ctx.db.execute(sql`update teams set monthly_budget_micros = null`);
});

describe('migration 0010', () => {
  it('creates the reservation table and the ledger columns with their defaults', async () => {
    const { runId } = await mkRun();
    await acc.settle(scope, (await acc.reserve(scope, reserveReq(runId))).reservationId, {
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const [line] = await ledgerOf(runId);
    expect(line).toMatchObject({
      usageSource: 'provider',
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      via: 'in-process',
    });
    expect(line!.reservationId).toBeTruthy();
    const cols = (await n.ctx.db.execute(
      sql`select column_name from information_schema.columns where table_name = 'run_node_sessions' and column_name = 'model_token_jti'`,
    )) as unknown as { rows: unknown[] };
    expect(cols.rows).toHaveLength(1);
  });

  it('refuses negative costs and unknown statuses at the database', async () => {
    const { runId } = await mkRun();
    const base = { runId, agentId: randomUUID(), tenantId: DEFAULT_TENANT_ID, month: '2026-10-01' };
    await expect(n.ctx.db.insert(costLedger).values({ ...base, costMicros: -1 })).rejects.toThrow();
    const res = {
      id: randomUUID(),
      runId,
      agentId: 'a',
      provider: 'simulated',
      model: 'sim-1',
      reservedMicros: 1,
      reservedInputTokens: 1,
      reservedOutputTokens: 1,
      expiresAt: new Date(),
    };
    await expect(
      n.ctx.db.insert(modelReservations).values({ ...res, reservedMicros: -1 }),
    ).rejects.toThrow();
    await expect(
      n.ctx.db.insert(modelReservations).values({ ...res, status: 'bogus' }),
    ).rejects.toThrow();
    await expect(
      n.ctx.db.insert(modelReservations).values({ ...res, actualMicros: -5 }),
    ).rejects.toThrow();
  });

  it('allows a reservation to produce at most one ledger line', async () => {
    const { runId } = await mkRun();
    const r = await acc.reserve(scope, reserveReq(runId));
    await acc.settle(scope, r.reservationId, { usage: { inputTokens: 1, outputTokens: 1 } });
    await expect(
      n.ctx.db.insert(costLedger).values({
        runId,
        agentId: randomUUID(),
        tenantId: DEFAULT_TENANT_ID,
        month: '2026-10-01',
        reservationId: r.reservationId,
      }),
    ).rejects.toThrow();
  });
});

describe('integer micros arithmetic', () => {
  it('prices exactly, without float drift', () => {
    // 0.1 + 0.2 style prices: 3 tokens at 0.3 USD/MTok is 0.9 micro-USD, rounded up once.
    expect(
      priceMicros(ratesOf({ inputPerMTok: 0.3, outputPerMTok: 0 }), { input: 3, output: 0 }),
    ).toBe(1);
    // 1 000 000 tokens at 0.1 USD/MTok is exactly 100 000 micros (0.1 * 1e6 drifts in floats).
    expect(
      priceMicros(ratesOf({ inputPerMTok: 0.1, outputPerMTok: 0 }), {
        input: 1_000_000,
        output: 0,
      }),
    ).toBe(100_000);
    expect(
      priceMicros(ratesOf({ inputPerMTok: 0.07, outputPerMTok: 0.07 }), {
        input: 1_000_000,
        output: 1_000_000,
      }),
    ).toBe(140_000);
    expect(
      priceMicros(ratesOf({ inputPerMTok: 15, outputPerMTok: 75 }), { input: 0, output: 0 }),
    ).toBe(0);
  });

  it('matches an exact BigInt reference for random inputs and always returns integers', () => {
    let seed = 12345;
    const rnd = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let i = 0; i < 500; i++) {
      const inP = rnd(20_000) / 1000;
      const outP = rnd(100_000) / 1000;
      const t = {
        input: rnd(200_000),
        output: rnd(64_000),
        cacheRead: rnd(1000),
        cacheWrite: rnd(1000),
      };
      const rates = ratesOf({ inputPerMTok: inP, outputPerMTok: outP });
      const exact =
        (BigInt(t.input) * rates.input +
          BigInt(t.output) * rates.output +
          BigInt(t.cacheRead) * rates.cacheRead +
          BigInt(t.cacheWrite) * rates.cacheWrite +
          999_999n) /
        1_000_000n;
      const got = priceMicros(rates, t);
      expect(Number.isInteger(got)).toBe(true);
      expect(got).toBe(Number(exact));
      expect(got).toBeGreaterThanOrEqual(0);
      // The cost of fewer tokens never exceeds the cost of the bound (reservation >= settlement).
      expect(priceMicros(rates, { ...t, input: Math.floor(t.input / 2) })).toBeLessThanOrEqual(got);
    }
  });

  it('prices cache tokens with explicit rates and falls back to input and 1.25 x input', () => {
    const explicit = ratesOf({
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    });
    expect(
      priceMicros(explicit, { input: 1000, output: 1000, cacheRead: 10_000, cacheWrite: 2000 }),
    ).toBe(3000 + 15_000 + 3000 + 7500);
    const fallback = ratesOf({ inputPerMTok: 4, outputPerMTok: 0 });
    expect(priceMicros(fallback, { input: 0, output: 0, cacheRead: 1000 })).toBe(4000);
    expect(priceMicros(fallback, { input: 0, output: 0, cacheWrite: 1000 })).toBe(5000);
  });
});

describe('reserve', () => {
  it('holds the worst-case cost and records the reservation', async () => {
    const { runId } = await mkRun();
    const r = await acc.reserve(scope, reserveReq(runId, { deadlineMs: 1000 }));
    expect(r).toMatchObject({
      provider: 'simulated',
      model: 'sim-1',
      reservedMicros: CALL,
      reservedInputTokens: 1000,
      reservedOutputTokens: 1000,
      priced: true,
      remaining: {},
    });
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    const [row] = await acc.list(scope, { runId });
    expect(row).toMatchObject({
      id: r.reservationId,
      status: 'active',
      agentId: 'a',
      sessionId: null,
    });
  });

  it('prices cache_control input at the higher cache-write rate', async () => {
    n.ctx.costModel = new CostModel([
      {
        provider: 'simulated',
        model: 'sim-1',
        inputPerMTok: 10,
        outputPerMTok: 20,
        perToolCallUsd: 0,
        cacheWritePerMTok: 12.5,
      } as never,
    ]);
    const { runId } = await mkRun();
    const plain = await acc.reserve(scope, reserveReq(runId));
    const cached = await acc.reserve(scope, reserveReq(runId, { cacheWrite: true }));
    expect(plain.reservedMicros).toBe(30_000);
    expect(cached.reservedMicros).toBe(32_500);
  });

  it('validates the request and the run', async () => {
    const { runId } = await mkRun();
    for (const bad of [
      { inputTokens: -1 },
      { inputTokens: 1.5 },
      { inputTokens: Number.NaN },
      { maxOutputTokens: 0 },
      { maxOutputTokens: Number.POSITIVE_INFINITY },
      { minOutputTokens: 0 },
    ]) {
      expect(await code(acc.reserve(scope, reserveReq(runId, bad)))).toBe('model_request_invalid');
    }
    expect(await code(acc.reserve(scope, reserveReq(runId, { agentId: 'nope' })))).toBe(
      'model_not_allowed',
    );
    expect(await code(acc.reserve(scope, reserveReq(randomUUID())))).toBe('not_found');
    const idle = await mkRun({ status: 'succeeded' });
    expect(await code(acc.reserve(scope, reserveReq(idle.runId)))).toBe('invalid_state');
    expect(await acc.list(scope)).toHaveLength(0);
  });

  it('logs a warning when the price of a run cannot be resolved', async () => {
    const warn = vi.spyOn(n.ctx.logger, 'warn');
    const failing = new ModelAccountingService(
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
        priceFor: async () => {
          throw new Error('price lookup broke');
        },
      },
    );
    const { runId } = await mkRun();
    await failing.reserve(scope, reserveReq(runId)).catch(() => undefined);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'price lookup broke', runId }),
      'could not resolve the model price for a run',
    );
    warn.mockRestore();
  });

  it('enforces the concurrency limits per session and per tenant from the database', async () => {
    const small = new ModelAccountingService(
      n.ctx,
      n.services.audit,
      n.services.agents,
      n.services.budgets,
      undefined,
      {
        maxConcurrentPerSession: 2,
        maxConcurrentPerTenant: 3,
        graceMs: 1000,
        defaultDeadlineMs: 1000,
      },
    );
    const { runId } = await mkRun();
    const sessionId = randomUUID();
    await small.reserve(scope, reserveReq(runId, { sessionId }));
    const second = await small.reserve(scope, reserveReq(runId, { sessionId }));
    expect(await code(small.reserve(scope, reserveReq(runId, { sessionId })))).toBe(
      'model_rate_limited',
    );
    // Another session of the same tenant still fits until the tenant cap.
    await small.reserve(scope, reserveReq(runId, { sessionId: randomUUID() }));
    expect(await code(small.reserve(scope, reserveReq(runId, { sessionId: randomUUID() })))).toBe(
      'model_rate_limited',
    );
    // Settling frees the slot.
    await small.settle(scope, second.reservationId, { usage: { inputTokens: 1, outputTokens: 1 } });
    await small.reserve(scope, reserveReq(runId, { sessionId: randomUUID() }));
  });
});

describe('limits', () => {
  const MAX_CALLS = 3;
  const cases: [string, Opts, string, () => Promise<void> | void][] = [
    ['run cost', { runBudget: '  maxCostUsd: 0.03' }, 'control_budget_cost', () => undefined],
    ['run tokens', { runBudget: '  maxTokens: 2000' }, 'control_budget_tokens', () => undefined],
    [
      'step cost',
      { agentBudget: '      maxCostUsd: 0.03' },
      'control_budget_cost',
      () => undefined,
    ],
    [
      'step tokens',
      { agentBudget: '      maxTokens: 2000' },
      'control_budget_tokens',
      () => undefined,
    ],
    [
      'step model calls',
      { agentBudget: `      maxSteps: 1` },
      'control_budget_steps',
      () => undefined,
    ],
  ];

  it.each(cases)('%s: an exact fit is granted, one more refused', async (_n, o, expected) => {
    const { runId } = await mkRun(o);
    const first = await acc.reserve(scope, reserveReq(runId));
    expect(first.reservationId).toBeTruthy();
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe(expected);
    // Nothing stays reserved for a refusal.
    expect(await acc.list(scope, { runId, status: 'active' })).toHaveLength(1);
    void MAX_CALLS;
  });

  it('allows a reservation that lands exactly on the limit and refuses one micro more', async () => {
    // 0.03 USD = 30 000 micros = exactly one call; a call that needs 30 001 is refused.
    const { runId } = await mkRun({ runBudget: '  maxCostUsd: 0.03' });
    expect(await code(acc.reserve(scope, reserveReq(runId, { maxOutputTokens: 1001 })))).toBe(
      'control_budget_cost',
    );
    expect(
      (await acc.reserve(scope, reserveReq(runId, { maxOutputTokens: 1000 }))).reservedMicros,
    ).toBe(30_000);
  });

  it('counts the spend of earlier calls and of steps recorded through recordStep', async () => {
    const { runId } = await mkRun({ runBudget: '  maxCostUsd: 0.06' });
    const first = await acc.reserve(scope, reserveReq(runId));
    await acc.settle(scope, first.reservationId, {
      usage: { inputTokens: 1000, outputTokens: 1000 },
    });
    // A priced tool call recorded by the trusted path also counts against the run.
    await n.services.control.recordStep(runId, {
      kind: 'tool_call',
      agentId: 'a',
      name: 'x/y',
      status: 'ok',
      costMicros: 1,
    });
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe('control_budget_cost');
    expect(
      (await acc.reserve(scope, reserveReq(runId, { maxOutputTokens: 999 }))).reservedOutputTokens,
    ).toBe(999);
  });

  it('keeps a step budget separate from other agents and runs', async () => {
    const a = await mkRun({ agentBudget: '      maxSteps: 1' });
    const b = await mkRun({ agentBudget: '      maxSteps: 1' });
    await acc.reserve(scope, reserveReq(a.runId));
    expect(await code(acc.reserve(scope, reserveReq(a.runId)))).toBe('control_budget_steps');
    await acc.reserve(scope, reserveReq(b.runId));
  });

  it('counts settled model calls of the step against maxSteps', async () => {
    const { runId } = await mkRun({ agentBudget: '      maxSteps: 2' });
    for (let i = 0; i < 2; i++) {
      const r = await acc.reserve(scope, reserveReq(runId));
      await acc.settle(scope, r.reservationId, { usage: { inputTokens: 1, outputTokens: 1 } });
    }
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe('control_budget_steps');
  });

  it('refuses at the tenant, use case and team budgets with their own codes', async () => {
    const { runId, teamId } = await mkRun({ useCase: 'uc-limits' });
    await setTenantBudget(CALL);
    await acc.reserve(scope, reserveReq(runId));
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe('control_budget_tenant');
    await setTenantBudget(null);
    await n.ctx.db.execute(sql`delete from model_reservations`);

    await n.req({
      method: 'PUT',
      url: '/v1/budgets/use-cases/uc-limits',
      payload: { monthlyBudgetUsd: 0.03 },
    });
    await acc.reserve(scope, reserveReq(runId));
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe('control_budget_use_case');
    await n.ctx.db.execute(sql`delete from use_case_budgets`);
    await n.ctx.db.execute(sql`delete from model_reservations`);

    await setTeamBudget(teamId!, CALL);
    await acc.reserve(scope, reserveReq(runId));
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe('control_budget_team');
  });

  it('counts monthly spend from the ledger, and a spend at the limit blocks even a free call', async () => {
    const { runId } = await mkRun();
    await setTenantBudget(40_000);
    const r = await acc.reserve(scope, reserveReq(runId));
    await acc.settle(scope, r.reservationId, { usage: { inputTokens: 1000, outputTokens: 1000 } });
    // 10 000 micros are left: the next worst case (30 000) does not fit.
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe('control_budget_tenant');
    await setTenantBudget(CALL);
    // Spend equals the limit: blocked, whatever the call would cost.
    expect(await code(acc.reserve(scope, reserveReq(runId, { maxOutputTokens: 1 })))).toBe(
      'control_budget_tenant',
    );
  });

  it('lets a lowered budget keep granted reservations while new ones see the new limit', async () => {
    const { runId } = await mkRun();
    await setTenantBudget(CALL * 2);
    const granted = await acc.reserve(scope, reserveReq(runId));
    await setTenantBudget(1);
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe('control_budget_tenant');
    const s = await acc.settle(scope, granted.reservationId, {
      usage: { inputTokens: 1000, outputTokens: 1000 },
    });
    expect(s.costMicros).toBe(CALL);
  });

  it('shrinks the output to the headroom when a minimum is given and refuses below it', async () => {
    // 0.02 USD = 20 000 micros; input 1000 tokens cost 10 000, leaving 500 output tokens at 20.
    const { runId } = await mkRun({ runBudget: '  maxCostUsd: 0.02' });
    const r = await acc.reserve(scope, reserveReq(runId, { minOutputTokens: 256 }));
    expect(r.reservedOutputTokens).toBe(500);
    expect(r.reservedMicros).toBe(20_000);
    expect(r.remaining.costMicros).toBe(0);
    const { runId: other } = await mkRun({ runBudget: '  maxCostUsd: 0.02' });
    expect(await code(acc.reserve(scope, reserveReq(other, { minOutputTokens: 501 })))).toBe(
      'control_budget_cost',
    );
    // A token budget clamps the output too (input counts against it).
    const { runId: t } = await mkRun({ runBudget: '  maxTokens: 1300' });
    expect(
      (await acc.reserve(scope, reserveReq(t, { minOutputTokens: 100 }))).reservedOutputTokens,
    ).toBe(300);
    // The input alone exceeding the budget is refused whatever the minimum.
    const { runId: tiny } = await mkRun({ runBudget: '  maxTokens: 900' });
    expect(await code(acc.reserve(scope, reserveReq(tiny, { minOutputTokens: 1 })))).toBe(
      'control_budget_tokens',
    );
  });

  it('reports the tightest remaining headroom', async () => {
    const { runId } = await mkRun({
      runBudget: '  maxCostUsd: 1\n  maxTokens: 100000',
      agentBudget: '      maxSteps: 5',
    });
    const r = await acc.reserve(scope, reserveReq(runId));
    expect(r.remaining).toEqual({ costMicros: 1_000_000 - CALL, tokens: 98_000, modelCalls: 4 });
  });
});

describe('unpriced models', () => {
  const unpriced = { provider: 'openai', model: 'gpt-unpriced' };

  it('are refused whenever any cost limit applies', async () => {
    const run = await mkRun({ ...unpriced, runBudget: '  maxCostUsd: 1' });
    expect(await code(acc.reserve(scope, reserveReq(run.runId)))).toBe('model_unpriced');
    const step = await mkRun({ ...unpriced, agentBudget: '      maxCostUsd: 1' });
    expect(await code(acc.reserve(scope, reserveReq(step.runId)))).toBe('model_unpriced');
    const monthly = await mkRun(unpriced);
    await setTenantBudget(1_000_000);
    expect(await code(acc.reserve(scope, reserveReq(monthly.runId)))).toBe('model_unpriced');
    await setTenantBudget(null);
    await setTeamBudget(monthly.teamId!, 5);
    expect(await code(acc.reserve(scope, reserveReq(monthly.runId)))).toBe('model_unpriced');
    await setTeamBudget(monthly.teamId!, null);
    await n.req({
      method: 'PUT',
      url: '/v1/budgets/use-cases/uc-unpriced',
      payload: { monthlyBudgetUsd: 1 },
    });
    const uc = await mkRun({ ...unpriced, useCase: 'uc-unpriced' });
    expect(await code(acc.reserve(scope, reserveReq(uc.runId)))).toBe('model_unpriced');
    expect(await acc.list(scope)).toHaveLength(0);
  });

  it('proceed without a cost limit, counting tokens at zero cost, and still honour token limits', async () => {
    const free = await mkRun({ ...unpriced, runBudget: '  maxTokens: 5000' });
    const r = await acc.reserve(scope, reserveReq(free.runId));
    expect(r).toMatchObject({ priced: false, reservedMicros: 0 });
    const s = await acc.settle(scope, r.reservationId, {
      usage: { inputTokens: 700, outputTokens: 300 },
    });
    expect(s.costMicros).toBe(0);
    const [line] = await ledgerOf(free.runId);
    expect(line).toMatchObject({ tokensIn: 700, tokensOut: 300, costMicros: 0 });
    expect(await code(acc.reserve(scope, reserveReq(free.runId, { inputTokens: 4500 })))).toBe(
      'control_budget_tokens',
    );
  });

  it('are fine when the price is explicitly zero (self-hosted)', async () => {
    n.ctx.costModel = new CostModel([
      { provider: 'ollama', model: '*', inputPerMTok: 0, outputPerMTok: 0, perToolCallUsd: 0 },
    ]);
    const run = await mkRun({ provider: 'ollama', model: 'llama', runBudget: '  maxCostUsd: 1' });
    expect((await acc.reserve(scope, reserveReq(run.runId))).priced).toBe(true);
  });
});

describe('concurrent reservations never exceed a limit', () => {
  const load = (runId: string, count = 50) =>
    Promise.allSettled(Array.from({ length: count }, () => acc.reserve(scope, reserveReq(runId))));
  const granted = (rs: PromiseSettledResult<unknown>[]) =>
    rs.filter((r) => r.status === 'fulfilled').length;
  const refusals = (rs: PromiseSettledResult<unknown>[]) =>
    rs
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as { code: string }).code);

  const expectTen = async (runId: string, refusal: string) => {
    const rs = await load(runId);
    expect(granted(rs)).toBe(10);
    expect(new Set(refusals(rs))).toEqual(new Set([refusal]));
    const active = await acc.list(scope, { status: 'active' });
    expect(active.reduce((a, r) => a + Number(r.reservedMicros), 0)).toBe(10 * CALL);
  };

  it('run cost', async () =>
    expectTen((await mkRun({ runBudget: '  maxCostUsd: 0.3' })).runId, 'control_budget_cost'));
  it('run tokens', async () =>
    expectTen((await mkRun({ runBudget: '  maxTokens: 20000' })).runId, 'control_budget_tokens'));
  it('step cost', async () =>
    expectTen(
      (await mkRun({ agentBudget: '      maxCostUsd: 0.3' })).runId,
      'control_budget_cost',
    ));
  it('step model calls', async () =>
    expectTen((await mkRun({ agentBudget: '      maxSteps: 10' })).runId, 'control_budget_steps'));
  it('tenant monthly', async () => {
    const { runId } = await mkRun();
    await setTenantBudget(10 * CALL);
    await expectTen(runId, 'control_budget_tenant');
  });
  it('team monthly', async () => {
    const { runId, teamId } = await mkRun();
    await setTeamBudget(teamId!, 10 * CALL);
    await expectTen(runId, 'control_budget_team');
  });
  it('use case monthly', async () => {
    const { runId } = await mkRun({ useCase: 'uc-load' });
    await n.req({
      method: 'PUT',
      url: '/v1/budgets/use-cases/uc-load',
      payload: { monthlyBudgetUsd: 0.3 },
    });
    await expectTen(runId, 'control_budget_use_case');
  });

  it('several runs of one tenant share the tenant budget', async () => {
    const runIds = [(await mkRun()).runId, (await mkRun()).runId, (await mkRun()).runId];
    await setTenantBudget(10 * CALL);
    const rs = await Promise.allSettled(
      Array.from({ length: 60 }, (_v, i) => acc.reserve(scope, reserveReq(runIds[i % 3]!))),
    );
    expect(granted(rs)).toBe(10);
  });

  it('settled spend plus new reservations stay within the limit while calls settle concurrently', async () => {
    const { runId } = await mkRun({ runBudget: '  maxCostUsd: 0.3' });
    let spent = 0;
    await Promise.all(
      Array.from({ length: 40 }, async () => {
        try {
          const r = await acc.reserve(scope, reserveReq(runId));
          const s = await acc.settle(scope, r.reservationId, {
            usage: { inputTokens: 1000, outputTokens: 1000 },
          });
          spent += s.costMicros;
        } catch (e) {
          expect((e as { code: string }).code).toBe('control_budget_cost');
        }
      }),
    );
    expect(spent).toBe(10 * CALL);
    expect((await runRow(runId)).costMicros).toBe(10 * CALL);
    expect(await acc.list(scope, { status: 'active' })).toHaveLength(0);
  });

  it('two tenants reserve concurrently without affecting each other', async () => {
    const mk = async (slug: string) => {
      const r = await n.req({
        method: 'POST',
        url: '/v1/tenants',
        payload: {
          slug,
          name: slug,
          admin: { email: `admin@${slug}.example.org`, displayName: slug, password: PW },
        },
      });
      expect(r.statusCode).toBe(201);
      const token = await n.login(`admin@${slug}.example.org`, PW);
      const asTenant: TestNode['req'] = (o) => n.req({ ...o, token });
      await asTenant({
        method: 'POST',
        url: '/v1/teams',
        payload: { slug: 'team-security', name: 'S' },
      });
      const { runId } = await mkRun({ runBudget: '  maxCostUsd: 0.3' }, asTenant);
      return { tenantId: r.json().id as string, runId };
    };
    const [a, b] = [await mk('acc-a'), await mk('acc-b')];
    const rs = await Promise.allSettled([
      ...Array.from({ length: 30 }, () =>
        acc.reserve({ tenantId: a.tenantId }, reserveReq(a.runId)),
      ),
      ...Array.from({ length: 30 }, () =>
        acc.reserve({ tenantId: b.tenantId }, reserveReq(b.runId)),
      ),
    ]);
    expect(granted(rs.slice(0, 30))).toBe(10);
    expect(granted(rs.slice(30))).toBe(10);
    // Reservations of A are invisible to every query as B.
    expect(await acc.list({ tenantId: a.tenantId })).toHaveLength(10);
    expect((await acc.list({ tenantId: b.tenantId })).every((r) => r.runId === b.runId)).toBe(true);
    const [aRes] = await acc.list({ tenantId: a.tenantId });
    expect(await code(acc.settle({ tenantId: b.tenantId }, aRes!.id))).toBe('not_found');
    expect(await code(acc.reserve({ tenantId: b.tenantId }, reserveReq(a.runId)))).toBe(
      'not_found',
    );
    expect(await code(acc.reserve({ tenantId: DEFAULT_TENANT_ID }, reserveReq(a.runId)))).toBe(
      'not_found',
    );
    expect(await acc.list(scope)).toHaveLength(0);
    // The lock key is per tenant: different tenants take different advisory locks.
    const keys = (await n.ctx.db.execute(
      sql`select hashtext(${a.tenantId}) as a, hashtext(${b.tenantId}) as b`,
    )) as unknown as { rows: { a: number; b: number }[] };
    expect(keys.rows[0]!.a).not.toBe(keys.rows[0]!.b);
    expect(ACCOUNTING_LOCK_NS).toBeGreaterThan(0);
  });
});

describe('settle', () => {
  it('writes the model_call step, ledger line, run counters and audit entries atomically', async () => {
    const { runId } = await mkRun();
    const r = await acc.reserve(scope, reserveReq(runId));
    const s = await acc.settle(scope, r.reservationId, {
      usage: { inputTokens: 600, outputTokens: 400, cacheReadTokens: 300, cacheWriteTokens: 100 },
      via: 'proxy',
      detail: { input: { messages: 1 }, output: { text: 'hi' }, durationMs: 12 },
    });
    // 600*10 + 400*20 + 300*10 (cache read as input) + 100*12.5 (1.25 x input) = 18 250.
    expect(s).toMatchObject({
      status: 'settled',
      costMicros: 18_250,
      tokensIn: 1000,
      tokensOut: 400,
      usageSource: 'provider',
      alreadyClosed: false,
    });
    const [line] = await ledgerOf(runId);
    expect(line).toMatchObject({
      tokensIn: 1000,
      tokensOut: 400,
      costMicros: 18_250,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      usageSource: 'provider',
      via: 'proxy',
      reservationId: r.reservationId,
      provider: 'simulated',
      model: 'sim-1',
    });
    expect(await runRow(runId)).toMatchObject({
      tokensIn: 1000,
      tokensOut: 400,
      costMicros: 18_250,
    });
    const steps = (await n.req({ method: 'GET', url: `/v1/runs/${runId}/steps` })).json().items as {
      kind: string;
      status: string;
      agentId: string;
      name: string;
    }[];
    expect(steps).toEqual([
      expect.objectContaining({
        kind: 'model_call',
        status: 'ok',
        agentId: 'a',
        name: 'simulated/sim-1',
      }),
    ]);
    const [entry] = (await auditActions('step.model_call')).filter((e) => e.runId === runId);
    expect(entry!.payload).toMatchObject({
      callId: r.reservationId,
      costMicros: 18_250,
      usageSource: 'provider',
      via: 'proxy',
    });
    const [row] = await acc.list(scope, { runId });
    expect(row).toMatchObject({ status: 'settled', actualMicros: 18_250 });
    expect(row!.settledAt).toBeInstanceOf(Date);
  });

  it('is idempotent: a second settlement changes nothing and reports the recorded outcome', async () => {
    const { runId } = await mkRun();
    const r = await acc.reserve(scope, reserveReq(runId));
    const first = await acc.settle(scope, r.reservationId, {
      usage: { inputTokens: 100, outputTokens: 100 },
    });
    const again = await acc.settle(scope, r.reservationId, {
      usage: { inputTokens: 999, outputTokens: 999 },
    });
    expect(again).toMatchObject({
      alreadyClosed: true,
      status: 'settled',
      costMicros: first.costMicros,
    });
    expect(await ledgerOf(runId)).toHaveLength(1);
    expect(await runRow(runId)).toMatchObject({ tokensIn: 100, tokensOut: 100 });
    // Concurrent duplicates (a retry racing the original) also settle exactly once.
    const r2 = await acc.reserve(scope, reserveReq(runId));
    const dup = await Promise.all(
      Array.from({ length: 5 }, () =>
        acc.settle(scope, r2.reservationId, { usage: { inputTokens: 50, outputTokens: 50 } }),
      ),
    );
    expect(dup.filter((d) => !d.alreadyClosed)).toHaveLength(1);
    expect(await ledgerOf(runId)).toHaveLength(2);
    expect(await code(acc.settle(scope, randomUUID()))).toBe('not_found');
  });

  it('falls back to the estimate when the provider reports nothing', async () => {
    const { runId } = await mkRun();
    const r = await acc.reserve(
      scope,
      reserveReq(runId, { inputTokens: 2000, maxOutputTokens: 4000 }),
    );
    // 900 text bytes + 300 tool argument bytes = 1200 bytes -> 400 output tokens; input as reserved.
    const s = await acc.settle(scope, r.reservationId, {
      output: { textBytes: 900, toolArgBytes: 300 },
    });
    expect(s).toMatchObject({ usageSource: 'estimated', tokensIn: 2000, tokensOut: 400 });
    expect(s.costMicros).toBe(2000 * 10 + 400 * 20);
    expect((await ledgerOf(runId))[0]).toMatchObject({ usageSource: 'estimated' });
    // Without any measurement the reserved output is charged (fail closed in money).
    const r2 = await acc.reserve(scope, reserveReq(runId));
    const s2 = await acc.settle(scope, r2.reservationId, {});
    expect(s2).toMatchObject({ usageSource: 'estimated', tokensOut: 1000, costMicros: CALL });
  });

  it.each([
    ['negative tokens', { inputTokens: -5, outputTokens: 10 }],
    ['fractional tokens', { inputTokens: 5.5, outputTokens: 10 }],
    ['NaN', { inputTokens: Number.NaN, outputTokens: 10 }],
    ['Infinity', { inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY }],
    ['string', { inputTokens: '5' as unknown as number, outputTokens: 10 }],
    ['negative cache', { inputTokens: 1, outputTokens: 1, cacheReadTokens: -1 }],
    ['absurdly large', { inputTokens: 1, outputTokens: 9_000_000_000 }],
  ])(
    'treats unusable usage (%s) as missing, never as a negative or invalid cost',
    async (_n, usage) => {
      const { runId } = await mkRun();
      const r = await acc.reserve(scope, reserveReq(runId));
      const s = await acc.settle(scope, r.reservationId, { usage, output: { textBytes: 30 } });
      expect(s.usageSource).toBe('estimated');
      expect(s.costMicros).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(s.costMicros)).toBe(true);
      expect(s.tokensOut).toBe(10);
    },
  );

  it('applies the lower bound to an endpoint that reports implausibly little output', async () => {
    const { runId } = await mkRun();
    const r = await acc.reserve(scope, reserveReq(runId));
    // 8 000 bytes of output cannot be fewer than 1 000 tokens; the provider claims 3.
    const s = await acc.settle(scope, r.reservationId, {
      usage: { inputTokens: 100, outputTokens: 3 },
      output: { textBytes: 8000 },
    });
    expect(s).toMatchObject({ usageSource: 'floor', tokensOut: 1000 });
    expect(
      (await auditActions('model.usage_floor')).find((e) => e.runId === runId)?.payload,
    ).toMatchObject({
      reportedOutputTokens: 3,
      flooredOutputTokens: 1000,
    });
    // Honest usage is not floored.
    const r2 = await acc.reserve(scope, reserveReq(runId));
    const s2 = await acc.settle(scope, r2.reservationId, {
      usage: { inputTokens: 100, outputTokens: 900 },
      output: { textBytes: 3000 },
    });
    expect(s2.usageSource).toBe('provider');
  });

  it('charges what the provider reported when it exceeds the reservation and audits the overrun', async () => {
    const { runId } = await mkRun();
    const r = await acc.reserve(scope, reserveReq(runId));
    const s = await acc.settle(scope, r.reservationId, {
      usage: { inputTokens: 1000, outputTokens: 2000 },
    });
    expect(s.costMicros).toBe(50_000);
    expect(
      (await auditActions('model.overrun')).find((e) => e.runId === runId)?.payload,
    ).toMatchObject({
      callId: r.reservationId,
      reservedMicros: CALL,
      actualMicros: 50_000,
    });
  });

  it('never charges more than the reservation for usage within the bound', async () => {
    const { runId } = await mkRun();
    for (const [i, o] of [
      [1000, 1000],
      [1, 1],
      [999, 1],
      [0, 0],
    ] as const) {
      const r = await acc.reserve(scope, reserveReq(runId));
      const s = await acc.settle(scope, r.reservationId, {
        usage: { inputTokens: i, outputTokens: o },
      });
      expect(s.costMicros).toBeLessThanOrEqual(r.reservedMicros);
    }
    expect((await auditActions('model.overrun')).filter((e) => e.runId === runId)).toHaveLength(0);
  });

  it('releases a failed call at zero with an error step and returns the headroom', async () => {
    const { runId } = await mkRun({ runBudget: '  maxCostUsd: 0.03' });
    const r = await acc.reserve(scope, reserveReq(runId));
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe('control_budget_cost');
    const released = await acc.release(scope, r.reservationId, 'provider 400');
    expect(released).toMatchObject({ status: 'settled', costMicros: 0, tokensIn: 0, tokensOut: 0 });
    expect(await ledgerOf(runId)).toHaveLength(0);
    expect(await runRow(runId)).toMatchObject({ costMicros: 0, tokensIn: 0 });
    const steps = (await n.req({ method: 'GET', url: `/v1/runs/${runId}/steps` })).json().items as {
      kind: string;
      status: string;
    }[];
    expect(steps).toEqual([expect.objectContaining({ kind: 'model_call', status: 'error' })]);
    // The whole budget is available again.
    await acc.reserve(scope, reserveReq(runId));
  });

  it('rolls everything back when settlement fails halfway, and a retry succeeds', async () => {
    const { runId } = await mkRun();
    const r = await acc.reserve(scope, reserveReq(runId));
    const spy = vi.spyOn(n.services.audit, 'append').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      acc.settle(scope, r.reservationId, { usage: { inputTokens: 10, outputTokens: 10 } }),
    ).rejects.toThrow('disk full');
    expect(spy).toHaveBeenCalled();
    // Neither the step, the ledger line, the counters nor the reservation status changed.
    expect(await ledgerOf(runId)).toHaveLength(0);
    expect(await runRow(runId)).toMatchObject({ costMicros: 0, tokensIn: 0, lastSeq: 0 });
    expect((await acc.list(scope, { runId }))[0]).toMatchObject({
      status: 'active',
      actualMicros: null,
    });
    const s = await acc.settle(scope, r.reservationId, {
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    expect(s.alreadyClosed).toBe(false);
    expect(await ledgerOf(runId)).toHaveLength(1);
  });

  it('rolls a reservation back when a limit refuses it halfway', async () => {
    const { runId } = await mkRun({ runBudget: '  maxCostUsd: 0.03' });
    await acc.reserve(scope, reserveReq(runId));
    await code(acc.reserve(scope, reserveReq(runId)));
    expect(await acc.list(scope, { runId })).toHaveLength(1);
  });

  it('raises budget alerts for the settled cost', async () => {
    const { runId } = await mkRun();
    await setTenantBudget(40_000);
    const r = await acc.reserve(scope, reserveReq(runId));
    await acc.settle(scope, r.reservationId, { usage: { inputTokens: 1000, outputTokens: 1000 } });
    const raised = await n.ctx.db
      .select()
      .from(events)
      .where(eq(events.type, 'io.openagentix.budget.alert'));
    expect(raised.length).toBeGreaterThanOrEqual(2);
  });

  it('increments the cost metric after the commit', async () => {
    const { runId } = await mkRun();
    const inc = vi.spyOn(n.ctx.metrics.costMicros, 'inc');
    const r = await acc.reserve(scope, reserveReq(runId));
    await acc.settle(scope, r.reservationId, { usage: { inputTokens: 1000, outputTokens: 1000 } });
    expect(inc).toHaveBeenCalledWith({ provider: 'simulated' }, CALL);
  });

  it('scrubs step payloads of secrets the broker handed out', async () => {
    const scrub = vi.fn(async (_runId: string, v: unknown) => ({
      ...(v as object),
      scrubbed: true,
    }));
    const scrubbing = new ModelAccountingService(
      n.ctx,
      n.services.audit,
      n.services.agents,
      n.services.budgets,
      scrub as never,
    );
    const { runId } = await mkRun();
    const r = await scrubbing.reserve(scope, reserveReq(runId));
    await scrubbing.settle(scope, r.reservationId, {
      usage: { inputTokens: 1, outputTokens: 1 },
      detail: { input: { a: 1 }, output: { b: 2 } },
    });
    expect(scrub).toHaveBeenCalledTimes(2);
    const steps = (await n.req({ method: 'GET', url: `/v1/runs/${runId}/steps` })).json().items as {
      input: unknown;
      output: unknown;
    }[];
    expect(steps[0]).toMatchObject({ input: { scrubbed: true }, output: { scrubbed: true } });
  });
});

describe('expire and purge', () => {
  it('charges an overdue reservation in full, audits it, and ignores a late settlement', async () => {
    const { runId } = await mkRun();
    const r = await acc.reserve(scope, reserveReq(runId, { deadlineMs: 1000 }));
    expect(await acc.expire()).toBe(0);
    const later = new Date(Date.now() + 1000 + 60_000 + 5000);
    n.ctx.now = () => later;
    expect(await acc.expire()).toBe(1);
    expect(await acc.expire()).toBe(0);
    const [line] = await ledgerOf(runId);
    expect(line).toMatchObject({
      usageSource: 'reservation',
      costMicros: CALL,
      tokensIn: 1000,
      tokensOut: 1000,
      reservationId: r.reservationId,
    });
    expect((await acc.list(scope, { runId }))[0]).toMatchObject({
      status: 'expired',
      actualMicros: CALL,
    });
    expect(
      (await auditActions('model.reservation_expired')).find((e) => e.runId === runId)?.payload,
    ).toMatchObject({ callId: r.reservationId, reservedMicros: CALL });
    expect(await runRow(runId)).toMatchObject({ costMicros: CALL });
    const late = await acc.settle(scope, r.reservationId, {
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(late).toMatchObject({ status: 'expired', alreadyClosed: true, costMicros: CALL });
    expect(await ledgerOf(runId)).toHaveLength(1);
  });

  it('expires reservations of every tenant, each under its own lock, and survives a bad row', async () => {
    const a = await mkRun();
    const b = await mkRun();
    await acc.reserve(scope, reserveReq(a.runId, { deadlineMs: 1 }));
    await acc.reserve(scope, reserveReq(b.runId, { deadlineMs: 1 }));
    n.ctx.now = () => new Date(Date.now() + 3_600_000);
    const warn = vi.spyOn(n.ctx.logger, 'warn');
    vi.spyOn(n.services.audit, 'append').mockRejectedValueOnce(new Error('boom'));
    expect(await acc.expire()).toBe(1);
    expect(warn).toHaveBeenCalled();
    expect(await acc.expire()).toBe(1);
  });

  it('keeps the expired amount counted against budgets', async () => {
    const { runId } = await mkRun({ runBudget: '  maxCostUsd: 0.03' });
    await acc.reserve(scope, reserveReq(runId, { deadlineMs: 1 }));
    n.ctx.now = () => new Date(Date.now() + 3_600_000);
    await acc.expire();
    expect(await code(acc.reserve(scope, reserveReq(runId)))).toBe('control_budget_cost');
  });

  it('purges closed reservations after 35 days but never active ones or the ledger', async () => {
    const { runId } = await mkRun();
    const closed = await acc.reserve(scope, reserveReq(runId));
    await acc.settle(scope, closed.reservationId, { usage: { inputTokens: 1, outputTokens: 1 } });
    await acc.reserve(scope, reserveReq(runId));
    expect(await acc.purge()).toBe(0);
    n.ctx.now = () => new Date(Date.now() + 36 * 86_400_000);
    expect(await acc.purge()).toBe(1);
    expect(await acc.list(scope, { runId })).toHaveLength(1);
    expect(await ledgerOf(runId)).toHaveLength(1);
  });
});

describe('trusted recordStep path', () => {
  it('writes ledger lines with the default source and via', async () => {
    const { runId } = await mkRun();
    await n.services.control.recordStep(runId, {
      kind: 'model_call',
      agentId: 'a',
      name: 'simulated/sim-1',
      status: 'ok',
      tokensIn: 5,
      tokensOut: 6,
      costMicros: 7,
      provider: 'simulated',
      model: 'sim-1',
    });
    expect((await ledgerOf(runId))[0]).toMatchObject({
      usageSource: 'provider',
      via: 'in-process',
      reservationId: null,
      cacheReadTokens: 0,
      costMicros: 7,
    });
  });
});
