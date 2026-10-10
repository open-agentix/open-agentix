import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OaxError, type StepCredentials } from '@openagentix/core';
import { McpServerConfigSchema, type McpServerConfig } from '@openagentix/mcp';
import type { FetchFn } from '@openagentix/runners';
import { describe, expect, it } from 'vitest';
import { mergeCredentials, parseNodeEnv, runNode, stdioGuardFor } from '../src/run-node.js';

const RUN = '99999999-2222-4333-8444-555555555555';
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  OAX_CONTROL_URL: 'http://api:8080',
  OAX_RUN_ID: RUN,
  OAX_NODE_ID: 'n-1',
  OAX_STEP_IDS: 'action',
  OAX_RUN_TOKEN_FILE: '/run/oax/token',
  ...over,
});

describe('parseNodeEnv', () => {
  it('parses a valid environment', () => {
    expect(parseNodeEnv(env())).toEqual({
      controlUrl: 'http://api:8080',
      runId: RUN,
      nodeId: 'n-1',
      stepIds: ['action'],
      tokenFile: '/run/oax/token',
    });
  });
  it.each([
    ['OAX_CONTROL_URL', undefined],
    ['OAX_CONTROL_URL', 'not a url'],
    ['OAX_CONTROL_URL', 'file:///etc/passwd'],
    ['OAX_RUN_ID', undefined],
    ['OAX_RUN_ID', '../../x'],
    ['OAX_STEP_IDS', undefined],
    ['OAX_STEP_IDS', 'a,b'],
    ['OAX_STEP_IDS', 'Not A Slug'],
    ['OAX_RUN_TOKEN_FILE', undefined],
  ])('refuses %s = %s', (key, value) => {
    expect(() => parseNodeEnv(env({ [key]: value }))).toThrow(OaxError);
  });
});

describe('mergeCredentials', () => {
  const stdio = McpServerConfigSchema.parse({
    name: 'jira',
    transport: 'stdio',
    command: 'jira-mcp',
    env: { A: '1' },
    envSecrets: { STALE: 'ref' },
  });
  const http = McpServerConfigSchema.parse({
    name: 'crm',
    transport: 'streamable-http',
    url: 'https://crm.example.org/mcp',
    headers: { 'x-a': '1' },
    headerSecrets: { authorization: 'ref' },
  });
  const mem = McpServerConfigSchema.parse({ name: 'demo', transport: 'in-memory' });
  const creds: StepCredentials = {
    agentId: 'action',
    expiresAt: 'x',
    credentials: [{ secret: 's', env: 'GH_TOKEN', value: 'v1' }],
    connections: [
      { server: 'jira', env: { JIRA_TOKEN: 'v2' } },
      { server: 'crm', headers: { authorization: 'Bearer v3' } },
    ],
  };
  it('puts values where the step needs them and strips every reference', () => {
    const [j, c, d] = mergeCredentials([stdio, http, mem], creds, { HTTPS_PROXY: 'http://p' }) as [
      Extract<McpServerConfig, { transport: 'stdio' }>,
      Extract<McpServerConfig, { transport: 'streamable-http' }>,
      McpServerConfig,
    ];
    expect(j.env).toEqual({ A: '1', HTTPS_PROXY: 'http://p', GH_TOKEN: 'v1', JIRA_TOKEN: 'v2' });
    expect(j.envSecrets).toEqual({});
    expect(c.headers).toEqual({ 'x-a': '1', authorization: 'Bearer v3' });
    expect(c.headerSecrets).toEqual({});
    expect(d).toEqual(mem);
  });
  it('a connection the broker sent nothing for gets no values', () => {
    const [j] = mergeCredentials([stdio], { ...creds, credentials: [], connections: [] }, {}) as [
      Extract<McpServerConfig, { transport: 'stdio' }>,
    ];
    expect(j.env).toEqual({ A: '1' });
  });
});

interface Call {
  method: string;
  path: string;
  auth: string;
  body: Record<string, unknown> | undefined;
}

