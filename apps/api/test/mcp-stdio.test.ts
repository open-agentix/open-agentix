import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/index.js';
import { connections, runs } from '../src/db/schema.js';
import { reportStdioViolations } from '../src/context.js';
import { RUN_TOKEN_SECRET, testNode, type TestNode } from './helpers.js';

/**
 * ADR 0016 slice S0: tenant-defined stdio MCP connections. Command allowlist, always-refused
 * programs, environment rules, publish-time isolation, run-time fail closed, air-gapped rules and
 * the migration report.
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
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-');
const OK = { transport: 'stdio', command: '/opt/mcp/bin/jira-mcp', args: ['--readonly'] };

let n: TestNode;
let teamId: string;
const post = (name: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  n.req({ method: 'POST', url: '/v1/connections', payload: { name, config, ...extra } });
const put = (id: string, config: Record<string, unknown>) =>
  n.req({ method: 'PUT', url: `/v1/connections/${id}`, payload: { config } });
const audit = async (action: string) =>
  (await n.req({ method: 'GET', url: `/v1/audit?action=${action}&limit=100` })).json().items as {
    payload: Record<string, unknown>;
  }[];

beforeAll(async () => {
  n = await testNode(ENV);
  teamId = (
    await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } })
  ).json().id;
});
afterAll(async () => n.close());

describe('creating and updating tenant stdio connections', () => {
  it('accepts an allowlisted absolute command and shows no warning', async () => {
    const res = await post('ok-tenant', OK);
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toEqual([]);
  });

  it.each([
    ['not allowlisted', { ...OK, command: '/opt/other/server' }],
    ['relative name', { ...OK, command: 'jira-mcp' }],
    ['relative path', { ...OK, command: './jira-mcp' }],
    ['traversal out of the allowlisted dir', { ...OK, command: '/opt/mcp/bin/../../../bin/true' }],
    ['below the allowlisted dir', { ...OK, command: '/opt/mcp/bin/sub/x' }],
    ['a shell', { ...OK, command: '/opt/mcp/bin/bash' }],
    ['a shell with -c', { ...OK, command: '/opt/mcp/bin/sh', args: ['-c', 'id'] }],
    ['npx', { ...OK, command: '/opt/mcp/bin/npx', args: ['-y', 'some-server@latest'] }],
    ['uvx', { ...OK, command: '/opt/mcp/bin/uvx', args: ['some-server'] }],
    ['docker', { ...OK, command: '/opt/mcp/bin/docker', args: ['run', 'x'] }],
    ['curl', { ...OK, command: '/opt/mcp/bin/curl' }],
    ['node -e', { ...OK, command: '/opt/mcp/bin/node', args: ['-e', 'require("child_process")'] }],
    ['python -c', { ...OK, command: '/opt/mcp/bin/python3', args: ['-c', 'import os'] }],
  ])('refuses %s with mcp_command_forbidden', async (_l, config) => {
    const res = await post(`bad-${Math.random().toString(36).slice(2, 8)}`, config);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mcp_command_forbidden');
  });

  it.each(['PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'PYTHONPATH', 'BASH_ENV', 'HTTPS_PROXY'])(
    'refuses the environment variable %s (plain and secret-backed)',
    async (name) => {
      const a = await post(`env-a-${slug(name)}`, { ...OK, env: { [name]: 'x' } });
      expect(a.statusCode).toBe(400);
      expect(a.json().error).toBe('mcp_env_forbidden');
      const b = await post(`env-b-${slug(name)}`, { ...OK, envSecrets: { [name]: 'ref' } });
      expect(b.statusCode).toBe(400);
      expect(b.json().error).toBe('mcp_env_forbidden');
    },
  );

  it('does not resolve tenant paths on the api host (no file or symlink oracle)', async () => {
    // `/proc/self/cwd` is a symlink to the api's working directory; `/proc/self/exe` to its binary.
    for (const command of ['/proc/self/cwd', '/proc/self/exe', '/proc/self/root/etc/passwd']) {
      const res = await post(`probe-${Math.random().toString(36).slice(2, 8)}`, {
        ...OK,
        command,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(process.cwd());
      expect(res.body).not.toContain(process.execPath);
      expect(res.body).not.toMatch(/real path/);
    }
  });

  it('has no field for a working directory or a shell', async () => {
    for (const extra of [{ cwd: '/' }, { shell: true }]) {
      const res = await post('with-extra', { ...OK, ...extra });
      expect(res.statusCode).toBe(400);
    }
  });

  it('applies to team and agent scope too', async () => {
    const bad = { ...OK, command: '/bin/true' };
    expect((await post('team-bad', bad, { scope: 'team', scopeId: teamId })).statusCode).toBe(400);
    expect((await post('team-ok', OK, { scope: 'team', scopeId: teamId })).statusCode).toBe(201);
  });

  it('checks updates as well: a good connection cannot be changed into a bad one', async () => {
    const id = (await post('to-update', OK)).json().id as string;
    expect((await put(id, { ...OK, command: '/opt/mcp/bin/sh' })).statusCode).toBe(400);
    expect((await put(id, { ...OK, env: { LD_PRELOAD: '/tmp/x.so' } })).statusCode).toBe(400);
    expect((await put(id, { ...OK, args: ['--other'] })).statusCode).toBe(200);
  });

  it('does not touch platform connections, streamable-http or in-memory ones', async () => {
    const platform = await post(
      'platform-stdio',
      { transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { NODE_OPTIONS: '--x' } },
      { scope: 'platform' },
    );
    expect(platform.statusCode).toBe(201);
    expect(platform.json().warnings).toEqual([]);
    const http = await post('http-one', {
      transport: 'streamable-http',
      url: 'https://m.example.org/mcp',
    });
    expect(http.statusCode).toBe(201);
    expect((await post('mem-one', { transport: 'in-memory' })).statusCode).toBe(201);
  });
});

describe('platform connections stay operator configuration', () => {
  it('a tenant admin of the operator home tenant cannot change or delete a platform connection', async () => {
    // The platform connection lives in the bootstrap admin's tenant; a second admin of that
    // tenant without platform operator access must not be able to turn it into a shell that the
    // worker starts for every tenant (platform stdio is exempt from the command rules).
    const plat = await post(
      'plat-owned',
      { transport: 'stdio', command: '/usr/local/bin/oax-workspace' },
      { scope: 'platform' },
    );
    expect(plat.statusCode).toBe(201);
    const id = plat.json().id as string;
    for (const role of ['admin', 'integrator']) {
      const email = `home-${role}@example.com`;
      const u = await n.req({
        method: 'POST',
        url: '/v1/users',
        payload: { email, displayName: role, password: 'home-password-123', globalRoles: [role] },
      });
      expect(u.statusCode).toBe(201);
      const token = await n.login(email, 'home-password-123');
      const changed = await n.req({
        method: 'PUT',
        url: `/v1/connections/${id}`,
        token,
        payload: {
          config: {
            transport: 'stdio',
            command: '/bin/sh',
            args: ['-c', 'id'],
            envSecrets: { X: 'platform-secret' },
          },
        },
      });
      expect(changed.statusCode).toBe(403);
      const deleted = await n.req({ method: 'DELETE', url: `/v1/connections/${id}`, token });
      expect(deleted.statusCode).toBe(403);
      // a tenant connection of their own tenant is still theirs to manage
      const own = await n.req({
        method: 'POST',
        url: '/v1/connections',
        token,
        payload: { name: `own-${role}`, config: OK },
      });
      expect(own.statusCode).toBe(201);
      const ownPut = await n.req({
        method: 'PUT',
        url: `/v1/connections/${own.json().id}`,
        token,
        payload: { config: { ...OK, args: [] } },
      });
      expect(ownPut.statusCode).toBe(200);
    }
    const after = await n.req({ method: 'GET', url: `/v1/connections/${id}` });
    expect(after.json().config.command).toBe('/usr/local/bin/oax-workspace');
    // the platform operator still can
    expect(
      (
        await put(id, { transport: 'stdio', command: '/usr/local/bin/oax-workspace', args: ['-v'] })
      ).statusCode,
    ).toBe(200);
  });
});

describe('the default allows no tenant command at all', () => {
  it('refuses every tenant stdio connection when OAX_MCP_STDIO_COMMANDS is unset', async () => {
    const bare = await testNode({});
    try {
      const res = await bare.req({
        method: 'POST',
        url: '/v1/connections',
        payload: { name: 'any', config: OK },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('mcp_command_forbidden');
      expect(res.body).toContain('OAX_MCP_STDIO_COMMANDS');
      // platform connections are unaffected
      const platform = await bare.req({
        method: 'POST',
        url: '/v1/connections',
        payload: { name: 'plat', scope: 'platform', config: { transport: 'stdio', command: 'x' } },
      });
      expect(platform.statusCode).toBe(201);
    } finally {
      await bare.close();
    }
  });

  it('fails start-up on an unsafe allowlist entry', () => {
    for (const bad of ['relative/x', '/usr/bin/*', '/opt/a/../b', '/*', '/opt/*/x'])
      expect(() =>
        loadConfig({
          OAX_DATABASE_URL: 'memory://',
          NODE_ENV: 'test',
          OAX_MCP_STDIO_COMMANDS: bad,
        }),
      ).toThrow(/OAX_MCP_STDIO_COMMANDS/);
  });
});

