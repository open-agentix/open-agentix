import { eq } from 'drizzle-orm';
import { schema } from '@openagentix/api';
import { OaxError, type RunnerKind } from '@openagentix/core';
import { demoServerFactories, inMemoryServers } from '@openagentix/mcp';
import type {
  IsolatingRunner,
  RunNodeExit,
  RunNodeHandle,
  RunNodeSpec,
  RunNodeStopReason,
} from '@openagentix/runners';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { injectFetch, testNode, type TestNode } from '../../api/test/helpers.js';
import { NodeDispatcher, Worker, runNode } from '../src/index.js';

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
  OAX_CONTAINER_EGRESS_ALLOW: 'jira.example.com,crm.example.com',
};
/** The default tenant starts without any secret; these tests need one. */
const allowSecrets = (node: TestNode) =>
  node.req({ method: 'GET', url: '/v1/tenants' }).then((r) =>
    node.req({
      method: 'PATCH',
      url: `/v1/tenants/${r.json().items[0].id}`,
      payload: { secretRefs: ['mail-hook'] },
    }),
  );

const source = (name: string, action: string) => `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: ${name}
version: 1.0.0
owner: team-ops
runtime:
  runner: in-process
  egress: [jira.example.com, crm.example.com]
schemas:
  Out: { type: object, required: [ok], properties: { ok: { type: boolean } } }
agents:
  - id: research
    provider: simulated
    model: sim-1
    instructions: Research.
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Out" } }
    simulation: { responses: [{ text: '{"ok":true}' }] }
  - id: action
    provider: simulated
    model: sim-1
    instructions: Act.
    input: { from: [research] }
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Out" } }
    simulation: { responses: [{ text: '{"ok":true}' }] }
    runtime: { runner: container, egress: [jira.example.com] }
    credentials:
      - { secret: mail-hook, env: MAIL_TOKEN }
    tools:
      - { server: cve-db, tool: lookup_cve }
${action}
---
`;

/** Runs the real run node code in this process instead of a container; records every call. */
class InProcessNodeRunner implements IsolatingRunner {
  readonly kind: RunnerKind = 'container';
  readonly specs: RunNodeSpec[] = [];
  readonly stops: RunNodeStopReason[] = [];
  readonly exits: (number | null)[] = [];
  constructor(
    private readonly n: TestNode,
    private readonly mode: 'normal' | 'crash' | 'hang' | 'timeout' | 'start-fails' = 'normal',
  ) {}
  imageFor(): string {
    return IMAGE;
  }
  async execute(): Promise<never> {
    throw new Error('not used');
  }
  async startNode(spec: RunNodeSpec): Promise<RunNodeHandle> {
    this.specs.push(spec);
    if (this.mode === 'start-fails') throw new OaxError('network_not_internal', 'nope');
    const done =
      this.mode === 'normal'
        ? runNode({
            env: {
              OAX_CONTROL_URL: spec.controlUrl,
              OAX_RUN_ID: spec.runId,
              OAX_NODE_ID: spec.nodeId,
              OAX_STEP_IDS: spec.steps.join(','),
              OAX_RUN_TOKEN_FILE: '/run/oax/token',
            },
            readFile: async () => spec.runToken,
            fetchImpl: injectFetch(this.n.app),
            inMemoryMcp: inMemoryServers(demoServerFactories()),
            log: () => undefined,
          })
        : Promise.resolve(137);
    return {
      nodeId: spec.nodeId,
      wait: async (signal?: AbortSignal): Promise<RunNodeExit> => {
        if (this.mode === 'hang')
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
        if (this.mode === 'hang') return { exitCode: null, reason: 'cancelled' };
        if (this.mode === 'timeout') return { exitCode: null, reason: 'timeout' };
        const exitCode = await done;
        this.exits.push(exitCode);
        return { exitCode };
      },
      stop: async (reason) => void this.stops.push(reason),
    };
  }
}

let n: TestNode;
const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function publish(src: string): Promise<string> {
  const a = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: src } });
  expect(a.statusCode, a.body).toBe(201);
  const p = await n.req({ method: 'POST', url: `/v1/agents/${a.json().id}/publish` });
  expect(p.statusCode, p.body).toBe(201);
  return a.json().id as string;
}

