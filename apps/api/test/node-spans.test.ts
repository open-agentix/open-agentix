import { randomUUID } from 'node:crypto';
import { type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { issueModelToken, parseTraceparent } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, runNodeSessions, runSteps, runs } from '../src/db/schema.js';
import {
  matchGrant,
  nodeEventOf,
  readNodeSession,
  storedParent,
} from '../src/services/node-telemetry.js';
import { configureTelemetryRuntime, resetTelemetryRuntime, withSpan } from '../src/telemetry.js';
import { RUN_TOKEN_SECRET, testNode, type TestNode } from './helpers.js';
import {
  BASE_ENV,
  FakeUpstream,
  HARNESS_ENV,
  IMAGE,
  ask,
  postModel,
  publicLookup,
  secrets,
} from './model-proxy-helpers.js';
import { attributesComply, countingStats, startTracing } from './trace-harness.js';

/**
 * Slice S4 of ADR 0015: control node spans for isolated steps and the bounded node telemetry. The
 * control node runs for real (database, model proxy, gate route, step route); only the exporter is
 * an in-memory one. Every test fails on the code before the slice (no stored context, no spans).
 */
const CANARY = 'CANARY-7f3a9c';
const ENV = {
  ...BASE_ENV,
  ...HARNESS_ENV,
  OAX_MCP_STDIO_COMMANDS: '/opt/mcp/bin/*',
  OAX_OTEL_NODE_EVENTS_MAX: '8',
};
const SOURCE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: node-span-agent
version: 1.0.0
owner: team-ops
budget: { maxTokens: 1000000, maxCostUsd: 100, maxSteps: 500, maxToolCalls: 5000, timeoutSeconds: 600 }
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Research.
    runtime: { runner: container }
    tools:
      - { server: jira, tool: get_issue }
      - { server: jira, tool: list_* }
  - id: h
    provider: claude
    model: claude-x
    instructions: Fix.
    runtime: { runner: container, harness: claude-code }