const agent = (name: string, runner: string, stepRunner: string | null, tools: string) => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: 1.0.0
owner: team-ops
runtime:
  runner: ${runner}
  egress: []
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Work.
${stepRunner ? `    runtime: { runner: ${stepRunner}, egress: [] }\n` : ''}    tools:
${tools}
    simulation:
      responses:
        - text: done
---
Work.
`;
const create = async (source: string) =>
  (await n.req({ method: 'POST', url: '/v1/agents', payload: { source } })).json().id as string;
const publish = (id: string) => n.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
const tool = (server: string) => `      - { server: ${server}, tool: get_issue }`;

describe('publish refuses in-process steps with a tenant stdio grant', () => {
  beforeAll(async () => {
    await post('tenant-stdio', {
      ...OK,
      tools: { get_issue: { access: 'read' } },
      profiles: { read: ['get_issue'] },
    });
  });

  it('refuses the default runner (in-process) with mcp_stdio_requires_isolation', async () => {
    const id = await create(agent('inproc-default', 'in-process', null, tool('tenant-stdio')));
    const res = await publish(id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mcp_stdio_requires_isolation');
    expect(JSON.stringify(res.json().details)).toContain('agents.0.runtime.runner');
    const denied = (await audit('agent.publish.denied')).find(
      (e) => e.payload.code === 'mcp_stdio_requires_isolation',
    );
    expect(denied).toBeDefined();
  });

  it('refuses the local runner and a step that falls back to in-process', async () => {
    expect(
      (await publish(await create(agent('inproc-local', 'local', null, tool('tenant-stdio')))))
        .statusCode,
    ).toBe(400);
    const mixed = await create(
      agent('inproc-step', 'container', 'in-process', tool('tenant-stdio')),
    );
    expect((await publish(mixed)).statusCode).toBe(400);
  });

  it('refuses a profile grant on the connection as well', async () => {
    const id = await create(
      agent(
        'inproc-profile',
        'in-process',
        null,
        '      - { server: tenant-stdio, profile: read }',
      ),
    );
    expect((await publish(id)).json().error).toBe('mcp_stdio_requires_isolation');
  });

  it('accepts an isolating runner, and in-process steps on other transports', async () => {
    expect(
      (await publish(await create(agent('node-ok', 'container', null, tool('tenant-stdio')))))
        .statusCode,
    ).toBe(201);
    expect(
      (await publish(await create(agent('http-inproc', 'in-process', null, tool('http-one')))))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await publish(
          await create(agent('plat-inproc', 'in-process', null, tool('platform-stdio'))),
        )
      ).statusCode,
    ).toBe(201);
  });

  it('validation shows the same problem to the console', async () => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/agents/validate',
      payload: { source: agent('v', 'in-process', null, tool('tenant-stdio')) },
    });
    expect(res.json().valid).toBe(false);
    expect(JSON.stringify(res.json().errors)).toContain('run only in run nodes');
  });
});

describe('stored connections that break the rules fail closed at run time', () => {
  let agentId: string;
  const stored = async (name: string, config: Record<string, unknown>, scope = 'tenant') => {
    const [t] = await n.ctx.db.select().from(connections).limit(1);
    await n.ctx.db.insert(connections).values({
      id: crypto.randomUUID(),
      tenantId: t!.tenantId,
      scope,
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
  const newRun = async () => {
    const res = await n.req({
      method: 'POST',
      url: `/v1/agents/${agentId}/runs`,
      payload: { data: {} },
    });
    const id = res.json().id as string;
    await n.ctx.db
      .update(runs)
      .set({
        status: 'running',
        lockedBy: 'w1',
        startedAt: new Date(),
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(runs.id, id));
    return id;
  };
  const session = (runId: string) =>
    n.services.runNodes.createSession(runId, 'w1', {
      agentId: 'a',
      input: {},
      timeoutSeconds: 30,
      runner: 'container',
      image: IMAGE,
    });

  beforeAll(async () => {
    await stored('legacy-npx', { transport: 'stdio', command: 'npx', args: ['-y', 'x@latest'] });
    await stored('legacy-env', {
      transport: 'stdio',
      command: '/opt/mcp/bin/ok',
      env: { LD_PRELOAD: '/x.so' },
    });
    for (const name of ['legacy-npx', 'legacy-env', 'tenant-stdio'])
      await publish(await create(agent(`run-${name}`, 'container', null, tool(name))));
    agentId = (await n.req({ method: 'GET', url: '/v1/agents?limit=100' }))
      .json()
      .items.find((a: { name: string }) => a.name === 'run-legacy-npx').id;
  });

  it('refuses the step with mcp_command_forbidden, an audit entry and a metric', async () => {
    const runId = await newRun();
    await expect(session(runId)).rejects.toMatchObject({
      code: 'mcp_command_forbidden',
      statusCode: 422,
    });
    const entry = (await audit('mcp.stdio.refused')).find(
      (e) => e.payload.connection === 'legacy-npx',
    );
    expect(entry?.payload).toMatchObject({
      code: 'mcp_command_forbidden',
      step: 'a',
      scope: 'tenant',
    });
    expect(JSON.stringify(entry?.payload)).not.toMatch(/token|secret-value/);
    expect(await n.ctx.metrics.registry.metrics()).toMatch(
      /oax_mcp_stdio_refused_total\{code="mcp_command_forbidden"\} [1-9]/,
    );
  });

  it('a good connection yields a handover with the checked servers and the allowlist', async () => {
    const [ag] = (await n.req({ method: 'GET', url: '/v1/agents?limit=100' }))
      .json()
      .items.filter((a: { name: string }) => a.name === 'run-tenant-stdio');
    const res = await n.req({
      method: 'POST',
      url: `/v1/agents/${ag.id}/runs`,
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
    const created = await session(runId);
    const handover = await n.services.runNodes.handover(
      { runId, workerId: created.nodeId, sid: created.sessionId, steps: ['a'] } as never,
      runId,
      'a',
    );
    expect(handover.stdio).toEqual({
      tenantServers: ['tenant-stdio'],
      allowlist: ['/opt/mcp/bin/*'],
    });
  });

  it('lists the offenders per tenant and flags them on the connection', async () => {
    const list = await n.req({ method: 'GET', url: '/v1/connections/stdio-violations' });
    expect(list.statusCode).toBe(200);
    const names = list
      .json()
      .items.map((i: { connection: { name: string } }) => i.connection.name)
      .sort();
    expect(names).toEqual(['legacy-env', 'legacy-npx']);
    expect(list.json().items[0].issues.length).toBeGreaterThan(0);
    const all = (await n.req({ method: 'GET', url: '/v1/connections' })).json().items as {
      name: string;
      warnings: string[];
    }[];
    expect(all.find((c) => c.name === 'legacy-npx')!.warnings.join()).toMatch(/absolute path/);
    expect(all.find((c) => c.name === 'ok-tenant')!.warnings).toEqual([]);
  });

  it('reports them at start-up (warning and gauge) without changing the rows', async () => {
    const warn = vi.fn();
    await reportStdioViolations(
      n.ctx.db,
      n.ctx.config,
      { warn, debug: vi.fn() } as never,
      n.ctx.metrics,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0].count).toBe(2);
    expect(await n.ctx.metrics.registry.metrics()).toMatch(/oax_mcp_stdio_violations 2/);
    expect((await n.ctx.db.select().from(connections)).some((c) => c.name === 'legacy-npx')).toBe(
      true,
    );
  });
});

describe('air-gapped mode', () => {
  const air = (extra: Record<string, string> = {}) =>
    testNode({ OAX_AIRGAPPED: 'true', ...extra }).finally(() => undefined);

  it('refuses platform stdio unless the operator trusts it, and tenant stdio without an isolating runner', async () => {
    const closed = await air({ OAX_MCP_STDIO_COMMANDS: '/opt/mcp/bin/*' });
    try {
      const plat = await closed.req({
        method: 'POST',
        url: '/v1/connections',
        payload: {
          name: 'plat',
          scope: 'platform',
          config: { transport: 'stdio', command: '/opt/x' },
        },
      });
      expect(plat.statusCode).toBe(422);
      expect(plat.json().error).toBe('airgap_violation');
      expect(plat.body).toContain('OAX_AIRGAPPED_STDIO=trusted');
      const tenant = await closed.req({
        method: 'POST',
        url: '/v1/connections',
        payload: { name: 't', config: OK },
      });
      expect(tenant.statusCode).toBe(422);
      expect(tenant.body).toContain('no isolating runner');
    } finally {
      await closed.close();
    }
  });

  it('accepts them with OAX_AIRGAPPED_STDIO=trusted and a container runner', async () => {
    const open = await air({ ...ENV, OAX_AIRGAPPED_STDIO: 'trusted' });
    try {
      const plat = await open.req({
        method: 'POST',
        url: '/v1/connections',
        payload: {
          name: 'plat',
          scope: 'platform',
          config: { transport: 'stdio', command: '/opt/x' },
        },
      });
      expect(plat.statusCode).toBe(201);
      expect(
        (
          await open.req({
            method: 'POST',
            url: '/v1/connections',
            payload: { name: 't', config: OK },
          })
        ).statusCode,
      ).toBe(201);
    } finally {
      await open.close();
    }
  });
});

describe('config', () => {
  it('exposes the allowlist and the air-gapped acknowledgement', () => {
    const c = loadConfig({
      OAX_DATABASE_URL: 'memory://',
      NODE_ENV: 'test',
      OAX_RUN_TOKEN_SECRET: RUN_TOKEN_SECRET,
      OAX_MCP_STDIO_COMMANDS: '/opt/a/*, /usr/local/bin/x',
      OAX_AIRGAPPED_STDIO: 'trusted',
    });
    expect(c.mcp.stdioCommands).toEqual(['/opt/a/*', '/usr/local/bin/x']);
    expect(c.airgap.stdioTrusted).toBe(true);
    expect(
      loadConfig({ OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' }).mcp.stdioCommands,
    ).toEqual([]);
  });
});
