import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, AgentSpec } from '@openagentix/core';
import type {
  ExternalHarness,
  FetchFn,
  HarnessInvocation,
  HarnessResult,
  ModelProxyEndpoint,
} from '@openagentix/runners';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runNode } from '../src/run-node.js';

const RUN = '99999999-2222-4333-8444-555555555555';
const TOKEN = 'oaxmt.eyJ2IjoxfQ.c2lnbmF0dXJl';
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  OAX_CONTROL_URL: 'http://api:8080',
  OAX_RUN_ID: RUN,
  OAX_NODE_ID: 'n-1',
  OAX_STEP_IDS: 'action',
  OAX_RUN_TOKEN_FILE: '/run/oax/token',
  ...over,
});

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** A control node that serves one harness step and the model token of it. */
function control(tokenAnswer: () => Response = () => Response.json(tokenBody())) {
  const calls: Call[] = [];
  const handover = {
    agentId: 'action',
    agent: {
      id: 'action',
      provider: 'claude',
      model: 'claude-x',
      instructions: 'Act.',
      outputs: [{ format: 'markdown' }],
      tools: [],
      runtime: { runner: 'container', harness: 'claude-code' },
    },
    input: { q: 1 },
    attempt: 1,
    run: { name: 'p', version: '1.0.0', classification: 'internal', budget: {} },
    mcp: [],
  };
  const fetchImpl: FetchFn = async (url, init) => {
    const u = new URL(url);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, body });
    switch (`${init?.method ?? 'GET'} ${u.pathname.replace(RUN, ':id')}`) {
      case 'GET /v1/worker/runs/:id/handover':
        return Response.json(handover);
      case 'POST /v1/worker/runs/:id/credentials':
        return Response.json({
          agentId: 'action',
          expiresAt: 'x',
          credentials: [],
          connections: [],
        });
      case 'POST /v1/worker/runs/:id/model-token':
        return tokenAnswer();
      case 'GET /v1/worker/runs/:id/status':
        return Response.json({ cancelled: false });
      default:
        return new Response(null, { status: 204 });
    }
  };
  return { calls, fetchImpl };
}

const tokenBody = (over: Record<string, unknown> = {}) => ({
  token: TOKEN,
  expiresAt: '2030-01-01T00:00:00.000Z',
  protocol: 'anthropic',
  baseUrl: 'http://api:8080/v1/model-proxy/anthropic',
  model: 'claude-x',
  ...over,
});

