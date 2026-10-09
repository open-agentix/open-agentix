import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EgressPolicy,
  OaxError,
  parseAllowlist,
  resetEgressPolicy,
  setEgressPolicy,
  type AgentDefinition,
  type AgentSpec,
} from '@openagentix/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeCodeHarness,
  HARNESS_DEFAULT_TIMEOUT_MS,
  OPENCODE_PROXY_PROVIDER,
  OpenCodeHarness,
  assertProxyInvocation,
  executeWithHarness,
  executePipeline,
  type ExternalHarness,
  type HarnessInvocation,
  type HarnessResult,
  type ModelProxyEndpoint,
} from '../src/index.js';
import { runHarnessProcess } from '../src/harness/process.js';
import { agentFile, prepared, setup } from './helpers.js';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const FAKE_OPENCODE = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url));
const GATE = {
  serverName: 'oax-gate',
  url: 'http://127.0.0.1:1234/mcp',
  runToken: 'run-token-xyz',
};
const TOKEN = 'oaxmt.eyJ2IjoxfQ.c2lnbmF0dXJl';

const endpoint = (extra: Partial<ModelProxyEndpoint> = {}): ModelProxyEndpoint => ({
  protocol: 'anthropic',
  baseUrl: 'https://control.example.org/v1/model-proxy/anthropic/',
  token: TOKEN,
  model: 'sim-1',
  ...extra,
});