async function runWith(
  agentId: string,
  runner: InProcessNodeRunner | undefined,
  opts: { cancelAfterMs?: number } = {},
) {
  const worker = new Worker(n.ctx, {
    inMemoryMcp: inMemoryServers(demoServerFactories()),
    ...(runner
      ? {
          isolation: {
            runners: { container: runner as IsolatingRunner & { imageFor(): string } },
            controlUrl: 'http://api:8080',
            limits: { cpus: 1, memoryMb: 256, pids: 64 },
            cancelPollMs: 20,
          },
        }
      : {}),
  });
  const res = await n.req({
    method: 'POST',
    url: `/v1/agents/${agentId}/runs`,
    payload: { data: { go: true } },
  });
  const runId = res.json().id as string;
  if (opts.cancelAfterMs)
    setTimeout(() => {
      // drizzle builders run only when awaited
      n.ctx.db
        .update(schema.runs)
        .set({ cancelRequested: true })
        .where(eq(schema.runs.id, runId))
        .then(
          () => undefined,
          () => undefined,
        );
    }, opts.cancelAfterMs);
  worker.start();
  const run = await waitFor(async () => {
    const r = (await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json();
    return ['succeeded', 'failed', 'cancelled', 'blocked_by_policy'].includes(r.status)
      ? r
      : undefined;
  });
  await worker.stop();
  const audit = (await n.req({ method: 'GET', url: `/v1/audit?runId=${runId}&limit=200` })).json()
    .items as { action: string; payload: Record<string, unknown> }[];
  const steps = (await n.req({ method: 'GET', url: `/v1/runs/${runId}/steps?limit=100` })).json()
    .items as { kind: string; agentId: string | null; name: string }[];
  const sessions = await n.ctx.db
    .select()
    .from(schema.runNodeSessions)
    .where(eq(schema.runNodeSessions.runId, runId));
  return { run, audit, steps, sessions, runId };
}

beforeAll(async () => {
  n = await testNode(ENV);
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  await allowSecrets(n);
  await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: { name: 'cve-db', config: { transport: 'in-memory' } },
  });
});
afterAll(async () => n.close());

