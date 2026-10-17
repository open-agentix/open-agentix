import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SecretResolver } from '@openagentix/core';
import { handleMockMcpHttp, McpServerConfigSchema, type MockTool } from '@openagentix/mcp';
import type { OutboundDispatcher } from '@openagentix/providers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, connections, runs } from '../src/db/schema.js';
import { connectionCarriesCredentials } from '../src/services/dev-run-gate.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0017 S5: for a development run every credential that is not a scoped secret with its own
 * `usage` counts as production: operator secrets (legacy references), the secrets of stdio MCP
 * connections, static header secrets and OAuth tokens of HTTP connections. They are refused at
 * admission, when a worker claims the run, at issuance and on the relay, unless the policy lets
 * drafts use production credentials.
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
  OAX_MCP_STDIO_COMMANDS: '/opt/mcp/bin/*',
  OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
};
const TOKEN = 'Bearer CANARY-PROD-JIRA-5521';

class Secrets implements SecretResolver {
  async resolve(ref: string): Promise<string> {
    if (ref === 'prod-jira-token') return TOKEN;
    throw new Error(`no secret ${ref}`);
  }
}

const agentSource = (name: string, tools: string, creds = '') => `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: ${name}
version: 1.0.0
owner: nobody
runtime:
  runner: container
  egress: [jira.example.org]
budget: { maxTokens: 1000, maxCostUsd: 1, maxSteps: 50, maxToolCalls: 10, timeoutSeconds: 100 }
agents:
  - id: research
    provider: simulated
    model: sim-1
    instructions: Research.
${tools}${creds}
---
`;
const tool = (server: string) => `    tools:\n      - { server: ${server}, tool: get_issue }\n`;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let n: TestNode;
let http: Server;
const upstreamCalls: (string | undefined)[] = [];
let seq = 0;

const policy = async (patch: Json) => {
  const root = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id as string;
  const res = await n.req({
    method: 'PATCH',
    url: `/v1/tenants/${root}/settings/agent-lifecycle`,
    payload: patch,
  });
  expect(res.statusCode, res.body).toBe(200);
};
const loosen = () => policy({ allowDraftRuns: 'on', allowProductionSecretsInDraftRuns: true });
const reset = () => policy({ allowDraftRuns: null, allowProductionSecretsInDraftRuns: null });

async function agent(tools: string, creds = ''): Promise<string> {
  const res = await n.req({
    method: 'POST',
    url: '/v1/agents',
    payload: { source: agentSource(`cred-agent-${++seq}`, tools, creds) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}
const devRun = (agentId: string) =>
  n.req({ method: 'POST', url: `/v1/agents/${agentId}/dev-runs`, payload: { data: {} } });
const finish = (runId: string) =>
  n.ctx.db
    .update(runs)
    .set({ status: 'succeeded', finishedAt: new Date(), lockedBy: null })
    .where(eq(runs.id, runId));
const running = (runId: string) =>
  n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
    })
    .where(eq(runs.id, runId));
const session = (runId: string) =>
  n.services.runNodes.createSession(runId, 'w1', {
    agentId: 'research',
    input: {},
    timeoutSeconds: 30,
    runner: 'container',
    image: IMAGE,
  });
const refusals = async (runId: string) =>
  (await n.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'mcp.relay.refused')))
    .filter((e) => e.runId === runId)
    .map((e) => (e.payload as Json).reason);

beforeAll(async () => {
  const tools: MockTool[] = [
    {
      name: 'get_issue',
      description: 'get',
      inputSchema: { type: 'object' },
      handler: () => 'issue',
    },
  ];
  http = createServer((req, res) => {
    upstreamCalls.push(req.headers.authorization);
    void handleMockMcpHttp(req, res, 'srv', tools);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  const local = {
    fetch: (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
    },
    close: async () => undefined,
  } as unknown as OutboundDispatcher;
  n = await testNode(ENV, { secrets: new Secrets(), mcpOutbound: local, mcpProbeLimit: 10_000 });
  const tenant = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id as string;
  await n.req({
    method: 'PATCH',
    url: `/v1/tenants/${tenant}`,
    payload: { secretRefs: ['prod-jira-token'] },
  });
  const connect = async (name: string, config: Json) => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: { name, scope: 'tenant', config },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const r = await n.req({ method: 'POST', url: `/v1/connections/${id}/tools/refresh` });
    if (r.statusCode === 200 && r.json().snapshot) {
      await n.req({
        method: 'POST',
        url: `/v1/connections/${id}/tool-snapshots/${r.json().snapshot.digest}/approve`,
        payload: { scope: 'new-versions' },
      });
    }
  };
  const httpConfig = (extra: Json) => ({
    transport: 'streamable-http',
    url: 'https://jira.example.org/mcp',
    timeoutMs: 10_000,
    ...extra,
  });
  await connect('prodhttp', httpConfig({ headerSecrets: { authorization: 'prod-jira-token' } }));
  await connect('openhttp', httpConfig({ auth: { kind: 'none' } }));
  const stdio = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'prodstdio',
      scope: 'tenant',
      config: {
        transport: 'stdio',
        command: '/opt/mcp/bin/jira-mcp',
        envSecrets: { JIRA_TOKEN: 'prod-jira-token' },
        tools: { get_issue: { access: 'read' } },
      },
    },
  });
  expect(stdio.statusCode, stdio.body).toBe(201);
}, 120_000);
afterAll(async () => {
  await n?.close();
  await new Promise((r) => http.close(r));
});

