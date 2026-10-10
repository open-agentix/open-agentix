import { eq } from 'drizzle-orm';
import { schema } from '@openagentix/api';
import type { RunnerKind } from '@openagentix/core';
import { demoServerFactories, inMemoryServers } from '@openagentix/mcp';
import type {
  IsolatingRunner,
  RunNodeExit,
  RunNodeHandle,
  RunNodeSpec,
} from '@openagentix/runners';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTelemetryRuntime } from '../../api/src/telemetry.js';
import { attributesComply, startTracing } from '../../api/test/trace-harness.js';
import { injectFetch, testNode, type TestNode } from '../../api/test/helpers.js';
import { Worker, runNode } from '../src/index.js';

/**
 * Slice S4 of ADR 0015, end to end: the real worker, executor, dispatcher, control node and run node
 * code (in this process instead of a container). Checks the golden span tree of an isolated step and
 * that the node gets `TRACEPARENT` for log correlation only.
 */
const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
const ENV = {
  OAX_RUNNERS_ENABLED: 'in-process,container',
  OAX_MODEL_PROXY_ENABLED: 'true',
  OAX_CONTAINER_RUNNER_ENABLED: 'true',
  OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
  OAX_CONTAINER_IMAGE: IMAGE,
  OAX_CONTAINER_NETWORK: 'oax-nodes',
  OAX_NODE_CONTROL_URL: 'http://api:8080',
  OAX_WORKER_POLL_MS: '20',
  OAX_CONTAINER_EGRESS_PROXY_URL: 'http://egress-proxy:3128',
  OAX_CONTAINER_EGRESS_GRANT_SECRET: 'g'.repeat(40),
  OAX_CONTAINER_EGRESS_ALLOW: 'jira.example.com',
};
const SOURCE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: node-spans-e2e
version: 1.0.0
owner: team-ops
runtime:
  runner: in-process
  egress: [jira.example.com]
agents:
  - id: action
    provider: simulated
    model: sim-1
    instructions: Act.
    runtime: { runner: container, egress: [jira.example.com] }
    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-2021-44228 } }]
        - text: done
---
`;

/** Runs the real run node code in this process, with the environment a runner would give it. */
class InProcessNodeRunner implements IsolatingRunner {
  readonly kind: RunnerKind = 'container';
  readonly specs: RunNodeSpec[] = [];
  readonly logs: string[] = [];
  constructor(private readonly n: TestNode) {}
  imageFor(): string {
    return IMAGE;
  }
  async execute(): Promise<never> {
    throw new Error('not used');
  }
  async startNode(spec: RunNodeSpec): Promise<RunNodeHandle> {
    this.specs.push(spec);
    const done = runNode({
      env: {
        OAX_CONTROL_URL: spec.controlUrl,
        OAX_RUN_ID: spec.runId,
        OAX_NODE_ID: spec.nodeId,
        OAX_STEP_IDS: spec.steps.join(','),
        OAX_RUN_TOKEN_FILE: '/run/oax/token',
        // what the container runner puts into the environment
        ...(spec.traceparent ? { TRACEPARENT: spec.traceparent } : {}),
      },
      readFile: async () => spec.runToken,
      fetchImpl: injectFetch(this.n.app),
      inMemoryMcp: inMemoryServers(demoServerFactories()),
      log: (line) => void this.logs.push(line),
    });
    return {
      nodeId: spec.nodeId,
      wait: async (): Promise<RunNodeExit> => ({ exitCode: await done }),
      stop: async () => undefined,
    };
  }
}

let n: TestNode;
let t: ReturnType<typeof startTracing> | undefined;
let agentId: string;

beforeAll(async () => {
  n = await testNode(ENV);
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: { name: 'cve-db', config: { transport: 'in-memory' } },
  });
  const a = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: SOURCE } });
  expect(a.statusCode, a.body).toBe(201);
  agentId = a.json().id;
  const p = await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  expect(p.statusCode, p.body).toBe(201);
});
afterAll(async () => n.close());
beforeEach(() => {
  t = startTracing();
});
afterEach(async () => {
  await t?.stop();
  t = undefined;
  resetTelemetryRuntime();
});

async function go(runner: InProcessNodeRunner) {
  const worker = new Worker(n.ctx, {
    inMemoryMcp: inMemoryServers(demoServerFactories()),
    isolation: {
      runners: { container: runner as IsolatingRunner & { imageFor(): string } },
      controlUrl: 'http://api:8080',
      limits: { cpus: 1, memoryMb: 256, pids: 64 },
      cancelPollMs: 20,
    },
  });
  const res = await n.req({
    method: 'POST',
    url: `/v1/agents/${agentId}/runs`,
    payload: { data: { go: true } },
  });
  const runId = res.json().id as string;
  worker.start();
  const end = Date.now() + 15_000;
  let run: Record<string, unknown> | undefined;
  while (Date.now() < end) {
    const r = (await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json();
    if (['succeeded', 'failed', 'cancelled', 'blocked_by_policy'].includes(r.status)) {
      run = r;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await worker.stop();
  const [session] = await n.ctx.db
    .select()
    .from(schema.runNodeSessions)
    .where(eq(schema.runNodeSessions.runId, runId));
  return { run: run!, runId, session: session! };
}

describe('isolated step, end to end', () => {
  it('golden tree: the control node spans hang under the dispatching invoke_agent span', async () => {
    const runner = new InProcessNodeRunner(n);
    const { run, session } = await go(runner);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    const all = t!.exporter.getFinishedSpans();
    const inRun = all.filter((s) => s.spanContext().traceId === run.traceId);
    const agent = inRun.find((s) => s.name === 'invoke_agent action')!;
    expect(agent).toBeDefined();
    const kids = inRun
      .filter((s) => s.parentSpanContext?.spanId === agent.spanContext().spanId)
      .map((s) => s.name)
      .sort();
    expect(kids).toEqual([
      'chat sim-1',
      'chat sim-1',
      'oax.node.session',
      'oax.policy.check cve-db/lookup_cve',
    ]);
    // the stored context is the dispatching span, and the node got exactly that value
    expect(session.traceContext).toBe(`00-${run.traceId}-${agent.spanContext().spanId}-01`);
    expect(runner.specs).toHaveLength(1);
    expect(runner.specs[0]!.traceparent).toBe(session.traceContext);
    // the node's claims are events of the session span, never spans of their own
    const node = inRun.find((s) => s.name === 'oax.node.session')!;
    expect(node.events.map((e) => e.name)).toContain('oax.node.tool_call');
    expect(node.events.find((e) => e.name === 'oax.node.tool_call')!.attributes).toMatchObject({
      'oax.claim': 'node',
      'gen_ai.tool.name': 'lookup_cve',
      'oax.mcp.server': 'cve-db',
    });
    expect(node.attributes).toMatchObject({
      'oax.node.runner': 'container',
      'oax.node.revoke_reason': 'step_end',
      'oax.node.events_dropped': 0,
    });
    expect(attributesComply(all)).toEqual([]);
    // the run tree continues to hold: workflow -> handover/agent
    expect(inRun.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'oax.run.admit',
        'invoke_workflow node-spans-e2e',
        'oax.handover action',
      ]),
    );
  });

  it('without an SDK nothing is stored and the node gets no TRACEPARENT', async () => {
    await t!.stop();
    t = undefined;
    const runner = new InProcessNodeRunner(n);
    const { run, session } = await go(runner);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(session.traceContext).toBeNull();
    expect(session.otelSession).toBeNull();
    expect(runner.specs[0]!.traceparent).toBeUndefined();
  });
});
