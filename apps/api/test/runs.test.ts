import { generateAuditKeyPair, type OaxError } from '@openagentix/core';
import {
  DEMO_TOOL_ACCESS,
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
import { auditLog, runs } from '../src/db/schema.js';
import { CVE_TRIAGE, JIRA_EVENT, TICKET_UPDATER, TRIVY_EVENT, example } from './fixtures.js';
import { injectFetch, testNode, testSecrets, type TestNode } from './helpers.js';

const keys = generateAuditKeyPair();
let n: TestNode;
let teamId: string;
let operator: string;
let viewerOther: string;
const store = new Map<string, Ticket>();

async function claim(runId: string, worker = 'w1') {
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: worker,
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
    })
    .where(eq(runs.id, runId));
}

async function execute(
  runId: string,
  mutate?: (prepared: Awaited<ReturnType<typeof n.services.control.prepare>>) => void,
) {
  await claim(runId);
  const prepared = await n.services.control.prepare(runId);
  mutate?.(prepared);
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

async function manualRun(agentId: string, data: unknown, token?: string): Promise<string> {
  const res = await n.req({
    method: 'POST',
    url: `/v1/agents/${agentId}/runs`,
    payload: { data },
    ...(token ? { token } : {}),
  });
  return res.json().id as string;
}

let triageId: string;
let updaterId: string;

beforeAll(async () => {
  n = await testNode({
    OAX_PRICE_TABLE: JSON.stringify([
      { provider: 'simulated', model: 'sim-1', inputPerMTok: 10, outputPerMTok: 20 },
    ]),
    OAX_AUDIT_SIGNING_KEY: keys.privateKeyPem,
    OAX_AUDIT_SIGNING_KEY_ID: 'k1',
    OAX_AUDIT_CHECKPOINT_EVERY: '10',
  });
  teamId = (
    await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-security', name: 'Security' },
    })
  ).json().id;
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  const op = (
    await n.req({
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'op@example.com', displayName: 'Op', password: 'operator-password' },
    })
  ).json().id;
  const vw = (
    await n.req({
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'ops-viewer@example.com', displayName: 'V', password: 'viewer-password-1' },
    })
  ).json().id;
  await n.req({
    method: 'PUT',
    url: `/v1/teams/${teamId}/members`,
    payload: { members: [{ userId: op, role: 'operator' }] },
  });
  const teams = (await n.req({ method: 'GET', url: '/v1/teams' })).json().items as {
    id: string;
    slug: string;
  }[];
  await n.req({
    method: 'PUT',
    url: `/v1/teams/${teams.find((t) => t.slug === 'team-ops')!.id}/members`,
    payload: { members: [{ userId: vw, role: 'viewer' }] },
  });
  operator = await n.login('op@example.com', 'operator-password');
  viewerOther = await n.login('ops-viewer@example.com', 'viewer-password-1');
  triageId = (
    await n.req({ method: 'POST', url: '/v1/agents', payload: { source: CVE_TRIAGE } })
  ).json().id;
  updaterId = (
    await n.req({ method: 'POST', url: '/v1/agents', payload: { source: TICKET_UPDATER } })
  ).json().id;
  await n.req({ method: 'POST', url: `/v1/agents/${triageId}/publish` });
  await n.req({ method: 'POST', url: `/v1/agents/${updaterId}/publish` });
});
afterAll(async () => n.close());