function control(over: Partial<Record<string, () => Response>> = {}) {
  const calls: Call[] = [];
  const handover = {
    agentId: 'action',
    agent: {
      id: 'action',
      provider: 'simulated',
      model: 'sim-1',
      instructions: 'Act.',
      outputs: [{ format: 'json' }],
      tools: [],
      simulation: { responses: [{ text: '{"ok":true}' }] },
    },
    input: { research: { ok: true } },
    attempt: 1,
    run: { name: 'p', version: '1.0.0', classification: 'internal', budget: {} },
    mcp: [],
  };
  const fetchImpl: FetchFn = async (url, init) => {
    const u = new URL(url);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({
      method: init?.method ?? 'GET',
      path: u.pathname,
      auth: String((init?.headers as Record<string, string>).authorization),
      body,
    });
    const key = `${init?.method ?? 'GET'} ${u.pathname.replace(RUN, ':id')}`;
    if (over[key]) return over[key]!();
    switch (key) {
      case 'GET /v1/worker/runs/:id/handover':
        return Response.json(handover);
      case 'POST /v1/worker/runs/:id/credentials':
        return Response.json({
          agentId: 'action',
          expiresAt: 'x',
          credentials: [],
          connections: [],
        });
      case 'GET /v1/worker/runs/:id/status':
        return Response.json({ cancelled: false });
      case 'POST /v1/worker/runs/:id/model':
        return Response.json({
          callId: 'call-1',
          response: {
            text: '{"ok":true}',
            toolCalls: [],
            usage: { inputTokens: 7, outputTokens: 3 },
            stopReason: 'end_turn',
            model: 'sim-1',
          },
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            source: 'provider',
          },
          costMicros: 5,
          priced: true,
          remaining: {},
        });
      case 'GET /v1/worker/runs/:id/budget':
        return Response.json({ breaches: [] });
      case 'POST /v1/worker/runs/:id/gate':
        return Response.json({ effect: 'allow', reasons: [] });
      default:
        return new Response(null, { status: 204 });
    }
  };
  return { calls, fetchImpl, handover };
}

const base = (fetchImpl: FetchFn, over: Record<string, unknown> = {}) => ({
  env: env(),
  fetchImpl,
  readFile: async () => 'oaxrt.a.b\n',
  sleep: async () => undefined,
  log: () => undefined,
  ...over,
});
const results = (calls: Call[]) =>
  calls.filter((c) => c.path.endsWith('/handover/result')).map((c) => c.body!);

