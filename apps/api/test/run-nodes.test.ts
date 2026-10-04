import { issueRunToken } from '@openagentix/core';
import { ContainerRunner } from '@openagentix/runners';
import type { StepCredentials } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';
import { costLedger, eventSources, runNodeSessions, runs, runSteps } from '../src/db/schema.js';
import { RUN_TOKEN_SECRET, testNode, type TestNode } from './helpers.js';

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
  OAX_CONTAINER_EGRESS_ALLOW: 'jira.example.org,*.corp.example',
  // a platform provider key: never handed to a node, whatever the tenant allows
  OAX_PROVIDERS: JSON.stringify([
    { kind: 'simulated', name: 'simulated' },
    { kind: 'openai', name: 'oai', apiKeySecret: 'oai-key' },
  ]),
};
/** What the default tenant is allowed to receive in these tests (it starts with nothing). */
const ALLOWED = ['mail-hook', 'trivy-hook', 'gh-hook', 'oai-key', 'src-secret', 'plat-secret'];

const SOURCE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: broker-agent
version: 1.0.0
owner: team-ops
runtime:
  runner: container
  egress: [jira.example.org]
budget: { maxTokens: 1000, maxCostUsd: 1, maxSteps: 50, maxToolCalls: 10, timeoutSeconds: 100 }
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
  - id: leak-provider
    provider: simulated
    model: sim-1
    instructions: x.
    credentials:
      - { secret: oai-key }
  - id: leak-source
    provider: simulated
    model: sim-1
    instructions: x.
    credentials:
      - { secret: src-secret }
  - id: leak-platform
    provider: simulated
    model: sim-1
    instructions: x.
    credentials:
      - { secret: plat-secret }