describe('isolated step end to end (run node code in-process, fake engine)', () => {
  it('runs the isolated step in a node with a step-scoped token and revokes everything after', async () => {
    const id = await publish(source('e2e-ok', ''));
    const runner = new InProcessNodeRunner(n);
    const { run, audit, steps, sessions } = await runWith(id, runner);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(run.outputs.map((o: { agentId: string }) => o.agentId)).toEqual(['research', 'action']);
    expect(run.outputs[1].json).toEqual({ ok: true });
    // exactly one node, for exactly the isolated step, with only non-secret material
    expect(runner.specs).toHaveLength(1);
    const spec = runner.specs[0]!;
    expect(spec.steps).toEqual(['action']);
    expect(spec.image).toBe(IMAGE);
    expect(spec.controlUrl).toBe('http://api:8080');
    expect(spec.egress).toEqual(['jira.example.com']); // narrowed by the step
    expect(spec.runToken.startsWith('oaxrt.')).toBe(true);
    expect(JSON.stringify({ ...spec, runToken: '' })).not.toContain('mail-secret-1');
    // the node did the model call of the isolated step; the orchestrator did the other one
    const modelCalls = steps.filter((s) => s.kind === 'model_call').map((s) => s.agentId);
    expect(modelCalls.sort()).toEqual(['action', 'research']);
    // both calls are reserved and settled by the control node: the orchestrator's through the
    // control plane, the node's through the model proxy; the run counters are the ledger's
    const ledger = await n.ctx.db
      .select()
      .from(schema.costLedger)
      .where(eq(schema.costLedger.runId, run.id));
    expect(ledger.map((l) => l.via).sort()).toEqual(['in-process', 'proxy']);
    expect(ledger.every((l) => l.reservationId)).toBe(true);
    expect(run.tokensIn).toBe(ledger.reduce((a, l) => a + l.tokensIn, 0));
    expect(run.tokensIn).toBeGreaterThan(0);
    const reserved = await n.ctx.db.select().from(schema.modelReservations);
    expect(reserved.filter((r) => r.runId === run.id).map((r) => r.status)).toEqual([
      'settled',
      'settled',
    ]);
    // audit: started -> issued -> revoked -> stopped, no values
    const actions = audit.map((e) => e.action);
    for (const a of [
      'runnode.started',
      'credential.issued',
      'credential.revoked',
      'runnode.stopped',
    ])
      expect(actions, a).toContain(a);
    expect(audit.find((e) => e.action === 'credential.issued')!.payload).toMatchObject({
      refs: ['mail-hook'],
      agentId: 'action',
    });
    expect(audit.find((e) => e.action === 'credential.revoked')!.payload).toMatchObject({
      reason: 'step_end',
    });
    expect(audit.find((e) => e.action === 'runnode.stopped')!.payload).toMatchObject({
      exitCode: 0,
    });
    expect(JSON.stringify(audit)).not.toContain('mail-secret-1');
    // the node was removed and its session revoked; the token is dead
    expect(runner.stops).toEqual(['step_end']);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.revokedAt).not.toBeNull();
    expect(sessions[0]!.handover).toBeNull(); // the step input is not kept
    const after = await n.req({
      method: 'GET',
      url: `/v1/worker/runs/${run.id}/status`,
      token: spec.runToken,
    });
    expect(after.statusCode).toBe(401);
    // the audit chain stays valid with the new entries
    expect(
      (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json().valid,
    ).toBe(true);
  });

  it('never runs an isolated step inline when no container runner is configured (fail closed)', async () => {
    const id = await publish(source('e2e-nowhere', ''));
    const { run, steps } = await runWith(id, undefined);
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('runner_unavailable');
    expect(steps.some((s) => s.agentId === 'action' && s.kind === 'model_call')).toBe(false);
  });

  it('fails the run when the node dies without a result, and still cleans up', async () => {
    const id = await publish(source('e2e-crash', ''));
    const runner = new InProcessNodeRunner(n, 'crash');
    const { run, audit, sessions } = await runWith(id, runner);
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('run_node_failed');
    expect(runner.stops).toEqual(['step_end']);
    expect(sessions[0]!.revokedAt).not.toBeNull();
    expect(audit.find((e) => e.action === 'runnode.stopped')!.payload).toMatchObject({
      exitCode: 137,
    });
  });

  it('fails the run on a node timeout', async () => {
    const id = await publish(source('e2e-timeout', ''));
    const runner = new InProcessNodeRunner(n, 'timeout');
    const { run, audit } = await runWith(id, runner);
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('control_timeout');
    expect(runner.stops).toEqual(['timeout']);
    expect(audit.find((e) => e.action === 'credential.revoked')!.payload).toMatchObject({
      reason: 'timeout',
    });
  });

  it('cancels a running node when the run is cancelled', async () => {
    const id = await publish(source('e2e-cancel', ''));
    const runner = new InProcessNodeRunner(n, 'hang');
    const { run, audit, sessions } = await runWith(id, runner, { cancelAfterMs: 150 });
    expect(run.status).toBe('cancelled');
    expect(runner.stops).toEqual(['cancelled']);
    expect(sessions[0]!.revokedAt).not.toBeNull();
    expect(audit.find((e) => e.action === 'credential.revoked')!.payload).toMatchObject({
      reason: 'cancelled',
    });
  });

  it('fails the run (revoked, nothing left running) when the node cannot be started', async () => {
    const id = await publish(source('e2e-start-fails', ''));
    const runner = new InProcessNodeRunner(n, 'start-fails');
    const { run, sessions } = await runWith(id, runner);
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('network_not_internal');
    expect(sessions[0]!.revokedAt).not.toBeNull();
  });

  it('carries the proxy refusal for a provider the control node cannot serve into the run', async () => {
    const src = source('e2e-provider', '').replace(
      'id: action\n    provider: simulated',
      'id: action\n    provider: anthropic',
    );
    const id = await publish(src);
    const { run, steps } = await runWith(id, new InProcessNodeRunner(n));
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('model_not_allowed');
    expect(run.errorMessage).not.toContain('W1-3b');
    expect(steps.some((s) => s.agentId === 'action' && s.kind === 'error')).toBe(true);
  });

  it('refuses a tenant without allowed secrets: the step fails, no value is delivered', async () => {
    const id = await publish(source('e2e-no-secrets', ''));
    const tenantId = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id;
    await n.req({ method: 'PATCH', url: `/v1/tenants/${tenantId}`, payload: { secretRefs: [] } });
    try {
      const { run, audit } = await runWith(id, new InProcessNodeRunner(n));
      expect(run.status).toBe('failed');
      expect(audit.some((e) => e.action === 'credential.denied')).toBe(true);
      expect(audit.some((e) => e.action === 'credential.issued')).toBe(false);
    } finally {
      await n.req({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}`,
        payload: { secretRefs: ['mail-hook'] },
      });
    }
  });
});

describe('NodeDispatcher', () => {
  const def = (runtime: object = {}, step: object = {}) =>
    ({
      runtime: { runner: 'container', egress: ['a.example'], ...runtime },
      budget: {},
      agents: [{ id: 's', ...step }],
    }) as never;
  const mk = (definition: never, runners: Record<string, unknown> = {}) =>
    new NodeDispatcher(
      {
        services: { runNodes: {}, control: {} } as never,
        runners: runners as never,
        workerId: 'w',
        controlUrl: 'http://api:8080',
        limits: { cpus: 1, memoryMb: 128, pids: 8 },
      },
      definition,
    );
  it('treats in-process and local as inline and everything else as isolating', () => {
    const agent = { id: 's' } as never;
    expect(mk(def({ runner: 'in-process' })).isolates(agent)).toBe(false);
    expect(mk(def({ runner: 'local' })).isolates(agent)).toBe(false);
    expect(mk(def({ runner: 'container' })).isolates(agent)).toBe(true);
    expect(mk(def({ runner: 'aws-lambda' })).isolates(agent)).toBe(true);
    // a per-step runner wins over the pipeline's
    expect(
      mk(def({ runner: 'container' })).isolates({
        id: 's',
        runtime: { runner: 'in-process' },
      } as never),
    ).toBe(false);
    expect(
      mk(def({ runner: 'in-process' })).isolates({
        id: 's',
        runtime: { runner: 'container' },
      } as never),
    ).toBe(true);
  });
  it('refuses a missing runner, a widened egress list and an unknown toolbox image', async () => {
    const req = (agent: object) => ({ runId: 'r', agent, input: null }) as never;
    await expect(mk(def()).dispatch(req({ id: 's' }))).rejects.toMatchObject({
      code: 'runner_unavailable',
    });
    const runner = { imageFor: () => IMAGE, startNode: async () => ({}) };
    await expect(
      mk(def(), { container: runner }).dispatch(
        req({ id: 's', runtime: { egress: ['evil.example'] } }),
      ),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    const strict = {
      imageFor: () => {
        throw new OaxError('toolbox_image_unknown', 'x');
      },
    };
    await expect(
      mk(def(), { container: strict }).dispatch(req({ id: 's', toolbox: 'git+node' })),
    ).rejects.toMatchObject({ code: 'toolbox_image_unknown' });
  });
  it('takes tokens and cost from the ledger of the control node, not from the node, and bounds its counters', async () => {
    const calls: string[] = [];
    const services = {
      runNodes: {
        createSession: async () => ({
          sessionId: 's',
          nodeId: 'n',
          token: 'oaxrt.a.b',
          expiresAt: new Date(),
        }),
        revoke: async () => void calls.push('revoke'),
        recordStopped: async () => void calls.push('stopped'),
        resultOf: async () => ({
          agentId: 's',
          format: 'json',
          content: '{}',
          usage: { tokensIn: 9e9, tokensOut: 9e9, costMicros: 9e12, steps: 5e6, toolCalls: 7 },
        }),
      },
      // the ledger counters of the run: what the model proxy recorded while the node ran
      control: {
        isCancelled: async () => false,
        runUsage: async () =>
          calls.includes('stopped')
            ? { tokensIn: 1100, tokensOut: 220, costMicros: 3300 }
            : { tokensIn: 1000, tokensOut: 200, costMicros: 3000 },
      },
    };
    const runner = {
      imageFor: () => IMAGE,
      startNode: async () => ({
        nodeId: 'n',
        wait: async () => ({ exitCode: 0 }),
        stop: async () => void calls.push('stop'),
      }),
    };
    const d = new NodeDispatcher(
      {
        services: services as never,
        runners: { container: runner } as never,
        workerId: 'w',
        controlUrl: 'http://api:8080',
        limits: { cpus: 1, memoryMb: 128, pids: 8 },
      },
      def(),
    );
    const res = await d.dispatch({ runId: 'r', agent: { id: 's' } as never, input: null });
    // tokens and cost are what the ledger gained during the step, never the node's 9e9 report
    expect(res.usage).toEqual({
      tokensIn: 100,
      tokensOut: 20,
      costMicros: 300,
      steps: 1000,
      toolCalls: 7,
    });
    // the token dies before the node is removed
    expect(calls.indexOf('revoke')).toBeLessThan(calls.indexOf('stop'));
  });
});

describe('air-gapped deployments', () => {
  it('run an isolated step with the same configuration (no outbound access needed)', async () => {
    const air = await testNode({ ...ENV, OAX_AIRGAPPED: 'true' });
    try {
      await allowSecrets(air);
      await air.req({
        method: 'POST',
        url: '/v1/teams',
        payload: { slug: 'team-ops', name: 'Ops' },
      });
      await air.req({
        method: 'POST',
        url: '/v1/connections',
        payload: { name: 'cve-db', config: { transport: 'in-memory' } },
      });
      const a = await air.req({
        method: 'POST',
        url: '/v1/agents',
        payload: { source: source('e2e-airgap', '') },
      });
      expect(
        (await air.req({ method: 'POST', url: `/v1/agents/${a.json().id}/publish` })).statusCode,
      ).toBe(201);
      const prev = n;
      n = air;
      try {
        const { run } = await runWith(a.json().id, new InProcessNodeRunner(air));
        expect(run.status, JSON.stringify(run)).toBe('succeeded');
      } finally {
        n = prev;
      }
    } finally {
      await air.close();
    }
  });
});