describe('remote worker contract (run token + policy gate over HTTP)', () => {
  it('executes the cve-triage pipeline and records steps, costs and audit', async () => {
    const runId = await manualRun(triageId, TRIVY_EVENT);
    const result = await execute(runId);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('succeeded');
    const run = (await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json();
    expect(run).toMatchObject({ status: 'succeeded', toolCalls: 2, steps: 10 });
    expect(run.costMicros).toBeGreaterThan(0);
    expect(run.outputs[0].json).toMatchObject({ severity: 'CRITICAL' });
    const steps = (await n.req({ method: 'GET', url: `/v1/runs/${runId}/steps?limit=4` })).json();
    expect(steps.items.map((s: { kind: string }) => s.kind)).toEqual([
      'model_call',
      'policy_decision',
      'tool_call',
      'model_call',
    ]);
    const rest = (
      await n.req({ method: 'GET', url: `/v1/runs/${runId}/steps?cursor=${steps.nextCursor}` })
    ).json();
    expect(rest.items).toHaveLength(6);
    expect(store.get('SEC-42')?.comments).toHaveLength(1);
    const audit = (await n.req({ method: 'GET', url: `/v1/audit?runId=${runId}&limit=200` }))
      .json()
      .items.map((e: { action: string }) => e.action);
    expect(audit).toContain('policy.decision');
    expect(audit).toContain('run.completed');
  });

  it('waits for a human approval and resumes', async () => {
    const runId = await manualRun(updaterId, JIRA_EVENT);
    const pending = execute(runId);
    let approval: { id: string } | undefined;
    for (let i = 0; i < 200 && !approval; i++) {
      approval = (await n.req({ method: 'GET', url: '/v1/approvals', token: operator })).json()
        .items[0];
      if (!approval) await new Promise((r) => setTimeout(r, 10));
    }
    expect(approval).toBeTruthy();
    expect((await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json().status).toBe(
      'awaiting_approval',
    );
    expect(
      (await n.req({ method: 'GET', url: '/v1/approvals', token: viewerOther })).json().items,
    ).toEqual([]);
    expect(
      (
        await n.req({
          method: 'POST',
          url: `/v1/approvals/${approval!.id}/decision`,
          token: viewerOther,
          payload: { decision: 'approve' },
        })
      ).statusCode,
    ).toBe(403);
    const decided = await n.req({
      method: 'POST',
      url: `/v1/approvals/${approval!.id}/decision`,
      token: operator,
      payload: { decision: 'approve', comment: 'ok' },
    });
    expect(decided.json()).toMatchObject({ status: 'approved', comment: 'ok' });
    expect(
      (
        await n.req({
          method: 'POST',
          url: `/v1/approvals/${approval!.id}/decision`,
          token: operator,
          payload: { decision: 'reject' },
        })
      ).statusCode,
    ).toBe(409);
    const result = await pending;
    expect(result.status).toBe('succeeded');
    expect(store.get('SEC-42')).toMatchObject({ status: 'triaged' });
    const history = (await n.req({ method: 'GET', url: '/v1/approvals?status=approved' })).json()
      .items;
    expect(history).toHaveLength(1);
  });

  it('rejects run tokens for other runs, expired leases and garbage', async () => {
    const runId = await manualRun(triageId, TRIVY_EVENT);
    const otherRun = await manualRun(triageId, TRIVY_EVENT);
    await claim(runId, 'w1');
    const token = n.services.control.issueToken(runId, 'w1');
    const gate = (id: string, t: string) =>
      n.req({
        method: 'POST',
        url: `/v1/worker/runs/${id}/gate`,
        token: t,
        payload: {
          agentId: 'triage',
          call: { server: 'cve-db', tool: 'lookup_cve', args: { cveId: 'CVE-2024-3094' } },
        },
      });
    expect((await gate(runId, token)).json().effect).toBe('allow');
    expect((await gate(otherRun, token)).statusCode).toBe(403);
    expect((await gate(runId, 'oaxrt.bad.token')).statusCode).toBe(401);
    expect((await gate(runId, n.services.control.issueToken(runId, 'w2'))).statusCode).toBe(409);
    expect(
      (await n.req({ method: 'GET', url: `/v1/worker/runs/${runId}/status`, token })).json(),
    ).toEqual({ cancelled: false });
    const ap = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/approvals`,
      token,
      payload: { agentId: 'triage', call: { server: 'x', tool: 'y' } },
    });
    expect(ap.statusCode).toBe(201);
    const status = await n.req({
      method: 'GET',
      url: `/v1/worker/runs/${runId}/approvals/${ap.json().approvalId}`,
      token,
    });
    expect(status.json()).toEqual({ status: 'pending' });
    expect(
      (
        await n.req({
          method: 'GET',
          url: `/v1/worker/runs/${runId}/approvals/00000000-0000-4000-8000-000000000000`,
          token,
        })
      ).statusCode,
    ).toBe(404);
    // cancelling an active run sets the flag and rejects pending approvals
    expect((await n.req({ method: 'POST', url: `/v1/runs/${runId}/cancel` })).json().status).toBe(
      'awaiting_approval',
    );
    expect(
      (await n.req({ method: 'GET', url: `/v1/worker/runs/${runId}/status`, token })).json(),
    ).toEqual({ cancelled: true });
    expect(
      (
        await n.req({
          method: 'GET',
          url: `/v1/worker/runs/${runId}/approvals/${ap.json().approvalId}`,
          token,
        })
      ).json(),
    ).toEqual({ status: 'rejected' });
    const done = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/complete`,
      token,
      payload: {
        status: 'cancelled',
        outputs: [],
        usage: { tokensIn: 0, tokensOut: 0, costMicros: 0, steps: 0, toolCalls: 0 },
        error: { code: 'cancelled', message: 'x' },
      },
    });
    expect(done.statusCode).toBe(204);
    expect((await gate(runId, token)).statusCode).toBe(409);
  });

  it('times out approvals', async () => {
    const runId = await manualRun(updaterId, JIRA_EVENT);
    await claim(runId);
    const id = await n.services.control.requestApproval(
      runId,
      'updater',
      { server: 'tickets', tool: 'update_ticket', args: {} },
      [],
    );
    const realNow = n.ctx.now;
    n.ctx.now = () => new Date(Date.now() + 2 * 3600_000);
    try {
      expect(await n.services.control.approvalStatus(runId, id)).toBe('timeout');
      const decide = await n.req({
        method: 'POST',
        url: `/v1/approvals/${id}/decision`,
        token: operator,
        payload: { decision: 'approve' },
      });
      expect(decide.statusCode).toBe(409);
    } finally {
      n.ctx.now = realNow;
    }
  });
});