---
`;

let n: TestNode;
let agentId: string;
let tenantId: string;

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
  tenantId = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id;
  expect(
    (
      await n.req({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}`,
        payload: { secretRefs: ALLOWED },
      })
    ).statusCode,
  ).toBe(200);
  // a platform connection and an event source that use secrets of their own
  await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'platform-tool',
      scope: 'platform',
      config: { transport: 'stdio', command: 'x', envSecrets: { T: 'plat-secret' } },
    },
  });
  await n.ctx.db.insert(eventSources).values({
    id: crypto.randomUUID(),
    name: 'hook',
    kind: 'webhook',
    secretRefs: ['src-secret'],
  });
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
      await set(ALLOWED);
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
    expect(await n.services.runNodes.knownSecrets(runId)).toContain('mail-secret-1');
    // still scrubbed after the session ended: late steps must not leak the values either
    await n.services.runNodes.revokeRun(runId, 'cancelled');
    expect(await n.services.runNodes.knownSecrets(runId)).toContain('mail-secret-1');
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
    expect(tenants[0].secretRefs).toEqual([...ALLOWED].sort());
    const id = tenants[0].id as string;
    for (const bad of [
      ['has space'],
      ['../x'],
      ['*'],
      ['acme*'],
      ['UPPER.x'],
      Array.from({ length: 65 }, (_, i) => `s${i}`),
    ]) {
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
      payload: { secretRefs: ['bb', 'a_*', 'bb'] },
    });
    expect(set.json().secretRefs).toEqual(['a_*', 'bb']);
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
  it('parses the egress settings and refuses half of them or a bad private range', () => {
    const c = cfg(ENV).runners.container;
    expect(c.config?.egressProxyUrl).toBe('http://egress-proxy:3128');
    expect(c.config?.egressGrantSecret).toBe('g'.repeat(40));
    expect(c.config?.egressAllow).toEqual(['jira.example.org', '*.corp.example']);
    // The control node does not need the grant secret (only the worker and the proxy do): a proxy
    // URL without it loads here and is refused when the worker builds its runner.
    const noSecret = { ...ENV } as Record<string, string>;
    delete noSecret.OAX_CONTAINER_EGRESS_GRANT_SECRET;
    const loaded = cfg(noSecret).runners.container;
    expect(loaded.config?.egressProxyUrl).toBe('http://egress-proxy:3128');
    expect(loaded.config?.egressGrantSecret).toBeUndefined();
    expect(() => new ContainerRunner(loaded.config!)).toThrow(/together/);
    // one key must not serve two purposes
    expect(() => cfg({ ...ENV, OAX_CONTAINER_EGRESS_GRANT_SECRET: RUN_TOKEN_SECRET })).toThrow(
      /must differ from OAX_RUN_TOKEN_SECRET/,
    );
    expect(() => cfg({ ...ENV, OAX_CONTAINER_EGRESS_GRANT_SECRET: 'short' })).toThrow();
    expect(
      cfg({ ...ENV, OAX_CONTAINER_INSTANCE_ID: 'prod-1' }).runners.container.config?.instanceId,
    ).toBe('prod-1');
    expect(() => cfg({ ...ENV, OAX_CONTAINER_EGRESS_PRIVATE_ALLOW: 'not-a-cidr' })).toThrow(
      /not a CIDR/,
    );
    expect(() => cfg({ ...ENV, OAX_CONTAINER_EGRESS_ALLOW: '*.com' })).toThrow();
    expect(
      cfg({ ...ENV, OAX_CONTAINER_EGRESS_PRIVATE_ALLOW: '10.1.0.0/16' }).runners.container.enabled,
    ).toBe(true);
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

describe('platform secrets are never handed to a node', () => {
  it.each([
    ['leak-provider', 'oai-key', 'a provider key'],
    ['leak-source', 'src-secret', 'an event source secret'],
    ['leak-platform', 'plat-secret', 'the secret of a platform connection'],
  ])('%s: %s (%s) is refused even though the tenant allows it', async (step, ref) => {
    const runId = await newRun();
    const s = await session(runId, step);
    const res = await creds(runId, s.token, step);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(ref + '-value');
    const denied = (await auditOf(runId)).find((e) => e.action === 'credential.denied')!;
    expect(denied.payload).toMatchObject({ reason: 'platform_secret' });
    expect(denied.payload.refs).toEqual([ref]);
  });
  it('the check is canonical: a differently written name of the same secret is refused too', async () => {
    const refs = await n.services.runNodes.platformSecretRefs();
    expect(refs.has('oai_key')).toBe(true);
    expect(refs.has('src_secret')).toBe(true);
    expect(refs.has('plat_secret')).toBe(true);
    expect(refs.has('mail_hook')).toBe(false);
  });
});

describe('in-process runs obey the same tenant allowlist', () => {
  it('a tenant connection resolves only allowed references', async () => {
    const r = await n.services.runNodes.resolverFor(tenantId);
    expect(await r.resolve('mail-hook')).toBe('mail-secret-1');
    await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}`,
      payload: { secretRefs: ['gh-*'] },
    });
    try {
      const narrow = await n.services.runNodes.resolverFor(tenantId);
      expect(await narrow.resolve('gh-hook')).toBe('gh-secret');
      await expect(narrow.resolve('mail-hook')).rejects.toMatchObject({
        code: 'secret_not_allowed',
      });
      await expect(narrow.resolve('MAIL.hook')).rejects.toMatchObject({
        code: 'secret_not_allowed',
      });
      // a platform secret name is NOT resolvable by a tenant connection just because a platform
      // connection uses it
      await expect(narrow.resolve('plat-secret')).rejects.toMatchObject({
        code: 'secret_not_allowed',
      });
    } finally {
      await n.req({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}`,
        payload: { secretRefs: ALLOWED },
      });
    }
    await n.req({ method: 'PATCH', url: `/v1/tenants/${tenantId}`, payload: { secretRefs: [] } });
    try {
      const none = await n.services.runNodes.resolverFor(tenantId);
      await expect(none.resolve('mail-hook')).rejects.toMatchObject({ code: 'secret_not_allowed' });
    } finally {
      await n.req({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}`,
        payload: { secretRefs: ALLOWED },
      });
    }
  });

  it('only PLATFORM-scope servers get the unrestricted resolver, chosen per server', async () => {
    const platform = await n.services.catalog.platformMcpNames({ tenantId, teamId: null, agentId });
    expect([...platform]).toEqual(['platform-tool']);
    await n.req({ method: 'PATCH', url: `/v1/tenants/${tenantId}`, payload: { secretRefs: [] } });
    try {
      const { secretsFor, secrets } = await n.services.runNodes.resolverForRun(tenantId, platform);
      // the platform connection keeps working with the operator's secret ...
      expect(await secretsFor('platform-tool').resolve('trivy-hook')).toBe('hook-secret-1');
      // ... a tenant connection (even one with the very same reference) does not
      await expect(secretsFor('jira').resolve('trivy-hook')).rejects.toMatchObject({
        code: 'secret_not_allowed',
      });
      await expect(secrets.resolve('trivy-hook')).rejects.toMatchObject({
        code: 'secret_not_allowed',
      });
    } finally {
      await n.req({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}`,
        payload: { secretRefs: ALLOWED },
      });
    }
  });
});