---
`;

const up = new FakeUpstream();
let n: TestNode;
let agentId: string;
let t: ReturnType<typeof startTracing> | undefined;
let stats: ReturnType<typeof countingStats>;

beforeAll(async () => {
  n = await testNode(ENV, { secrets, fetchImpl: up.fetch, hostLookup: publicLookup });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  const conn = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'jira',
      config: {
        transport: 'stdio',
        command: '/opt/mcp/bin/jira-mcp',
        tools: { get_issue: { access: 'read' }, list_issues: { access: 'read' } },
      },
    },
  });
  expect(conn.statusCode, conn.body).toBe(201);
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: SOURCE } });
  expect(created.statusCode, created.body).toBe(201);
  agentId = created.json().id;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  expect(pub.statusCode, pub.body).toBe(201);
});
afterAll(async () => n.close());
beforeEach(() => {
  up.reset();
  t = startTracing();
  stats = countingStats();
  configureTelemetryRuntime({ stats });
});
afterEach(async () => {
  await t?.stop();
  t = undefined;
  resetTelemetryRuntime();
});

const spans = (): ReadableSpan[] => t!.exporter.getFinishedSpans();
const byName = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix));
const one = (prefix: string): ReadableSpan => {
  const found = byName(prefix);
  expect(found, prefix).toHaveLength(1);
  return found[0]!;
};
const ms = (h: [number, number]) => h[0] * 1000 + h[1] / 1e6;
const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;
const everything = () =>
  JSON.stringify(
    spans().map((s) => ({
      name: s.name,
      attributes: s.attributes,
      events: s.events,
      status: s.status,
      links: s.links,
    })),
  );

interface Made {
  runId: string;
  sessionId: string;
  nodeId: string;
  token: string;
  traceId: string;
  /** Span id of the dispatching `invoke_agent` span, as the worker has it. */
  dispatchSpanId: string;
  traceparent: string | undefined;
}

/** A run with a session created the way the dispatcher does: inside the step's `invoke_agent` span. */
async function dispatch(step: 'a' | 'h' = 'a', traced = true): Promise<Made> {
  const res = await n.req({
    method: 'POST',
    url: `/v1/agents/${agentId}/runs`,
    payload: { data: { go: true } },
  });
  const runId = res.json().id as string;
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 600_000),
    })
    .where(eq(runs.id, runId));
  const [run] = await n.ctx.db.select().from(runs).where(eq(runs.id, runId));
  let dispatchSpanId = '';
  let created!: Awaited<ReturnType<TestNode['services']['runNodes']['createSession']>>;
  const create = async () => {
    created = await n.services.runNodes.createSession(runId, 'w1', {
      agentId: step,
      input: { go: true },
      timeoutSeconds: 120,
      runner: 'container',
      image: IMAGE,
    });
  };
  if (traced)
    await withSpan(
      {
        name: `invoke_agent ${step}`,
        kind: 'invoke_agent',
        parent: { traceId: run!.traceId!, spanId: run!.traceRootSpanId! },
      },
      {},
      async (span) => {
        dispatchSpanId = span.spanContext().spanId;
        await create();
      },
    );
  else await create();
  return {
    runId,
    sessionId: created.sessionId,
    nodeId: created.nodeId,
    token: created.token,
    traceId: run!.traceId!,
    dispatchSpanId,
    traceparent: created.traceparent,
  };
}

const row = async (sessionId: string) =>
  (await n.ctx.db.select().from(runNodeSessions).where(eq(runNodeSessions.id, sessionId)))[0]!;
const report = (m: Made, payload: object, headers: Record<string, string> = {}) =>
  n.req({
    method: 'POST',
    url: `/v1/worker/runs/${m.runId}/steps`,
    token: m.token,
    payload: { agentId: 'a', ...payload },
    headers,
  });
const gate = (m: Made, server: string, tool: string, headers: Record<string, string> = {}) =>
  n.req({
    method: 'POST',
    url: `/v1/worker/runs/${m.runId}/gate`,
    token: m.token,
    payload: { agentId: 'a', call: { server, tool, args: {} } },
    headers,
  });
const events = (s: ReadableSpan) => s.events.map((e) => ({ name: e.name, ...e.attributes }));

describe('stored session context (dispatch)', () => {
  it('writes the dispatching span as traceparent and creates the telemetry state', async () => {
    const m = await dispatch();
    const r = await row(m.sessionId);
    expect(r.traceContext).toBe(`00-${m.traceId}-${m.dispatchSpanId}-01`);
    expect(m.traceparent).toBe(r.traceContext);
    expect(readNodeSession(r.otelSession)).toEqual({
      runner: 'container',
      harness: null,
      dropped: 0,
      events: [],
    });
    expect(parseTraceparent(r.traceContext)).toMatchObject({ traceId: m.traceId });
  });

  it('records the harness of a harness step', async () => {
    const m = await dispatch('h');
    expect(readNodeSession((await row(m.sessionId)).otelSession)).toMatchObject({
      runner: 'container',
      harness: 'claude-code',
    });
  });

  it('changes nothing without an SDK: no context, no state, no traceparent for the node', async () => {
    await t!.stop();
    t = undefined;
    const m = await dispatch('a', false);
    const r = await row(m.sessionId);
    expect(r.traceContext).toBeNull();
    expect(r.otelSession).toBeNull();
    expect(m.traceparent).toBeUndefined();
    // reports and gate calls work as before and write nothing to the telemetry state
    expect(
      (await report(m, { kind: 'tool_call', name: 'jira/get_issue', status: 'ok' })).statusCode,
    ).toBe(204);
    expect((await gate(m, 'jira', 'get_issue')).statusCode).toBe(200);
    expect((await row(m.sessionId)).otelSession).toBeNull();
    await n.services.runNodes.revoke(m.sessionId, 'step_end');
    t = startTracing();
    expect(spans()).toEqual([]);
  });

  it('stores nothing when the active span belongs to another trace', async () => {
    const res = await n.req({
      method: 'POST',
      url: `/v1/agents/${agentId}/runs`,
      payload: { data: {} },
    });
    const runId = res.json().id as string;
    await n.ctx.db
      .update(runs)
      .set({
        status: 'running',
        lockedBy: 'w1',
        startedAt: new Date(),
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(runs.id, runId));
    let sessionId = '';
    await withSpan(
      { name: 'invoke_agent a', kind: 'invoke_agent', newTrace: true },
      {},
      async () => {
        sessionId = (
          await n.services.runNodes.createSession(runId, 'w1', {
            agentId: 'a',
            input: {},
            timeoutSeconds: 60,
            runner: 'container',
            image: IMAGE,
          })
        ).sessionId;
      },
    );
    expect((await row(sessionId)).traceContext).toBeNull();
  });
});

describe('model proxy chat span', () => {
  it('is a CLIENT child of the stored context with the proxy numbers only', async () => {
    const m = await dispatch();
    const res = await postModel(n, m.runId, m.token, ask(`prompt ${CANARY}`));
    expect(res.statusCode, res.body).toBe(200);
    const chat = one('chat');
    expect(chat.name).toBe('chat sim-1');
    expect(chat.kind).toBe(2); // CLIENT
    expect(parentOf(chat)).toBe(m.dispatchSpanId);
    expect(chat.spanContext().traceId).toBe(m.traceId);
    expect(chat.status.code).not.toBe(2);
    expect(chat.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'simulated',
      'gen_ai.request.model': 'sim-1',
      'oax.model.via': 'proxy',
      'oax.model.surface': 'native',
      'oax.reservation.result': 'reserved',
      'oax.run.id': m.runId,
    });
    expect(chat.attributes['gen_ai.usage.input_tokens']).toEqual(expect.any(Number));
    expect(chat.attributes['gen_ai.usage.output_tokens']).toEqual(expect.any(Number));
    expect(chat.attributes['oax.cost.micro_usd']).toEqual(expect.any(Number));
    expect(chat.attributes['oax.usage.source']).toBe('provider');
    expect(everything()).not.toContain(CANARY);
    expect(attributesComply(spans())).toEqual([]);
  });

  it('ends a refused call as an error span with the proxy code, without the node-chosen model', async () => {
    const m = await dispatch();
    const res = await postModel(n, m.runId, m.token, ask('x', {}, `evil-${CANARY}`));
    expect(res.statusCode).toBe(403);
    const chat = one('chat');
    expect(chat.name).toBe('chat sim-1');
    expect(chat.status.code).toBe(2);
    expect(chat.attributes['error.type']).toBe('model_not_allowed');
    expect(parentOf(chat)).toBe(m.dispatchSpanId);
    expect(everything()).not.toContain(CANARY);
  });

  it('creates no span for a session without a stored context', async () => {
    await t!.stop();
    t = undefined;
    const m = await dispatch('a', false);
    expect((await postModel(n, m.runId, m.token, ask())).statusCode).toBe(200);
    t = startTracing();
    expect(spans()).toEqual([]);
  });

  it('the pass-through surface of a harness produces the same span with oax.model.surface', async () => {
    const m = await dispatch();
    // The harness step cannot carry a simulation: the harness token is minted for the native step.
    const { token, claims } = issueModelToken(
      RUN_TOKEN_SECRET,
      {
        runId: m.runId,
        sid: m.sessionId,
        nodeId: m.nodeId,
        agentId: 'a',
        surface: 'harness',
        harness: 'claude-code',
        ttlSeconds: 60,
        notAfterMs: Date.now() + 60_000,
      },
      Date.now(),
    );
    expect(await n.services.runNodes.recordModelToken(m.sessionId, claims.jti)).toBe(true);
    const res = await n.req({
      method: 'POST',
      url: '/v1/model-proxy/anthropic/v1/messages',
      token,
      payload: { model: 'sim-1', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const chat = one('chat');
    expect(chat.attributes['oax.model.surface']).toBe('anthropic');
    expect(parentOf(chat)).toBe(m.dispatchSpanId);
  });
});

describe('gate policy check for nodes', () => {
  it('wraps the control decision in oax.policy.check under the stored context', async () => {
    const m = await dispatch();
    const res = await gate(m, 'jira', 'get_issue');
    expect(res.statusCode, res.body).toBe(200);
    const check = one('oax.policy.check');
    expect(check.name).toBe('oax.policy.check jira/get_issue');
    expect(parentOf(check)).toBe(m.dispatchSpanId);
    expect(check.attributes).toMatchObject({
      'gen_ai.tool.name': 'get_issue',
      'oax.mcp.server': 'jira',
      'oax.policy.effect': res.json().effect,
      'oax.run.id': m.runId,
    });
  });

  it('labels a call that no grant covers _unknown and exports none of the node text', async () => {
    const m = await dispatch();
    const res = await gate(m, 'jira', `delete_${CANARY}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().effect).toBe('deny');
    const check = one('oax.policy.check');
    expect(check.name).toBe('oax.policy.check _unknown');
    expect(check.attributes['gen_ai.tool.name']).toBeUndefined();
    expect(check.attributes['oax.mcp.server']).toBeUndefined();
    expect(check.attributes['oax.policy.effect']).toBe('deny');
    const other = await gate(m, `srv-${CANARY.toLowerCase()}`, 'get_issue');
    expect(other.statusCode).toBe(200);
    expect(everything().toLowerCase()).not.toContain(CANARY.toLowerCase());
  });

  it('exports the grant, not the node text, for a wildcard grant', async () => {
    const m = await dispatch();
    await gate(m, 'jira', `list_${CANARY}`);
    const check = one('oax.policy.check');
    expect(check.name).toBe('oax.policy.check jira/list_*');
    expect(check.attributes['gen_ai.tool.name']).toBe('list_*');
    expect(everything()).not.toContain(CANARY);
  });
});