describe('runs API', () => {
  it('lists runs with filters and team scoping', async () => {
    const all = (
      await n.req({ method: 'GET', url: `/v1/runs?agentId=${triageId}&limit=2` })
    ).json();
    expect(all.items).toHaveLength(2);
    expect(all.nextCursor).toBeTruthy();
    const next = (
      await n.req({
        method: 'GET',
        url: `/v1/runs?agentId=${triageId}&limit=50&cursor=${all.nextCursor}`,
      })
    ).json();
    expect(next.items.length).toBeGreaterThanOrEqual(1);
    const succeeded = (
      await n.req({ method: 'GET', url: `/v1/runs?status=succeeded&teamId=${teamId}` })
    ).json().items;
    expect(succeeded.every((r: { status: string }) => r.status === 'succeeded')).toBe(true);
    expect(
      (await n.req({ method: 'GET', url: '/v1/runs', token: viewerOther })).json().items,
    ).toEqual([]);
    const [one] = succeeded;
    expect(
      (await n.req({ method: 'GET', url: `/v1/runs/${one.id}`, token: viewerOther })).statusCode,
    ).toBe(404);
  });

  it('adds names, time filters and dashboard stats', async () => {
    const [first] = (
      await n.req({ method: 'GET', url: `/v1/runs?agentId=${triageId}&limit=1` })
    ).json().items;
    expect(first.agentName).toBe('cve-triage');
    const future = (
      await n.req({ method: 'GET', url: '/v1/runs?from=2100-01-01T00:00:00Z' })
    ).json().items;
    expect(future).toEqual([]);
    const past = (await n.req({ method: 'GET', url: '/v1/runs?to=2000-01-01T00:00:00Z' })).json()
      .items;
    expect(past).toEqual([]);
    const stats = (
      await n.req({
        method: 'GET',
        url: `/v1/stats/runs?agentId=${triageId}&from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`,
      })
    ).json();
    expect(stats.total).toBeGreaterThan(2);
    expect(stats.byStatus.succeeded).toBeGreaterThanOrEqual(1);
    expect(stats.costMicros).toBeGreaterThan(0);
    expect(stats.avgDurationMs).not.toBeNull();
    expect(
      (await n.req({ method: 'GET', url: '/v1/stats/runs', token: viewerOther })).json(),
    ).toMatchObject({ total: 0, avgDurationMs: null });
    const approved = (await n.req({ method: 'GET', url: '/v1/approvals?status=approved' })).json()
      .items[0];
    expect(approved.pipelineName).toBe('ticket-updater');
    const byRun = (
      await n.req({ method: 'GET', url: `/v1/approvals?status=approved&runId=${approved.runId}` })
    ).json().items;
    expect(byRun).toHaveLength(1);
    const none = (
      await n.req({ method: 'GET', url: `/v1/approvals?status=approved&runId=${first.id}` })
    ).json().items;
    expect(none).toEqual([]);
  });

  it('cancels queued runs and refuses to cancel finished ones', async () => {
    const runId = await manualRun(triageId, TRIVY_EVENT);
    const cancelled = await n.req({
      method: 'POST',
      url: `/v1/runs/${runId}/cancel`,
      token: operator,
    });
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });
    expect((await n.req({ method: 'POST', url: `/v1/runs/${runId}/cancel` })).statusCode).toBe(409);
  });

  it('streams steps as server-sent events', async () => {
    const [run] = (await n.req({ method: 'GET', url: '/v1/runs?status=succeeded&limit=1' })).json()
      .items;
    const res = await n.req({ method: 'GET', url: `/v1/runs/${run.id}/stream` });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: step');
    expect(res.body).toContain('event: status');
    expect(res.body).toContain('event: end');
    const st = await n.req({ method: 'POST', url: `/v1/runs/${run.id}/stream-token` });
    expect(st.statusCode).toBe(201);
    const viaQuery = await n.req({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream?access_token=${st.json().token}`,
      token: null,
    });
    expect(viaQuery.body).toContain('event: end');
    expect(
      (
        await n.req({
          method: 'GET',
          url: `/v1/runs/${run.id}/stream?access_token=oaxst.x.y`,
          token: null,
        })
      ).statusCode,
    ).toBe(401);
    const other = (await n.req({ method: 'GET', url: '/v1/runs?limit=2' }))
      .json()
      .items.find((r: { id: string }) => r.id !== run.id);
    expect(
      (
        await n.req({
          method: 'GET',
          url: `/v1/runs/${other.id}/stream?access_token=${st.json().token}`,
          token: null,
        })
      ).statusCode,
    ).toBe(403);
    const { issueStreamToken } = await import('../src/auth/stream-token.js');
    const expired = issueStreamToken('r'.repeat(40), 'u', run.id, 1, Date.now() - 10_000).token;
    expect(
      (
        await n.req({
          method: 'GET',
          url: `/v1/runs/${run.id}/stream?access_token=${expired}`,
          token: null,
        })
      ).statusCode,
    ).toBe(401);
    const resumed = await n.req({
      method: 'GET',
      url: `/v1/runs/${run.id}/stream`,
      headers: { 'last-event-id': String(run.steps - 1) },
    });
    expect(resumed.body.match(/event: step/g)).toHaveLength(1);
  });

  it('accepts a date or an ISO timestamp as period bounds and rejects garbage', async () => {
    const all = (await n.req({ method: 'GET', url: '/v1/costs/summary?groupBy=agent' })).json();
    const month = new Date().toISOString().slice(0, 7);
    const urls = [
      `from=${month}-01`, // date
      `from=${month}-17`, // any day of the month
      `from=${encodeURIComponent(`${month}-01T00:00:00.000Z`)}`, // what the UI used to send
      `from=${encodeURIComponent(new Date(Date.now() - 30 * 86_400_000).toISOString())}`, // last 30 days
      `to=${encodeURIComponent(`${month}-01T00:00:00+02:00`)}`,
    ];
    for (const q of urls) {
      const res = await n.req({ method: 'GET', url: `/v1/costs/summary?groupBy=agent&${q}` });
      expect(res.statusCode, q).toBe(200);
    }
    // 'This month' keeps the rows booked this month, 'All time' (no bound) returns everything.
    const thisMonth = (
      await n.req({
        method: 'GET',
        url: `/v1/costs/summary?groupBy=agent&from=${encodeURIComponent(`${month}-01T00:00:00.000Z`)}`,
      })
    ).json();
    expect(thisMonth.items).toEqual(all.items);
    const future = await n.req({
      method: 'GET',
      url: '/v1/costs/summary?groupBy=agent&from=2999-01-15T00:00:00Z',
    });
    expect(future.json().items).toEqual([]);
    for (const bad of ['from=yesterday', 'from=2026-13-01', 'from=2026-02-31', 'to=2026-10']) {
      expect(
        (await n.req({ method: 'GET', url: `/v1/costs/summary?${bad}` })).statusCode,
        bad,
      ).toBe(400);
    }
    const exp = await n.req({
      method: 'GET',
      url: `/v1/costs/export?format=json&from=${encodeURIComponent(`${month}-01T00:00:00.000Z`)}`,
    });
    expect(exp.statusCode).toBe(200);
  });

  it('summarises costs and enforces team budgets', async () => {
    const byAgent = (await n.req({ method: 'GET', url: '/v1/costs/summary?groupBy=agent' })).json();
    expect(byAgent.items[0]).toMatchObject({ key: triageId, label: 'cve-triage' });
    const byUseCase = (
      await n.req({ method: 'GET', url: '/v1/costs/summary?groupBy=use_case' })
    ).json();
    expect(byUseCase.items.map((i: { key: string | null }) => i.key)).toContain(
      'vulnerability-management',
    );
    const csv = await n.req({
      method: 'GET',
      url: '/v1/costs/export?from=2000-01-01&to=2100-01-01',
    });
    expect(csv.headers['content-type']).toContain('text/csv');
    const [header, first] = csv.body.split('\r\n');
    expect(header).toBe(
      'id,createdAt,month,tenantId,teamId,agentId,agentName,useCase,runId,stepSeq,provider,model,tokensIn,tokensOut,costMicros,costUsd',
    );
    expect(first).toContain('cve-triage,vulnerability-management');
    const json = (await n.req({ method: 'GET', url: '/v1/costs/export?format=json' })).json();
    expect(json.items[0]).toMatchObject({
      agentName: 'cve-triage',
      useCase: 'vulnerability-management',
      tenantId: '00000000-0000-4000-8000-000000000001',
    });
    expect(json.items[0].stepSeq).toBeGreaterThan(0);
    expect(
      (await n.req({ method: 'GET', url: '/v1/costs/export', token: viewerOther })).body
        .split('\r\n')
        .filter(Boolean),
    ).toHaveLength(1);
    const byTeam = (await n.req({ method: 'GET', url: '/v1/costs/summary?groupBy=team' })).json();
    expect(byTeam.items[0].label).toBe('team-security');
    expect(byAgent.items[0].costMicros).toBeGreaterThan(0);
    for (const g of ['run', 'team', 'month', 'provider', 'model']) {
      expect(
        (
          await n.req({
            method: 'GET',
            url: `/v1/costs/summary?groupBy=${g}&from=2020-01-01&to=2100-01-01`,
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (await n.req({ method: 'GET', url: '/v1/costs/summary', token: viewerOther })).json().items,
    ).toEqual([]);
    await n.ctx.db.execute(
      `update teams set monthly_budget_micros = 1 where slug = 'team-security'` as never,
    );
    const blocked = (
      await n.req({
        method: 'POST',
        url: `/v1/agents/${triageId}/runs`,
        payload: { data: TRIVY_EVENT },
      })
    ).json();
    expect(blocked).toMatchObject({
      status: 'blocked_by_policy',
      errorCode: 'team_budget_exceeded',
    });
  });
});

describe('audit API', () => {
  it('verifies the chain including signed checkpoints', async () => {
    const r = (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json();
    expect(r.valid).toBe(true);
    expect(r.checkedEntries).toBeGreaterThan(20);
    expect(r.checkedCheckpoints).toBeGreaterThan(0);
    const slice = (
      await n.req({ method: 'POST', url: '/v1/audit/verify', payload: { fromSeq: 5, toSeq: 12 } })
    ).json();
    expect(slice).toMatchObject({ valid: true, checkedEntries: 8 });
    const small = await n.services.audit.verify(1, undefined, 7);
    expect(small.valid).toBe(true);
  });

  it('still detects a modified entry (tamper test)', async () => {
    // The table is append-only (trigger), so simulate someone with raw storage access.
    const mutate = async (action: string) => {
      await n.ctx.db.execute(sql`set session_replication_role = replica`);
      try {
        await n.ctx.db.update(auditLog).set({ action }).where(eq(auditLog.seq, 7));
      } finally {
        await n.ctx.db.execute(sql`set session_replication_role = origin`);
      }
    };
    const [row] = await n.ctx.db.select().from(auditLog).where(eq(auditLog.seq, 7));
    await mutate('run.tampered');
    try {
      const r = (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json();
      expect(r.valid).toBe(false);
      expect(r.issues.some((i: { seq: number }) => i.seq === 7)).toBe(true);
    } finally {
      await mutate(row!.action);
    }
    expect(
      (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json().valid,
    ).toBe(true);
  });

  it('reports the real head (last sequence number and its hash) of the verified chain', async () => {
    const r = (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json();
    const last = (await n.req({ method: 'GET', url: '/v1/audit?limit=1' })).json().items[0];
    expect(r.headSeq).toBe(last.seq);
    expect(r.headSeq).toBeGreaterThan(0);
    expect(r.headHash).toBe(last.hash);
    expect(r.headHash).not.toBe('0'.repeat(64));
  });

  it('lists, filters, exports and checkpoints', async () => {
    const page = (await n.req({ method: 'GET', url: '/v1/audit?limit=5' })).json();
    expect(page.items).toHaveLength(5);
    const decisions = (
      await n.req({ method: 'GET', url: '/v1/audit?action=policy.decision' })
    ).json().items;
    expect(decisions.every((e: { action: string }) => e.action === 'policy.decision')).toBe(true);
    const nextRes = await n.req({
      method: 'GET',
      url: `/v1/audit?limit=5&cursor=${page.nextCursor}&from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`,
    });
    expect(nextRes.statusCode).toBe(200);
    const next = nextRes.json();
    expect(next.items[0].seq).toBeLessThan(page.items[4].seq);
    const exp = await n.req({ method: 'GET', url: '/v1/audit/export?action=run.completed' });
    expect(exp.headers['content-type']).toContain('application/x-ndjson');
    const lines = exp.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { action: string });
    expect(lines.every((l) => l.action === 'run.completed')).toBe(true);
    const all = await n.req({
      method: 'GET',
      url: '/v1/audit/export?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z',
    });
    expect(all.body.trim().split('\n').length).toBeGreaterThan(20);
    const cp = await n.req({ method: 'POST', url: '/v1/audit/checkpoints' });
    expect(cp.statusCode).toBe(201);
    expect(cp.json().keyId).toBe('k1');
    expect(
      (await n.req({ method: 'GET', url: '/v1/audit/checkpoints' })).json().items.length,
    ).toBeGreaterThan(1);
    let count = 0;
    for await (const _e of n.services.audit.export({ tenantId: 'all' }, 3)) count++;
    expect(count).toBeGreaterThan(20);
  });

  it('cannot checkpoint without a signing key', async () => {
    const plain = await testNode();
    expect((await plain.req({ method: 'POST', url: '/v1/audit/checkpoints' })).statusCode).toBe(
      409,
    );
    await plain.close();
  });

  it('control plane errors are typed', async () => {
    await expect(
      n.services.control.prepare('00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow(/not found/);
    await expect(
      n.services.control.recordStep('00000000-0000-4000-8000-000000000000', {
        kind: 'output',
        agentId: null,
        name: 'x',
        status: 'ok',
      }),
    ).rejects.toThrow(/not found/);
    expect(await n.services.control.isCancelled('00000000-0000-4000-8000-000000000000')).toBe(true);
    await expect(n.services.control.authorize('oaxrt.x.y', 'r')).rejects.toSatisfy(
      (e: OaxError) => e.code === 'run_token_invalid',
    );
  });
});

describe('typed handovers over the worker contract', () => {
  // Owned by team-ops: the budget test above leaves team-security without budget.
  const TRIAGE = example('ticket-triage.agents.md').replace(
    'owner: team-security',
    'owner: team-ops',
  );
  beforeAll(async () => {
    // Read-only steps need classified tools: declare the demo servers like an integrator would.
    for (const [name, tools] of Object.entries(DEMO_TOOL_ACCESS))
      await n.req({
        method: 'POST',
        url: '/v1/connections',
        payload: { name, config: { transport: 'in-memory', tools } },
      });
  });
  const publish = async (source: string): Promise<string> => {
    const id = (await n.req({ method: 'POST', url: '/v1/agents', payload: { source } })).json()
      .id as string;
    const res = await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
    expect(res.statusCode).toBeLessThan(300);
    return id;
  };
  const stepsOf = async (runId: string) =>
    (await n.req({ method: 'GET', url: `/v1/runs/${runId}/steps?limit=200` })).json().items as {
      kind: string;
      status: string;
      name: string;
    }[];
  const auditOf = async (runId: string) =>
    (await n.req({ method: 'GET', url: `/v1/audit?runId=${runId}&limit=200` })).json().items as {
      action: string;
      payload: unknown;
    }[];

  it('runs the ticket-triage example end to end', async () => {
    const id = await publish(TRIAGE);
    const runId = await manualRun(id, TRIVY_EVENT);
    const result = await execute(runId);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('succeeded');
    expect(result.outputs.map((o) => o.agentId)).toEqual(['research', 'analysis', 'action']);
    const run = (await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json();
    expect(run.status).toBe('succeeded');
  });

  it('records a skipped step and the step.skipped audit entry', async () => {
    const source = TRIAGE.replace('name: ticket-triage', 'name: ticket-triage-skip').replace(
      '["HIGH", "CRITICAL"]',
      '["CRITICAL"]',
    );
    const id = await publish(source);
    const runId = await manualRun(id, {
      ...TRIVY_EVENT,
      finding: { cveId: 'CVE-2023-44487', package: 'nghttp2', installed: '1.0' },
    });
    const result = await execute(runId);
    expect(result.status).toBe('succeeded');
    const steps = await stepsOf(runId);
    expect(steps).toContainEqual(expect.objectContaining({ kind: 'condition', status: 'skipped' }));
    const skipped = (await auditOf(runId)).find((a) => a.action === 'step.skipped');
    expect(skipped?.payload).toMatchObject({ agentId: 'action' });
  });

  it('fails with handover_invalid and audits it without the offending value', async () => {
    const source = TRIAGE.replace('name: ticket-triage', 'name: ticket-triage-bad').replace(
      'onInvalid: retry',
      'onInvalid: fail',
    );
    const id = await publish(source);
    const runId = await manualRun(id, TRIVY_EVENT);
    const result = await execute(runId, (prepared) => {
      const bad = prepared.definition.agents.find((a) => a.id === 'research')!;
      bad.simulation = { responses: [{ text: '{"severity":"SECRET-LEAK-CHECK"}' }] };
    });
    expect(result.error?.code).toBe('handover_invalid');
    const steps = await stepsOf(runId);
    expect(steps).toContainEqual(
      expect.objectContaining({ kind: 'handover', status: 'error', name: 'output' }),
    );
    const audit = await auditOf(runId);
    const entry = audit.find((a) => a.action === 'handover.invalid');
    expect(entry?.payload).toMatchObject({ agentId: 'research', direction: 'output' });
    // The model call keeps its text as before (redacted); the handover entry never has the value.
    expect(JSON.stringify(entry)).not.toContain('SECRET-LEAK-CHECK');
  });
});