describe('tenants cannot reach each other through spelling', () => {
  it('slugs that overlap in canonical form cannot coexist', async () => {
    const mk = (slug: string) =>
      n.req({ method: 'POST', url: '/v1/tenants', payload: { slug, name: slug } });
    expect((await mk('omega')).statusCode).toBe(201);
    for (const clash of ['omega-corp', 'omega-b']) {
      const res = await mk(clash);
      expect(res.statusCode, clash).toBe(409);
      expect(res.body).toContain('overlaps');
    }
    expect((await mk('omegacorp')).statusCode).toBe(201);
  });
  it('tenant connection references are checked against the tenant prefix in canonical form', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: {
        slug: 'zeta',
        name: 'Zeta',
        admin: { email: 'zeta@example.com', displayName: 'Z', password: 'zeta-password-123' },
      },
    });
    expect(created.statusCode).toBe(201);
    const token = await n.login('zeta@example.com', 'zeta-password-123');
    const conn = (name: string, ref: string) =>
      n.req({
        method: 'POST',
        url: '/v1/connections',
        token,
        payload: { name, config: { transport: 'stdio', command: 'x', envSecrets: { T: ref } } },
      });
    expect((await conn('c-a', 'zeta.token')).statusCode).toBe(201);
    expect((await conn('c-b', 'ZETA-token')).statusCode).toBe(201);
    for (const [i, ref] of ['zetacorp.token', 'other.zeta.token', 'oai-key'].entries()) {
      const res = await conn(`c-x${i}`, ref);
      expect(res.statusCode, ref).toBe(400);
      expect(res.body).toContain('must start with');
    }
  });
});

describe('a node cannot steer cost accounting or flood the records', () => {
  const stepBody = (over: object = {}) => ({
    kind: 'model_call',
    agentId: 'research',
    name: 'simulated/sim-1',
    status: 'ok',
    tokensIn: 5_000_000,
    tokensOut: 5_000_000,
    costMicros: 999_999_999,
    provider: 'fake',
    model: 'fake-1',
    durationMs: 5,
    ...over,
  });
  it('drops cost, tokens, provider and model of a node step; no ledger row, no run counters', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const res = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/steps`,
      token: s.token,
      payload: stepBody(),
    });
    expect(res.statusCode).toBe(204);
    const [row] = await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(row).toMatchObject({
      costMicros: 0,
      tokensIn: 0,
      tokensOut: 0,
      provider: null,
      model: null,
    });
    expect(await n.ctx.db.select().from(costLedger).where(eq(costLedger.runId, runId))).toEqual([]);
    const [run] = await n.ctx.db.select().from(runs).where(eq(runs.id, runId));
    expect(Number(run!.costMicros)).toBe(0);
    expect(run!.tokensIn + run!.tokensOut).toBe(0);
  });
  it('the trusted worker token still records cost (in-process behaviour is unchanged)', async () => {
    const runId = await newRun();
    const token = n.services.control.issueToken(runId, 'w1');
    const res = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/steps`,
      token,
      payload: stepBody({ costMicros: 1234, tokensIn: 10, tokensOut: 5 }),
    });
    expect(res.statusCode).toBe(204);
    const [run] = await n.ctx.db.select().from(runs).where(eq(runs.id, runId));
    expect(Number(run!.costMicros)).toBe(1234);
  });
  it('bounds numbers, names and payload sizes', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const post = (payload: object) =>
      n.req({ method: 'POST', url: `/v1/worker/runs/${runId}/steps`, token: s.token, payload });
    for (const bad of [
      { costMicros: 1e13 },
      { tokensIn: 1e10 },
      { durationMs: 1e10 },
      { provider: 'x'.repeat(101) },
      { name: 'x'.repeat(501) },
    ])
      expect((await post(stepBody(bad))).statusCode, JSON.stringify(bad)).toBe(400);
    const big = { text: 'x'.repeat(200_000) };
    expect(
      (
        await post(
          stepBody({ kind: 'tool_call', name: 'n'.repeat(400).slice(0, 300), output: big }),
        )
      ).statusCode,
    ).toBeLessThan(500);
    const rows = await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    const stored = rows.at(-1)!;
    expect(stored.output).toMatchObject({ truncated: true });
    expect(stored.name.length).toBeLessThanOrEqual(200);
  });
});

