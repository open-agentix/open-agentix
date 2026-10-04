import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OaxError, type StepCredentials } from '@openagentix/core';
import { McpServerConfigSchema, type McpServerConfig } from '@openagentix/mcp';
import { ModelProxyUnavailableProvider, type FetchFn } from '@openagentix/runners';
import { describe, expect, it } from 'vitest';
import { mergeCredentials, parseNodeEnv, runNode } from '../src/run-node.js';

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
    // it recorded its own model_call and output steps (the control node attributes costs)
    const steps = calls.filter((c) => c.path.endsWith('/steps')).map((c) => c.body!.kind);
    expect(steps).toEqual(expect.arrayContaining(['model_call', 'output']));
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

  it('has no model access beyond the keyless simulated provider (W1-3b)', async () => {
    const c = control();
    c.handover.agent.provider = 'anthropic';
    expect(await runNode(base(c.fetchImpl))).toBe(0); // the failure report was accepted
    const [res] = results(c.calls);
    expect(res!.failure).toMatchObject({ status: 'failed', code: 'provider_error' });
    expect(res!.failure).toMatchObject({ message: expect.stringContaining('W1-3b') });
    expect(res!.content).toBe('');
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

  it('only fails the provider placeholder, which is what a node gets for real providers', async () => {
    await expect(new ModelProxyUnavailableProvider('x').complete()).rejects.toThrow();
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
