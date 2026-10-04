import { issueRunToken } from '@openagentix/core';
import type { StepCredentials } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';
import { runNodeSessions, runs, runSteps } from '../src/db/schema.js';
import { RUN_TOKEN_SECRET, testNode, type TestNode } from './helpers.js';

const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
const ENV = {
  OAX_RUNNERS_ENABLED: 'in-process,container',
  OAX_CONTAINER_RUNNER_ENABLED: 'true',
  OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
  OAX_CONTAINER_IMAGE: IMAGE,
  OAX_CONTAINER_NETWORK: 'oax-nodes',
  OAX_NODE_CONTROL_URL: 'http://api:8080',
};

const SOURCE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: broker-agent
version: 1.0.0
owner: team-ops
runtime:
  runner: container
schemas:
  Out: { type: object, required: [ok], properties: { ok: { type: boolean } } }
agents:
  - id: research
    provider: simulated
    model: sim-1
    instructions: Research.
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Out" } }
    credentials:
      - { secret: mail-hook, env: MAIL_TOKEN }
    tools:
      - { server: jira, tool: get_issue }
  - id: action
    provider: simulated
    model: sim-1
    instructions: Act.
    when: 'exists(event.data.go)'
    credentials:
      - { secret: gh-hook }
---
`;

let n: TestNode;
let agentId: string;

async function newRun(): Promise<string> {
  const res = await n.req({
    method: 'POST',
    url: `/v1/agents/${agentId}/runs`,
    payload: { data: { go: true } },
  });
  const id = res.json().id as string;
  await claim(id);
  return id;
}
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
const session = (runId: string, agent = 'research', worker = 'w1') =>
  n.services.runNodes.createSession(runId, worker, {
    agentId: agent,
    input: { ticket: 'SEC-1' },
    timeoutSeconds: 30,
    runner: 'container',
    image: IMAGE,
  });
const creds = (runId: string, token: string, agentId: string) =>
  n.req({
    method: 'POST',
    url: `/v1/worker/runs/${runId}/credentials`,
    token,
    payload: { agentId },
  });
const auditOf = async (runId: string) =>
  (await n.req({ method: 'GET', url: `/v1/audit?runId=${runId}&limit=200` })).json().items as {
    action: string;
    payload: Record<string, unknown>;
  }[];

beforeAll(async () => {
  n = await testNode(ENV);
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  const conn = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'jira',
      config: {
        transport: 'stdio',
        command: 'jira-mcp',
        env: { JIRA_URL: 'https://jira.example.org' },
        envSecrets: { JIRA_TOKEN: 'trivy-hook' },
        tools: { get_issue: { access: 'read' } },
      },
    },
  });
  expect(conn.statusCode).toBe(201);
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: SOURCE } });
  expect(created.statusCode).toBe(201);
  agentId = created.json().id;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  expect(pub.statusCode, pub.body).toBe(201);
});
afterAll(async () => n.close());

describe('credential broker', () => {
  it('hands out exactly the step credentials, once, with no-store, and audits names only', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const res = await creds(runId, s.token, 'research');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as StepCredentials;
    expect(body.agentId).toBe('research');
    expect(body.credentials).toEqual([
      { secret: 'mail-hook', env: 'MAIL_TOKEN', value: 'mail-secret-1' },
    ]);
    expect(body.connections).toEqual([{ server: 'jira', env: { JIRA_TOKEN: 'hook-secret-1' } }]);
    // never the secret of the other step ("gh-hook") or any other configured secret
    expect(res.body).not.toContain('gh-secret');
    expect(new Date(body.expiresAt).getTime()).toBe(s.expiresAt.getTime());
    const audit = await auditOf(runId);
    const issued = audit.find((e) => e.action === 'credential.issued')!;
    expect(issued.payload).toMatchObject({
      runId,
      nodeId: s.nodeId,
      agentId: 'research',
      refs: ['mail-hook', 'trivy-hook'],
      connections: ['jira'],
      source: 'static',
    });
    expect(audit.some((e) => e.action === 'runnode.started')).toBe(true);
    // no value anywhere in the audit trail of the run
    const dump = JSON.stringify(audit);
    for (const v of ['mail-secret-1', 'hook-secret-1', 'gh-secret']) expect(dump).not.toContain(v);
  });

  it('issues once per step and session (409), and audits the denial', async () => {
    const runId = await newRun();
    const s = await session(runId);
    expect((await creds(runId, s.token, 'research')).statusCode).toBe(200);
    const again = await creds(runId, s.token, 'research');
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('credential_already_issued');
    expect(again.body).not.toContain('mail-secret-1');
    const denied = (await auditOf(runId)).find((e) => e.action === 'credential.denied')!;
    expect(denied.payload).toMatchObject({ agentId: 'research', reason: 'already_issued' });
    // a restarted node gets a new session and may fetch again
    const s2 = await session(runId);
    expect((await creds(runId, s2.token, 'research')).statusCode).toBe(200);
  });

  it('only hands credentials to a step-scoped token for a step in its token', async () => {
    const runId = await newRun();
    const s = await session(runId, 'research');
    const other = await creds(runId, s.token, 'action');
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe('credential_scope');
    expect(other.body).not.toContain('gh-secret');
    // the trusted worker's unscoped token is not a credential-broker token
    const worker = n.services.control.issueToken(runId, 'w1');
    const res = await creds(runId, worker, 'research');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('credential_scope');
    // unknown agent ids cannot be requested either
    expect((await creds(runId, s.token, 'ghost')).statusCode).toBe(403);
  });

  it('is bound to the run, the signature and the expiry of the token', async () => {
    const runId = await newRun();
    const otherRun = await newRun();
    const s = await session(runId);
    expect((await creds(otherRun, s.token, 'research')).statusCode).toBe(403);
    const forged = s.token.slice(0, -4) + 'AAAA';
    expect((await creds(runId, forged, 'research')).statusCode).toBe(401);
    const expired = issueRunToken(
      RUN_TOKEN_SECRET,
      { runId, workerId: s.nodeId, ttlSeconds: 60, sid: s.sessionId, steps: ['research'] },
      Date.now() - 3_600_000,
    );
    expect((await creds(runId, expired, 'research')).statusCode).toBe(401);
    // a correctly signed token for a session that does not exist is useless
    const ghost = issueRunToken(RUN_TOKEN_SECRET, {
      runId,
      workerId: s.nodeId,
      ttlSeconds: 60,
      sid: '00000000-0000-4000-8000-00000000dead',
      steps: ['research'],
    });
    const res = await creds(runId, ghost, 'research');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('run_node_session_revoked');
    // a token with another node id or another step list than the session is refused
    const wrongNode = issueRunToken(RUN_TOKEN_SECRET, {
      runId,
      workerId: 'someone-else',
      ttlSeconds: 60,
      sid: s.sessionId,
      steps: ['research'],
    });
    expect((await creds(runId, wrongNode, 'research')).statusCode).toBe(401);
    const widened = issueRunToken(RUN_TOKEN_SECRET, {
      runId,
      workerId: s.nodeId,
      ttlSeconds: 60,
      sid: s.sessionId,
      steps: ['research', 'action'],
    });
    expect((await creds(runId, widened, 'action')).statusCode).toBe(401);
  });

  it('a revoked session kills the token immediately, for every endpoint', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await n.services.runNodes.revoke(s.sessionId, 'step_end');
    await n.services.runNodes.revoke(s.sessionId, 'step_end'); // idempotent
    for (const [method, url, payload] of [
      ['POST', `/v1/worker/runs/${runId}/credentials`, { agentId: 'research' }],
      ['GET', `/v1/worker/runs/${runId}/handover?agentId=research`, undefined],
      ['GET', `/v1/worker/runs/${runId}/status`, undefined],
      ['GET', `/v1/worker/runs/${runId}/budget`, undefined],
      [
        'POST',
        `/v1/worker/runs/${runId}/gate`,
        { agentId: 'research', call: { server: 'jira', tool: 'get_issue', args: {} } },
      ],
    ] as const) {
      const res = await n.req({ method, url, token: s.token, ...(payload ? { payload } : {}) });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error).toBe('run_node_session_revoked');
    }
    const revoked = (await auditOf(runId)).filter((e) => e.action === 'credential.revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.payload).toMatchObject({ nodeId: s.nodeId, reason: 'step_end' });
  });

  it('expired sessions are dead even with a still-valid token signature', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await n.ctx.db
      .update(runNodeSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(runNodeSessions.id, s.sessionId));
    expect((await creds(runId, s.token, 'research')).statusCode).toBe(401);
  });

  it('completing or finishing the run revokes all its sessions', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await n.services.control.completeRun(runId, {
      status: 'succeeded',
      outputs: [],
      usage: { tokensIn: 0, tokensOut: 0, costMicros: 0, steps: 0, toolCalls: 0 },
    });
    expect((await creds(runId, s.token, 'research')).statusCode).toBe(401);
    expect(
      (await auditOf(runId)).find((e) => e.action === 'credential.revoked')?.payload,
    ).toMatchObject({
      reason: 'run_completed',
    });
  });

  it('refuses references the tenant does not allow (fail closed, nothing consumed)', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const tenantId = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id;
    const set = (secretRefs: string[]) =>
      n.req({ method: 'PATCH', url: `/v1/tenants/${tenantId}`, payload: { secretRefs } });
    try {
      expect((await set(['gh-*'])).statusCode).toBe(200);
      const denied = await creds(runId, s.token, 'research');
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe('credential_scope');
      expect(denied.body).not.toContain('mail-secret-1');
      const entry = (await auditOf(runId)).find((e) => e.action === 'credential.denied')!;
      expect(entry.payload).toMatchObject({
        reason: 'secret_not_allowed',
        refs: ['mail-hook', 'trivy-hook'],
      });
      // an empty allowlist allows nothing at all
      expect((await set([])).statusCode).toBe(200);
      expect((await creds(runId, s.token, 'research')).statusCode).toBe(403);
      // the denial did not consume the single issue: widening the allowlist makes it work
      expect((await set(['mail-*', 'trivy-*'])).statusCode).toBe(200);
      expect((await creds(runId, s.token, 'research')).statusCode).toBe(200);
    } finally {
      await set(['*']);
    }
  });

  it('fails closed when a secret is not configured and consumes the issue', async () => {
    const runId = await newRun();
    const s = await session(runId, 'action');
    const svc = n.services.runNodes as unknown as { source: unknown };
    const saved = svc.source;
    svc.source = {
      name: 'failing',
      issue: async () => {
        throw new Error('vault backend password=hunter2 unreachable');
      },
    };
    try {
      const res = await creds(runId, s.token, 'action');
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('hunter2');
      expect(
        (await auditOf(runId)).find((e) => e.action === 'credential.denied')?.payload,
      ).toMatchObject({ reason: 'unavailable' });
    } finally {
      svc.source = saved;
    }
    expect((await creds(runId, s.token, 'action')).statusCode).toBe(409);
  });
});

describe('credential values never reach step records', () => {
  it('scrubs issued values from steps recorded afterwards', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await creds(runId, s.token, 'research');
    const step = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/steps`,
      token: s.token,
      payload: {
        kind: 'tool_call',
        agentId: 'research',
        name: 'jira/get_issue',
        status: 'ok',
        output: { text: 'echo mail-secret-1 and hook-secret-1' },
      },
    });
    expect(step.statusCode).toBe(204);
    const rows = await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    const dump = JSON.stringify(rows) + JSON.stringify(await auditOf(runId));
    expect(dump).not.toContain('mail-secret-1');
    expect(dump).not.toContain('hook-secret-1');
    expect(n.services.runNodes.knownSecrets(runId)).toContain('mail-secret-1');
    await n.services.runNodes.revokeRun(runId, 'cancelled');
    expect(n.services.runNodes.knownSecrets(runId)).toEqual([]);
  });
});