describe('connectionCarriesCredentials', () => {
  const url = 'https://jira.example.org/mcp';
  const oauth = {
    kind: 'oauth',
    grant: 'client_credentials',
    client: {
      registration: 'preregistered',
      clientIdSecret: 'cid',
      clientAuth: 'client_secret_basic',
      clientSecretSecret: 'csec',
    },
    issuer: 'https://auth.example.org',
  };
  it.each([
    [
      'stdio with environment secrets',
      { name: 'a', transport: 'stdio', command: '/x', envSecrets: { T: 's' } },
      true,
    ],
    ['stdio without secrets', { name: 'a', transport: 'stdio', command: '/x' }, false],
    [
      'http with static header secrets',
      { name: 'a', transport: 'streamable-http', url, headerSecrets: { a: 's' } },
      true,
    ],
    ['http with OAuth', { name: 'a', transport: 'streamable-http', url, auth: oauth }, true],
    [
      'http with authentication switched off',
      { name: 'a', transport: 'streamable-http', url, auth: { kind: 'none' } },
      false,
    ],
    ['http with no secrets at all', { name: 'a', transport: 'streamable-http', url }, false],
  ])('%s', (_label, cfg, expected) => {
    expect(connectionCarriesCredentials(McpServerConfigSchema.parse(cfg))).toBe(expected);
  });
});

describe('admission', () => {
  it.each([
    ['an HTTP connection with a static header secret', 'prodhttp'],
    ['a stdio connection with environment secrets', 'prodstdio'],
  ])('refuses a draft that uses %s', async (_label, server) => {
    const id = await agent(tool(server));
    const res = await devRun(id);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'production_credentials_in_draft',
      details: { connections: [server] },
    });
    expect(res.body).not.toContain('CANARY');
  });

  it('accepts a connection without credentials', async () => {
    const res = await devRun(await agent(tool('openhttp')));
    expect(res.statusCode, res.body).toBe(202);
    await finish(res.json().id);
  });

  it('accepts credentialed connections where the policy lets drafts use production credentials', async () => {
    await loosen();
    try {
      for (const server of ['prodhttp', 'prodstdio']) {
        const res = await devRun(await agent(tool(server)));
        expect(res.statusCode, `${server}: ${res.body}`).toBe(202);
        await finish(res.json().id);
      }
    } finally {
      await reset();
    }
  });
});

describe('the relay', () => {
  const call = (runId: string, token: string) =>
    n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/mcp/prodhttp`,
      token,
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_issue', arguments: {} },
      },
    });

  it('does not reach a credentialed connection for a run admitted under a looser policy', async () => {
    const id = await agent(tool('prodhttp'));
    await loosen();
    let runId: string;
    try {
      runId = (await devRun(id)).json().id;
    } finally {
      await reset();
    }
    await running(runId);
    const s = await session(runId);
    upstreamCalls.length = 0;
    const res = await call(runId, s.token);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(upstreamCalls).toEqual([]);
    expect(res.body).not.toContain('CANARY');
    expect(await refusals(runId)).toContain('development_credentials');
    await finish(runId);
  });

  it('reaches it where the policy allows production credentials, and a run of a published version is not affected', async () => {
    const id = await agent(tool('prodhttp'));
    await loosen();
    try {
      const runId = (await devRun(id)).json().id as string;
      await running(runId);
      const s = await session(runId);
      upstreamCalls.length = 0;
      const res = await call(runId, s.token);
      expect(res.statusCode, res.body).toBe(200);
      expect(upstreamCalls.length).toBeGreaterThan(0);
      await finish(runId);
    } finally {
      await reset();
    }
  });
});

describe('a claimed run', () => {
  it('is checked again when a worker claims it', async () => {
    const id = await agent(tool('prodhttp'));
    await loosen();
    let runId: string;
    try {
      runId = (await devRun(id)).json().id;
      await running(runId);
      expect((await n.services.control.prepare(runId)).runId).toBe(runId);
    } finally {
      await reset();
    }
    await expect(n.services.control.prepare(runId)).rejects.toMatchObject({
      code: 'production_credentials_in_draft',
    });
    await finish(runId);
  });
});

describe('issuance', () => {
  it('refuses the scoped environment secrets of a credentialed connection too', async () => {
    // a stdio connection whose stored config names a scoped secret (the save rules refuse that, so
    // it is written behind their back): the usage of the secret alone would let it through
    const sec = await n.req({
      method: 'POST',
      url: '/v1/secrets',
      payload: {
        scope: 'tenant',
        name: 'ci-secret',
        value: 'canary-ci-secret-value',
        usage: 'any',
      },
    });
    expect(sec.statusCode, sec.body).toBe(201);
    const created = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'scopedstdio',
        scope: 'tenant',
        config: {
          transport: 'stdio',
          command: '/opt/mcp/bin/jira-mcp',
          envSecrets: { JIRA_TOKEN: 'prod-jira-token' },
          tools: { get_issue: { access: 'read' } },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    await n.ctx.db
      .update(connections)
      .set({
        config: {
          ...(created.json().config as Record<string, unknown>),
          envSecrets: { JIRA_TOKEN: 'tenant:ci-secret' },
        },
      })
      .where(eq(connections.id, created.json().id));
    const id = await agent(tool('scopedstdio'));
    await loosen();
    let runId: string;
    try {
      runId = (await devRun(id)).json().id;
    } finally {
      await reset();
    }
    await running(runId);
    const res = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/credentials`,
      token: (await session(runId)).token,
      payload: { agentId: 'research' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain('production_credentials_in_draft');
    expect(res.body).not.toContain('canary-ci-secret-value');
    await finish(runId);
  });
});