const TOOLS = `    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oax-harness-proxy-'));
});
afterEach(() => {
  resetEgressPolicy();
  rmSync(dir, { recursive: true, force: true });
});

function claudeInv(
  prompt: string,
  proxy = endpoint(),
  h = new ClaudeCodeHarness({ command: FAKE_CLAUDE }),
) {
  const def = agentFile(TOOLS);
  return { h, inv: h.buildInvocation(def, def.agents[0]!, prompt, GATE, undefined, proxy) };
}

describe('Claude Code through the model proxy', () => {
  it('points every model variable at the proxy and holds nothing but the model token', () => {
    const { inv } = claudeInv('x');
    expect(inv.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://control.example.org/v1/model-proxy/anthropic',
      ANTHROPIC_AUTH_TOKEN: TOKEN,
      ANTHROPIC_MODEL: 'sim-1',
      ANTHROPIC_SMALL_FAST_MODEL: 'sim-1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'sim-1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sim-1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'sim-1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    });
    expect(inv.env.HOME).toBeUndefined();
    expect(Object.keys(inv.env).filter((k) => /OAUTH|API_KEY|AWS_|PROXY/.test(k))).toEqual([]);
    expect(inv.modelProxy).toEqual({
      protocol: 'anthropic',
      baseUrl: 'https://control.example.org/v1/model-proxy/anthropic',
    });
    expect(inv.redact).toEqual([TOKEN]);
    // The token is neither on the command line nor in a generated file.
    expect(JSON.stringify(inv.args)).not.toContain(TOKEN);
    expect(JSON.stringify(inv.files)).not.toContain(TOKEN);
  });

  it('keeps the permission model: no built-in tools, dontAsk, exact gate allowlist, no bypass', () => {
    const { inv } = claudeInv('x');
    const at = (flag: string) => inv.args[inv.args.indexOf(flag) + 1];
    expect(at('--tools')).toBe('');
    expect(at('--permission-mode')).toBe('dontAsk');
    expect(at('--allowedTools')).toBe('mcp__oax-gate__cve-db__lookup_cve');
    expect(inv.args).toContain('--strict-mcp-config');
    expect(inv.args.some((a) => a.includes('skip-permissions'))).toBe(false);
  });

  it('always has a time limit: the agent budget, else the platform default', () => {
    expect(claudeInv('x').inv.limits?.timeoutMs).toBe(HARNESS_DEFAULT_TIMEOUT_MS);
    const h = new ClaudeCodeHarness({ defaultTimeoutMs: 5_000 });
    expect(claudeInv('x', endpoint(), h).inv.limits?.timeoutMs).toBe(5_000);
    const def = agentFile(`${TOOLS}\n    budget: { timeoutSeconds: 42, maxSteps: 3 }`);
    const inv = h.buildInvocation(def, def.agents[0]!, 'x', GATE, undefined, endpoint());
    expect(inv.limits).toMatchObject({ timeoutMs: 42_000, maxTurns: 3 });
  });

  it('refuses a surface it cannot speak', () => {
    expect(() => claudeInv('x', endpoint({ protocol: 'openai' }))).toThrow(
      /anthropic protocol only/,
    );
  });

  it('runs with an empty home, ignores a token file and never reads host credentials', async () => {
    const tokenFile = join(dir, 'oauth');
    writeFileSync(tokenFile, 'tok-oauth-1234567890\n');
    const h = new ClaudeCodeHarness({
      command: FAKE_CLAUDE,
      oauthTokenFile: tokenFile,
      home: '/root',
    });
    const { inv } = claudeInv('proxy-env', endpoint(), h);
    const res = await h.run(inv, { cwd: join(dir, 'w') });
    const seen = JSON.parse(res.text.replace(/\[REDACTED\]/g, 'R')) as Record<string, unknown>;
    expect(seen).toMatchObject({
      base: 'https://control.example.org/v1/model-proxy/anthropic',
      model: 'sim-1',
      small: 'sim-1',
      haiku: 'sim-1',
      tokenKind: 'oaxmt',
      oauth: null,
      apiKey: null,
      home: join(dir, 'w', '.home'),
      // The harness cannot hand the token back: it is scrubbed from everything it returns.
      echoed: 'token=R',
    });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it('talks to the proxy with the model token as its bearer', async () => {
    const seen: { url?: string; auth?: string; body?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', auth: String(req.headers.authorization), body });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}/v1/model-proxy/anthropic`;
      const { h, inv } = claudeInv('proxy-call', endpoint({ baseUrl: base }));
      const res = await h.run(inv, { cwd: join(dir, 'w') });
      expect(res.text).toBe('proxy answered 200');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe('/v1/model-proxy/anthropic/v1/messages');
      expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(seen[0]!.body!)).toMatchObject({ model: 'sim-1' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('does not depend on the direct-egress allowlist (the control node decides)', async () => {
    setEgressPolicy(new EgressPolicy({ airgapped: true, allow: parseAllowlist('') }));
    const { h, inv } = claudeInv('proxy-env');
    await expect(h.run(inv, { cwd: join(dir, 'w') })).resolves.toMatchObject({ isError: false });
    // The direct mode still refuses.
    const def = agentFile(TOOLS);
    const direct = h.buildInvocation(def, def.agents[0]!, 'proxy-env', GATE);
    await expect(h.run(direct, { cwd: join(dir, 'w2') })).rejects.toThrow(/air-gapped|egress/i);
  });
});

