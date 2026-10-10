import { randomBytes } from 'node:crypto';
import { StaticSecretResolver } from '@openagentix/core';
import { signWebhook } from '@openagentix/events';
import { demoServerFactories, inMemoryServers, type Ticket } from '@openagentix/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CVE_TRIAGE,
  JIRA_EVENT,
  TICKET_UPDATER,
  TRIVY_EVENT,
  agentSource,
} from '../../api/test/fixtures.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { Worker } from '../src/index.js';

/**
 * ADR 0015 section 12, "cardinality tests": tenants choose names (tenant, team? no: connection,
 * event source, agent, model). None of them may reach a Prometheus label, the number of series
 * must not grow with the number of tenants, and every label value must belong to a closed set.
 */
const PW = 'long-password-123';
const PHASE_A = 4;
const PHASE_B = 12;

const rand = () => randomBytes(4).toString('hex');
const secrets = new StaticSecretResolver({
  'trivy-hook': 'hook-secret-1',
  ...Object.fromEntries(
    Array.from({ length: PHASE_A + PHASE_B }, (_, i) => [`tn${i}.openai`, `sk-tenant-${i}`]),
  ),
});
const fakeFetch = async () =>
  new Response(
    JSON.stringify({
      model: 'gpt-4.1-mini',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const PROVIDERS = [
  'anthropic',
  'aws.bedrock',
  'azure.ai.openai',
  'openai',
  'openrouter',
  'ollama',
  'lmstudio',
  'vllm',
  'simulated',
  'other',
  'tool',
];
const slug = /^[a-z][a-z0-9_]{0,40}$/;
const oneOf = (...v: string[]) => new Set(v);

/** Closed value sets (or shapes) per metric and label; a new `oax_` metric must be declared here. */
const ALLOWED: Record<string, Record<string, Set<string> | RegExp>> = {
  http_request_duration_seconds: {
    method: /^[A-Z]{3,7}$/,
    route: /^[\w/:.*{}-]*$/,
    status: /^\d{3}$/,
  },
  events_ingested_total: {
    kind: oneOf('webhook', 'mail', 'kafka', 'cron', 'other'),
    outcome: slug,
  },
  runs_created_total: {
    trigger: oneOf('manual', 'webhook', 'mail', 'kafka', 'cron', 'demo', 'other'),
  },
  runs_refused_total: {
    trigger: oneOf('manual', 'webhook', 'mail', 'kafka', 'cron', 'demo', 'other'),
    reason: slug,
  },
  runs_finished_total: { status: oneOf('succeeded', 'failed', 'cancelled', 'blocked_by_policy') },
  policy_decisions_total: { effect: oneOf('allow', 'deny', 'require_approval') },
  runs_by_status: { status: /^[a-z_]+$/ },
  cost_micro_usd_total: { provider: new Set(PROVIDERS) },
  worker_active_runs: { worker: /^[\w.-]{1,64}$/ },
  run_duration_seconds: {
    status: oneOf('succeeded', 'failed', 'cancelled', 'blocked_by_policy'),
    trigger: oneOf('manual', 'webhook', 'mail', 'kafka', 'cron', 'demo', 'other'),
  },
  step_duration_seconds: {
    runner: oneOf(
      'in-process',
      'local',
      'container',
      'kubernetes-job',
      'aws-lambda',
      'github-actions',
      'gitlab-ci',
    ),
    status: oneOf('ok', 'error'),
  },
  tool_calls_total: {
    decision: oneOf('allow', 'deny', 'require_approval'),
    result: oneOf('ok', 'error', 'not_executed'),
  },
  approvals_total: { outcome: oneOf('approved', 'rejected', 'timeout', 'cancelled') },
  approval_wait_seconds: { outcome: oneOf('approved', 'rejected', 'timeout', 'cancelled') },
  tokens_total: {
    direction: oneOf('input', 'output', 'cache_read', 'cache_write'),
    provider: new Set(PROVIDERS),
    via: oneOf('in-process', 'proxy'),
  },
  budget_exhausted_total: {
    scope: oneOf('run', 'step', 'team', 'use_case', 'tenant'),
    limit: oneOf('tokens', 'usd', 'steps', 'tool_calls', 'timeout'),
  },
  guard_replacements_total: {
    source: oneOf('input', 'tool_result', 'tool_error'),
    class: oneOf('secret', 'invisible'),
  },
  node_reports_total: { kind: /^[a-z_]+$/, result: oneOf('accepted', 'refused', 'dropped') },
  model_proxy_requests_total: {
    surface: /^[a-z_-]+$/,
    provider: /^[a-z0-9.-]+$/,
    code: /^[a-z0-9_]+$/,
  },
  model_proxy_tokens_total: {
    direction: oneOf('input', 'output', 'cache_read', 'cache_write'),
    source: slug,
  },
  model_proxy_duration_seconds: { phase: oneOf('ttfb', 'total') },
  model_proxy_aborts_total: { reason: slug },
  model_proxy_reserved_micros: {},
  model_proxy_reservations_active: {},
  model_proxy_streams_active: {},
  otel_spans_dropped_total: {},
  otel_export_failures_total: { reason: oneOf('timeout', 'network', 'http', 'other') },
  otel_attributes_dropped_total: {
    key_class: oneOf('unknown', 'content', 'wrong_span', 'invalid', 'overflow'),
  },
  otel_redactions_total: { kind: /^[a-z0-9_-]+$/ },
  otel_inbound_context_total: { result: oneOf('ignored', 'linked', 'invalid') },
  otel_node_events_dropped_total: {},
  otel_node_context_mismatch_total: {},
  role_bindings_shadow_total: { outcome: slug, authoritative: oneOf('legacy', 'bindings') },
  authz_epoch_rejected_total: { reason: oneOf('stale', 'invalid') },
  mcp_stdio_violations: {},
  mcp_stdio_refused_total: { code: slug },
  role_bindings_reconcile_fixes_total: { kind: slug, trigger: slug },
  role_bindings_reconcile_runs_total: { trigger: slug, outcome: slug },
};
const RUNTIME_PREFIXES = ['oax_process_', 'oax_nodejs_'];

let n: TestNode;
let worker: Worker;
const tickets = new Map<string, Ticket>();
const canaries: string[] = [];

const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

interface Series {
  metric: string;
  labels: Record<string, string>;
}

/** Every series of the registry (histogram buckets are folded into their metric). */
async function series(): Promise<Series[]> {
  const out: Series[] = [];
  for (const m of await n.ctx.metrics.registry.getMetricsAsJSON()) {
    if (RUNTIME_PREFIXES.some((p) => m.name.startsWith(p))) continue;
    for (const v of m.values) {
      const { le: _le, quantile: _q, ...labels } = v.labels as Record<string, string>;
      out.push({ metric: m.name, labels });
    }
  }
  return out;
}

const keys = (all: Series[]) =>
  new Set(all.map((s) => `${s.metric}|${JSON.stringify(Object.entries(s.labels).sort())}`));

/** One tenant with random names for everything it may choose: a BYOK connection, an agent. */
async function tenantRun(i: number, extra = ''): Promise<void> {
  const name = `Tenant ${rand()} "${rand()}" <x>`;
  canaries.push(name);
  const tenantId = (
    await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: {
        slug: `tn${i}`,
        name,
        admin: { email: `a@tn${i}.example.org`, displayName: name, password: PW },
      },
    })
  ).json().id as string;
  expect(tenantId).toBeTruthy();
  const token = await n.login(`a@tn${i}.example.org`, PW);
  const as = (opts: Parameters<TestNode['req']>[0]) => n.req({ ...opts, token });
  await as({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-security', name: 'S' } });
  const connection = `conn-${rand()}`;
  const agentName = `agent-${rand()}`;
  canaries.push(connection, agentName);
  expect(
    (
      await as({
        method: 'POST',
        url: '/v1/connections',
        payload: {
          name: connection,
          kind: 'model',
          config: {
            kind: 'openai',
            apiKeySecret: `tn${i}.openai`,
            models: [{ id: 'gpt-4.1-mini' }],
          },
        },
      })
    ).statusCode,
  ).toBe(201);
  const source = agentSource(agentName, 'team-security', '1.0.0', extra)
    .replace('provider: simulated', `provider: ${connection}`)
    .replace('model: sim-1', 'model: gpt-4.1-mini');
  const agent = (await as({ method: 'POST', url: '/v1/agents', payload: { source } })).json()
    .id as string;
  await as({ method: 'POST', url: `/v1/agents/${agent}/publish` });
  await as({ method: 'POST', url: `/v1/agents/${agent}/runs`, payload: { data: {} } });
  await worker.tick();
  await worker.drain();
}

beforeAll(async () => {
  n = await testNode(
    { OAX_WORKER_POLL_MS: '20', OAX_RATE_LIMIT_LOGIN_MAX: '1000' },
    { secrets, fetchImpl: fakeFetch },
  );
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
  for (const c of ['cve-db', 'tickets'])
    await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: { name: c, config: { transport: 'in-memory' } },
    });
  await n.req({
    method: 'POST',
    url: '/v1/policies',
    payload: { name: 'baseline', bundle: { forbiddenTools: ['*/delete_*'] } },
  });
  worker = new Worker(n.ctx, {
    workerId: 'card',
    inMemoryMcp: inMemoryServers(demoServerFactories(tickets)),
  });
});
afterAll(async () => {
  await worker.stop(true);
  await n.close();
});

async function webhookRun(
  agentSource: string,
  sourceName: string,
  event: unknown,
  delivery: string,
) {
  const agent = (
    await n.req({ method: 'POST', url: '/v1/agents', payload: { source: agentSource } })
  ).json();
  await n.req({ method: 'POST', url: `/v1/agents/${agent.id}/publish` });
  const src = (
    await n.req({
      method: 'POST',
      url: '/v1/event-sources',
      payload: { name: sourceName, kind: 'webhook', secretRefs: ['trivy-hook'], agentId: agent.id },
    })
  ).json();
  const body = JSON.stringify(event);
  const res = await n.req({
    method: 'POST',
    url: `/v1/ingest/webhook/${src.id}`,
    token: null,
    payload: body,
    headers: {
      'content-type': 'application/json',
      ...signWebhook('hook-secret-1', body, Math.floor(Date.now() / 1000), delivery),
    },
  });
  expect(res.statusCode).toBe(202);
  await worker.tick();
  return res.json().runId as string;
}

describe('metric labels are tenant-safe', () => {
  it('counts tool calls, approvals, guard hits and kinds for runs of the default tenant', async () => {
    const hook = `hook-${rand()}`;
    canaries.push(hook);
    const triage = await webhookRun(CVE_TRIAGE, hook, TRIVY_EVENT, 'card-1');
    await worker.drain();
    expect((await n.req({ method: 'GET', url: `/v1/runs/${triage}` })).json().status).toBe(
      'succeeded',
    );
    const updaterHook = `jira-${rand()}`;
    canaries.push(updaterHook);
    const runId = await webhookRun(TICKET_UPDATER, updaterHook, JIRA_EVENT, 'card-2');
    const approval = await waitFor(
      async () =>
        (await n.req({ method: 'GET', url: '/v1/approvals' })).json().items[0] as
          { id: string } | undefined,
    );
    await n.req({
      method: 'POST',
      url: `/v1/approvals/${approval.id}/decision`,
      payload: { decision: 'approve' },
    });
    await worker.drain();
    expect((await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json().status).toBe(
      'succeeded',
    );
    // A bad signature counts as a refused event under its source kind.
    const sources = (await n.req({ method: 'GET', url: '/v1/event-sources' })).json().items as {
      id: string;
    }[];
    await n.req({
      method: 'POST',
      url: `/v1/ingest/webhook/${sources[0]!.id}`,
      token: null,
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    // Guard hits and the reports of an untrusted run node, through the trusted fact path.
    const guardStep = {
      kind: 'control',
      agentId: 'a',
      name: 'input_guard',
      status: 'ok',
      output: {
        source: 'tool_result',
        secrets: { total: 2, kinds: {} },
        invisible: { total: 1, classes: {} },
      },
    } as const;
    await n.services.control.recordStep(triage, guardStep);
    await n.services.control.recordStep(
      triage,
      { ...guardStep, output: { source: `Acme ${rand()}`, secrets: { total: 1 } } },
      { id: 'node-1' },
    );
    await n.services.control.recordStep(
      triage,
      { kind: 'policy_decision', agentId: 'a', name: 'x/y', status: 'ok' },
      { id: 'node-1' },
    );
    await n.services.control.recordStep(
      triage,
      { kind: 'tool_call', agentId: 'a', name: 'x/y', status: 'error' },
      { id: 'node-1' },
    );
    await expect(
      n.services.control.recordStep(
        triage,
        { kind: 'model_call', agentId: 'a', name: 'x/y', status: 'ok' },
        { id: 'node-1' },
      ),
    ).rejects.toMatchObject({ code: 'step_kind_refused' });
    const text = await n.ctx.metrics.registry.metrics();
    expect(text).toContain('oax_guard_replacements_total{source="tool_result",class="secret"} 2');
    expect(text).toContain(
      'oax_guard_replacements_total{source="tool_result",class="invisible"} 1',
    );
    expect(text).toContain('oax_guard_replacements_total{source="input",class="secret"} 1');
    expect(text).toContain('oax_node_reports_total{kind="control",result="accepted"} 1');
    expect(text).toContain('oax_node_reports_total{kind="policy_decision",result="dropped"} 1');
    expect(text).toContain('oax_node_reports_total{kind="tool_call",result="accepted"} 1');
    expect(text).toContain('oax_node_reports_total{kind="model_call",result="refused"} 1');
    expect(text).toContain('oax_tool_calls_total{decision="allow",result="error"} 1');
    expect(text).toMatch(/oax_tool_calls_total\{decision="allow",result="ok"\} [1-9]/);
    expect(text).toMatch(/oax_approvals_total\{outcome="approved"\} 1/);
    expect(text).toMatch(/oax_approval_wait_seconds_count\{outcome="approved"\} 1/);
    expect(text).toMatch(
      /oax_run_duration_seconds_count\{status="succeeded",trigger="webhook"\} 2/,
    );
    expect(text).toMatch(
      /oax_step_duration_seconds_count\{runner="in-process",status="ok"\} [1-9]/,
    );
    expect(text).toMatch(/oax_events_ingested_total\{kind="webhook",outcome="accepted"\} 2/);
    expect(text).toMatch(
      /oax_tokens_total\{direction="input",provider="simulated",via="in-process"\} [1-9]/,
    );
  });

  it('keeps the series set constant while tenants and their names multiply', async () => {
    for (let i = 0; i < PHASE_A; i++) await tenantRun(i);
    // One run per tenant stops at a tiny run budget (control_budget_cost on the reservation).
    await tenantRun(PHASE_A, 'budget:\n  maxCostUsd: 0.000001');
    const first = await series();
    const firstKeys = keys(first);
    for (let i = PHASE_A + 1; i < PHASE_A + PHASE_B; i++) await tenantRun(i);
    const second = await series();
    // Same families, same label values: new tenants, connections, agents and sources add nothing.
    expect([...keys(second)].filter((k) => !firstKeys.has(k))).toEqual([]);
    expect(second.length).toBe(first.length);
    const text = await n.ctx.metrics.registry.metrics();
    expect(text).toMatch(/oax_cost_micro_usd_total\{provider="openai"\} [1-9]/);
    expect(text).toMatch(/oax_budget_exhausted_total\{scope="run",limit="usd"\} [1-9]/);
  });

  it('puts every label value in a closed set and no tenant-chosen text anywhere', async () => {
    const all = await series();
    const problems: string[] = [];
    for (const s of all) {
      const rules = ALLOWED[s.metric.replace(/^oax_/, '')];
      if (!rules) {
        problems.push(`metric ${s.metric} has no entry in ALLOWED`);
        continue;
      }
      for (const [label, value] of Object.entries(s.labels)) {
        const rule = rules[label];
        const ok = rule instanceof RegExp ? rule.test(value) : rule?.has(value);
        if (!ok) problems.push(`${s.metric}{${label}="${value}"} is outside its closed set`);
      }
    }
    expect(problems).toEqual([]);
    const text = await n.ctx.metrics.registry.metrics();
    for (const c of canaries) expect(text).not.toContain(c);
    // Nothing that looks like a UUID (tenant, run or token ids) either.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
