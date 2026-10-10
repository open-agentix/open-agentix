import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connections, runs } from '../src/db/schema.js';
import { egressUnusedWarnings } from '../src/stdio-egress.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0016 slice S2: per-connection egress of stdio MCP servers. Deny by default, the operator's
 * per-program grant that a tenant can only narrow, the air-gapped allowlist, the run-time check
 * and the `egress_unused` lint.
 */
const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
const JIRA = '/opt/mcp/bin/jira-mcp';
const OTHER = '/opt/mcp/bin/other-mcp';
const ENV = {
  OAX_RUNNERS_ENABLED: 'in-process,container',
  OAX_CONTAINER_RUNNER_ENABLED: 'true',
  OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
  OAX_CONTAINER_IMAGE: IMAGE,
  OAX_CONTAINER_NETWORK: 'oax-nodes',
  OAX_NODE_CONTROL_URL: 'http://api:8080',
  OAX_CONTAINER_EGRESS_PROXY_URL: 'http://egress-proxy:3128',
  OAX_CONTAINER_EGRESS_GRANT_SECRET: 'g'.repeat(40),
  OAX_CONTAINER_EGRESS_ALLOW: '*.atlassian.example,api.jira.example',
  OAX_MCP_STDIO_COMMANDS: '/opt/mcp/bin/*',
  OAX_MCP_STDIO_EGRESS: JSON.stringify({ [JIRA]: ['*.atlassian.example', 'api.jira.example'] }),
};
const stdio = (command: string, egress?: string[]) => ({
  transport: 'stdio',
  command,
  ...(egress ? { egress } : {}),
});

