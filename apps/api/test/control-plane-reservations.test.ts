import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, costLedger, modelReservations, runSteps, runs } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';

/** In-process model calls reserve and settle through the control plane (ADR 0009 section 4.4). */
let n: TestNode;
let counter = 0;

function source(name: string, budget = ''): string {
  return `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: 1.0.0
owner: team-ops
${budget ? `budget:\n${budget}\n` : ''}agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Summarise the event.
---
`;
}

async function mkRun(budget = ''): Promise<string> {
  const id = (
    await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: source(`res-agent-${++counter}`, budget) },
    })
  ).json().id as string;
  expect((await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` })).statusCode).toBe(201);
  const run = (
    await n.req({ method: 'POST', url: `/v1/agents/${id}/runs`, payload: { data: { x: 1 } } })
  ).json();
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 600_000),
    })
    .where(eq(runs.id, run.id));
  return run.id as string;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};
const runRow = async (id: string) =>
  (await n.ctx.db.select().from(runs).where(eq(runs.id, id)))[0]!;
const reservations = (runId: string) =>
  n.ctx.db.select().from(modelReservations).where(eq(modelReservations.runId, runId));

beforeAll(async () => {
  n = await testNode({
    OAX_PRICE_TABLE: JSON.stringify([
      { provider: 'simulated', model: 'sim-1', inputPerMTok: 10, outputPerMTok: 20 },
    ]),
  });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
});
afterAll(async () => n.close());
afterEach(async () => {
  await n.ctx.db.execute(sql`delete from model_reservations`);
  await n.ctx.db.execute(sql`delete from cost_ledger`);
});

describe('ControlPlaneService.reserveModelCall and settlement', () => {
  it('reserves, then settles the reservation with a cost the control node computes itself', async () => {
    const runId = await mkRun();
    const cp = n.services.control;
    const grant = await cp.reserveModelCall(runId, {
      agentId: 'a',
      inputTokens: 1000,
      maxOutputTokens: 1000,
    });
    // 1000 in + 1000 out at 10 / 20 USD per MTok
    expect(grant).toMatchObject({ maxOutputTokens: 1000, reservedMicros: 30_000, priced: true });
    expect((await reservations(runId))[0]).toMatchObject({ status: 'active', sessionId: null });

    // The executor's own cost number is ignored: the ledger uses the catalog price.
    await cp.recordStep(runId, {
      kind: 'model_call',
      agentId: 'a',
      name: 'simulated/sim-1',
      status: 'ok',
      input: { messages: 1 },
      output: { text: 'hi' },
      tokensIn: 100,
      tokensOut: 50,
      costMicros: 999_999,
      durationMs: 12,
      reservationId: grant.reservationId,
    });
    // 10 and 20 USD per million tokens are 10 and 20 micro-USD per token: 100 * 10 + 50 * 20
    const run = await runRow(runId);
    expect(run).toMatchObject({ tokensIn: 100, tokensOut: 50 });
    expect(Number(run.costMicros)).toBe(2000);
    const [line] = await n.ctx.db.select().from(costLedger).where(eq(costLedger.runId, runId));
    expect(line).toMatchObject({
      reservationId: grant.reservationId,
      via: 'in-process',
      usageSource: 'provider',
    });
    expect((await reservations(runId))[0]).toMatchObject({ status: 'settled' });
    const steps = await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(steps.filter((s) => s.kind === 'model_call')).toHaveLength(1);
    expect(steps[0]).toMatchObject({ output: { text: 'hi' }, durationMs: 12 });
  });

  it('gives the reservation back at zero when the call failed on its own', async () => {
    const runId = await mkRun();
    const cp = n.services.control;
    const grant = await cp.reserveModelCall(runId, {
      agentId: 'a',
      inputTokens: 500,
      maxOutputTokens: 500,
    });
    await cp.recordStep(runId, {
      kind: 'error',
      agentId: 'a',
      name: 'model_call',
      status: 'error',
      output: { message: 'upstream 500' },
      reservationId: grant.reservationId,
    });
    expect((await reservations(runId))[0]).toMatchObject({ status: 'settled', actualMicros: 0 });
    const [step] = await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(step).toMatchObject({ kind: 'model_call', status: 'error', costMicros: 0 });
    expect(Number((await runRow(runId)).costMicros)).toBe(0);
  });

  it('settles a closed reservation only once', async () => {
    const runId = await mkRun();
    const cp = n.services.control;
    const grant = await cp.reserveModelCall(runId, {
      agentId: 'a',
      inputTokens: 10,
      maxOutputTokens: 10,
    });
    const step = {
      kind: 'model_call' as const,
      agentId: 'a',
      name: 'x',
      status: 'ok' as const,
      tokensIn: 10,
      tokensOut: 10,
      reservationId: grant.reservationId,
    };
    await cp.recordStep(runId, step);
    // a second report cannot double count: the reservation is no longer open
    expect(await code(cp.recordStep(runId, step))).toBe('not_found');
    expect((await runRow(runId)).tokensIn).toBe(10);
  });

  it('returns the call deadline the reservation was sized for', async () => {
    const runId = await mkRun();
    const grant = await n.services.control.reserveModelCall(runId, {
      agentId: 'a',
      inputTokens: 10,
      maxOutputTokens: 10,
    });
    expect(grant.deadlineMs).toBe(n.ctx.config.modelProxy.maxCallSeconds * 1000);
  });

  it('books a correction instead of failing when the reservation already expired', async () => {
    const runId = await mkRun();
    const cp = n.services.control;
    const grant = await cp.reserveModelCall(runId, {
      agentId: 'a',
      inputTokens: 10,
      maxOutputTokens: 10,
    });
    await n.ctx.db
      .update(modelReservations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(modelReservations.id, grant.reservationId));
    expect(await n.services.modelAccounting.expire()).toBe(1);
    await cp.recordStep(runId, {
      kind: 'model_call',
      agentId: 'a',
      name: 'x',
      status: 'ok',
      tokensIn: 7,
      tokensOut: 8,
      reservationId: grant.reservationId,
    });
    const audit = await n.ctx.db.select().from(auditLog).where(eq(auditLog.runId, runId));
    const late = audit.find((a) => a.action === 'model.late_settlement');
    expect(late?.payload).toMatchObject({
      callId: grant.reservationId,
      reportedTokensIn: 7,
      reportedTokensOut: 8,
    });
    // the conservative amount booked at expiry is not booked a second time
    expect((await reservations(runId))[0]).toMatchObject({ status: 'expired' });
    const steps = await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(steps.filter((s) => s.kind === 'model_call')).toHaveLength(1);
  });

  it('settles only reservations of an in-process call of the same agent', async () => {
    const runId = await mkRun();
    const cp = n.services.control;
    const grant = await cp.reserveModelCall(runId, {
      agentId: 'a',
      inputTokens: 10,
      maxOutputTokens: 10,
    });
    const step = {
      kind: 'model_call' as const,
      name: 'x',
      status: 'ok' as const,
      tokensIn: 1,
      tokensOut: 1,
      reservationId: grant.reservationId,
    };
    // another agent of the run
    expect(await code(cp.recordStep(runId, { ...step, agentId: 'other' }))).toBe('not_found');
    // a reservation of a proxied run node session belongs to the proxy
    await n.ctx.db
      .update(modelReservations)
      .set({ sessionId: '8a1b7d6e-1d0e-4b2a-9d7c-3a5f6f6f6f6f' })
      .where(eq(modelReservations.id, grant.reservationId));
    expect(await code(cp.recordStep(runId, { ...step, agentId: 'a' }))).toBe('not_found');
    expect((await reservations(runId))[0]).toMatchObject({ status: 'active' });
  });

  it('does not let a run settle the reservation of another run', async () => {
    const [a, b] = [await mkRun(), await mkRun()];
    const grant = await n.services.control.reserveModelCall(a, {
      agentId: 'a',
      inputTokens: 10,
      maxOutputTokens: 10,
    });
    expect(
      await code(
        n.services.control.recordStep(b, {
          kind: 'model_call',
          agentId: 'a',
          name: 'x',
          status: 'ok',
          tokensIn: 1,
          tokensOut: 1,
          reservationId: grant.reservationId,
        }),
      ),
    ).toBe('not_found');
    expect((await reservations(a))[0]).toMatchObject({ status: 'active' });
    expect((await runRow(b)).tokensIn).toBe(0);
  });

  it('refuses a reservation the run budget cannot cover, with the budget code', async () => {
    // 0.00001 USD = 10 micro-USD; one call of 1000 + 1000 tokens costs 30 000 micro-USD
    const runId = await mkRun('  maxCostUsd: 0.00001');
    expect(
      await code(
        n.services.control.reserveModelCall(runId, {
          agentId: 'a',
          inputTokens: 1000,
          maxOutputTokens: 1000,
        }),
      ),
    ).toBe('control_budget_cost');
    expect(await reservations(runId)).toHaveLength(0);
  });

  it('shrinks the output to what the budget allows when a floor is given', async () => {
    // 0.02 USD = 20 000 micro-USD: 1000 input tokens cost 10 000, leaving 10 000 for output at 20
    // micro-USD per token = 500 tokens; asking for 20 000 must shrink instead of refusing.
    const runId = await mkRun('  maxCostUsd: 0.02');
    const grant = await n.services.control.reserveModelCall(runId, {
      agentId: 'a',
      inputTokens: 1000,
      maxOutputTokens: 20_000,
      minOutputTokens: 256,
    });
    expect(grant.maxOutputTokens).toBe(500);
    expect(grant.remaining.costMicros).toBeDefined();
  });

  it('works without the accounting service by failing closed', async () => {
    const { ControlPlaneService } = await import('../src/services/control-plane.js');
    const s = n.services;
    const bare = new ControlPlaneService(
      n.ctx,
      s.audit,
      s.agents,
      s.catalog,
      s.budgets,
      s.runNodes,
    );
    const runId = await mkRun();
    const req = { agentId: 'a', inputTokens: 1, maxOutputTokens: 1 };
    expect(await code(bare.reserveModelCall(runId, req))).toBe('model_proxy_unavailable');
    expect(
      await code(
        bare.recordStep(runId, {
          kind: 'model_call',
          agentId: 'a',
          name: 'x',
          status: 'ok',
          reservationId: '8a1b7d6e-1d0e-4b2a-9d7c-3a5f6f6f6f6f',
        }),
      ),
    ).toBe('model_proxy_unavailable');
  });

  it('refuses a reservation for an unknown run', async () => {
    expect(
      await code(
        n.services.control.reserveModelCall('00000000-0000-4000-8000-000000000000', {
          agentId: 'a',
          inputTokens: 1,
          maxOutputTokens: 1,
        }),
      ),
    ).toBe('not_found');
  });

  it('reports the ledger counters of a run', async () => {
    const runId = await mkRun();
    expect(await n.services.control.runUsage(runId)).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      costMicros: 0,
    });
    await n.services.control.recordStep(runId, {
      kind: 'model_call',
      agentId: 'a',
      name: 'x',
      status: 'ok',
      tokensIn: 5,
      tokensOut: 6,
      costMicros: 7,
    });
    expect(await n.services.control.runUsage(runId)).toEqual({
      tokensIn: 5,
      tokensOut: 6,
      costMicros: 7,
    });
    expect(await code(n.services.control.runUsage('00000000-0000-4000-8000-000000000000'))).toBe(
      'not_found',
    );
  });

  it('refuses a model_call that a run node reports (the model proxy records them)', async () => {
    const runId = await mkRun();
    expect(
      await code(
        n.services.control.recordStep(
          runId,
          { kind: 'model_call', agentId: 'a', name: 'x', status: 'ok', tokensIn: 1 },
          { id: 'node-1' },
        ),
      ),
    ).toBe('step_kind_refused');
    expect((await runRow(runId)).tokensIn).toBe(0);
  });

  it('ignores a reservation id sent by a run node', async () => {
    const runId = await mkRun();
    const grant = await n.services.control.reserveModelCall(runId, {
      agentId: 'a',
      inputTokens: 10,
      maxOutputTokens: 10,
    });
    await n.services.control.recordStep(
      runId,
      {
        kind: 'error',
        agentId: 'a',
        name: 'x',
        status: 'error',
        reservationId: grant.reservationId,
      },
      { id: 'node-1' },
    );
    expect((await reservations(runId))[0]).toMatchObject({ status: 'active' });
  });
});

describe('POST /v1/worker/runs/{id}/model-reservations', () => {
  const post = (runId: string, token: string | undefined, payload: unknown) =>
    n.app.inject({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/model-reservations`,
      payload: payload as object,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
    });
  const body = { agentId: 'a', inputTokens: 1000, maxOutputTokens: 1000, minOutputTokens: 16 };

  it('grants a reservation to the orchestrator even while the proxy flag is off', async () => {
    expect(n.ctx.config.modelProxy.enabled).toBe(false);
    const runId = await mkRun();
    const res = await post(runId, n.services.control.issueToken(runId, 'w1'), body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      maxOutputTokens: 1000,
      reservedMicros: 30_000,
      priced: true,
    });
  });

  it('answers a refusal in the model envelope with the stable code', async () => {
    const runId = await mkRun('  maxCostUsd: 0.00001');
    const res = await post(runId, n.services.control.issueToken(runId, 'w1'), body);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: { code: 'control_budget_cost', message: expect.any(String) },
    });
  });

  it('requires a valid orchestrator token of this run', async () => {
    const [a, b] = [await mkRun(), await mkRun()];
    expect((await post(a, undefined, body)).statusCode).toBe(401);
    expect((await post(a, 'oaxrt.x.y', body)).statusCode).toBe(401);
    // a token of another run is not valid here
    expect((await post(a, n.services.control.issueToken(b, 'w1'), body)).statusCode).toBe(403);
    // another worker than the lease holder
    const other = await post(a, n.services.control.issueToken(a, 'w2'), body);
    expect(other.statusCode).toBe(403);
    expect(other.json().error.code).toBe('run_node_session_revoked');
  });

  it('rejects unknown fields and bad numbers', async () => {
    const runId = await mkRun();
    const t = n.services.control.issueToken(runId, 'w1');
    expect((await post(runId, t, { ...body, provider: 'x' })).statusCode).toBe(400);
    expect((await post(runId, t, { ...body, maxOutputTokens: 0 })).statusCode).toBe(400);
  });

  it('is available on the worker contract through forToken', async () => {
    const runId = await mkRun();
    const cp = n.services.control.forToken(n.services.control.issueToken(runId, 'w1'));
    expect(await cp.reserveModelCall?.(runId, body)).toMatchObject({ priced: true });
  });
});