describe('node-influenced data is scrubbed', () => {
  it('gate args, approval args, results and failures never keep a handed-out value', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await creds(runId, s.token, 'research');
    const leak = 'token=mail-secret-1 and hook-secret-1';
    const gate = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/gate`,
      token: s.token,
      payload: {
        agentId: 'research',
        call: { server: 'jira', tool: 'get_issue', args: { q: leak } },
      },
    });
    expect(gate.statusCode).toBe(200);
    await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/approvals`,
      token: s.token,
      payload: {
        agentId: 'research',
        call: { server: 'jira', tool: 'get_issue', args: { q: leak } },
      },
    });
    const post = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/handover/result`,
      token: s.token,
      payload: {
        agentId: 'research',
        format: 'json',
        content: JSON.stringify({ ok: true, note: leak }),
        json: { ok: true, note: leak },
        failure: { status: 'failed', code: 'x', message: `boom ${leak}` },
      },
    });
    expect(post.statusCode).toBe(204);
    const result = await n.services.runNodes.resultOf(s.sessionId);
    const dump = JSON.stringify(result) + JSON.stringify(await auditOf(runId));
    const approvals = JSON.stringify(
      await n.ctx.db.query?.approvals?.findMany?.({}).catch(() => []),
    );
    for (const v of ['mail-secret-1', 'hook-secret-1']) {
      expect(dump).not.toContain(v);
      expect(approvals).not.toContain(v);
    }
    expect(result).toMatchObject({ agentId: 'research' });
    // the result is deleted when it was read
    expect(await n.services.runNodes.resultOf(s.sessionId)).toBeNull();
  });
});

describe('sessions are bound to the orchestrator that created them', () => {
  it('a takeover of the run kills the old session', async () => {
    const runId = await newRun();
    const s = await session(runId);
    expect((await creds(runId, s.token, 'research')).statusCode).toBe(200);
    await n.ctx.db.update(runs).set({ lockedBy: 'w2' }).where(eq(runs.id, runId));
    const dead = await n.req({
      method: 'GET',
      url: `/v1/worker/runs/${runId}/status`,
      token: s.token,
    });
    expect(dead.statusCode).toBe(409);
    expect(dead.json().error).toBe('invalid_state');
    const s2 = await n.services.runNodes.createSession(runId, 'w2', {
      agentId: 'research',
      input: null,
      timeoutSeconds: 10,
      runner: 'container',
      image: IMAGE,
    });
    expect(
      (await n.req({ method: 'GET', url: `/v1/worker/runs/${runId}/status`, token: s2.token }))
        .statusCode,
    ).toBe(200);
  });
});

describe('handles and plaintext do not live in one process', () => {
  it('persists handles in the session and revokes them from a fresh service instance', async () => {
    const revoked: string[] = [];
    const { RunNodesService } = await import('../src/services/run-nodes.js');
    const source = {
      name: 'dynamic',
      issue: async (ref: string) => ({ value: `v-${ref}`, handle: `h-${ref}` }),
      revoke: async (h: string) => void revoked.push(h),
    };
    const svc = new RunNodesService(
      n.ctx,
      n.services.audit,
      n.services.agents,
      n.services.catalog,
      source,
    );
    const runId = await newRun();
    const s = await svc.createSession(runId, 'w1', {
      agentId: 'research',
      input: null,
      timeoutSeconds: 10,
      runner: 'container',
      image: IMAGE,
    });
    const claims = (await import('@openagentix/core')).verifyRunToken(RUN_TOKEN_SECRET, s.token);
    const out = await svc.issueCredentials(claims, runId, 'research');
    expect(out.credentials[0]!.value).toBe('v-mail-hook');
    const [row] = await n.ctx.db
      .select()
      .from(runNodeSessions)
      .where(eq(runNodeSessions.id, s.sessionId));
    expect([...row!.credentialHandles].sort()).toEqual(['h-mail-hook', 'h-trivy-hook']);
    const fresh = new RunNodesService(
      n.ctx,
      n.services.audit,
      n.services.agents,
      n.services.catalog,
      source,
    );
    await fresh.revoke(s.sessionId, 'step_end');
    expect(revoked.sort()).toEqual(['h-mail-hook', 'h-trivy-hook']);
    // a dynamic source's values are not re-resolved for scrubbing (only the static source is)
    expect(await fresh.knownSecrets(runId)).toEqual([]);
    // nothing secret sits in memory of the service
    expect(Object.values(svc).some((v) => v instanceof Map)).toBe(false);
  });
  it('a fresh instance can scrub static values (no per-process state needed)', async () => {
    const runId = await newRun();
    const s = await session(runId);
    await creds(runId, s.token, 'research');
    const { RunNodesService } = await import('../src/services/run-nodes.js');
    const fresh = new RunNodesService(
      n.ctx,
      n.services.audit,
      n.services.agents,
      n.services.catalog,
    );
    expect((await fresh.knownSecrets(runId)).sort()).toEqual(['hook-secret-1', 'mail-secret-1']);
    expect(
      await fresh.knownSecrets('00000000-0000-4000-8000-0000000000bb').catch(() => 'err'),
    ).toBeDefined();
  });
});

describe('the handover carries only what is left of the budget', () => {
  it('subtracts consumption and elapsed time', async () => {
    const runId = await newRun();
    await n.ctx.db
      .update(runs)
      .set({
        tokensIn: 100,
        tokensOut: 50,
        costMicros: 250_000,
        toolCalls: 4,
        lastSeq: 12,
        startedAt: new Date(Date.now() - 30_000),
      })
      .where(eq(runs.id, runId));
    const s = await session(runId);
    const h = (
      await n.req({
        method: 'GET',
        url: `/v1/worker/runs/${runId}/handover?agentId=research`,
        token: s.token,
      })
    ).json();
    expect(h.run.budget).toMatchObject({
      maxTokens: 850,
      maxCostUsd: 0.75,
      maxToolCalls: 6,
      maxSteps: 38,
    });
    expect(h.run.budget.timeoutSeconds).toBeLessThanOrEqual(70);
    expect(h.run.budget.timeoutSeconds).toBeGreaterThan(60);
  });
  it('never hands out zero or negative limits (floor of the smallest legal value)', async () => {
    const runId = await newRun();
    await n.ctx.db
      .update(runs)
      .set({
        tokensIn: 5000,
        costMicros: 5_000_000,
        toolCalls: 99,
        lastSeq: 999,
        startedAt: new Date(Date.now() - 10_000_000),
      })
      .where(eq(runs.id, runId));
    const s = await session(runId);
    const h = (
      await n.req({
        method: 'GET',
        url: `/v1/worker/runs/${runId}/handover?agentId=research`,
        token: s.token,
      })
    ).json();
    expect(h.run.budget).toMatchObject({
      maxTokens: 1,
      maxToolCalls: 1,
      maxSteps: 1,
      timeoutSeconds: 1,
    });
    expect(h.run.budget.maxCostUsd).toBeGreaterThan(0);
  });
});

describe('step egress is bounded by the operator ceiling at publish', () => {
  it('refuses egress outside OAX_CONTAINER_EGRESS_ALLOW and accepts what is inside', async () => {
    const mk = (egress: string, name: string) =>
      SOURCE.replace('name: broker-agent', `name: ${name}`).replace(
        'egress: [jira.example.org]',
        `egress: [${egress}]`,
      );
    for (const [i, bad] of ['evil.example.com', '10.0.0.0/8', '"*.com"', '0.0.0.0/1'].entries()) {
      const a = await n.req({
        method: 'POST',
        url: '/v1/agents',
        payload: { source: mk(bad, `egress-bad-${i}`) },
      });
      expect(a.statusCode, a.body).toBe(201);
      const pub = await n.req({ method: 'POST', url: `/v1/agents/${a.json().id}/publish` });
      expect(pub.statusCode, bad).toBe(400);
      expect(pub.body).toContain('runtime.egress');
    }
    const ok = await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: mk('jira.example.org, "*.corp.example"', 'egress-ok') },
    });
    expect(
      (await n.req({ method: 'POST', url: `/v1/agents/${ok.json().id}/publish` })).statusCode,
    ).toBe(201);
  });
});

describe('what a node may report, and who said it', () => {
  const post = (runId: string, token: string, payload: object) =>
    n.req({ method: 'POST', url: `/v1/worker/runs/${runId}/steps`, token, payload });
  it.each(['condition', 'handover', 'control', 'policy_decision', 'approval'])(
    'ignores a %s step reported by a node (no row, no audit entry)',
    async (kind) => {
      const runId = await newRun();
      const s = await session(runId);
      const res = await post(runId, s.token, {
        kind,
        agentId: 'research',
        name: 'when',
        status: kind === 'condition' ? 'skipped' : 'error',
        output: { when: 'x', reason: 'forged' },
      });
      expect(res.statusCode).toBe(204);
      expect(await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, runId))).toEqual([]);
      const forged = (await auditOf(runId)).filter((e) =>
        /^(step|condition|handover)\./.test(e.action),
      );
      expect(forged).toEqual([]);
    },
  );
  it('records model_call, tool_call, output and error with provenance', async () => {
    const runId = await newRun();
    const s = await session(runId);
    for (const kind of ['model_call', 'tool_call', 'output', 'error'])
      expect(
        (await post(runId, s.token, { kind, agentId: 'research', name: kind, status: 'ok' }))
          .statusCode,
      ).toBe(204);
    const rows = await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(rows.map((r) => r.kind).sort()).toEqual(['error', 'model_call', 'output', 'tool_call']);
    expect(rows.every((r) => r.reportedBy === `node:${s.nodeId}`)).toBe(true);
    const entries = (
      await n.req({ method: 'GET', url: `/v1/audit?runId=${runId}&limit=200` })
    ).json().items as {
      action: string;
      actor: string;
      payload: { reportedBy?: string };
    }[];
    const derived = entries.filter((e) => e.action.startsWith('step.'));
    expect(derived).toHaveLength(4);
    expect(
      derived.every(
        (e) => e.actor === `node:${s.nodeId}` && e.payload.reportedBy === `node:${s.nodeId}`,
      ),
    ).toBe(true);
  });
  it('steps of the trusted worker carry no node provenance', async () => {
    const runId = await newRun();
    const token = n.services.control.issueToken(runId, 'w1');
    expect(
      (
        await post(runId, token, {
          kind: 'condition',
          agentId: 'research',
          name: 'when',
          status: 'skipped',
          output: { when: 'x' },
        })
      ).statusCode,
    ).toBe(204);
    const [row] = await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(row).toMatchObject({ kind: 'condition', reportedBy: null });
    expect((await auditOf(runId)).some((e) => e.action === 'step.skipped')).toBe(true);
  });
});