describe('oax.node.session span and bounded node events', () => {
  it('turns accepted reports into claims on the session span, stamped at receipt', async () => {
    const m = await dispatch();
    const created = await row(m.sessionId);
    expect(
      (await report(m, { kind: 'tool_call', name: 'jira/get_issue', status: 'ok', durationMs: 42 }))
        .statusCode,
    ).toBe(204);
    expect(
      (await report(m, { kind: 'tool_call', name: `jira/nuke_${CANARY}`, status: 'error' }))
        .statusCode,
    ).toBe(204);
    expect(
      (await report(m, { kind: 'output', name: 'result', status: 'ok', output: { text: CANARY } }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await report(m, {
          kind: 'error',
          name: `code-${CANARY}`,
          status: 'error',
          output: { message: `boom ${CANARY}`, code: CANARY },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await report(m, {
          kind: 'control',
          name: 'input_guard',
          status: 'ok',
          output: {
            source: 'tool_result',
            invisible: { total: 3 },
            secrets: { total: 1, kinds: { 'known-secret': 1, 'Not A Kind': 4 } },
          },
        })
      ).statusCode,
    ).toBe(204);
    // reports the control node ignores do not become events either
    expect(
      (await report(m, { kind: 'policy_decision', name: 'jira/get_issue', status: 'ok' }))
        .statusCode,
    ).toBe(204);
    // before the session ends, no span exists
    expect(byName('oax.node.session')).toHaveLength(0);
    await n.services.runNodes.revoke(m.sessionId, 'step_end');
    const ended = await row(m.sessionId);
    const span = one('oax.node.session');
    expect(parentOf(span)).toBe(m.dispatchSpanId);
    expect(span.kind).toBe(0); // INTERNAL
    expect(span.attributes).toMatchObject({
      'oax.node.runner': 'container',
      'oax.node.revoke_reason': 'step_end',
      'oax.node.events_dropped': 0,
      'oax.run.id': m.runId,
    });
    // times come from the control node's clock: creation and revocation
    expect(ms(span.startTime)).toBe(created.createdAt.getTime());
    expect(ms(span.endTime)).toBeCloseTo(ended.revokedAt!.getTime(), 0);
    expect(events(span)).toEqual([
      {
        name: 'oax.node.tool_call',
        'oax.claim': 'node',
        'oax.claimed.status': 'ok',
        'oax.claimed.duration_ms': 42,
        'gen_ai.tool.name': 'get_issue',
        'oax.mcp.server': 'jira',
      },
      { name: 'oax.node.tool_call', 'oax.claim': 'node', 'oax.claimed.status': 'error' },
      { name: 'oax.node.output', 'oax.claim': 'node', 'oax.claimed.status': 'ok' },
      { name: 'oax.node.error', 'oax.claim': 'node', 'oax.claimed.status': 'error' },
      {
        name: 'oax.node.guard',
        'oax.claim': 'node',
        'oax.claimed.status': 'ok',
        'oax.guard.source': 'tool_result',
        'oax.guard.invisible': 3,
        'oax.guard.secrets': 1,
        'oax.guard.secret_kinds': ['known-secret'],
      },
    ]);
    for (const e of span.events) {
      expect(ms(e.time)).toBeGreaterThanOrEqual(created.createdAt.getTime());
      expect(ms(e.time)).toBeLessThanOrEqual(ended.revokedAt!.getTime() + 1);
    }
    expect(everything()).not.toContain(CANARY);
    expect(attributesComply(spans())).toEqual([]);
  });

  it('a harness session carries oax.node.harness', async () => {
    const m = await dispatch('h');
    await n.services.runNodes.revoke(m.sessionId, 'timeout');
    expect(one('oax.node.session').attributes).toMatchObject({
      'oax.node.harness': 'claude-code',
      'oax.node.revoke_reason': 'timeout',
    });
  });

  it('emits the span once, whichever path ends the session', async () => {
    const m = await dispatch();
    await n.services.runNodes.revoke(m.sessionId, 'step_end');
    await n.services.runNodes.revoke(m.sessionId, 'cancelled');
    await n.services.runNodes.revokeRun(m.runId, 'run_completed');
    expect(byName('oax.node.session')).toHaveLength(1);
  });

  it('golden: an isolated step has chat, policy check and session spans under invoke_agent', async () => {
    const m = await dispatch();
    await postModel(n, m.runId, m.token, ask());
    await gate(m, 'jira', 'get_issue');
    await report(m, { kind: 'tool_call', name: 'jira/get_issue', status: 'ok' });
    await n.services.runNodes.revoke(m.sessionId, 'step_end');
    // the dispatching span is the parent of everything the control node made for the session
    const agent = one('invoke_agent');
    const children = spans().filter((s) => parentOf(s) === agent.spanContext().spanId);
    // (the HTTP server spans of the requests are separate traces of their own)
    const inRun = spans().filter((s) => s.spanContext().traceId === m.traceId);
    expect(children.map((s) => s.name).sort()).toEqual([
      'chat sim-1',
      'oax.node.session',
      'oax.policy.check jira/get_issue',
    ]);
    expect(inRun.map((s) => s.name).sort()).toEqual([
      'chat sim-1',
      'invoke_agent a',
      'oax.node.session',
      'oax.policy.check jira/get_issue',
      'oax.run.admit',
    ]);
  });
});

describe('node threat tests', () => {
  it('ignores a forged traceparent, counts the mismatch and parents nothing from it', async () => {
    const m = await dispatch();
    const forged = `00-${'ab'.repeat(16)}-${'cd'.repeat(8)}-01`;
    expect((await gate(m, 'jira', 'get_issue', { traceparent: forged })).statusCode).toBe(200);
    expect(stats.node.mismatch).toBe(1);
    expect(
      (await report(m, { kind: 'output', name: 'x', status: 'ok' }, { traceparent: forged }))
        .statusCode,
    ).toBe(204);
    expect((await postModel(n, m.runId, m.token, ask(), { traceparent: forged })).statusCode).toBe(
      200,
    );
    expect(stats.node.mismatch).toBe(3);
    // garbage counts too; the stored context itself is not a mismatch
    await gate(m, 'jira', 'get_issue', { traceparent: 'not-a-traceparent' });
    expect(stats.node.mismatch).toBe(4);
    await gate(m, 'jira', 'get_issue', { traceparent: m.traceparent! });
    expect(stats.node.mismatch).toBe(4);
    await n.services.runNodes.revoke(m.sessionId, 'step_end');
    for (const s of spans()) {
      expect(s.spanContext().traceId).not.toBe('ab'.repeat(16));
      expect(s.parentSpanContext?.spanId).not.toBe('cd'.repeat(8));
      expect(JSON.stringify(s.links)).not.toContain('cdcdcdcd');
    }
    expect(byName('oax.policy.check').every((s) => parentOf(s) === m.dispatchSpanId)).toBe(true);
    expect(one('chat').spanContext().traceId).toBe(m.traceId);
    // the stored context never changed
    expect((await row(m.sessionId)).traceContext).toBe(m.traceparent);
  });

  it('a flood of 10 000 reports is capped, counted, and the span says how many were dropped', async () => {
    const m = await dispatch();
    const cap = n.ctx.config.otel.nodeEventsMax;
    expect(cap).toBe(8);
    for (let i = 0; i < 10_000; i++)
      await n.services.runNodes.noteReport(m.sessionId, 'a', {
        kind: 'tool_call',
        name: 'jira/get_issue',
        status: 'ok',
        durationMs: i,
      });
    const stored = readNodeSession((await row(m.sessionId)).otelSession)!;
    expect(stored.events).toHaveLength(cap);
    expect(stored.dropped).toBe(10_000 - cap);
    expect(stats.node.eventsDropped).toBe(10_000 - cap);
    await n.services.runNodes.revoke(m.sessionId, 'step_end');
    const span = one('oax.node.session');
    expect(span.events).toHaveLength(cap);
    expect(span.attributes['oax.node.events_dropped']).toBe(10_000 - cap);
  }, 180_000);

  it('the same flood through the HTTP route keeps rows and audit as before and the cap holds', async () => {
    const m = await dispatch();
    for (let i = 0; i < 25; i++)
      expect(
        (await report(m, { kind: 'tool_call', name: 'jira/get_issue', status: 'ok' })).statusCode,
      ).toBe(204);
    const stored = readNodeSession((await row(m.sessionId)).otelSession)!;
    expect(stored.events).toHaveLength(8);
    expect(stored.dropped).toBe(17);
    // the ordinary records are unaffected by the telemetry cap
    expect(await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, m.runId))).toHaveLength(
      25,
    );
    const audits = (await n.ctx.db.select().from(auditLog)).filter(
      (a) => a.runId === m.runId && a.action === 'step.tool_call',
    );
    expect(audits).toHaveLength(25);
  });

  it('an ungranted tool name is never exported; a granted one is exported as the grant', async () => {
    const m = await dispatch();
    await report(m, { kind: 'tool_call', name: `jira/${CANARY}`, status: 'ok' });
    await report(m, { kind: 'tool_call', name: `other-server/get_issue`, status: 'ok' });
    await report(m, { kind: 'tool_call', name: 'jira/list_anything', status: 'ok' });
    await n.services.runNodes.revoke(m.sessionId, 'step_end');
    const evs = events(one('oax.node.session'));
    expect(evs[0]).not.toHaveProperty('gen_ai.tool.name');
    expect(evs[1]).not.toHaveProperty('gen_ai.tool.name');
    expect(evs[2]).toMatchObject({ 'gen_ai.tool.name': 'list_*', 'oax.mcp.server': 'jira' });
    expect(everything()).not.toContain(CANARY);
  });

  it('caps an absurd claimed duration and leaves the span times alone', async () => {
    const m = await dispatch();
    const created = await row(m.sessionId);
    // the report schema allows one day; the platform clamps to one hour on the attribute
    expect(
      (
        await report(m, {
          kind: 'tool_call',
          name: 'jira/get_issue',
          status: 'ok',
          durationMs: 86_400_000,
        })
      ).statusCode,
    ).toBe(204);
    // ten days is refused by the schema, and clamped by the event builder if it ever got through
    expect(
      (
        await report(m, {
          kind: 'tool_call',
          name: 'jira/get_issue',
          status: 'ok',
          durationMs: 864_000_000,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      nodeEventOf(
        { kind: 'tool_call', name: 'jira/get_issue', status: 'ok', durationMs: 864_000_000 },
        [],
        1,
      )?.d,
    ).toBe(86_400_000);
    expect(
      nodeEventOf({ kind: 'output', name: 'x', status: 'ok', durationMs: Number.NaN }, [], 1),
    ).not.toHaveProperty('d');
    expect(
      nodeEventOf({ kind: 'output', name: 'x', status: 'ok', durationMs: -5 }, [], 1),
    ).not.toHaveProperty('d');
    await n.services.runNodes.revoke(m.sessionId, 'step_end');
    const span = one('oax.node.session');
    expect(events(span)[0]).toMatchObject({ 'oax.claimed.duration_ms': 3_600_000 });
    expect(ms(span.startTime)).toBe(created.createdAt.getTime());
    expect(ms(span.endTime) - ms(span.startTime)).toBeLessThan(60_000);
  });

  it('still refuses a model call report and keeps it out of the events', async () => {
    const m = await dispatch();
    const res = await report(m, {
      kind: 'model_call',
      name: 'sim-1',
      status: 'ok',
      tokensIn: 10,
      tokensOut: 10,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('step_kind_refused');
    expect(readNodeSession((await row(m.sessionId)).otelSession)!.events).toEqual([]);
  });

  it('cannot create a span: reports, gate calls and model calls of a node make only the spans of the control node', async () => {
    const m = await dispatch();
    await report(m, {
      kind: 'tool_call',
      name: `jira/${CANARY}`,
      status: 'ok',
      output: { text: CANARY },
    });
    await gate(m, 'jira', 'get_issue');
    await postModel(n, m.runId, m.token, ask(CANARY));
    await n.services.runNodes.revoke(m.sessionId, 'step_end');
    expect(
      spans()
        .filter((s) => s.spanContext().traceId === m.traceId)
        .map((s) => s.name.split(' ')[0])
        .sort(),
    ).toEqual(['chat', 'invoke_agent', 'oax.node.session', 'oax.policy.check', 'oax.run.admit']);
    expect(everything()).not.toContain(CANARY);
  });
});

describe('unit: what a stored report may carry', () => {
  it('matchGrant returns the grant strings only', () => {
    const grants = [
      { server: 'jira', tool: 'get_issue' },
      { server: 'jira', tool: 'list_*' },
      { server: 'x', tool: '*' },
    ];
    expect(matchGrant(grants, 'jira', 'get_issue')).toEqual({ server: 'jira', tool: 'get_issue' });
    expect(matchGrant(grants, 'jira', 'list_things')).toEqual({ server: 'jira', tool: 'list_*' });
    expect(matchGrant(grants, 'x', 'anything')).toEqual({ server: 'x', tool: '*' });
    expect(matchGrant(grants, 'jira', 'get_issue2')).toBeNull();
    expect(matchGrant(grants, 'jira2', 'get_issue')).toBeNull();
    expect(matchGrant(grants, 'jira', 'x'.repeat(200))).toBeNull();
    expect(matchGrant(undefined, 'jira', 'get_issue')).toBeNull();
    expect(
      matchGrant([{ server: 'jira', tool: { $ne: 1 } }, null, 3], 'jira', 'get_issue'),
    ).toBeNull();
  });

  it('nodeEventOf keeps fixed sets and numbers only', () => {
    const ev = nodeEventOf(
      {
        kind: 'control',
        name: 'input_guard',
        status: 'ok',
        output: {
          source: `evil-${CANARY}`,
          invisible: { total: 'many' },
          secrets: { total: 2, kinds: { 'Bad Kind With Spaces': 1, github_token: 1 } },
        },
      },
      [],
      5,
    );
    expect(ev).toEqual({ k: 'guard', t: 5, s: 'ok', sec: 2, kinds: ['github_token'] });
    expect(
      nodeEventOf({ kind: 'tool_call', name: 'a/b', status: `weird-${CANARY}` }, [], 1),
    ).toEqual({ k: 'tool_call', t: 1 });
    expect(nodeEventOf({ kind: 'model_call', name: 'a', status: 'ok' }, [], 1)).toBeNull();
    expect(nodeEventOf({ kind: 'control', name: 'kill', status: 'ok' }, [], 1)).toBeNull();
  });

  it('storedParent rejects malformed and all-zero contexts', () => {
    expect(storedParent(null)).toBeNull();
    expect(storedParent('garbage')).toBeNull();
    expect(storedParent(`00-${'0'.repeat(32)}-${'a'.repeat(16)}-01`)).toBeNull();
    expect(storedParent(`00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`)).toBeNull();
    expect(storedParent(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`)).toEqual({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
  });

  it('the database refuses a malformed telemetry state', async () => {
    const m = await dispatch();
    const update = (v: unknown) =>
      n.ctx.db
        .update(runNodeSessions)
        .set({ otelSession: v })
        .where(eq(runNodeSessions.id, m.sessionId));
    await expect(update([])).rejects.toThrow();
    await expect(update({ events: 'x', dropped: 0 })).rejects.toThrow();
    await expect(
      update({ events: Array.from({ length: 1001 }, () => ({})), dropped: 0 }),
    ).rejects.toThrow();
    await expect(update({ events: [], dropped: 'many' })).rejects.toThrow();
    await update({ events: [], dropped: 0 });
    expect(randomUUID()).toBeTruthy();
  });
});