describe('what a run node token may and may not do', () => {
  it('cannot complete the run', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const res = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/complete`,
      token: s.token,
      payload: {
        status: 'succeeded',
        outputs: [],
        usage: { tokensIn: 0, tokensOut: 0, costMicros: 0, steps: 0, toolCalls: 0 },
      },
    });
    expect(res.statusCode).toBe(403);
    expect((await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json().status).toBe(
      'running',
    );
  });

  it('can only gate, record and request approvals for its own step', async () => {
    const runId = await newRun();
    const s = await session(runId, 'research');
    const call = { server: 'jira', tool: 'get_issue', args: {} };
    const gate = (agent: string) =>
      n.req({
        method: 'POST',
        url: `/v1/worker/runs/${runId}/gate`,
        token: s.token,
        payload: { agentId: agent, call },
      });
    expect((await gate('research')).json().effect).toBe('allow');
    expect((await gate('action')).statusCode).toBe(403);
    const step = (agent: string | null) =>
      n.req({
        method: 'POST',
        url: `/v1/worker/runs/${runId}/steps`,
        token: s.token,
        payload: { kind: 'output', agentId: agent, name: 'x', status: 'ok' },
      });
    expect((await step('research')).statusCode).toBe(204);
    expect((await step('action')).statusCode).toBe(403);
    expect((await step(null)).statusCode).toBe(403);
    const approval = (agent: string) =>
      n.req({
        method: 'POST',
        url: `/v1/worker/runs/${runId}/approvals`,
        token: s.token,
        payload: { agentId: agent, call },
      });
    expect((await approval('action')).statusCode).toBe(403);
    expect((await approval('research')).statusCode).toBe(201);
    expect(
      (
        await n.req({ method: 'GET', url: `/v1/worker/runs/${runId}/status`, token: s.token })
      ).json(),
    ).toEqual({
      cancelled: false,
    });
  });

  it('the unscoped worker token keeps working as before', async () => {
    const runId = await newRun();
    const token = n.services.control.issueToken(runId, 'w1');
    const res = await n.req({ method: 'GET', url: `/v1/worker/runs/${runId}/status`, token });
    expect(res.statusCode).toBe(200);
    const bad = await n.req({
      method: 'GET',
      url: `/v1/worker/runs/${runId}/handover?agentId=research`,
      token,
    });
    expect(bad.statusCode).toBe(403);
  });
});

describe('handover and result', () => {
  it('returns only the step: spec without secrets/when/credentials, input, stripped MCP config', async () => {
    const runId = await newRun();
    const s = await session(runId, 'research');
    const res = await n.req({
      method: 'GET',
      url: `/v1/worker/runs/${runId}/handover?agentId=research`,
      token: s.token,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const h = res.json();
    expect(h.agentId).toBe('research');
    expect(h.input).toEqual({ ticket: 'SEC-1' });
    expect(h.agent).not.toHaveProperty('credentials');
    expect(h.agent).not.toHaveProperty('when');
    expect(h.outputSchema).toMatchObject({ type: 'object', required: ['ok'] });
    expect(JSON.stringify(h.outputSchema)).not.toContain('$ref');
    expect(h.run).toMatchObject({ name: 'broker-agent', version: '1.0.0' });
    expect(h.mcp).toHaveLength(1);
    expect(h.mcp[0]).toMatchObject({
      name: 'jira',
      env: { JIRA_URL: 'https://jira.example.org' },
      envSecrets: {},
    });
    // nothing about the other step or any secret reference/value
    const dump = res.body;
    for (const forbidden of [
      'gh-hook',
      'gh-secret',
      'mail-hook',
      'trivy-hook',
      'hook-secret-1',
      'action',
    ]) {
      expect(dump, forbidden).not.toContain(forbidden);
    }
    const other = await n.req({
      method: 'GET',
      url: `/v1/worker/runs/${runId}/handover?agentId=action`,
      token: s.token,
    });
    expect(other.statusCode).toBe(403);
  });

  it('accepts one result per session, scoped to its step, and the orchestrator can read it', async () => {
    const runId = await newRun();
    const s = await session(runId, 'research');
    const post = (agent: string, extra: object = {}) =>
      n.req({
        method: 'POST',
        url: `/v1/worker/runs/${runId}/handover/result`,
        token: s.token,
        payload: { agentId: agent, format: 'json', content: '{"ok":true}', ...extra },
      });
    expect(await n.services.runNodes.resultOf(s.sessionId)).toBeNull();
    expect((await post('action')).statusCode).toBe(403);
    expect(
      (
        await post('research', {
          usage: { tokensIn: 1, tokensOut: 2, costMicros: 3, steps: 1, toolCalls: 0 },
        })
      ).statusCode,
    ).toBe(204);
    expect((await post('research')).statusCode).toBe(409);
    expect(await n.services.runNodes.resultOf(s.sessionId)).toMatchObject({
      agentId: 'research',
      content: '{"ok":true}',
      usage: { costMicros: 3 },
    });
    expect(await n.services.runNodes.resultOf('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('rejects oversize results and malformed failures', async () => {
    const runId = await newRun();
    const s = await session(runId, 'research');
    const res = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/handover/result`,
      token: s.token,
      payload: { agentId: 'research', format: 'json', content: 'x'.repeat(1_000_001) },
    });
    expect(res.statusCode).toBe(400);
    const bad = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/handover/result`,
      token: s.token,
      payload: {
        agentId: 'research',
        format: 'none',
        content: '',
        failure: { status: 'succeeded', code: 'x', message: 'y' },
      },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('sessions are created only by the lease holder', () => {
  it('refuses another worker, inactive runs and unknown agents', async () => {
    const runId = await newRun();
    await expect(session(runId, 'research', 'someone-else')).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(session(runId, 'ghost')).rejects.toMatchObject({ statusCode: 400 });
    await expect(session('00000000-0000-4000-8000-0000000000aa')).rejects.toMatchObject({
      statusCode: 404,
    });
    await n.ctx.db.update(runs).set({ status: 'queued', lockedBy: null }).where(eq(runs.id, runId));
    await expect(session(runId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('caps the token lifetime at the step timeout plus a minute', async () => {
    const runId = await newRun();
    const s = await session(runId);
    expect(s.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(91_000);
    expect(s.expiresAt.getTime() - Date.now()).toBeGreaterThan(80_000);
  });

  it('records the stop of a node', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await n.services.runNodes.recordStopped(s.sessionId, { exitCode: 0, durationMs: 12 });
    await n.services.runNodes.recordStopped(s.sessionId, {
      exitCode: null,
      durationMs: 1,
      reason: 'timeout',
    });
    await n.services.runNodes.recordStopped('00000000-0000-4000-8000-000000000000', {
      exitCode: 0,
      durationMs: 1,
    });
    const stops = (await auditOf(runId)).filter((e) => e.action === 'runnode.stopped');
    expect(stops.map((e) => e.payload.exitCode).sort()).toEqual([0, null]);
  });
});

describe('tenant secret allowlist API', () => {
  it('is visible, validated and only changeable by platform operators', async () => {
    const tenants = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items;
    expect(tenants[0].secretRefs).toEqual(['*']);
    const id = tenants[0].id as string;
    for (const bad of [['has space'], ['../x'], Array.from({ length: 65 }, (_, i) => `s${i}`)]) {
      const res = await n.req({
        method: 'PATCH',
        url: `/v1/tenants/${id}`,
        payload: { secretRefs: bad },
      });
      expect(res.statusCode).toBe(400);
    }
    const created = await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: { slug: 'acme', name: 'Acme' },
    });
    // a new tenant starts with an empty allowlist (fail closed)
    expect(created.json().secretRefs).toEqual([]);
    const set = await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${created.json().id}`,
      payload: { secretRefs: ['b', 'a*', 'b'] },
    });
    expect(set.json().secretRefs).toEqual(['a*', 'b']);
  });
});

