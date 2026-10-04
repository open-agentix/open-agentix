import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelReservations, runs, DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { ACCOUNTING_LOCK_NS, ModelAccountingService } from '../src/services/model-accounting.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * The same guarantees on a real PostgreSQL with several connections (PGlite runs one transaction at
 * a time, so it cannot show lock contention). Opt in with OAX_TEST_DATABASE_URL, for example
 * `postgres://postgres:test@127.0.0.1:55432/postgres` of a throwaway container.
 */
const URL = process.env.OAX_TEST_DATABASE_URL;
const CALL = 30_000;

describe.skipIf(!URL)('model accounting on PostgreSQL', () => {
  let n: TestNode;
  let acc: ModelAccountingService;
  let runId: string;

  beforeAll(async () => {
    n = await testNode({
      OAX_DATABASE_URL: URL!,
      OAX_PRICE_TABLE: JSON.stringify([
        { provider: 'simulated', model: 'sim-1', inputPerMTok: 10, outputPerMTok: 20 },
      ]),
    });
    await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-security', name: 'S' },
    });
    const source = `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: pg-agent
version: 1.0.0
owner: team-security
budget:
  maxCostUsd: 0.3
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: x
---
`;
    const id = (await n.req({ method: 'POST', url: '/v1/agents', payload: { source } })).json().id;
    await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
    runId = (
      await n.req({ method: 'POST', url: `/v1/agents/${id}/runs`, payload: { data: { x: 1 } } })
    ).json().id;
    await n.ctx.db
      .update(runs)
      .set({ status: 'running', lockedBy: 'w1' })
      .where(eq(runs.id, runId));
    acc = new ModelAccountingService(
      n.ctx,
      n.services.audit,
      n.services.agents,
      n.services.budgets,
      undefined,
      {
        maxConcurrentPerSession: 1000,
        maxConcurrentPerTenant: 1000,
        graceMs: 1000,
        defaultDeadlineMs: 1000,
      },
    );
  });
  afterAll(async () => n.close());

  const req = { runId: '', agentId: 'a', inputTokens: 1000, maxOutputTokens: 1000 };

  it('50 parallel reservations against a budget for 10 grant exactly 10', async () => {
    const rs = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        acc.reserve({ tenantId: DEFAULT_TENANT_ID }, { ...req, runId }),
      ),
    );
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const rows = await n.ctx.db
      .select()
      .from(modelReservations)
      .where(eq(modelReservations.runId, runId));
    expect(rows.reduce((a, r) => a + Number(r.reservedMicros), 0)).toBe(10 * CALL);
  });

  it('a held lock of one tenant blocks that tenant only', async () => {
    const other = '00000000-0000-4000-8000-0000000000aa';
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = n.ctx.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${ACCOUNTING_LOCK_NS}::int, hashtext(${DEFAULT_TENANT_ID}))`,
      );
      locked();
      await held;
    });
    await isLocked;
    let done = false;
    const blocked = acc
      .list({ tenantId: DEFAULT_TENANT_ID })
      .then(() =>
        acc
          .settle({ tenantId: DEFAULT_TENANT_ID }, '00000000-0000-4000-8000-0000000000bb')
          .catch(() => undefined),
      )
      .then(() => (done = true));
    // Another tenant's lock is free: its reservation attempt is answered (not_found) at once.
    await acc.reserve({ tenantId: other }, { ...req, runId }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await holder;
    await blocked;
    expect(done).toBe(true);
  });
});