let n: TestNode;
const post = (name: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  n.req({ method: 'POST', url: '/v1/connections', payload: { name, config, ...extra } });
const audit = async (action: string) =>
  (await n.req({ method: 'GET', url: `/v1/audit?action=${action}&limit=100` })).json().items as {
    payload: Record<string, unknown>;
  }[];

beforeAll(async () => {
  n = await testNode(ENV);
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
});
afterAll(async () => n.close());

describe('saving a tenant stdio connection with egress', () => {
  it('no egress is the default and means no network', async () => {
    const res = await post('t-none', stdio(JIRA));
    expect(res.statusCode).toBe(201);
    expect(res.json().config.egress).toBeUndefined();
  });

  it('accepts entries inside the operator grant of the program, and narrower ones', async () => {
    expect((await post('t-exact', stdio(JIRA, ['api.jira.example']))).statusCode).toBe(201);
    expect((await post('t-sub', stdio(JIRA, ['acme.atlassian.example']))).statusCode).toBe(201);
    expect((await post('t-same', stdio(JIRA, ['*.atlassian.example']))).statusCode).toBe(201);
  });

  it.each([
    ['a host outside the grant', ['evil.example']],
    ['a look-alike suffix', ['api.jira.example.evil.example']],
    ['a wider wildcard than the grant', ['*.example.com']],
    ['another port than the grant (443)', ['api.jira.example:22']],
    ['the metadata address', ['169.254.169.254']],
    ['a private CIDR', ['10.0.0.0/8']],
    ['loopback', ['127.0.0.1']],
    ['localhost', ['localhost']],
    ['one allowed and one outside entry', ['api.jira.example', 'evil.example']],
  ])('refuses %s with 422 egress_denied', async (_n, egress) => {
    const res = await post(`t-bad-${Math.random().toString(36).slice(2, 8)}`, stdio(JIRA, egress));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('egress_denied');
  });

  it.each([
    ['a scheme', ['https://api.jira.example']],
    ['a path', ['api.jira.example/x']],
    ['a far too broad wildcard', ['*.com']],
    ['a CIDR wider than /8', ['0.0.0.0/0']],
    ['a bad port', ['api.jira.example:99999']],
    ['an empty entry', [' ']],
  ])('refuses a malformed entry (%s) with 400 mcp_egress_invalid', async (_n, egress) => {
    const res = await post(`t-mal-${Math.random().toString(36).slice(2, 8)}`, stdio(JIRA, egress));
    expect(res.statusCode).toBe(400);
  });

  it('a program without an operator grant gets no network, whatever the tenant asks for', async () => {
    const res = await post('t-other', stdio(OTHER, ['api.jira.example']));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('egress_denied');
    expect(res.json().message).toContain('granted no network');
    expect((await post('t-other-none', stdio(OTHER))).statusCode).toBe(201);
  });

  it('updating cannot widen what the grant allows', async () => {
    const id = (await post('t-upd', stdio(JIRA, ['api.jira.example']))).json().id as string;
    const bad = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { config: stdio(JIRA, ['api.jira.example', 'evil.example']) },
    });
    expect(bad.statusCode).toBe(422);
    const ok = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { config: stdio(JIRA, ['x.atlassian.example']) },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('is not widened through the interpreter spelling: the grant belongs to the program file', async () => {
    const res = await post('t-node', {
      transport: 'stdio',
      command: process.execPath,
      args: ['/opt/mcp/bin/other-mcp.js'],
      egress: ['api.jira.example'],
    });
    // not allowlisted as a command either; whichever rule fires first, it is refused
    expect([400, 422]).toContain(res.statusCode);
  });

  it('operator (platform) connections choose their own egress; the grammar still applies', async () => {
    expect(
      (
        await post('p-any', stdio('/opt/platform/x', ['anything.example.org']), {
          scope: 'platform',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await post('p-bad', stdio('/opt/platform/x', ['*.com']), { scope: 'platform' })).statusCode,
    ).toBe(400);
  });
});

describe('run-time: the control node decides the egress of every step', () => {
  let agentId: string;
  const stored = async (name: string, config: Record<string, unknown>) => {
    const [t] = await n.ctx.db.select().from(connections).limit(1);
    await n.ctx.db.insert(connections).values({
      id: crypto.randomUUID(),
      tenantId: t!.tenantId,
      scope: 'tenant',
      scopeId: null,
      name,
      kind: 'mcp',
      config: {
        name,
        tools: {},
        profiles: {},
        args: [],
        env: {},
        envSecrets: {},
        timeoutMs: 30000,
        maxResultBytes: 262144,
        ...config,
      },
      createdBy: t!.createdBy,
    });
    await n.ctx.cache.delPrefix('connections:');
  };
  const agentSource = (name: string, servers: string[]) => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: 1.0.0
owner: team-ops
runtime:
  runner: container
  egress: []
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Work.
    tools:
${servers.map((s) => `      - { server: ${s}, tool: get_issue }`).join('\n')}
    simulation:
      responses:
        - text: done
---
Work.
`;
  const publishAgent = async (name: string, servers: string[]) => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: agentSource(name, servers) },
    });
    const id = created.json().id as string;
    expect((await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` })).statusCode).toBe(201);
    return id;
  };
  const session = async (id: string) => {
    const res = await n.req({
      method: 'POST',
      url: `/v1/agents/${id}/runs`,
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
    return () =>
      n.services.runNodes.createSession(runId, 'w1', {
        agentId: 'a',
        input: {},
        timeoutSeconds: 30,
        runner: 'container',
        image: IMAGE,
      });
  };

  beforeAll(async () => {
    await post('run-good', stdio(JIRA, ['API.Jira.Example', 'x.atlassian.example']));
    await post('run-none', stdio(JIRA));
    // stored before the grant existed (or the grant shrank): outside the grant now
    await stored('run-wide', { transport: 'stdio', command: JIRA, egress: ['evil.example'] });
    await stored('run-nogrant', {
      transport: 'stdio',
      command: OTHER,
      egress: ['api.jira.example'],
    });
    agentId = await publishAgent('egress-good', ['run-good', 'run-none']);
  });

  it('hands the worker exactly the servers that have egress, normalized, for the runner to grant', async () => {
    const created = await (await session(agentId))();
    expect(created.mcpEgress).toEqual([
      { server: 'run-good', egress: ['api.jira.example', 'x.atlassian.example'] },
    ]);
    const started = (await audit('runnode.started')).find(
      (e) => e.payload.nodeId === created.nodeId,
    );
    expect(started?.payload.mcpEgress).toEqual(created.mcpEgress);
  });

  it('a step without any server egress yields an empty list', async () => {
    const id = await publishAgent('egress-none', ['run-none']);
    expect((await (await session(id))()).mcpEgress).toEqual([]);
  });

  it.each(['run-wide', 'run-nogrant'])(
    'fails a stored connection outside its grant closed (%s): no node, audit entry, metric',
    async (name) => {
      const id = await publishAgent(`egress-${name}`, [name]);
      await expect((await session(id))()).rejects.toMatchObject({
        code: 'egress_denied',
        statusCode: 422,
      });
      const entry = (await audit('mcp.egress.refused')).find((e) => e.payload.connection === name);
      expect(entry?.payload).toMatchObject({ scope: 'tenant', step: 'a' });
      expect(await n.ctx.metrics.registry.metrics()).toMatch(
        /oax_mcp_stdio_refused_total\{code="egress_denied"\} [1-9]/,
      );
    },
  );
});