describe('runNode', () => {
  it('fetches handover and credentials, runs the step and posts the result with the token', async () => {
    const { calls, fetchImpl } = control();
    expect(await runNode(base(fetchImpl))).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'GET', auth: 'Bearer oaxrt.a.b' });
    expect(calls[0]!.path).toBe(`/v1/worker/runs/${RUN}/handover`);
    expect(calls[1]!.path).toBe(`/v1/worker/runs/${RUN}/credentials`);
    const [res] = results(calls);
    expect(res).toMatchObject({ agentId: 'action', format: 'json', content: '{"ok":true}' });
    expect(res!.usage).toBeDefined();
    // every call used the same step-scoped token; the node never called `complete`
    expect(new Set(calls.map((c) => c.auth))).toEqual(new Set(['Bearer oaxrt.a.b']));
    expect(calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
    // the model call went through the proxy (the control node recorded and priced it); the node
    // reports its output step only and never a model_call of its own
    const steps = calls.filter((c) => c.path.endsWith('/steps')).map((c) => c.body!.kind);
    expect(steps).toContain('output');
    expect(steps).not.toContain('model_call');
    const model = calls.filter((c) => c.path.endsWith('/model'));
    expect(model).toHaveLength(1);
    expect(model[0]).toMatchObject({ method: 'POST', auth: 'Bearer oaxrt.a.b' });
    expect(model[0]!.body).toMatchObject({ agentId: 'action', request: { model: 'sim-1' } });
    // the published simulation script is never sent by the node
    expect(JSON.stringify(model[0]!.body)).not.toContain('simulation');
    expect(res!.usage).toMatchObject({ tokensIn: 7, tokensOut: 3, costMicros: 5 });
  });

  it('removes the token file once it was read (the token lives in memory only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oax-token-'));
    try {
      const file = join(dir, 'token');
      writeFileSync(file, 'oaxrt.a.b\n');
      const { calls, fetchImpl } = control();
      const code = await runNode(
        base(fetchImpl, { env: env({ OAX_RUN_TOKEN_FILE: file }), readFile: undefined }),
      );
      expect(code).toBe(0);
      expect(existsSync(file)).toBe(false);
      // the run still worked: the token is held in memory
      expect(new Set(calls.map((c) => c.auth))).toEqual(new Set(['Bearer oaxrt.a.b']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a token file that cannot be removed (mounted Secret, stdin)', async () => {
    const { fetchImpl } = control();
    const removed: string[] = [];
    const code = await runNode(
      base(fetchImpl, {
        removeTokenFile: async (p: string) => {
          removed.push(p);
          throw new Error('EROFS');
        },
      }),
    );
    expect(code).toBe(0);
    expect(removed).toEqual(['/run/oax/token']);
  });

  it('waits for the token file the runner uploads after the start', async () => {
    const { fetchImpl } = control();
    let reads = 0;
    const code = await runNode(
      base(fetchImpl, {
        readFile: async () => {
          if (++reads < 3) throw new Error('ENOENT');
          return 'oaxrt.a.b\n';
        },
      }),
    );
    expect(code).toBe(0);
    expect(reads).toBe(3);
  });

  it('exits with 2 and posts nothing when it cannot start', async () => {
    const { calls, fetchImpl } = control();
    const logs: string[] = [];
    const log = (l: string) => void logs.push(l);
    expect(await runNode(base(fetchImpl, { env: env({ OAX_STEP_IDS: 'a,b' }), log }))).toBe(2);
    // no token ever arrives
    expect(
      await runNode(base(fetchImpl, { readFile: async () => 'not-a-token', tokenWaitMs: 0, log })),
    ).toBe(2);
    expect(
      await runNode(
        base(fetchImpl, {
          readFile: async () => {
            throw new Error('x');
          },
          tokenWaitMs: 0,
          log,
        }),
      ),
    ).toBe(2);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).not.toContain('not-a-token');
  });

  it('reports a handover for another step as a failure instead of running it', async () => {
    const probe = control();
    const wrong = {
      ...probe.handover,
      agentId: 'other',
      agent: { ...probe.handover.agent, id: 'other' },
    };
    const c = control({ 'GET /v1/worker/runs/:id/handover': () => Response.json(wrong) });
    expect(await runNode(base(c.fetchImpl))).toBe(1); // exit code of a node that failed
    const [res] = results(c.calls); // ...but it still told the orchestrator why
    expect(res!.failure).toMatchObject({ code: 'run_node_invalid' });
    // it never asked the broker for credentials or ran anything
    expect(c.calls.some((x) => x.path.endsWith('/credentials'))).toBe(false);
    expect(c.calls.some((x) => x.path.endsWith('/steps'))).toBe(false);
  });

  it('fails closed with a failure report when the broker refuses (409/403)', async () => {
    for (const status of [409, 403, 401]) {
      const c = control({
        'POST /v1/worker/runs/:id/credentials': () => new Response('{}', { status }),
      });
      expect(await runNode(base(c.fetchImpl))).toBe(1);
      const [res] = results(c.calls);
      expect(res!.failure).toMatchObject({ status: 'failed', code: 'control_plane_error' });
      // the step never ran: no model call was recorded
      expect(c.calls.some((x) => x.path.endsWith('/steps'))).toBe(false);
    }
  });

  it('sends every provider, a real one included, through the model proxy (no key on the node)', async () => {
    const c = control();
    c.handover.agent.provider = 'anthropic';
    expect(await runNode(base(c.fetchImpl))).toBe(0);
    expect(c.calls.filter((x) => x.path.endsWith('/model'))).toHaveLength(1);
    const [res] = results(c.calls);
    expect(res!.failure).toBeUndefined();
  });

  it('fails the step with the proxy refusal code and records nothing itself', async () => {
    const c = control({
      'POST /v1/worker/runs/:id/model': () =>
        Response.json(
          {
            error: {
              code: 'control_budget_cost',
              message: 'the cost budget cannot cover the call',
            },
          },
          { status: 403 },
        ),
    });
    expect(await runNode(base(c.fetchImpl))).toBe(0); // the failure report was accepted
    const [res] = results(c.calls);
    expect(res!.failure).toMatchObject({ status: 'failed', code: 'control_budget_cost' });
    expect(res!.content).toBe('');
    const steps = c.calls.filter((x) => x.path.endsWith('/steps')).map((x) => x.body!.kind);
    expect(steps).not.toContain('model_call');
  });

  it('maps a classification refusal of the proxy to a policy block', async () => {
    const c = control({
      'POST /v1/worker/runs/:id/model': () =>
        Response.json({ error: { code: 'classification_denied', message: 'no' } }, { status: 403 }),
    });
    expect(await runNode(base(c.fetchImpl))).toBe(0);
    const [res] = results(c.calls);
    expect(res!.failure).toMatchObject({
      status: 'blocked_by_policy',
      code: 'classification_denied',
    });
  });

  it('turns a step that blocks on policy into a failure with the same status', async () => {
    const c = control();
    // the model asks for a tool the step does not have: the executor records a denial and the
    // simulated script then ends; use a script whose output is invalid JSON for the schema
    Object.assign(c.handover.agent, {
      output: { schema: { type: 'object', required: ['x'] }, onInvalid: 'fail' },
    });
    expect(await runNode(base(c.fetchImpl))).toBe(0);
    const [res] = results(c.calls);
    expect(res!.failure).toMatchObject({ status: 'failed', code: 'handover_invalid' });
  });

  it('exits 1 when the result cannot be posted', async () => {
    const c = control({
      'POST /v1/worker/runs/:id/handover/result': () => new Response('{}', { status: 409 }),
    });
    expect(await runNode(base(c.fetchImpl))).toBe(1);
  });

  it('exits 1 when even the failure cannot be reported', async () => {
    const c = control({
      'GET /v1/worker/runs/:id/handover': () => new Response('{}', { status: 500 }),
      'POST /v1/worker/runs/:id/handover/result': () => new Response('{}', { status: 500 }),
    });
    expect(await runNode(base(c.fetchImpl))).toBe(1);
  });

  it('takes the egress proxy account from line 2 and keeps it out of logs', async () => {
    const c = control();
    const logs: string[] = [];
    const code = await runNode(
      base(c.fetchImpl, {
        readFile: async () => 'oaxrt.a.b\nhttp://n-1:pw@proxy:3128/\n',
        log: (l: string) => void logs.push(l),
      }),
    );
    expect(code).toBe(0);
    expect(logs.join('')).not.toContain('pw@');
  });

  it('refuses a malformed or non-http proxy line', async () => {
    const c = control();
    for (const bad of ['not a url', 'ftp://p:1/', 'file:///etc/passwd']) {
      expect(
        await runNode(
          base(c.fetchImpl, { readFile: async () => `oaxrt.a.b\n${bad}\n`, tokenWaitMs: 0 }),
        ),
      ).toBe(2);
    }
    expect(c.calls).toHaveLength(0);
  });

  it('gives up when a read blocks past the deadline (stdin never closed)', async () => {
    const c = control();
    expect(
      await runNode(
        base(c.fetchImpl, {
          readFile: () => new Promise<string>(() => undefined),
          tokenWaitMs: 30,
        }),
      ),
    ).toBe(2);
  });
});