describe('assertProxyInvocation', () => {
  const base = (): HarnessInvocation => ({
    command: 'x',
    args: ['--permission-mode', 'dontAsk'],
    env: { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: TOKEN },
    files: {},
    limits: { timeoutMs: 1000 },
    modelProxy: { protocol: 'anthropic', baseUrl: 'https://c/v1/model-proxy/anthropic' },
  });
  it('accepts a clean invocation', () => {
    expect(() => assertProxyInvocation(base())).not.toThrow();
  });
  it.each([
    ['a provider key', (i: HarnessInvocation) => (i.env.ANTHROPIC_API_KEY = 'sk-ant-xyz')],
    ['an OAuth token', (i: HarnessInvocation) => (i.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok')],
    ['an AWS credential', (i: HarnessInvocation) => (i.env.AWS_ACCESS_KEY_ID = 'AKIA')],
    ['an OpenAI key', (i: HarnessInvocation) => (i.env.OPENAI_API_KEY = 'sk')],
    ['a Bedrock switch', (i: HarnessInvocation) => (i.env.CLAUDE_CODE_USE_BEDROCK = '1')],
    ['another route (proxy variable)', (i: HarnessInvocation) => (i.env.HTTPS_PROXY = 'http://p')],
    ['a foreign secret', (i: HarnessInvocation) => (i.env.GH_TOKEN = 'ghp_abc')],
    [
      'a permission bypass',
      (i: HarnessInvocation) => i.args.push('--dangerously-skip-permissions'),
    ],
    ['another permission mode', (i: HarnessInvocation) => (i.args[1] = 'bypassPermissions')],
    ['no time limit', (i: HarnessInvocation) => delete i.limits!.timeoutMs],
  ])('refuses %s', (_name, mutate) => {
    const inv = base();
    mutate(inv);
    expect(() => assertProxyInvocation(inv)).toThrow(
      /harness_proxy_invariant|must not|not allowed|allowlist|dontAsk|not a model token|time limit/,
    );
  });
  it('refuses a plain invocation and a mismatching base URL', () => {
    const inv = base();
    delete inv.modelProxy;
    expect(() => assertProxyInvocation(inv)).toThrow(/not a proxy invocation/);
    expect(() =>
      assertProxyInvocation(
        base(),
        endpoint({ baseUrl: 'https://other/v1/model-proxy/anthropic' }),
      ),
    ).toThrow(/does not match/);
  });
  it('is checked again right before the process starts', async () => {
    const { h, inv } = claudeInv('proxy-env');
    inv.env.AWS_SECRET_ACCESS_KEY = 'x';
    await expect(h.run(inv, { cwd: join(dir, 'w') })).rejects.toThrow(/must not reach/);
  });
});

describe('OpenCode through the model proxy', () => {
  const build = (
    proxy: ModelProxyEndpoint,
    h = new OpenCodeHarness({ command: FAKE_OPENCODE }),
  ) => {
    const def = agentFile(TOOLS);
    return {
      h,
      inv: h.buildInvocation(def, def.agents[0]!, 'scenario: env', GATE, undefined, proxy),
    };
  };
  type Seen = {
    key: string | null;
    keys: string[];
    config: {
      model: string;
      enabled_providers: string[];
      provider: Record<string, { npm: string; options: Record<string, unknown> }>;
      permission: Record<string, string>;
    };
  };

  it.each([
    ['anthropic', '@ai-sdk/anthropic', 'https://control.example.org/v1/model-proxy/anthropic/v1'],
    ['openai', '@ai-sdk/openai-compatible', 'https://control.example.org/v1/model-proxy/openai/v1'],
  ] as const)('builds a one-provider config for the %s surface', async (protocol, npm, baseURL) => {
    const { h, inv } = build(
      endpoint({ protocol, baseUrl: `https://control.example.org/v1/model-proxy/${protocol}` }),
    );
    expect(inv.args.slice(0, 5)).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      `${OPENCODE_PROXY_PROVIDER}/sim-1`,
    ]);
    const res = await h.run(inv, { cwd: join(dir, `w-${protocol}`) });
    const seen = JSON.parse(res.text.replace(/\[REDACTED\]/g, 'R')) as Seen;
    // The model token is the API key of the child and only reaches it through the environment.
    expect(seen.key).toBe('R');
    expect(JSON.stringify(inv.args)).not.toContain(TOKEN);
    expect(inv.files['.openagentix/opencode.json']).not.toContain(TOKEN);
    expect(seen.config.enabled_providers).toEqual([OPENCODE_PROXY_PROVIDER]);
    expect(Object.keys(seen.config.provider)).toEqual([OPENCODE_PROXY_PROVIDER]);
    const entry = seen.config.provider[OPENCODE_PROXY_PROVIDER]!;
    expect(entry.npm).toBe(npm);
    expect(entry.options).toMatchObject({ baseURL, apiKey: '{env:OAX_OPENCODE_API_KEY}' });
    expect(entry.options.headers).toBeUndefined();
    // Deny by default; only the gate tool is allowed.
    expect(seen.config.permission['*']).toBe('deny');
    expect(seen.config.permission['bash']).toBe('deny');
    expect(seen.config.permission['oax-gate_cve-db__lookup_cve']).toBe('allow');
    expect(seen.keys.filter((k) => /AWS|OPENAI|ANTHROPIC|PROXY/.test(k))).toEqual([]);
  });

  it('needs no model connection on the node and refuses a model mismatch', () => {
    expect(() =>
      build(endpoint({ protocol: 'openai', baseUrl: 'https://c/v1/model-proxy/openai' })),
    ).not.toThrow();
    expect(() => build(endpoint({ model: 'other-model' }))).toThrow(/does not match/);
  });

  it('has a time limit and scrubs the token from what the harness returns', async () => {
    const def = agentFile(TOOLS);
    const h = new OpenCodeHarness({ command: FAKE_OPENCODE });
    const inv = h.buildInvocation(
      def,
      def.agents[0]!,
      'scenario: leak',
      GATE,
      undefined,
      endpoint(),
    );
    expect(inv.limits?.timeoutMs).toBe(HARNESS_DEFAULT_TIMEOUT_MS);
    const res = await h.run(inv, { cwd: join(dir, 'w') });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(res.text).toContain('[REDACTED]');
  });

  it('verifies the pinned binary checksum in proxy mode too', async () => {
    const h = new OpenCodeHarness({ command: FAKE_OPENCODE, expectedSha256: 'a'.repeat(64) });
    const { inv } = build(endpoint(), h);
    await expect(h.run(inv, { cwd: join(dir, 'w') })).rejects.toThrow(/checksum/);
  });
});

