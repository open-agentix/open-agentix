import { signWebhook } from '@openagentix/events';
import { demoServerFactories, inMemoryServers, type Ticket } from '@openagentix/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CVE_TRIAGE, JIRA_EVENT, TICKET_UPDATER, TRIVY_EVENT } from '../../api/test/fixtures.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { Worker } from '../src/index.js';

/**
 * End to end: signed webhooks -> events -> queued runs -> worker (simulated provider + mock MCP
 * servers) -> policy gate -> human approval -> succeeded, with audit chain and costs.
 */
let n: TestNode;
let worker: Worker;
let operator: string;
const tickets = new Map<string, Ticket>();

const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  n = await testNode({
    OAX_WORKER_POLL_MS: '20',
    OAX_PRICE_TABLE: JSON.stringify([
      {
        provider: 'simulated',
        model: 'sim-1',
        inputPerMTok: 3,
        outputPerMTok: 15,
        perToolCallUsd: 0.0001,
      },
    ]),
  });
  const team = (
    await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-security', name: 'Security', monthlyBudgetUsd: 100 },
    })
  ).json();
  const op = (
    await n.req({
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'oncall@example.com', displayName: 'On-call', password: 'oncall-password' },
    })
  ).json();
  await n.req({
    method: 'PUT',
    url: `/v1/teams/${team.id}/members`,
    payload: { members: [{ userId: op.id, role: 'operator' }] },
  });
  operator = await n.login('oncall@example.com', 'oncall-password');
  for (const name of ['cve-db', 'tickets'])
    await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: { name, config: { transport: 'in-memory' } },
    });
  await n.req({
    method: 'POST',
    url: '/v1/policies',
    payload: { name: 'baseline', bundle: { forbiddenTools: ['*/delete_*'] } },
  });
  for (const [source, name] of [
    [CVE_TRIAGE, 'trivy'],
    [TICKET_UPDATER, 'jira'],
  ] as const) {
    const agent = (await n.req({ method: 'POST', url: '/v1/agents', payload: { source } })).json();
    expect(
      (await n.req({ method: 'POST', url: `/v1/agents/${agent.id}/publish` })).statusCode,
    ).toBe(201);
    await n.req({
      method: 'POST',
      url: '/v1/event-sources',
      payload: { name, kind: 'webhook', secretRefs: ['trivy-hook'], agentId: agent.id },
    });
  }
  worker = new Worker(n.ctx, {
    workerId: 'e2e',
    inMemoryMcp: inMemoryServers(demoServerFactories(tickets)),
  });
  worker.start();
});
afterAll(async () => {
  await worker.stop(true);
  await n.close();
});

async function sendWebhook(
  sourceName: string,
  payload: unknown,
  delivery: string,
): Promise<string> {
  const sources = (await n.req({ method: 'GET', url: '/v1/event-sources' })).json().items as {
    id: string;
    name: string;
  }[];
  const body = JSON.stringify(payload);
  const res = await n.req({
    method: 'POST',
    url: `/v1/ingest/webhook/${sources.find((s) => s.name === sourceName)!.id}`,
    token: null,
    payload: body,
    headers: {
      'content-type': 'application/json',
      ...signWebhook('hook-secret-1', body, Math.floor(Date.now() / 1000), delivery),
    },
  });
  expect(res.statusCode).toBe(202);
  return res.json().runId as string;
}

const runOf = (id: string) => n.req({ method: 'GET', url: `/v1/runs/${id}` }).then((r) => r.json());

describe('end to end', () => {
  it('cve-triage: webhook -> triage -> ticket comment', async () => {
    const runId = await sendWebhook('trivy', TRIVY_EVENT, 'trivy-1');
    const run = await waitFor(async () => {
      const r = await runOf(runId);
      return ['succeeded', 'failed', 'blocked_by_policy'].includes(r.status) ? r : undefined;
    });
    expect(run).toMatchObject({ status: 'succeeded', toolCalls: 2 });
    expect(run.costMicros).toBeGreaterThan(0);
    expect(run.outputs[1].content).toContain('CVE-2024-3094: CRITICAL');
    expect(tickets.get('SEC-42')?.comments[0]).toContain('Fixed in 5.6.2');
  });

  it('ticket-updater: webhook -> approval -> update', async () => {
    const runId = await sendWebhook('jira', JIRA_EVENT, 'jira-1');
    const approval = await waitFor(
      async () =>
        (await n.req({ method: 'GET', url: '/v1/approvals', token: operator })).json().items[0] as
          { id: string; tool: string } | undefined,
    );
    expect(approval.tool).toBe('tickets/update_ticket');
    expect(tickets.get('SEC-42')?.status).toBe('open');
    await n.req({
      method: 'POST',
      url: `/v1/approvals/${approval.id}/decision`,
      token: operator,
      payload: { decision: 'approve' },
    });
    const run = await waitFor(async () => {
      const r = await runOf(runId);
      return r.status === 'succeeded' || r.status === 'failed' ? r : undefined;
    });
    expect(run.status).toBe('succeeded');
    expect(tickets.get('SEC-42')).toMatchObject({
      status: 'triaged',
      labels: ['security', 'critical'],
    });
    const steps = (await n.req({ method: 'GET', url: `/v1/runs/${runId}/steps` }))
      .json()
      .items.map((s: { kind: string; status: string }) => `${s.kind}:${s.status}`);
    expect(steps).toContain('policy_decision:pending');
    expect(steps).toContain('approval:approved');
  });

  it('keeps an intact audit trail and cost ledger', async () => {
    const verify = (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json();
    expect(verify.valid).toBe(true);
    const costs = (await n.req({ method: 'GET', url: '/v1/costs/summary?groupBy=team' })).json()
      .items;
    expect(costs[0].costMicros).toBeGreaterThan(0);
    const metrics = await n.ctx.metrics.registry.metrics();
    expect(metrics).toContain('oax_runs_finished_total{status="succeeded"}');
  });
});