class FakeHarness implements ExternalHarness {
  readonly name = 'claude-code' as const;
  proxies: (ModelProxyEndpoint | undefined)[] = [];
  buildInvocation(
    _def: AgentDefinition,
    _agent: AgentSpec,
    prompt: string,
    _gate: unknown,
    _tools?: unknown,
    proxy?: ModelProxyEndpoint,
  ): HarnessInvocation {
    this.proxies.push(proxy);
    return {
      command: 'fake',
      args: [],
      env: {},
      files: {},
      stdin: prompt,
      limits: { timeoutMs: 1000 },
    };
  }
  run(): Promise<HarnessResult> {
    return Promise.resolve({
      exitCode: 0,
      text: 'harness answer',
      isError: false,
      turns: 1,
      costUsd: 0.25,
      tokensIn: 50,
      tokensOut: 5,
      toolCalls: [],
      terminated: 'none',
    });
  }
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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oax-node-harness-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runNode with a harness step', () => {
  it('asks for the harness model token, runs the harness behind the proxy and reports the output', async () => {
    const { calls, fetchImpl } = control();
    const harness = new FakeHarness();
    const code = await runNode(
      base(fetchImpl, { harnessFactory: () => harness, harnessWorkRoot: dir }),
    );
    expect(code).toBe(0);
    const tokenCall = calls.find((c) => c.path.endsWith('/model-token'))!;
    expect(tokenCall.body).toEqual({ agentId: 'action', harness: 'claude-code' });
    expect(harness.proxies).toEqual([
      {
        protocol: 'anthropic',
        baseUrl: 'http://api:8080/v1/model-proxy/anthropic',
        token: TOKEN,
        model: 'claude-x',
      },
    ]);
    // The node never calls the native model route and never reports a model call itself.
    expect(calls.some((c) => c.path.endsWith('/model'))).toBe(false);
    const steps = calls.filter((c) => c.path.endsWith('/steps')).map((c) => c.body!);
    expect(steps.map((s) => s.kind)).toEqual(['output']);
    expect(steps[0]!.output).toMatchObject({
      content: 'harness answer',
      harness: { reported: { costUsd: 0.25, tokensIn: 50, tokensOut: 5 } },
    });
    const [res] = results(calls);
    expect(res).toMatchObject({ agentId: 'action', content: 'harness answer' });
    // Measured by the proxy, never taken from the harness report.
    expect(res!.usage).toMatchObject({ tokensIn: 0, tokensOut: 0, costMicros: 0 });
    // The model token goes nowhere but into the harness.
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  it('reports the code of a refused model token as the failure of the step', async () => {
    const { calls, fetchImpl } = control(() =>
      Response.json(
        { error: { code: 'model_token_already_issued', message: 'already issued' } },
        { status: 409 },
      ),
    );
    const harness = new FakeHarness();
    const code = await runNode(
      base(fetchImpl, { harnessFactory: () => harness, harnessWorkRoot: dir }),
    );
    expect(code).toBe(0);
    expect(harness.proxies).toEqual([]);
    expect(results(calls)[0]).toMatchObject({
      failure: { status: 'failed', code: 'model_token_already_issued' },
    });
  });

  it('refuses a native answer: a harness needs a pass-through surface', async () => {
    const { calls, fetchImpl } = control(() =>
      Response.json(tokenBody({ protocol: 'native', baseUrl: 'http://api:8080/v1/worker/runs/x' })),
    );
    const harness = new FakeHarness();
    await runNode(base(fetchImpl, { harnessFactory: () => harness, harnessWorkRoot: dir }));
    expect(harness.proxies).toEqual([]);
    expect(results(calls)[0]).toMatchObject({ failure: { code: 'model_surface_mismatch' } });
  });

  it('starts the binary named by the node image and hands it nothing but the model token', async () => {
    const bin = join(dir, 'claude');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
require('node:fs').readFileSync(0);
const e = process.env;
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1,
  result: JSON.stringify({ base: e.ANTHROPIC_BASE_URL, hasToken: (e.ANTHROPIC_AUTH_TOKEN ?? '').startsWith('oaxmt.'),
  model: e.ANTHROPIC_MODEL, leaked: Object.keys(e).filter((k) => /OAUTH|API_KEY|AWS|RUN_TOKEN/.test(k)) }),
  usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');`,
    );
    chmodSync(bin, 0o755);
    const { calls, fetchImpl } = control();
    const code = await runNode(
      base(fetchImpl, {
        env: env({ OAX_CLAUDE_BIN: bin, OAX_RUN_TOKEN_FILE: '/run/oax/token' }),
        harnessWorkRoot: dir,
      }),
    );
    expect(code).toBe(0);
    const out = JSON.parse(results(calls)[0]!.content as string) as Record<string, unknown>;
    expect(out).toEqual({
      base: 'http://api:8080/v1/model-proxy/anthropic',
      hasToken: true,
      model: 'claude-x',
      leaked: [],
    });
  });

  it('fails visibly when the harness binary is missing from the image', async () => {
    const { calls, fetchImpl } = control();
    const code = await runNode(
      base(fetchImpl, { env: env({ OAX_CLAUDE_BIN: join(dir, 'missing') }), harnessWorkRoot: dir }),
    );
    expect(code).toBe(0);
    expect(results(calls)[0]).toMatchObject({ failure: { code: 'harness_spawn_failed' } });
  });
});