describe('process limits', () => {
  it('stops everything the harness spawned when the time limit hits', async () => {
    const pidFile = join(dir, 'child.pid');
    const script = join(dir, 'spawner.mjs');
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setInterval(() => {}, 1000);`,
    );
    const res = await runHarnessProcess(
      {
        command: process.execPath,
        args: [script],
        env: { PATH: process.env.PATH ?? '' },
        files: {},
        limits: { timeoutMs: 600 },
      },
      { cwd: dir, env: { PATH: process.env.PATH ?? '' }, secrets: [], signal: undefined },
      {
        feed: () => undefined,
        turnCount: () => 0,
        costUsd: () => 0,
        finalize: () => ({
          text: '',
          isError: false,
          complete: true,
          turns: 0,
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          toolCalls: [],
        }),
      },
    );
    expect(res.terminated).toBe('timeout');
    const pid = Number(await (await import('node:fs/promises')).readFile(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow(); // gone
  });
});

// ---------- executeWithHarness in proxy mode ----------

class ScriptedProxyHarness implements ExternalHarness {
  readonly name = 'claude-code' as const;
  endpoints: (ModelProxyEndpoint | undefined)[] = [];
  constructor(private readonly result: Partial<HarnessResult> = {}) {}
  buildInvocation(
    _def: AgentDefinition,
    _agent: AgentSpec,
    prompt: string,
    _gate: unknown,
    _tools?: unknown,
    proxy?: ModelProxyEndpoint,
  ): HarnessInvocation {
    this.endpoints.push(proxy);
    return {
      command: 'scripted',
      args: [],
      env: {},
      files: {},
      stdin: prompt,
      limits: { maxTurns: 3 },
    };
  }
  run(): Promise<HarnessResult> {
    return Promise.resolve({
      exitCode: 0,
      text: 'answer',
      isError: false,
      turns: 2,
      costUsd: 0.5,
      tokensIn: 1000,
      tokensOut: 200,
      toolCalls: [],
      terminated: 'none',
      ...this.result,
    });
  }
}

describe('executeWithHarness through the proxy', () => {
  const kinds = (c: { steps: { kind: string; status: string }[] }) =>
    c.steps.map((s) => `${s.kind}:${s.status}`);

  it('leaves the books to the proxy: no model_call step, the harness report rides on the output', async () => {
    const def = agentFile(TOOLS);
    const harness = new ScriptedProxyHarness({
      toolCalls: [{ id: '1', name: 'mcp__oax-gate__x', input: {}, isError: false, output: '' }],
    });
    const { ctx, control, tools } = setup(def);
    const asked: string[] = [];
    const r = await executeWithHarness(prepared(def), ctx, harness, {
      modelProxy: (a) => {
        asked.push(a.id);
        return Promise.resolve(endpoint());
      },
    });
    await tools.close();
    expect(r.status).toBe('succeeded');
    expect(asked).toEqual(['a']);
    expect(harness.endpoints[0]).toMatchObject({ protocol: 'anthropic', model: 'sim-1' });
    expect(kinds(control)).toEqual(['output:ok']);
    // Reported numbers never enter the usage that the node reports.
    expect(r.usage).toMatchObject({ tokensIn: 0, tokensOut: 0, costMicros: 0 });
    const out = control.steps.find((s) => s.kind === 'output')!.output as {
      content: string;
      harness: Record<string, unknown>;
    };
    expect(out.content).toBe('answer');
    expect(out.harness).toMatchObject({
      name: 'claude-code',
      turns: 2,
      terminated: 'none',
      reported: { costUsd: 0.5, tokensIn: 1000, tokensOut: 200 },
      toolCalls: [{ name: 'mcp__oax-gate__x', isError: false }],
    });
    expect(control.verifyAudit().valid).toBe(true);
  });

  it('keeps the report of a failed run in an error step and maps the terminations', async () => {
    const def = agentFile(TOOLS);
    const harness = new ScriptedProxyHarness({
      isError: true,
      terminated: 'timeout',
      errorMessage: 'harness stopped: timeout',
    });
    const { ctx, control, tools } = setup(def);
    const r = await executeWithHarness(prepared(def), ctx, harness, {
      modelProxy: () => Promise.resolve(endpoint()),
    });
    await tools.close();
    expect(r).toMatchObject({ status: 'failed', error: { code: 'control_timeout' } });
    expect(kinds(control)).toEqual(['error:error']);
    expect(control.steps[0]!.output).toMatchObject({ harness: { terminated: 'timeout' } });
  });

  it('blocks a harness that used a tool outside the gate, with the report on record', async () => {
    const def = agentFile(TOOLS);
    const harness = new ScriptedProxyHarness({
      toolCalls: [{ id: '1', name: 'Bash', input: {}, isError: false, output: '' }],
    });
    const { ctx, control, tools } = setup(def);
    const r = await executeWithHarness(prepared(def), ctx, harness, {
      modelProxy: () => Promise.resolve(endpoint()),
    });
    await tools.close();
    expect(r).toMatchObject({
      status: 'blocked_by_policy',
      error: { code: 'harness_unmanaged_tool' },
    });
    expect(kinds(control)).toContain('error:error');
  });

  it('fails the step with the code of a refused model token', async () => {
    const def = agentFile(TOOLS);
    const harness = new ScriptedProxyHarness();
    const { ctx, control, tools } = setup(def);
    const r = await executeWithHarness(prepared(def), ctx, harness, {
      modelProxy: () =>
        Promise.reject(new OaxError('model_token_already_issued', 'already issued')),
    });
    await tools.close();
    expect(r).toMatchObject({ status: 'failed', error: { code: 'model_token_already_issued' } });
    expect(kinds(control)).toEqual(['error:error']);
    expect(harness.endpoints).toEqual([]);
  });

  it('does not run the proxy path without the option (CLI behaviour is unchanged)', async () => {
    const def = agentFile(TOOLS);
    const harness = new ScriptedProxyHarness();
    const { ctx, control, tools } = setup(def);
    await executeWithHarness(prepared(def), ctx, harness, {});
    await tools.close();
    expect(harness.endpoints).toEqual([undefined]);
    expect(kinds(control)).toEqual(['model_call:ok', 'output:ok']);
  });
});

describe('the step executor', () => {
  it('never runs a harness step inline', async () => {
    const def = agentFile(TOOLS);
    const inline = {
      ...def,
      agents: [{ ...def.agents[0]!, runtime: { harness: 'claude-code' as const } }],
    } as AgentDefinition;
    const { ctx, tools } = setup(inline);
    const r = await executePipeline(prepared(inline), ctx);
    await tools.close();
    expect(r).toMatchObject({
      status: 'failed',
      error: { code: 'harness_requires_isolated_runner' },
    });
  });
});
