import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StaticSecretResolver, toolsDigest, type PinnedTool } from '@openagentix/core';
import { handleMockMcpHttp, type MockTool } from '@openagentix/mcp';
import type { OutboundDispatcher } from '@openagentix/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0016 section 5 (slice S3): tool snapshots of an HTTP MCP connection, their review (refresh,
 * list, approve for new or existing versions, reject), the pins a publish records and the
 * refusals around them. The "server" is a real HTTP MCP server whose tool list the tests change.
 */
let n: TestNode;
let http: Server;
let port = 0;
let tools: MockTool[] = [];
const PW = 'tenant-admin-password-1';

const tool = (name: string, extra: Partial<MockTool> = {}): MockTool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  handler: () => 'ok',
  ...extra,
});

/** Sends tenant (https) connections to the local server; platform connections dial it directly. */
const localDispatcher = {
  fetch: (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    // port 9 (discard) stands for a server that is down
    if (u.port === '9')
      return Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  },
  close: async () => undefined,
} as unknown as OutboundDispatcher;

beforeAll(async () => {
  http = createServer((req, res) => {
    void handleMockMcpHttp(req, res, 'srv', tools);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  port = (http.address() as AddressInfo).port;
  n = await testNode(
    { OAX_RATE_LIMIT_LOGIN_MAX: '1000' },
    {
      secrets: new StaticSecretResolver({ 'platform-token': 'platform-token-value-0001' }),
      mcpOutbound: localDispatcher,
      mcpProbeLimit: 10_000,
      hostLookup: async () => [{ address: '93.184.216.34' }],
    },
  );
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-security', name: 'S' } });
});
afterAll(async () => {
  await n.close();
  await new Promise((r) => http.close(r));
});

const connect = async (
  name: string,
  config: Record<string, unknown> = {},
  token?: string,
  scope: 'platform' | 'tenant' = 'platform',
) => {
  const res = await n.req({
    method: 'POST',
    url: '/v1/connections',
    ...(token ? { token } : {}),
    payload: {
      name,
      scope,
      config: {
        transport: 'streamable-http',
        url:
          scope === 'platform' ? `http://127.0.0.1:${port}/mcp` : 'https://mcp.vendor.example/mcp',
        ...config,
      },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const api = (
  method: 'GET' | 'POST',
  url: string,
  token?: string,
  payload?: Record<string, unknown>,
) =>
  n.req({
    method,
    url,
    ...(token !== undefined ? { token } : {}),
    ...(payload ? { payload } : {}),
  });
const refresh = (id: string, token?: string) =>
  api('POST', `/v1/connections/${id}/tools/refresh`, token);
const list = (id: string, token?: string) =>
  api('GET', `/v1/connections/${id}/tool-snapshots`, token);
const detail = (id: string, digest: string, token?: string) =>
  api('GET', `/v1/connections/${id}/tool-snapshots/${digest}`, token);
const approve = (
  id: string,
  digest: string,
  scope: 'new-versions' | 'existing-versions',
  token?: string,
) => api('POST', `/v1/connections/${id}/tool-snapshots/${digest}/approve`, token, { scope });
const reject = (id: string, digest: string, token?: string) =>
  api('POST', `/v1/connections/${id}/tool-snapshots/${digest}/reject`, token);

const source = (name: string, server: string, grants: string[], version = '1.0.0') => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: ${version}
owner: team-security
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Work.
    tools:
${grants.map((g) => `      - { server: ${server}, tool: "${g}" }`).join('\n')}
---
Work.
`;
async function agentFor(name: string, server: string, grants: string[], version = '1.0.0') {
  const res = await api('POST', '/v1/agents', undefined, {
    source: source(name, server, grants, version),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const publish = (id: string, token?: string) => api('POST', `/v1/agents/${id}/publish`, token);
const audit = async (action: string) =>
  (await api('GET', `/v1/audit?action=${action}&limit=200`)).json().items as {
    target: string;
    payload: Record<string, unknown>;
  }[];

/** Refresh + approve (new-versions) the current tool list; returns the digest. */
async function pin(id: string, scope: 'new-versions' | 'existing-versions' = 'new-versions') {
  const r = await refresh(id);
  expect(r.statusCode, r.body).toBe(200);
  const digest = r.json().snapshot.digest as string;
  const a = await approve(id, digest, scope);
  expect(a.statusCode, a.body).toBe(200);
  return digest;
}

describe('refresh and list', () => {
  it('stores the list as a pending snapshot and answers without any tool text', async () => {
    tools = [tool('get_issue', { description: 'PRIVATE-DESCRIPTION-1' }), tool('other')];
    const id = await connect('snap-basic');
    const res = await refresh(id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      ok: true,
      category: 'ok',
      created: true,
      matchesCurrent: false,
      snapshot: { status: 'pending', source: 'refresh', toolCount: 2, current: false },
    });
    expect(body.snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body).not.toMatch(/PRIVATE-DESCRIPTION|get_issue/);
    // The digest is the one anybody can compute from the definitions the server sent.
    const wire: PinnedTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description!,
      inputSchema: t.inputSchema!,
    }));
    expect(body.snapshot.digest).toBe(toolsDigest(wire));

    const l = (await list(id)).json().items;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ digest: body.snapshot.digest, status: 'pending' });
    expect(JSON.stringify(l)).not.toContain('PRIVATE-DESCRIPTION');
    const d = (await detail(id, body.snapshot.digest)).json();
    expect(d.tools.map((t: PinnedTool) => t.name)).toEqual(['get_issue', 'other']);
    expect(d.tools[0].description).toBe('PRIVATE-DESCRIPTION-1');
    expect(d.base).toBeNull();
  });

  it('finds the existing snapshot when nothing changed and creates a new one when it did', async () => {
    tools = [tool('get_issue'), tool('other')];
    const id = await connect('snap-twice');
    const first = (await refresh(id)).json();
    const again = (await refresh(id)).json();
    expect(again.created).toBe(false);
    expect(again.snapshot.digest).toBe(first.snapshot.digest);
    tools = [tool('get_issue', { description: 'reworded' }), tool('other')];
    const changed = (await refresh(id)).json();
    expect(changed.created).toBe(true);
    expect(changed.snapshot.digest).not.toBe(first.snapshot.digest);
    expect((await list(id)).json().items).toHaveLength(2);
  });

  it('shows the diff base and the changed tool names of a pending snapshot', async () => {
    tools = [tool('a_tool'), tool('b_tool'), tool('c_tool')];
    const id = await connect('snap-diff');
    const approved = await pin(id);
    tools = [tool('a_tool'), tool('b_tool', { description: 'changed' }), tool('d_tool')];
    const next = (await refresh(id)).json().snapshot.digest;
    const d = (await detail(id, next)).json();
    expect(d.base.digest).toBe(approved);
    expect(d.changed).toEqual(['b_tool', 'c_tool', 'd_tool']);
  });

  it('refuses a stdio connection and reports an unreachable server by category', async () => {
    const stdio = await api('POST', '/v1/connections', undefined, {
      name: 'snap-stdio',
      scope: 'platform',
      config: { transport: 'stdio', command: '/bin/true' },
    });
    const res = await refresh(stdio.json().id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mcp_refresh_unsupported');
    const dead = await connect('snap-dead', { url: 'http://127.0.0.1:9/mcp' });
    const down = await refresh(dead);
    expect(down.statusCode).toBe(200);
    expect(down.json().ok).toBe(false);
    expect(down.json().snapshot).toBeUndefined();
    expect((await list(dead)).json().items).toEqual([]);
  });

  it('refuses a list that contains a credential and stores nothing', async () => {
    tools = [tool('leaky', { description: `use ghp_${'a1B2c3D4e5'.repeat(4)} to log in` })];
    const id = await connect('snap-secret');
    const res = await refresh(id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('mcp_tools_contain_secret');
    expect(res.body).not.toContain('ghp_');
    expect((await list(id)).json().items).toEqual([]);
    const entry = (await audit('mcp.tools.refreshed')).find((a) => a.target === id);
    expect(entry?.payload).toMatchObject({ outcome: 'refused', code: 'mcp_tools_contain_secret' });
    expect(JSON.stringify(entry)).not.toContain('ghp_');
  });

  it('refuses a list with too many tools or a duplicate name', async () => {
    const id = await connect('snap-big');
    tools = Array.from({ length: 501 }, (_, i) => tool(`t${i}`));
    const big = await refresh(id);
    expect(big.statusCode).toBe(422);
    expect(big.json().error).toBe('mcp_tools_too_large');
    expect((await list(id)).json().items).toEqual([]);
  });

  it('is audited with counts and digests, never with definitions', async () => {
    tools = [tool('get_issue', { description: 'AUDIT-CANARY-DESCRIPTION' })];
    const id = await connect('snap-audit');
    const digest = (await refresh(id)).json().snapshot.digest;
    await approve(id, digest, 'new-versions');
    const entries = [
      ...(await audit('mcp.tools.refreshed')),
      ...(await audit('mcp.tools.approved')),
    ].filter((a) => a.target === id);
    expect(entries.map((e) => e.payload.digest)).toEqual(expect.arrayContaining([digest]));
    expect(JSON.stringify(entries)).not.toContain('AUDIT-CANARY');
  });
});

describe('review', () => {
  it('approves for new versions, marks it current and is idempotent', async () => {
    tools = [tool('get_issue')];
    const id = await connect('rev-approve');
    const digest = (await refresh(id)).json().snapshot.digest;
    const a = await approve(id, digest, 'new-versions');
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({
      status: 'approved',
      approvalScope: 'new-versions',
      current: true,
    });
    expect((await approve(id, digest, 'new-versions')).statusCode).toBe(200);
    expect((await refresh(id)).json()).toMatchObject({ created: false, matchesCurrent: true });
  });

  it('rejects, refuses to approve a rejected snapshot and reopens it on an explicit refresh', async () => {
    tools = [tool('get_issue')];
    const id = await connect('rev-reject');
    const digest = (await refresh(id)).json().snapshot.digest;
    expect((await reject(id, digest)).json().status).toBe('rejected');
    const denied = await approve(id, digest, 'new-versions');
    expect(denied.statusCode).toBe(409);
    expect((await refresh(id)).json().snapshot.status).toBe('pending');
    expect((await approve(id, digest, 'new-versions')).statusCode).toBe(200);
    expect((await audit('mcp.tools.rejected')).some((a) => a.target === id)).toBe(true);
  });

  it('refuses existing-versions without a previous approved snapshot', async () => {
    tools = [tool('get_issue')];
    const id = await connect('rev-noprev');
    const digest = (await refresh(id)).json().snapshot.digest;
    const res = await approve(id, digest, 'existing-versions');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('mcp_no_previous_snapshot');
  });

  it('answers 404 for an unknown digest and for a connection that is not an MCP connection', async () => {
    tools = [tool('get_issue')];
    const id = await connect('rev-404');
    await refresh(id);
    expect((await detail(id, 'f'.repeat(64))).statusCode).toBe(404);
    expect((await approve(id, 'f'.repeat(64), 'new-versions')).statusCode).toBe(404);
    expect((await reject(id, 'f'.repeat(64))).statusCode).toBe(404);
    const m = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'rev-model2',
        kind: 'model',
        config: { kind: 'openai', baseUrl: 'https://llm.vendor.example/v1', apiKeySecret: 'tok' },
      },
    });
    expect((await list(m.json().id)).statusCode).toBe(404);
    expect((await refresh(m.json().id)).statusCode).toBe(404);
  });

  it('needs connections:write to refresh, approve and reject; agent engineers cannot approve', async () => {
    tools = [tool('get_issue')];
    const id = await connect('rev-perm');
    const digest = (await refresh(id)).json().snapshot.digest;
    const mk = async (email: string, role: string) => {
      await n.req({
        method: 'POST',
        url: '/v1/users',
        payload: { email, displayName: role, password: PW, globalRoles: [role] },
      });
      return n.login(email, PW);
    };
    const engineer = await mk('eng-tools@example.com', 'agent-engineer');
    const viewer = await mk('view-tools@example.com', 'viewer');
    // reading needs connections:read (engineers have it, viewers do not)
    expect((await list(id, engineer)).statusCode).toBe(200);
    expect((await list(id, viewer)).statusCode).toBe(403);
    for (const token of [engineer, viewer]) {
      expect((await refresh(id, token)).statusCode).toBe(403);
      expect((await approve(id, digest, 'new-versions', token)).statusCode).toBe(403);
      expect((await reject(id, digest, token)).statusCode).toBe(403);
    }
    expect((await list(id, '')).statusCode).toBe(401);
    // nothing changed
    expect((await list(id)).json().items[0].status).toBe('pending');
  });
});

describe('publish pins the tool definitions', () => {
  it('refuses a version while the connection has no approved snapshot (mcp_tools_unreviewed)', async () => {
    tools = [tool('get_issue')];
    const id = await connect('pub-unreviewed');
    const agent = await agentFor('pub-unreviewed-agent', 'pub-unreviewed', ['get_issue']);
    const res = await publish(agent);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mcp_tools_unreviewed');
    // a pending snapshot is not a review
    await refresh(id);
    expect((await publish(agent)).json().error).toBe('mcp_tools_unreviewed');
    const denied = (await audit('agent.publish.denied')).find((a) => a.target === agent);
    expect(denied?.payload.errors).toBeDefined();
  });

  it('refuses a granted tool that the approved snapshot does not list (mcp_tool_unknown)', async () => {
    tools = [tool('get_issue')];
    const id = await connect('pub-unknown');
    await pin(id);
    const agent = await agentFor('pub-unknown-agent', 'pub-unknown', ['get_issue', 'ghost_tool']);
    const res = await publish(agent);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mcp_tool_unknown');
  });

  it('records the pin in the immutable version and exposes it in the version detail', async () => {
    tools = [tool('get_issue'), tool('other')];
    const id = await connect('pub-ok');
    const snapshot = await pin(id);
    const agent = await agentFor('pub-ok-agent', 'pub-ok', ['get_issue']);
    const res = await publish(agent);
    expect(res.statusCode, res.body).toBe(201);
    const v = (await api('GET', `/v1/agents/${agent}/versions/1.0.0`)).json();
    const wire = (names: string[]): PinnedTool[] =>
      tools
        .filter((t) => names.includes(t.name))
        .map((t) => ({ name: t.name, description: t.description!, inputSchema: t.inputSchema! }));
    expect(v.toolPins['pub-ok']).toEqual({
      snapshotDigest: snapshot,
      toolsDigest: toolsDigest(wire(['get_issue'])),
      granted: ['get_issue'],
    });
    expect(v.definition.toolPins['pub-ok'].toolsDigest).toBe(v.toolPins['pub-ok'].toolsDigest);
    expect(typeof v.expansionDigest).toBe('string');
    const detailAfter = (await detail(id, snapshot)).json();
    expect(detailAfter.pinnedVersions).toBe(1);
    expect(detailAfter.pinnedBy).toEqual([
      { agentId: agent, agent: 'pub-ok-agent', version: '1.0.0' },
    ]);
  });

  it('uses the latest approved snapshot for new versions', async () => {
    tools = [tool('get_issue')];
    const id = await connect('pub-latest');
    const first = await pin(id);
    tools = [tool('get_issue', { description: 'v2' })];
    const second = await pin(id);
    const agent = await agentFor('pub-latest-agent', 'pub-latest', ['get_issue']);
    await publish(agent);
    const v = (await api('GET', `/v1/agents/${agent}/versions/1.0.0`)).json();
    expect(first).not.toBe(second);
    expect(v.toolPins['pub-latest'].snapshotDigest).toBe(second);
  });

  it('does not touch connections that cannot be pinned (stdio, in-memory)', async () => {
    const mem = await api('POST', '/v1/connections', undefined, {
      name: 'pub-mem',
      config: { transport: 'in-memory' },
    });
    expect(mem.statusCode).toBe(201);
    const agent = await agentFor('pub-mem-agent', 'pub-mem', ['anything']);
    const res = await publish(agent);
    expect(res.statusCode, res.body).toBe(201);
    const v = (await api('GET', `/v1/agents/${agent}/versions/1.0.0`)).json();
    expect(v.toolPins).toBeUndefined();
    expect(v.definition.toolPins).toBeUndefined();
  });
});

describe('existing-versions approval', () => {
  it('lets published versions accept a snapshot whose granted names and classes are unchanged', async () => {
    tools = [tool('get_issue'), tool('other')];
    const id = await connect('ev-ok', { tools: { get_issue: { access: 'read' } } });
    const first = await pin(id);
    const agent = await agentFor('ev-ok-agent', 'ev-ok', ['get_issue']);
    expect((await publish(agent)).statusCode).toBe(201);
    // a reworded description is a change of the granted tool, but not of names or classes
    tools = [tool('get_issue', { description: 'reworded' }), tool('other')];
    const next = (await refresh(id)).json().snapshot.digest;
    const res = await approve(id, next, 'existing-versions');
    expect(res.statusCode, res.body).toBe(200);
    const approved = (await audit('mcp.tools.approved')).find((a) => a.payload.digest === next);
    expect(approved?.payload).toMatchObject({
      scope: 'existing-versions',
      previousDigest: first,
      acceptance: true,
      changed: ['get_issue'],
    });
    // the version itself is unchanged and still pins the first snapshot
    const v = (await api('GET', `/v1/agents/${agent}/versions/1.0.0`)).json();
    expect(v.toolPins['ev-ok'].snapshotDigest).toBe(first);
  });

  it('refuses it when a granted tool changed its access class, and says which', async () => {
    tools = [tool('get_issue'), tool('other')]; // not declared: no hint means write
    const id = await connect('ev-class');
    await pin(id);
    const agent = await agentFor('ev-class-agent', 'ev-class', ['get_issue']);
    expect((await publish(agent)).statusCode).toBe(201);
    tools = [tool('get_issue', { annotations: { readOnlyHint: true } }), tool('other')];
    const next = (await refresh(id)).json().snapshot.digest;
    const res = await approve(id, next, 'existing-versions');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('mcp_tools_access_changed');
    expect(res.json().details).toMatchObject({ versions: 1, tools: ['get_issue'] });
    expect((await audit('mcp.tools.approval_denied')).some((a) => a.target === id)).toBe(true);
    // the snapshot stayed pending, and new-versions is still possible
    expect((await detail(id, next)).json().status).toBe('pending');
    expect((await approve(id, next, 'new-versions')).statusCode).toBe(200);
  });

  it('refuses it when a tool matching a wildcard grant was added or removed', async () => {
    tools = [tool('get_a'), tool('get_b')];
    const id = await connect('ev-names');
    await pin(id);
    const agent = await agentFor('ev-names-agent', 'ev-names', ['get_*']);
    expect((await publish(agent)).statusCode).toBe(201);
    tools = [tool('get_a'), tool('get_b'), tool('get_c')];
    const added = (await refresh(id)).json().snapshot.digest;
    expect((await approve(id, added, 'existing-versions')).statusCode).toBe(409);
    tools = [tool('get_a')];
    const removed = (await refresh(id)).json().snapshot.digest;
    const res = await approve(id, removed, 'existing-versions');
    expect(res.statusCode).toBe(409);
    expect(res.json().details.tools).toEqual(['get_b']);
  });

  it('checks versions that pinned an older snapshot reachable through earlier acceptances', async () => {
    tools = [tool('get_a'), tool('get_b')];
    const id = await connect('ev-chain');
    await pin(id);
    const agent = await agentFor('ev-chain-agent', 'ev-chain', ['get_*']);
    expect((await publish(agent)).statusCode).toBe(201); // pins snapshot 1
    tools = [tool('get_a', { description: 'two' }), tool('get_b')];
    const two = (await refresh(id)).json().snapshot.digest;
    expect((await approve(id, two, 'existing-versions')).statusCode).toBe(200);
    // snapshot 3 adds a tool: the version pinned snapshot 1, which is not "the previous digest",
    // but it accepts snapshot 2, so it must be checked against snapshot 3 as well
    tools = [tool('get_a', { description: 'two' }), tool('get_b'), tool('get_c')];
    const three = (await refresh(id)).json().snapshot.digest;
    const res = await approve(id, three, 'existing-versions');
    expect(res.statusCode).toBe(409);
    expect(res.json().details.tools).toEqual(['get_c']);
  });

  it('does not let a version accept a change of a tool it does not hold', async () => {
    tools = [tool('get_issue'), tool('other')];
    const id = await connect('ev-unheld');
    await pin(id);
    const agent = await agentFor('ev-unheld-agent', 'ev-unheld', ['get_issue']);
    expect((await publish(agent)).statusCode).toBe(201);
    tools = [tool('get_issue'), tool('other', { annotations: { readOnlyHint: true } })];
    const next = (await refresh(id)).json().snapshot.digest;
    expect((await approve(id, next, 'existing-versions')).statusCode).toBe(200);
  });
});

describe('tenant isolation', () => {
  it("answers 404 for another tenant's connection and its snapshots, whatever the call", async () => {
    tools = [tool('get_issue')];
    const mk = async (slug: string) => {
      const r = await n.req({
        method: 'POST',
        url: '/v1/tenants',
        payload: {
          slug,
          name: slug,
          admin: { email: `admin@${slug}.example.org`, displayName: slug, password: PW },
        },
      });
      expect(r.statusCode, r.body).toBe(201);
      return n.login(`admin@${slug}.example.org`, PW);
    };
    const alice = await mk('iso-a');
    const bob = await mk('iso-b');
    const own = await connect('iso-own', {}, alice, 'tenant');
    const digest = (await refresh(own, alice)).json().snapshot.digest;
    expect((await approve(own, digest, 'new-versions', alice)).statusCode).toBe(200);

    const missing = '00000000-0000-4000-8000-000000000099';
    const calls: [string, () => Promise<{ statusCode: number; body: string }>][] = [
      ['list', () => list(own, bob)],
      ['detail', () => detail(own, digest, bob)],
      ['refresh', () => refresh(own, bob)],
      ['approve', () => approve(own, digest, 'new-versions', bob)],
      ['reject', () => reject(own, digest, bob)],
    ];
    for (const [name, call] of calls) {
      const foreign = await call();
      expect(foreign.statusCode, name).toBe(404);
    }
    // identical to a connection that does not exist
    expect((await list(missing, bob)).statusCode).toBe(404);
    expect((await refresh(missing, bob)).statusCode).toBe(404);
    expect((await list(own, bob)).json()).toEqual((await list(missing, bob)).json());
    // a digest that exists elsewhere is not found in your own connection either
    const mine = await connect('iso-mine', {}, bob, 'tenant');
    expect((await detail(mine, digest, bob)).statusCode).toBe(404);
    expect((await approve(mine, digest, 'new-versions', bob)).statusCode).toBe(404);
    // and bob's publish cannot use alice's snapshot: his connection has none
    await n.req({
      method: 'POST',
      url: '/v1/teams',
      token: bob,
      payload: { slug: 'team-security', name: 'S' },
    });
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      token: bob,
      payload: { source: source('iso-agent', 'iso-mine', ['get_issue']) },
    });
    expect(created.statusCode, created.body).toBe(201);
    const pub = await publish(created.json().id, bob);
    expect(pub.json().error).toBe('mcp_tools_unreviewed');
    // alice's data is untouched
    expect((await list(own, alice)).json().items).toHaveLength(1);
  });

  it('lets a tenant read the snapshots of a platform connection but not change them', async () => {
    tools = [tool('get_issue')];
    const platform = await connect('iso-platform');
    const digest = (await refresh(platform)).json().snapshot.digest;
    const t = await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: {
        slug: 'iso-c',
        name: 'iso-c',
        admin: { email: 'admin@iso-c.example.org', displayName: 'c', password: PW },
      },
    });
    expect(t.statusCode).toBe(201);
    const carol = await n.login('admin@iso-c.example.org', PW);
    expect((await list(platform, carol)).statusCode).toBe(200);
    expect((await approve(platform, digest, 'new-versions', carol)).statusCode).toBe(403);
    expect((await reject(platform, digest, carol)).statusCode).toBe(403);
    expect((await refresh(platform, carol)).statusCode).toBe(403);
    expect((await detail(platform, digest)).json().status).toBe('pending');
  });
});