describe('platform configuration of the container runner', () => {
  const base = {
    NODE_ENV: 'test',
    OAX_DATABASE_URL: 'memory://',
    OAX_RUN_TOKEN_SECRET: RUN_TOKEN_SECRET,
  };
  const cfg = (env: Record<string, string>) => loadConfig({ ...base, ...env });
  it('is off by default and requires the flag when listed', () => {
    expect(cfg({}).runners.container).toEqual({ enabled: false });
    expect(() => cfg({ OAX_RUNNERS_ENABLED: 'in-process,container' })).toThrow(
      /requires OAX_CONTAINER_RUNNER_ENABLED=true/,
    );
  });
  it('needs engine, digest-pinned image, internal network and node control URL', () => {
    for (const key of [
      'OAX_CONTAINER_ENGINE_URL',
      'OAX_CONTAINER_IMAGE',
      'OAX_CONTAINER_NETWORK',
      'OAX_NODE_CONTROL_URL',
    ]) {
      const env = { ...ENV, OAX_CONTAINER_RUNNER_ENABLED: 'true' } as Record<string, string>;
      delete env[key];
      expect(() => cfg(env), key).toThrow(new RegExp(`${key} is required`));
    }
    expect(() => cfg({ ...ENV, OAX_CONTAINER_IMAGE: 'node:22-alpine' })).toThrow(
      /pinned by digest/,
    );
    const ok = cfg(ENV).runners.container;
    expect(ok.enabled).toBe(true);
    expect(ok.config).toMatchObject({ image: IMAGE, network: 'oax-nodes', allowRawSocket: false });
    expect(ok.nodeControlUrl).toBe('http://api:8080');
  });
  it('parses the egress proxy settings and refuses half of them', () => {
    const withProxy = cfg({
      ...ENV,
      OAX_CONTAINER_EGRESS_PROXY_LISTEN: '0.0.0.0:3128',
      OAX_CONTAINER_EGRESS_PROXY_URL: 'http://worker:3128',
      OAX_CONTAINER_TOOLBOX_IMAGES: JSON.stringify({ trivy: `x/y@sha256:${'b'.repeat(64)}` }),
    }).runners.container;
    expect(withProxy.egressProxyListen).toEqual({ host: '0.0.0.0', port: 3128 });
    expect(withProxy.config?.egressProxyUrl).toBe('http://worker:3128');
    expect(() => cfg({ ...ENV, OAX_CONTAINER_EGRESS_PROXY_LISTEN: '0.0.0.0:3128' })).toThrow(
      /both/,
    );
    expect(() =>
      cfg({
        ...ENV,
        OAX_CONTAINER_EGRESS_PROXY_LISTEN: 'nonsense',
        OAX_CONTAINER_EGRESS_PROXY_URL: 'http://w:1',
      }),
    ).toThrow(/host:port/);
  });
  it('publish refuses a step runner that is not enabled', async () => {
    const plain = await testNode();
    try {
      const src = SOURCE.replace(
        'runtime:\n  runner: container',
        'runtime:\n  runner: in-process',
      ).replace(
        'id: action\n    provider',
        'id: action\n    runtime: { runner: container }\n    provider',
      );
      await plain.req({
        method: 'POST',
        url: '/v1/teams',
        payload: { slug: 'team-ops', name: 'Ops' },
      });
      const a = await plain.req({ method: 'POST', url: '/v1/agents', payload: { source: src } });
      expect(a.statusCode, a.body).toBe(201);
      const pub = await plain.req({ method: 'POST', url: `/v1/agents/${a.json().id}/publish` });
      expect(pub.statusCode).toBe(400);
      expect(pub.body).toContain('agents.1.runtime.runner');
    } finally {
      await plain.close();
    }
  });
});
