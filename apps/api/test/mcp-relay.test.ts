import { createServer, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { issueRunToken, type SecretResolver } from '@openagentix/core';
import { handleMockMcpHttp, type MockTool } from '@openagentix/mcp';
import type { OutboundDispatcher } from '@openagentix/providers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvals, connections, runs } from '../src/db/schema.js';
import { RUN_TOKEN_SECRET, testNode, type TestNode } from './helpers.js';

/**
 * ADR 0016 section 6: the control-node MCP relay, tested as a malicious run node would use it.
 * The node holds nothing but its step-scoped run token; everything else must be refused or answered
 * from the control node's own state, and no byte of a header secret may reach any node-visible
 * surface (handover, broker, relay answers, errors, audit, metrics).
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
const PLATFORM_SECRET = 'Bearer CANARY-PLATFORM-7d41c0ffee';
const TENANT_SECRET = 'Bearer CANARY-TENANT-91ab5eed';
const CANARIES = ['CANARY-PLATFORM', 'CANARY-TENANT', '7d41c0ffee', '91ab5eed'];

class MutableSecrets implements SecretResolver {
  constructor(public values: Record<string, string>) {}
  async resolve(ref: string): Promise<string> {
    const v = this.values[ref];
    if (v === undefined) throw new Error(`no secret ${ref} (internal detail)`);
    return v;
  }
}

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
      - { server: jira, tool: echo_auth }
      - { server: jira, tool: echo_url }
      - { server: jira, tool: limited, maxCallsPerRun: 2 }
      - { server: jira, tool: slow }
      - { server: jira, tool: big }
      - { server: jira, tool: risky, approval: required, allowAdditionalArgs: true }
      - { server: crm, tool: lookup }
      - { server: locked, tool: lookup }
  - id: plain
    provider: simulated
    model: sim-1
    instructions: Plain.
---
`;

interface Booted {
  n: TestNode;
  secrets: MutableSecrets;
  seen: { auth: string | undefined; ctx: unknown }[];
  tools: MockTool[];
  close: () => Promise<void>;
  newRun: (token?: string) => Promise<string>;
  session: (
    runId: string,
    agent?: string,
  ) => ReturnType<TestNode['services']['runNodes']['createSession']>;
  relay: (
    runId: string,
    token: string,
    server: string,
    body: unknown,
  ) => ReturnType<TestNode['req']>;
  rpc: (
    runId: string,
    token: string,
    method: string,
    params?: Record<string, unknown>,
    server?: string,
  ) => Promise<{
    status: number;
    // JSON-RPC answers are inspected deeply by the tests; the shape is the wire's, not ours
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: any;
    body: string;
  }>;
  agentId: string;
  failUpstream: (on: boolean) => void;
}

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const secrets = new MutableSecrets({
    'relay-platform-token': PLATFORM_SECRET,
    'relay-tenant-token': TENANT_SECRET,
  });
  const seen: Booted['seen'] = [];
  let lastAuth: string | undefined;
  let lastUrl: string | undefined;
  let failing = false;
  const tool = (name: string, extra: Partial<MockTool> = {}): MockTool => ({
    name,
    description: `does ${name}`,
    inputSchema: { type: 'object' },
    handler: () => `result of ${name}`,
    ...extra,
  });
  const tools: MockTool[] = [
    tool('get_issue'),
    tool('other'),
    tool('echo_auth', { handler: () => `the header was ${lastAuth}` }),
    tool('echo_url', { handler: () => `the url was ${lastUrl}` }),
    tool('slow', { delayMs: 3000 }),
    tool('big', { handler: () => 'a'.repeat(100_000) }),
    tool('risky'),
    tool('lookup'),
    tool('limited'),
  ];
  const http: Server = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    lastUrl = req.url;
    if (failing) {
      // an error page that quotes the credential it was sent
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(`rejected credential ${lastAuth}`);
      return;
    }
    void handleMockMcpHttp(req, res, 'srv', tools);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const port = (http.address() as AddressInfo).port;
  const local = {
    fetch: (url: string | URL, init?: RequestInit, ctx?: unknown) => {
      seen.push({ auth: new Headers(init?.headers).get('authorization') ?? undefined, ctx });
      const u = new URL(String(url));
      return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
    },
    close: async () => undefined,
  } as unknown as OutboundDispatcher;
  const n = await testNode(ENV_WITH(env), { secrets, mcpOutbound: local, mcpProbeLimit: 10_000 });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  const tenant = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id as string;
  await n.req({
    method: 'PATCH',
    url: `/v1/tenants/${tenant}`,
    payload: { secretRefs: ['relay-tenant-token'] },
  });
  const conn = (name: string, scope: 'platform' | 'tenant', extra: Record<string, unknown>) =>
    n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name,
        scope,
        config: {
          transport: 'streamable-http',
          url: `${scope === 'tenant' ? 'https' : 'http'}://${name}.example.org/mcp?api_key=URL-CANARY-5521`,
          timeoutMs: 500,
          maxResultBytes: 2000,
          ...extra,
        },
      },
    });
  const jira = await conn('jira', 'platform', {
    headerSecrets: { authorization: 'relay-platform-token' },
    headers: { 'x-plain': 'plain-value-8841' },
  });
  expect(jira.statusCode, jira.body).toBe(201);
  const crm = await conn('crm', 'tenant', {
    headerSecrets: { authorization: 'relay-tenant-token' },
  });
  expect(crm.statusCode, crm.body).toBe(201);
  const locked = await conn('locked', 'tenant', {
    headerSecrets: { authorization: 'relay-tenant-token' },
  });
  expect(locked.statusCode, locked.body).toBe(201);
  for (const c of [jira, crm, locked]) {
    const id = c.json().id as string;
    const r = await n.req({ method: 'POST', url: `/v1/connections/${id}/tools/refresh` });
    expect(r.statusCode, r.body).toBe(200);
    const a = await n.req({
      method: 'POST',
      url: `/v1/connections/${id}/tool-snapshots/${r.json().snapshot.digest}/approve`,
      payload: { scope: 'new-versions' },
    });
    expect(a.statusCode, a.body).toBe(200);
  }
  // approved with an allowed secret; afterwards the stored connection names one its tenant may not use
  await n.ctx.db
    .update(connections)
    .set({
      config: {
        ...(locked.json().config as Record<string, unknown>),
        headerSecrets: { authorization: 'forbidden-ref' },
      },
    })
    .where(eq(connections.id, locked.json().id));
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: SOURCE } });
  expect(created.statusCode, created.body).toBe(201);
  const agentId = created.json().id as string;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  expect(pub.statusCode, pub.body).toBe(201);

  const newRun = async () => {
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
    return runId;
  };
  const session: Booted['session'] = (runId, agent = 'research') =>
    n.services.runNodes.createSession(runId, 'w1', {
      agentId: agent,
      input: {},
      timeoutSeconds: 30,
      runner: 'container',
      image: IMAGE,
    });
  const relay: Booted['relay'] = (runId, token, server, body) =>
    n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/mcp/${server}`,
      token,
      payload: body as never,
    });
  let nextId = 1;
  const rpc: Booted['rpc'] = async (runId, token, method, params, server = 'jira') => {
    const res = await relay(runId, token, server, {
      jsonrpc: '2.0',
      id: nextId++,
      method,
      ...(params ? { params } : {}),
    });
    return {
      status: res.statusCode,
      json: res.body ? safeJson(res.body) : undefined,
      body: res.body,
    };
  };
  return {
    n,
    secrets,
    seen,
    tools,
    agentId,
    failUpstream: (on) => void (failing = on),
    newRun: newRun as Booted['newRun'],
    session,
    relay,
    rpc,
    close: async () => {
      await n.close();
      await new Promise((r) => http.close(r));
    },
  };
}
const ENV_WITH = (env: Record<string, string>) => ({ ...ENV, ...env });
const safeJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
const noCanary = (text: string) => {
  for (const c of [...CANARIES, 'URL-CANARY-5521', 'plain-value-8841'])
    expect(text, `leaked ${c}`).not.toContain(c);
};

let b: Booted;
beforeAll(async () => {
  b = await boot();
});
afterAll(async () => b.close());

const auditText = async (n: TestNode) =>
  JSON.stringify((await n.req({ method: 'GET', url: '/v1/audit?limit=500' })).json());

describe('what a node is handed', () => {
  it('carries neither header secrets, header values nor the url of an HTTP server', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    const h = await b.n.req({
      method: 'GET',
      url: `/v1/worker/runs/${runId}/handover?agentId=research`,
      token: s.token,
    });
    expect(h.statusCode, h.body).toBe(200);
    noCanary(h.body);
    expect(h.body).not.toContain('jira.example.org');
    expect(h.body).not.toContain('relay-platform-token');
    expect(h.json().http).toEqual({ relay: true });
    const jira = h.json().mcp.find((c: { name: string }) => c.name === 'jira');
    expect(jira).toMatchObject({
      url: 'https://mcp-relay.invalid/',
      headers: {},
      headerSecrets: {},
    });
    expect(jira.egress).toBeUndefined();
    // the pins still arrive (digests only)
    expect(h.json().toolPins.jira.granted).toContain('get_issue');
  });

  it('the broker no longer brokers header secrets, platform connections included', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    const res = await b.n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/credentials`,
      token: s.token,
      payload: { agentId: 'research' },
    });
    expect(res.statusCode, res.body).toBe(200);
    noCanary(res.body);
    expect(res.json().connections).toEqual([]);
    expect(Object.keys(res.json())).not.toContain('headers');
  });
});

describe('POST /v1/worker/runs/{id}/mcp/{server}', () => {
  it('runs initialize, ping, tools/list and tools/call with credentials resolved on the control node', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    b.seen.length = 0;
    const init = await b.rpc(runId, s.token, 'initialize', { protocolVersion: '2025-06-18' });
    expect(init.status, init.body).toBe(200);
    expect(init.json.result.protocolVersion).toBe('2025-06-18');
    expect(init.json.result.capabilities).toEqual({ tools: {} });
    expect((await b.rpc(runId, s.token, 'ping')).json.result).toEqual({});
    const list = await b.rpc(runId, s.token, 'tools/list');
    expect(list.status, list.body).toBe(200);
    // a pinned list is exactly the verified (granted) tools; `other` is not granted
    expect(list.json.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'big',
      'echo_auth',
      'echo_url',
      'get_issue',
      'limited',
      'risky',
      'slow',
    ]);
    const call = await b.rpc(runId, s.token, 'tools/call', {
      name: 'get_issue',
      arguments: { k: 1 },
    });
    expect(call.json.result).toMatchObject({
      content: [{ type: 'text', text: 'result of get_issue' }],
      isError: false,
    });
    // upstream saw the secret, through the dispatcher with purpose mcp and the platform origin
    expect(new Set(b.seen.map((x) => x.auth))).toEqual(new Set([PLATFORM_SECRET]));
    expect(b.seen[0]!.ctx).toMatchObject({ purpose: 'mcp', scope: { origin: 'platform' } });
    // and nothing of it reached the node
    for (const r of [init, list, call]) noCanary(r.body);
  });

  it('the notifications of the client protocol are accepted and do nothing', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    for (const method of ['notifications/initialized', 'notifications/cancelled']) {
      const res = await b.relay(runId, s.token, 'jira', { jsonrpc: '2.0', method });
      expect(res.statusCode, method).toBe(202);
      expect(res.body).toBe('');
    }
  });

  it('redacts a secret the server echoes back: results, errors and the audit stay clean', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    const echo = await b.rpc(runId, s.token, 'tools/call', { name: 'echo_auth', arguments: {} });
    expect(echo.status, echo.body).toBe(200);
    expect(echo.json.result.content[0].text).toContain('the header was');
    noCanary(echo.body);
    noCanary(await auditText(b.n));
  });

  it('redacts an echoed url credential, and secrets even with OAX_REDACT_MODEL_CONTEXT=off', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    // the url query of the stored connection carries a key: the server sees it, the node must not
    const url = await b.rpc(runId, s.token, 'tools/call', { name: 'echo_url', arguments: {} });
    expect(url.status, url.body).toBe(200);
    expect(url.json.result.content[0].text).toContain('the url was /mcp?api_key=');
    noCanary(url.body);
    // switching model-context redaction off is about trusted processes; a relay answer leaves the
    // control node for an untrusted node and stays redacted (a fresh run opens a fresh session)
    const second = await b.newRun();
    const s2 = await b.session(second);
    process.env.OAX_REDACT_MODEL_CONTEXT = 'off';
    try {
      const echo = await b.rpc(second, s2.token, 'tools/call', {
        name: 'echo_auth',
        arguments: {},
      });
      expect(echo.status, echo.body).toBe(200);
      expect(echo.json.result.content[0].text).toContain('the header was');
      noCanary(echo.body);
    } finally {
      delete process.env.OAX_REDACT_MODEL_CONTEXT;
    }
  });

  it('serves a tenant connection with the tenant allowlist and the tenant origin', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    b.seen.length = 0;
    const list = await b.rpc(runId, s.token, 'tools/list', undefined, 'crm');
    expect(list.status, list.body).toBe(200);
    expect(b.seen[0]).toMatchObject({
      auth: TENANT_SECRET,
      ctx: { purpose: 'mcp', scope: { origin: 'tenant' } },
    });
    noCanary(list.body);
  });

  it('a secret the tenant may not use is unavailable, and the answer does not name it', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    const res = await b.rpc(runId, s.token, 'tools/list', undefined, 'locked');
    expect(res.status, res.body).toBe(200);
    expect(res.json.error.data.oaxCode).toBe('mcp_credentials_unavailable');
    expect(res.body).not.toContain('forbidden-ref');
    expect(res.body).not.toContain('internal detail');
  });
});

describe('refusals look alike', () => {
  const unknown = { error: 'not_found', message: 'MCP server not found' };
  const same = (res: { statusCode: number; body: string }, label: string) => {
    const body = JSON.parse(res.body);
    expect(res.statusCode, label).toBe(404);
    expect(Object.keys(body).sort(), label).toEqual(['error', 'message']);
    expect(body, label).toEqual(unknown);
  };
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

  it('an unknown server, a server without a grant, a foreign step and a stale connection', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    same(await b.relay(runId, s.token, 'no-such-server', msg), 'unknown');
    // the other step of the run holds no grant on jira at all
    const plain = await b.session(runId, 'plain');
    same(await b.relay(runId, plain.token, 'jira', msg), 'step without grants');
    // a name the router refuses is no 2xx either (and says nothing about any target)
    expect((await b.relay(runId, s.token, 'X'.repeat(200), msg)).statusCode).toBeGreaterThanOrEqual(
      400,
    );
    same(await b.relay(runId, s.token, '..%2F..%2Fjira', msg), 'path trick');
  });

  it('a forged, expired, revoked, foreign or orchestrator token is refused like an unknown one', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    const other = await b.newRun();
    const otherSession = await b.session(other);
    same(await b.relay(runId, 'oaxrt.forged.token', 'jira', msg), 'forged');
    same(await b.relay(runId, s.token.slice(0, -2) + 'xx', 'jira', msg), 'tampered signature');
    // another run's token against this run's id
    same(await b.relay(runId, otherSession.token, 'jira', msg), 'foreign run');
    // an expired token of a live session
    const expired = issueRunToken(
      RUN_TOKEN_SECRET,
      { runId, workerId: s.nodeId, ttlSeconds: 1, sid: s.sessionId, steps: ['research'] },
      Date.now() - 60_000,
    );
    same(await b.relay(runId, expired, 'jira', msg), 'expired');
    // the orchestrator's own (unscoped) token has no business here
    same(
      await b.relay(runId, b.n.services.control.issueToken(runId, 'w1'), 'jira', msg),
      'orchestrator',
    );
    // a step list that is not exactly one step
    const multi = issueRunToken(
      RUN_TOKEN_SECRET,
      { runId, workerId: s.nodeId, ttlSeconds: 60, sid: s.sessionId, steps: ['research', 'plain'] },
      Date.now(),
    );
    same(await b.relay(runId, multi, 'jira', msg), 'two steps');
    // a live session works, then dies with a revoke and is refused the same way
    expect((await b.relay(runId, s.token, 'jira', msg)).statusCode).toBe(200);
    await b.n.services.runNodes.revoke(s.sessionId, 'step_end');
    same(await b.relay(runId, s.token, 'jira', msg), 'revoked');
    // replay of the same bytes after the revoke
    same(await b.relay(runId, s.token, 'jira', msg), 'replay after revoke');
  });

  it("a finished run's token and a lost lease are refused", async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    await b.n.ctx.db.update(runs).set({ status: 'succeeded' }).where(eq(runs.id, runId));
    same(await b.relay(runId, s.token, 'jira', msg), 'run finished');
    const second = await b.newRun();
    const s2 = await b.session(second);
    await b.n.ctx.db.update(runs).set({ lockedBy: 'w2' }).where(eq(runs.id, second));
    same(await b.relay(second, s2.token, 'jira', msg), 'lease lost');
  });

  it('a connection of another tenant is not reachable, whatever the grant says', async () => {
    // `crm` exists as a tenant connection of the default tenant only. A second tenant's step with a
    // grant on a server of that name gets the same refusal as for a server that does not exist.
    const pw = 'long-password-123';
    const mk = async (slug: string) =>
      b.n.req({
        method: 'POST',
        url: '/v1/tenants',
        payload: {
          slug,
          name: slug,
          admin: { email: `a@${slug}.example.org`, displayName: slug, password: pw },
        },
      });
    expect((await mk('org-relay')).statusCode).toBe(201);
    const tok = await b.n.login('a@org-relay.example.org', pw);
    const src = SOURCE.replace('name: relay-agent', 'name: relay-agent-b');
    await b.n.req({
      method: 'POST',
      url: '/v1/teams',
      token: tok,
      payload: { slug: 'team-ops', name: 'Ops' },
    });
    const created = await b.n.req({
      method: 'POST',
      url: '/v1/agents',
      token: tok,
      payload: { source: src },
    });
    expect(created.statusCode, created.body).toBe(201);
    const ag = created.json().id as string;
    const pub = await b.n.req({ method: 'POST', url: `/v1/agents/${ag}/publish`, token: tok });
    expect(pub.statusCode, pub.body).toBe(201);
    const run = (
      await b.n.req({
        method: 'POST',
        url: `/v1/agents/${ag}/runs`,
        token: tok,
        payload: { data: {} },
      })
    ).json().id as string;
    await b.n.ctx.db
      .update(runs)
      .set({
        status: 'running',
        lockedBy: 'w1',
        startedAt: new Date(),
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(runs.id, run));
    const s = await b.session(run);
    same(await b.relay(run, s.token, 'crm', msg), 'foreign tenant connection');
  });

  it('records why in the audit log, bounded, and never in the answer', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    for (let i = 0; i < 40; i++) await b.relay(runId, s.token, `probe-${i}`, msg);
    const entries = (
      (
        await b.n.req({
          method: 'GET',
          url: `/v1/audit?action=mcp.relay.refused&runId=${runId}&limit=200`,
        })
      ).json().items as { payload: Record<string, unknown> }[]
    ).filter((e) => e.payload.runId === runId);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(20);
    expect(entries[0]!.payload.reason).toBe('not_granted');
  });
});

describe('only the MCP methods on the list', () => {
  let runId: string;
  let token: string;
  beforeAll(async () => {
    runId = await b.newRun();
    token = (await b.session(runId)).token;
  });

  it.each(['sampling/createMessage', 'elicitation/create', 'roots/list'])(
    'does not relay %s (mcp_capability_unsupported)',
    async (method) => {
      const res = await b.rpc(runId, token, method, {});
      expect(res.status).toBe(200);
      expect(res.json.error.data.oaxCode).toBe('mcp_capability_unsupported');
    },
  );

  it.each([
    'resources/list',
    'resources/read',
    'prompts/get',
    'logging/setLevel',
    'completion/complete',
    'tools/../call',
    'TOOLS/CALL',
    'notifications/roots/list_changed',
  ])('refuses %s', async (method) => {
    const res = await b.rpc(runId, token, method, {});
    expect(res.status).toBe(200);
    expect(res.json.error.data.oaxCode).toBe('mcp_method_not_allowed');
  });

  it('refuses a request without an id that would execute, and malformed messages', async () => {
    const calls = b.tools.length;
    expect(calls).toBeGreaterThan(0);
    for (const body of [
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_issue', arguments: {} } },
      { jsonrpc: '2.0', id: 1, method: 'notifications/initialized' },
      { jsonrpc: '1.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', extra: 'field' },
      { jsonrpc: '2.0', id: { a: 1 }, method: 'tools/list' },
      [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      'tools/list',
      null,
    ]) {
      const res = await b.relay(runId, token, 'jira', body);
      expect(res.statusCode, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, JSON.stringify(body)).toBeLessThan(500);
    }
    const bad = await b.n.app.inject({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/mcp/jira`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}',
    });
    expect(bad.statusCode).toBe(400);
    const proto = await b.n.app.inject({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/mcp/jira`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"__proto__":{"x":1}}}',
    });
    expect(proto.statusCode).toBe(400);
  });

  it('refuses tool calls the step has no grant for, with the gate as the reason', async () => {
    const res = await b.rpc(runId, token, 'tools/call', { name: 'other', arguments: {} });
    expect(res.json.error.data.oaxCode).toBe('policy_denied');
    const odd = await b.rpc(runId, token, 'tools/call', { name: '../etc', arguments: {} });
    expect(odd.json.error.data.oaxCode).toBe('mcp_relay_invalid');
    const extra = await b.rpc(runId, token, 'tools/call', {
      name: 'get_issue',
      url: 'http://evil',
    });
    expect(extra.json.error.data.oaxCode).toBe('mcp_relay_invalid');
    const arr = await b.rpc(runId, token, 'tools/call', { name: 'get_issue', arguments: [] });
    expect(arr.json.error.data.oaxCode).toBe('mcp_relay_invalid');
  });

  it('answers a missing token like any other bad one', async () => {
    const res = await b.n.req({
      method: 'POST',
      url: `/v1/worker/runs/${runId}/mcp/jira`,
      token: null,
      payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found', message: 'MCP server not found' });
  });
});

describe('approval and tool pin', () => {
  it('a call that needs approval passes once per granted approval, for exactly its arguments', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    const args = { amount: 5 };
    const refusedCall = await b.rpc(runId, s.token, 'tools/call', {
      name: 'risky',
      arguments: args,
    });
    expect(refusedCall.json.error.data.oaxCode).toBe('approval_required');
    const id = await b.n.services.control.requestApproval(
      runId,
      'research',
      { server: 'jira', tool: 'risky', args },
      [],
    );
    // pending is not enough
    expect(
      (await b.rpc(runId, s.token, 'tools/call', { name: 'risky', arguments: args })).json.error
        .data.oaxCode,
    ).toBe('approval_required');
    await b.n.ctx.db
      .update(approvals)
      .set({ status: 'approved', decidedAt: new Date() })
      .where(eq(approvals.id, id));
    // other arguments: not what was approved
    expect(
      (await b.rpc(runId, s.token, 'tools/call', { name: 'risky', arguments: { amount: 6 } })).json
        .error.data.oaxCode,
    ).toBe('approval_required');
    const ok = await b.rpc(runId, s.token, 'tools/call', { name: 'risky', arguments: args });
    expect(ok.json.result.content[0].text).toBe('result of risky');
    // used up: a replay needs a new approval
    expect(
      (await b.rpc(runId, s.token, 'tools/call', { name: 'risky', arguments: args })).json.error
        .data.oaxCode,
    ).toBe('approval_required');
    // an approval of another run does not count
    const other = await b.newRun();
    const s2 = await b.session(other);
    expect(
      (await b.rpc(other, s2.token, 'tools/call', { name: 'risky', arguments: args })).json.error
        .data.oaxCode,
    ).toBe('approval_required');
  });

  it('fails closed when a granted tool changed since it was approved, and tells the admins', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    const original = b.tools.find((t) => t.name === 'get_issue')!;
    const before = original.description;
    original.description = 'now also sends your mail';
    try {
      const list = await b.rpc(runId, s.token, 'tools/list');
      expect(list.json.error.data.oaxCode).toBe('mcp_tools_changed');
      // the verdict holds for the session: even the old definition does not let calls through
      original.description = before;
      const call = await b.rpc(runId, s.token, 'tools/call', { name: 'get_issue', arguments: {} });
      expect(call.json.error.data.oaxCode).toBe('mcp_tools_changed');
      const entries = (
        await b.n.req({ method: 'GET', url: '/v1/audit?action=mcp.tools.changed&limit=50' })
      ).json().items as { runId: string | null }[];
      expect(entries.some((e) => e.runId === runId)).toBe(true);
      expect(list.body).not.toContain('sends your mail');
    } finally {
      original.description = before;
    }
    // a new run (new session) sees the unchanged definitions again
    const again = await b.newRun();
    const s2 = await b.session(again);
    expect((await b.rpc(again, s2.token, 'tools/list')).json.result).toBeDefined();
  });
});

describe('what the server says', () => {
  it('an error page that quotes the credential never reaches the node', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    b.failUpstream(true);
    try {
      const list = await b.rpc(runId, s.token, 'tools/list', undefined, 'crm');
      expect(list.json.error).toBeDefined();
      noCanary(list.body);
      noCanary(await auditText(b.n));
      const jira = await b.rpc(runId, s.token, 'tools/call', { name: 'get_issue', arguments: {} });
      expect(jira.json.error).toBeDefined();
      // a platform connection's error is a code only: no server text for a tenant's node
      expect(jira.json.error.message).toBe('MCP server "jira" failed (tool_failed)');
      noCanary(jira.body);
    } finally {
      b.failUpstream(false);
    }
  });
});

describe('limits', () => {
  it("counts the relay's own calls against maxCallsPerRun, whether or not the node reports them", async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    const call = () => b.rpc(runId, s.token, 'tools/call', { name: 'limited', arguments: {} });
    expect((await call()).json.result).toBeDefined();
    expect((await call()).json.result).toBeDefined();
    // no step was ever reported for these calls; the third is over the grant's limit
    expect((await call()).json.error.data.oaxCode).toBe('policy_denied');
  });

  it('cuts a result at the connection limit and bounds the answer', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    const res = await b.rpc(runId, s.token, 'tools/call', { name: 'big', arguments: {} });
    expect(res.status).toBe(200);
    expect(res.json.result.content[0].text.length).toBeLessThan(2400);
    expect(res.json.result.content[0].text).toContain('[truncated');
  });

  it('times a long call out at the connection timeout and frees its slot', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    const t0 = Date.now();
    const res = await b.rpc(runId, s.token, 'tools/call', { name: 'slow', arguments: {} });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(res.json.error.data.oaxCode).toBe('tool_timeout');
    // the slot is back: a normal call works at once
    const ok = await b.rpc(runId, s.token, 'tools/call', { name: 'get_issue', arguments: {} });
    expect(ok.json.result).toBeDefined();
  });

  it('exposes the relay in the metrics with closed labels only', async () => {
    const text = await b.n.ctx.metrics.registry.metrics();
    const lines = text.split('\n').filter((l) => l.startsWith('oax_mcp_relay_requests_total{'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toMatch(
        /^oax_mcp_relay_requests_total\{method="(initialize|tools_list|tools_call|other)",outcome="(ok|refused|denied|approval_required|tools_changed|unsupported|rate_limited|busy|timeout|error)"\} \d+$/,
      );
    }
    expect(text).toContain('oax_mcp_relay_sessions');
    noCanary(text);
  });
});

describe('credential versions and sessions', () => {
  it('a rotated secret opens a new session and the old credentials are never used again', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    b.seen.length = 0;
    expect((await b.rpc(runId, s.token, 'tools/list')).json.result).toBeDefined();
    const sessionsBefore = b.n.services.mcpRelay.openSessions;
    b.secrets.values['relay-platform-token'] = 'Bearer CANARY-ROTATED-0042';
    try {
      const echo = await b.rpc(runId, s.token, 'tools/call', { name: 'echo_auth', arguments: {} });
      expect(echo.json.result).toBeDefined();
      expect(b.seen.at(-1)!.auth).toBe('Bearer CANARY-ROTATED-0042');
      expect(echo.body).not.toContain('CANARY-ROTATED');
      expect(b.n.services.mcpRelay.openSessions).toBe(sessionsBefore + 1);
    } finally {
      b.secrets.values['relay-platform-token'] = PLATFORM_SECRET;
    }
  });

  it('closes the relay sessions of a run when its node session is revoked', async () => {
    const runId = await b.newRun();
    const s = await b.session(runId);
    await b.rpc(runId, s.token, 'tools/list');
    const open = b.n.services.mcpRelay.openSessions;
    await b.n.services.runNodes.revokeRun(runId, 'run_completed');
    expect(b.n.services.mcpRelay.openSessions).toBeLessThan(open);
  });
});

describe('per-session concurrency and rate', () => {
  let small: Booted;
  beforeAll(async () => {
    small = await boot({
      OAX_MCP_RELAY_CONCURRENCY: '1',
      OAX_MCP_RELAY_RATE_PER_MINUTE: '6',
      OAX_MCP_RELAY_MAX_REQUEST_BYTES: '2048',
      OAX_MCP_RELAY_BODY_READ_SECONDS: '1',
    });
  });
  afterAll(async () => small.close());

  it('refuses a second call in flight and counts it', async () => {
    const runId = await small.newRun();
    const s = await small.session(runId);
    // the first call to `slow` holds the only slot until the connection timeout
    const first = small.rpc(runId, s.token, 'tools/call', { name: 'slow', arguments: {} });
    await new Promise((r) => setTimeout(r, 150));
    const second = await small.rpc(runId, s.token, 'tools/call', {
      name: 'get_issue',
      arguments: {},
    });
    expect(second.status).toBe(429);
    expect(second.json.error).toBe('mcp_relay_busy');
    expect((await first).json.error.data.oaxCode).toBe('tool_timeout');
  });

  it('refuses calls beyond the rate of the session, per session', async () => {
    const runId = await small.newRun();
    const s = await small.session(runId);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++)
      codes.push(
        (await small.rpc(runId, s.token, 'tools/call', { name: 'get_issue', arguments: {} }))
          .status,
      );
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
    // another run has its own budget
    const other = await small.newRun();
    const s2 = await small.session(other);
    expect(
      (await small.rpc(other, s2.token, 'tools/call', { name: 'get_issue', arguments: {} })).status,
    ).toBe(200);
  });

  it('cuts off a node that trickles its body (slowloris) and keeps serving others', async () => {
    const runId = await small.newRun();
    const s = await small.session(runId);
    const server = await small.n.app.listen({ port: 0, host: '127.0.0.1' });
    const port = Number(new URL(server).port);
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write(
      `POST /v1/worker/runs/${runId}/mcp/jira HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${s.token}\r\n` +
        `content-type: application/json\r\ncontent-length: 60\r\n\r\n{"jsonrpc"`,
    );
    const closed = new Promise<number>((resolve) => {
      const t0 = Date.now();
      sock.once('close', () => resolve(Date.now() - t0));
    });
    // a byte every 300 ms keeps an idle timeout happy; the body deadline is 1 s
    const drip = setInterval(() => sock.write(':'), 300);
    const took = await closed;
    clearInterval(drip);
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(5000);
    // the relay still serves a well-behaved node
    expect((await small.rpc(runId, s.token, 'ping')).status).toBe(200);
  });

  it('refuses an oversized body before it is read', async () => {
    const runId = await small.newRun();
    const s = await small.session(runId);
    const res = await small.relay(runId, s.token, 'jira', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_issue', arguments: { blob: 'x'.repeat(5000) } },
    });
    expect(res.statusCode).toBe(413);
  });
});