describe('tenant stdio servers in a run node (ADR 0016 S0)', () => {
  const fixture = fileURLToPath(
    new URL('../../../packages/mcp/test/fixtures/stdio-server.mjs', import.meta.url),
  );
  const node = realpathSync(process.execPath);
  const stdioConfig = (command: string, args: string[] = [fixture]) =>
    McpServerConfigSchema.parse({
      name: 'srv',
      transport: 'stdio',
      command,
      args,
      tools: { echo: { access: 'read' } },
    });
  const modelReply = (toolCalls: unknown[], text: string) =>
    Response.json({
      callId: `call-${Math.random()}`,
      response: {
        text,
        toolCalls,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
        model: 'sim-1',
      },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        source: 'provider',
      },
      costMicros: 1,
      priced: true,
      remaining: {},
    });
  const withStdio = (command: string, allowlist: string[], args?: string[]) => {
    let calls = 0;
    const c = control({
      'POST /v1/worker/runs/:id/model': () =>
        calls++ === 0
          ? modelReply([{ id: 't1', name: 'srv__echo', args: {} }], '')
          : modelReply([], '{"ok":true}'),
    });
    Object.assign(c.handover, {
      mcp: [stdioConfig(command, args)],
      stdio: { tenantServers: ['srv'], allowlist },
    });
    (c.handover.agent as Record<string, unknown>).tools = [{ server: 'srv', tool: 'echo' }];
    return c;
  };

  // The checkout is writable by the test user; the image of a real node is read-only.
  const readOnly = (fetchImpl: Parameters<typeof base>[0]) => ({
    ...base(fetchImpl),
    stdioWritable: () => false,
  });

  it('starts an allowlisted command running an allowlisted program file, and the step succeeds', async () => {
    const { calls, fetchImpl } = withStdio(node, [node, realpathSync(fixture)]);
    expect(await runNode(readOnly(fetchImpl))).toBe(0);
    expect(results(calls)[0]).toMatchObject({ format: 'json', content: '{"ok":true}' });
    expect(results(calls)[0]!.failure).toBeUndefined();
    // the server really started and answered the tool call
    const tool = calls.find((c) => c.path.endsWith('/steps') && c.body?.kind === 'tool_call');
    expect(JSON.stringify(tool?.body)).toContain('"status":"ok"');
  });

  it.each([
    ['a command that is not allowlisted', node, ['/opt/mcp/bin/*'], undefined],
    ['an interpreter with an inline program', node, [node], ['-e', 'process.exit(0)']],
    ['an interpreter running a program file that is not allowlisted', node, [node], undefined],
  ])(
    'fails the step with mcp_command_forbidden for %s, and starts nothing',
    async (_l, command, allow, args) => {
      const { calls, fetchImpl } = withStdio(command, allow, args);
      expect(await runNode(readOnly(fetchImpl))).toBe(1);
      expect(results(calls)[0]).toMatchObject({
        failure: { status: 'failed', code: 'mcp_command_forbidden' },
      });
      expect(calls.some((c) => c.path.endsWith('/model'))).toBe(false);
    },
  );

  it('refuses binaries the node could replace between the check and the start (writable)', async () => {
    // default probe: the checkout (fixture and its directory) is writable by the test user
    const { calls, fetchImpl } = withStdio(node, [node, realpathSync(fixture)]);
    expect(await runNode(base(fetchImpl))).toBe(1);
    expect(results(calls)[0]!.failure).toMatchObject({ code: 'mcp_command_forbidden' });
    expect(JSON.stringify(results(calls)[0])).toContain('writable by the run node');
    expect(calls.some((c) => c.path.endsWith('/model'))).toBe(false);
  });

  it('refuses a command that does not exist in the image of the node', async () => {
    const { calls, fetchImpl } = withStdio('/opt/mcp/bin/missing', ['/opt/mcp/bin/*']);
    expect(await runNode(base(fetchImpl))).toBe(1);
    expect(results(calls)[0]!.failure).toMatchObject({ code: 'mcp_command_forbidden' });
    expect(JSON.stringify(results(calls)[0])).toContain('does not exist');
  });

  it('applies the rules to the real binary: a symlink to a shell or out of the list is refused', () => {
    const handover = {
      mcp: [stdioConfig('/opt/mcp/bin/innocent', [])],
      stdio: { tenantServers: ['srv'], allowlist: ['/opt/mcp/bin/*'] },
    };
    const guard = (real: string) => () =>
      stdioGuardFor(
        handover,
        () => real,
        () => false,
      )(handover.mcp[0] as never);
    expect(guard('/opt/mcp/bin/innocent')).not.toThrow();
    expect(guard('/bin/bash')).toThrow(/refused even if allowlisted/);
    expect(guard('/usr/local/bin/other')).toThrow(/symlink may not lead out/);
  });

  it('leaves servers alone that the control node did not mark as tenant-defined', () => {
    const cfg = stdioConfig('/bin/sh', ['-c', 'id']);
    expect(() => stdioGuardFor({ mcp: [cfg] })(cfg as never)).not.toThrow();
  });

  it('refuses a configuration that differs from the one the control node checked', () => {
    const handover = {
      mcp: [stdioConfig('/opt/mcp/bin/a', [])],
      stdio: { tenantServers: ['srv'], allowlist: ['/opt/mcp/bin/*'] },
    };
    const changed = stdioConfig('/opt/mcp/bin/a', ['--extra']);
    expect(() => stdioGuardFor(handover, (p) => p)(changed as never)).toThrow(/changed after/);
  });
});

describe('the run node never touches the database', () => {
  it('does not import the control node package (no PostgreSQL client in its module graph)', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/run-node.ts', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => i!.startsWith('@openagentix/'))).toEqual(
      expect.not.arrayContaining(['@openagentix/api']),
    );
    expect(imports.some((i) => /^(pg|drizzle|@electric|ioredis|redis|postgres)/.test(i!))).toBe(
      false,
    );
    const cli = readFileSync(
      fileURLToPath(new URL('../src/run-node-cli.ts', import.meta.url)),
      'utf8',
    );
    expect(cli).not.toContain('@openagentix/api');
  });
});
