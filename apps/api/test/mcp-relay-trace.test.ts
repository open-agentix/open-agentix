import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleMockMcpHttp } from '@openagentix/mcp';
import type { OutboundDispatcher } from '@openagentix/providers';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runNodeSessions, runs } from '../src/db/schema.js';
import { resetTelemetryRuntime } from '../src/telemetry.js';
import { startTracing } from './trace-harness.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0015 S8 on the control-node relay (ADR 0016 S4): the relay opens its own `execute_tool` span
 * and offers only that span's position. Whatever the node sends (header, `params._meta`) never goes
 * upstream, and without both opt-ins nothing is added.
 */
const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
const ENV = {
  OAX_RUNNERS_ENABLED: 'in-process,container',
  OAX_CONTAINER_RUNNER_ENABLED: 'true',
  OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
  OAX_CONTAINER_IMAGE: IMAGE,
  OAX_CONTAINER_NETWORK: 'oax-nodes',
  OAX_NODE_CONTROL_URL: 'http://api:8080',
  OAX_CONTAINER_EGRESS_PROXY_URL: 'http://egress-proxy:3128',
  OAX_CONTAINER_EGRESS_GRANT_SECRET: 'g'.repeat(40),
  OAX_CONTAINER_EGRESS_ALLOW: 'jira.example.org',
};
const SOURCE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: relay-agent
version: 1.0.0
owner: team-ops
runtime:
  runner: container
  egress: [jira.example.org]
agents:
  - id: research
    provider: simulated
    model: sim-1
    instructions: Research.
    tools:
      - { server: jira, tool: get_issue, allowAdditionalArgs: true }
---
`;
const HOSTILE = `00-${'f'.repeat(32)}-${'e'.repeat(16)}-01`;
const NODE_PARENT_TRACE = '0af7651916cd43dd8448eb211c80319c';
const NODE_PARENT_SPAN = 'b7ad6b7169203331';

let t: ReturnType<typeof startTracing>;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  t = startTracing();
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  await t.stop();
  resetTelemetryRuntime();
});

interface Upstream {
  headers: Headers;
  body: string;
}

async function scenario(opts: { platform: 'allow' | 'deny' | undefined; propagate?: boolean }) {
  const upstream: Upstream[] = [];
  const http: Server = createServer((req, res) => {
    void handleMockMcpHttp(req, res, 'srv', [
      { name: 'get_issue', description: 'd', handler: () => 'ok' },
    ]);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  const local = {
    fetch: (url: string | URL, init?: RequestInit) => {
      upstream.push({ headers: new Headers(init?.headers), body: String(init?.body ?? '') });
      const u = new URL(String(url));
      return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
    },
    close: async () => undefined,
  } as unknown as OutboundDispatcher;
  const n: TestNode = await testNode(
    { ...ENV, ...(opts.platform ? { OAX_OTEL_MCP_PROPAGATION: opts.platform } : {}) },
    { mcpOutbound: local, mcpProbeLimit: 10_000 },
  );
  closers.push(async () => {
    await n.close();
    await new Promise((r) => http.close(r));
  });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  const c = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'jira',
      scope: 'platform',
      config: {
        transport: 'streamable-http',
        url: 'http://jira.example.org/mcp',
        ...(opts.propagate === undefined ? {} : { telemetry: { propagate: opts.propagate } }),
      },
    },
  });
  expect(c.statusCode, c.body).toBe(201);
  const id = c.json().id as string;
  const r = await n.req({ method: 'POST', url: `/v1/connections/${id}/tools/refresh` });
  const a = await n.req({
    method: 'POST',
    url: `/v1/connections/${id}/tool-snapshots/${r.json().snapshot.digest}/approve`,
    payload: { scope: 'new-versions' },
  });
  expect(a.statusCode, a.body).toBe(200);
  const agentId = (
    await n.req({ method: 'POST', url: '/v1/agents', payload: { source: SOURCE } })
  ).json().id as string;
  await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  const runId = (
    await n.req({ method: 'POST', url: `/v1/agents/${agentId}/runs`, payload: { data: {} } })
  ).json().id as string;
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
    })
    .where(eq(runs.id, runId));
  const session = await n.services.runNodes.createSession(runId, 'w1', {
    agentId: 'research',
    input: {},
    timeoutSeconds: 30,
    runner: 'container',
    image: IMAGE,
  });
  // The position the control node stored for this session (the dispatching step's span).
  await n.ctx.db
    .update(runNodeSessions)
    .set({ traceContext: `00-${NODE_PARENT_TRACE}-${NODE_PARENT_SPAN}-01` })
    .where(eq(runNodeSessions.runId, runId));
  upstream.length = 0;
  const res = await n.req({
    method: 'POST',
    url: `/v1/worker/runs/${runId}/mcp/jira`,
    token: session.token,
    // A compromised node sends its own context in every place it can.
    headers: { traceparent: HOSTILE, tracestate: 'a=b', baggage: 'k=v' },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_issue',
        arguments: {},
        _meta: { traceparent: HOSTILE, tracestate: 'a=b', baggage: 'k=v' },
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().result).toMatchObject({ isError: false });
  const call = upstream.find((u) => u.body.includes('"tools/call"'))!;
  return { upstream, call, spans: t.exporter.getFinishedSpans(), body: JSON.parse(call.body) };
}

const noNodeContext = (u: Upstream[]) => {
  for (const x of u) {
    for (const h of ['traceparent', 'tracestate', 'baggage'])
      expect(x.headers.get(h), `${h} header`).toBeNull();
    expect(x.body).not.toContain('ffffffff');
    expect(x.body).not.toContain('tracestate');
    expect(x.body).not.toContain('baggage');
  }
};

describe('relayed tools/call', () => {
  it.each([
    ['default: no setting, switch unset', undefined, undefined],
    ['platform allow, connection not opted in', 'allow', undefined],
    ['platform allow, connection off', 'allow', false],
    ['platform deny, connection on', 'deny', true],
    ['platform unset, connection on', undefined, true],
  ] as const)('%s: nothing is sent upstream', async (_l, platform, propagate) => {
    const s = await scenario({ platform, ...(propagate === undefined ? {} : { propagate }) });
    expect(s.body.params).toEqual({ name: 'get_issue', arguments: {} });
    noNodeContext(s.upstream);
    const span = s.spans.find((x) => x.name === 'execute_tool get_issue');
    expect(span?.attributes['oax.mcp.relay']).toBe(true);
    expect(span?.attributes['oax.mcp.propagated']).toBeUndefined();
  });

  it('both opt-ins: only the traceparent of the control-node span, never the node context', async () => {
    const s = await scenario({ platform: 'allow', propagate: true });
    const span = s.spans.find((x) => x.name === 'execute_tool get_issue')!;
    const c = span.spanContext();
    // A child of the stored session position, in the run's own trace.
    expect(c.traceId).toBe(NODE_PARENT_TRACE);
    expect(span.parentSpanContext?.spanId).toBe(NODE_PARENT_SPAN);
    expect(s.body.params).toEqual({
      name: 'get_issue',
      arguments: {},
      _meta: { traceparent: `00-${c.traceId}-${c.spanId}-01` },
    });
    noNodeContext(
      s.upstream.map((u) => ({
        ...u,
        body: u.body.replace(`00-${c.traceId}-${c.spanId}-01`, ''),
      })),
    );
    expect(span.attributes).toMatchObject({
      'oax.mcp.relay': true,
      'mcp.method.name': 'tools/call',
      'oax.mcp.propagated': true,
    });
  });
});