describe('Agent Check lint egress_unused', () => {
  const source = (egress: string[]) => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: lint-${Math.random().toString(36).slice(2, 8)}
version: 1.0.0
owner: team-ops
runtime:
  runner: container
  egress: [${egress.join(', ')}]
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Work.
    tools:
      - { server: lint-jira, tool: get_issue }
      - { server: lint-http, tool: get_x }
    simulation:
      responses:
        - text: done
---
Work.
`;
  beforeAll(async () => {
    await post('lint-jira', stdio(JIRA, ['api.jira.example']));
    await post('lint-http', {
      transport: 'streamable-http',
      url: 'https://mcp.atlassian.example/mcp',
    });
  });
  const warnings = async (egress: string[]) =>
    (
      await n.req({
        method: 'POST',
        url: '/v1/agents/validate',
        payload: { source: source(egress) },
      })
    )
      .json()
      .warnings.filter((w: { message: string }) => w.message.startsWith('egress_unused')) as {
      path: string;
      message: string;
    }[];

  it('flags a host that only serves a stdio server with its own grant', async () => {
    const w = await warnings(['api.jira.example']);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ path: 'agents.0.runtime.egress.0' });
    expect(w[0]!.message).toContain('egress_unused');
    expect(w[0]!.message).toContain('lint-jira');
  });
  it('does not flag the host of an HTTP server (the node still needs it until the relay)', async () => {
    expect(await warnings(['mcp.atlassian.example'])).toEqual([]);
  });
  it('does not flag a host no MCP connection of the step lists', async () => {
    expect(await warnings(['other.example.org'])).toEqual([]);
  });
  it('compares canonical spellings (case, default port)', () => {
    const w = egressUnusedWarnings(
      {
        runtime: { runner: 'container', egress: ['API.Jira.Example:443'] },
        agents: [{ id: 'a', tools: [{ server: 's' }] }],
      },
      [{ name: 's', transport: 'stdio', command: JIRA, egress: ['api.jira.example'] } as never],
    );
    expect(w).toHaveLength(1);
  });
  it('checks only container steps: Kubernetes needs the entry in runtime.egress', () => {
    const configs = [
      { name: 's', transport: 'stdio', command: JIRA, egress: ['api.jira.example'] } as never,
    ];
    const def = (runner: string, step?: string) => ({
      runtime: { runner, egress: ['api.jira.example'] },
      agents: [
        {
          id: 'a',
          tools: [{ server: 's' }],
          ...(step ? { runtime: { runner: step } } : {}),
        },
      ],
    });
    expect(egressUnusedWarnings(def('kubernetes-job'), configs)).toEqual([]);
    expect(egressUnusedWarnings(def('in-process'), configs)).toEqual([]);
    expect(egressUnusedWarnings(def('container', 'kubernetes-job'), configs)).toEqual([]);
    expect(egressUnusedWarnings(def('kubernetes-job', 'container'), configs)).toHaveLength(1);
  });
});

describe('air-gapped mode', () => {
  const air = (allow: string) =>
    testNode({ ...ENV, OAX_AIRGAPPED: 'true', OAX_AIRGAPPED_ALLOW: allow });

  it('accepts only hosts on the allowlist, and refuses wildcards and CIDRs (fail closed)', async () => {
    const a = await air('api.jira.example');
    try {
      const create = (name: string, egress: string[]) =>
        a.req({
          method: 'POST',
          url: '/v1/connections',
          payload: { name, config: stdio(JIRA, egress) },
        });
      expect((await create('ok', ['api.jira.example'])).statusCode).toBe(201);
      // inside the operator grant but not on the air-gapped allowlist
      const off = await create('off', ['x.atlassian.example']);
      expect(off.statusCode).toBe(422);
      expect(off.json().message).toContain('OAX_AIRGAPPED_ALLOW');
      const wild = await create('wild', ['*.atlassian.example']);
      expect(wild.statusCode).toBe(422);
      expect(wild.json().message).toContain('air-gapped');
      // the operator's own connections are bound by the allowlist as well
      const plat = await a.req({
        method: 'POST',
        url: '/v1/connections',
        payload: {
          name: 'plat',
          scope: 'platform',
          config: stdio('/opt/platform/x', ['not-allowed.example.org']),
        },
      });
      expect(plat.statusCode).toBe(422);
    } finally {
      await a.close();
    }
  });
});
