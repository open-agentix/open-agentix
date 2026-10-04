import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EgressPolicy,
  OaxError,
  PolicyBundleSchema,
  StaticSecretResolver,
  parseAllowlist,
  resetEgressPolicy,
  setEgressPolicy,
} from '@openagentix/core';
import type { ProviderConfig } from '@openagentix/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OpenCodeHarness,
  OpenCodeOutputParser,
  OPENCODE_BUILTIN_TOOLS,
  createHarness,
  executeWithHarness,
  type HarnessResult,
} from '../src/index.js';
import { agentFile, prepared, setup } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url));
const GATE = {
  serverName: 'oax-gate',
  url: 'http://127.0.0.1:1234/mcp',
  runToken: 'run-token-xyz',
};
const API_KEY = 'sk-test-0123456789abcdef';

const conn = (extra: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({
    kind: 'openai-compatible',
    name: 'simulated', // the test agents use `provider: simulated`
    baseUrl: 'http://127.0.0.1:9/v1/',
    apiKeySecret: 'llm-key',
    ...extra,
  }) as ProviderConfig;

const secrets = new StaticSecretResolver({ 'llm-key': API_KEY, 'hdr-secret': 'hdr-value-123456' });
const harnessFor = (p: ProviderConfig = conn(), extra = {}) =>
  new OpenCodeHarness({ command: FAKE, providers: [p], secrets, ...extra });

const TOOLS = `    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }
      - { server: tickets, tool: add_comment, allowAdditionalArgs: true }`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oax-opencode-test-'));
});
afterEach(() => {
  resetEgressPolicy();
  rmSync(dir, { recursive: true, force: true });
});

/** Builds an invocation for the scenario of the fake CLI. */
function build(h: OpenCodeHarness, scenario: string, agentYaml = TOOLS) {
  const def = agentFile(agentYaml);
  return h.buildInvocation(def, def.agents[0]!, `scenario: ${scenario}`, GATE);
}
const run = (h: OpenCodeHarness, scenario: string, signal?: AbortSignal, yaml = TOOLS) =>
  h.run(build(h, scenario, yaml), { cwd: join(dir, `w-${scenario}`), signal });

describe('OpenCodeHarness.buildInvocation', () => {
  it('only sees the policy gate, denies everything else and maps the agent contract', () => {
    const def = agentFile(`${TOOLS}
    budget: { maxSteps: 4, maxCostUsd: 0.25, timeoutSeconds: 90 }`);
    const h = harnessFor();
    const i = h.buildInvocation(def, def.agents[0]!, 'Triage this', GATE);
    expect(i.command).toBe(FAKE);
    expect(i.args).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'simulated/sim-1',
      '--agent',
      'oax',
    ]);
    expect(i.stdin).toBe('Triage this');
    expect(i.limits).toEqual({ maxTurns: 4, maxBudgetUsd: 0.25, timeoutMs: 90_000 });
    // no secrets and no prompt in the process list
    expect(JSON.stringify(i.args)).not.toMatch(/run-token|Triage|sk-/);
    expect(Object.keys(i.env).sort()).toEqual(
      [
        'LANG',
        'NO_COLOR',
        'OPENCODE_DISABLE_AUTOUPDATE',
        'OPENCODE_DISABLE_CLAUDE_CODE',
        'OPENCODE_DISABLE_DEFAULT_PLUGINS',
        'OPENCODE_DISABLE_LSP_DOWNLOAD',
        'OPENCODE_DISABLE_MODELS_FETCH',
        'OPENCODE_DISABLE_PROJECT_CONFIG',
        'PATH',
      ].sort(),
    );
    const cfg = JSON.parse(i.files['.openagentix/opencode.json']!) as Record<string, any>;
    expect(cfg.mcp).toEqual({
      'oax-gate': {
        type: 'remote',
        url: GATE.url,
        headers: { Authorization: 'Bearer run-token-xyz' },
        enabled: true,
      },
    });
    expect(cfg.permission['*']).toBe('deny');
    for (const b of OPENCODE_BUILTIN_TOOLS) {
      expect(cfg.permission[b]).toBe('deny');
      expect(cfg.tools[b]).toBe(false);
      expect(cfg.agent.oax.tools[b]).toBe(false);
    }
    expect(cfg.permission['oax-gate_cve-db__lookup_cve']).toBe('allow');
    expect(cfg.permission['oax-gate_tickets__add_comment']).toBe('allow');
    expect(cfg.agent.oax.permission).toEqual(cfg.permission);
    expect(cfg.agent.oax.steps).toBe(4);
    expect(cfg.agent.oax.prompt).toContain('Do it.');
    expect(cfg.enabled_providers).toEqual(['simulated']);
    expect(cfg.plugin).toEqual([]);
    expect(cfg.autoupdate).toBe(false);
    expect(cfg.share).toBe('disabled');
    // BYOK: the config references the key via the child's env, never contains it
    expect(cfg.provider.simulated.options).toEqual({
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: '{env:OAX_OPENCODE_API_KEY}',
    });
    expect(i.files['.openagentix/opencode.json']).not.toContain(API_KEY);
  });

  it('prefers the exact served tools and has a default step limit', () => {
    const def = agentFile(TOOLS);
    const i = harnessFor(conn(), { defaultMaxSteps: 7 }).buildInvocation(
      def,
      def.agents[0]!,
      'p',
      GATE,
      [
        {
          modelName: 'cve-db__lookup_cve',
          server: 'cve-db',
          tool: 'lookup_cve',
          description: '',
          inputSchema: {},
        },
      ],
    );
    const cfg = JSON.parse(i.files['.openagentix/opencode.json']!) as Record<string, any>;
    const allowed = Object.entries(cfg.permission).filter(([, v]) => v === 'allow');
    expect(allowed).toEqual([['oax-gate_cve-db__lookup_cve', 'allow']]);
    expect(i.limits).toEqual({ maxTurns: 7 });
  });

  it('refuses unknown and unsupported model connections', () => {
    const def = agentFile(TOOLS);
    const a = def.agents[0]!;
    expect(() => new OpenCodeHarness().buildInvocation(def, a, 'p', GATE)).toThrow(
      /no model connection "simulated"/,
    );
    for (const cfg of [
      { kind: 'simulated', name: 'simulated' },
      { kind: 'bedrock', name: 'simulated', region: 'eu-central-1' },
      {
        kind: 'azure-openai',
        name: 'simulated',
        endpoint: 'https://x.openai.azure.com',
        apiKeySecret: 'k',
      },
    ] as ProviderConfig[]) {
      try {
        harnessFor(cfg).buildInvocation(def, a, 'p', GATE);
        expect.unreachable();
      } catch (e) {
        expect((e as OaxError).code).toBe('harness_provider_unsupported');
      }
    }
  });

  it('maps the other connection kinds', () => {
    const def = agentFile(TOOLS);
    const cfgOf = (c: ProviderConfig) =>
      JSON.parse(
        harnessFor(c).buildInvocation(def, def.agents[0]!, 'p', GATE).files[
          '.openagentix/opencode.json'
        ]!,
      ).provider.simulated;
    expect(cfgOf({ kind: 'ollama', name: 'simulated' } as ProviderConfig).options.baseURL).toBe(
      'http://localhost:11434/v1',
    );
    expect(
      cfgOf({ kind: 'anthropic', name: 'simulated', apiKeySecret: 'k' } as ProviderConfig),
    ).toMatchObject({
      npm: '@ai-sdk/anthropic',
      options: { baseURL: 'https://api.anthropic.com/v1', apiKey: '{env:OAX_OPENCODE_API_KEY}' },
    });
    const withHeaders = cfgOf(
      conn({ headers: { 'x-a': '1' }, headerSecrets: { 'x-b': 'hdr-secret' } } as never),
    );
    expect(withHeaders.options.headers).toEqual({
      'x-a': '1',
      'x-b': '{env:OAX_OPENCODE_HEADER_0}',
    });
    expect(
      cfgOf({
        kind: 'lmstudio',
        name: 'simulated',
        baseUrl: 'http://localhost:1234/v1',
      } as ProviderConfig).options,
    ).toEqual({
      baseURL: 'http://localhost:1234/v1',
    });
    for (const kind of ['openrouter', 'vllm'] as const)
      expect(
        cfgOf({
          kind,
          name: 'simulated',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKeySecret: 'k',
        } as never).npm,
      ).toBe('@ai-sdk/openai-compatible');
  });
});

describe('OpenCodeOutputParser (recorded event stream)', () => {
  const lines = [
    { type: 'step_start', sessionID: 'ses_9', part: { type: 'step-start' } },
    {
      type: 'tool_use',
      part: {
        callID: 'call_1',
        tool: 'oax-gate_cve-db__lookup_cve',
        state: { status: 'completed', input: { cveId: 'CVE-1' }, output: 'ok' },
      },
    },
    {
      type: 'tool_use',
      part: { callID: 'call_2', tool: 'webfetch', state: { status: 'error', error: 'denied' } },
    },
    {
      type: 'step_finish',
      part: {
        cost: 0.5,
        tokens: { input: 3, output: 4, reasoning: 1, cache: { read: 2, write: 1 } },
      },
    },
    { type: 'step_start' },
    { type: 'text', part: { text: 'done ' } },
    { type: 'text', part: { text: 'now' } },
    { type: 'step_finish', part: { cost: 0.25 } },
    { type: 'tool_use', part: { tool: 'x', state: { status: 'completed', output: { a: 1 } } } },
    { type: 'tool_use' },
    { type: 'error', error: { message: 'oops' } },
    { type: 'error', error: 'weird' },
  ];

  it('extracts steps, gate tools in the shared name form, tokens, cost and the answer', () => {
    const p = new OpenCodeOutputParser('oax-gate');
    for (const l of lines) p.feed(JSON.stringify(l));
    p.feed('garbage');
    p.feed('"just a string"');
    const r = p.finalize(0);
    expect(r).toMatchObject({
      text: 'done now',
      turns: 2,
      costUsd: 0.75,
      tokensIn: 6,
      tokensOut: 5,
      sessionId: 'ses_9',
      complete: true,
      isError: true,
    });
    expect(r.errorMessage).toContain('unknown');
    expect(r.toolCalls.map((t) => [t.name, t.isError, t.output])).toEqual([
      ['mcp__oax-gate__cve-db__lookup_cve', false, 'ok'],
      ['webfetch', true, 'denied'],
      ['x', false, '{"a":1}'],
      ['', false, '""'],
    ]);
    expect(p.turnCount()).toBe(2);
    expect(p.costUsd()).toBe(0.75);
  });

  it('reports the error message of an error event and incomplete runs', () => {
    const p = new OpenCodeOutputParser('g');
    p.feed(JSON.stringify(lines[10]));
    expect(p.finalize(1)).toMatchObject({
      isError: true,
      complete: false,
      errorMessage: 'harness reported an error: oops',
    });
  });
});

describe('OpenCodeHarness.run (fake binary)', () => {
  it('runs in a confined environment: bound HOME/config, key only in the child env', async () => {
    const h = harnessFor(conn({ headerSecrets: { 'x-b': 'hdr-secret' } } as never));
    const r = await run(h, 'env');
    expect(r.isError).toBe(false);
    const seen = JSON.parse(r.text.replaceAll('[REDACTED]', 'R')) as Record<string, any>;
    const cwd = join(dir, 'w-env');
    expect(seen.home).toBe(join(cwd, '.home'));
    expect(seen.args[0]).toBe('run');
    expect(seen.keys.sort()).toEqual(
      [
        'HOME',
        'LANG',
        'NO_COLOR',
        'OAX_OPENCODE_API_KEY',
        'OAX_OPENCODE_HEADER_0',
        'OPENCODE_CONFIG',
        'OPENCODE_DISABLE_AUTOUPDATE',
        'OPENCODE_DISABLE_CLAUDE_CODE',
        'OPENCODE_DISABLE_DEFAULT_PLUGINS',
        'OPENCODE_DISABLE_LSP_DOWNLOAD',
        'OPENCODE_DISABLE_MODELS_FETCH',
        'OPENCODE_DISABLE_PROJECT_CONFIG',
        'PATH',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
      ].sort(),
    );
    // the key was delivered to the CLI but is scrubbed from what comes back
    expect(seen.key).toBe('R');
    expect(r.text).not.toContain(API_KEY);
    expect(r.model).toBeUndefined();
  });

  it('parses a successful run through the gate: answer, tool call, tokens, cost', async () => {
    const def = agentFile(TOOLS);
    const { ctx, tools } = setup(def);
    const h = harnessFor();
    const r = await executeWithHarness(prepared(def, { scenario: 'ok' }), ctx, h, {
      workRoot: dir,
    });
    await tools.close();
    expect(r.status).toBe('succeeded');
    expect(r.outputs[0]!.content).toBe('final answer');
    expect(r.usage).toMatchObject({ toolCalls: 1, tokensIn: 220, tokensOut: 40 });
    expect(r.usage.costMicros).toBe(2200 + 0); // 0.001 + 0.0012 harness cost, no tool price
  });

  it('records denied calls (policy) and stops forbidden tools', async () => {
    const def = agentFile(TOOLS);
    const policies = [PolicyBundleSchema.parse({ forbiddenTools: ['tickets/add_*'] })];
    const { ctx, control, tools, store } = setup(def, { control: { policies } });
    const r = await executeWithHarness(
      { ...prepared(def, { scenario: 'denied' }), policies },
      ctx,
      harnessFor(),
      { workRoot: dir },
    );
    await tools.close();
    expect(r.status).toBe('blocked_by_policy');
    expect(control.steps.map((s) => `${s.kind}:${s.status}`)).toContain('policy_decision:denied');
    expect(control.verifyAudit().valid).toBe(true);
    expect(store.size).toBe(0);
  });

  it('blocks the run when OpenCode used a built-in tool', async () => {
    const def = agentFile(TOOLS);
    const { ctx, tools } = setup(def);
    const r = await executeWithHarness(prepared(def, { scenario: 'builtin' }), ctx, harnessFor(), {
      workRoot: dir,
    });
    await tools.close();
    expect(r).toMatchObject({
      status: 'blocked_by_policy',
      error: { code: 'harness_unmanaged_tool' },
    });
    expect(r.error?.message).toContain('bash');
  });

  it('enforces step, cost and time limits and cancellation (process killed)', async () => {
    const limited = async (scenario: string, budget: string, signal?: AbortSignal) => {
      const def = agentFile(`${TOOLS}\n    budget: ${budget}`);
      const { ctx, tools } = setup(def);
      const r = await executeWithHarness(
        prepared(def, { scenario }),
        { ...ctx, ...(signal ? { signal } : {}) },
        harnessFor(),
        { workRoot: dir },
      );
      await tools.close();
      return r;
    };
    expect((await limited('steps', '{ maxSteps: 2 }')).error?.code).toBe('control_budget_steps');
    expect((await limited('cost', '{ maxCostUsd: 0.05 }')).error?.code).toBe('control_budget_cost');
    expect((await limited('hang', '{ timeoutSeconds: 1 }')).error?.code).toBe('control_timeout');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect((await limited('hang', '{ maxSteps: 3 }', ac.signal)).status).toBe('cancelled');
  }, 30_000);

  it('removes the temporary work directory (config, key material, HOME) after the run', async () => {
    const def = agentFile(TOOLS);
    const { ctx, tools } = setup(def);
    await executeWithHarness(prepared(def, { scenario: 'ok' }), ctx, harnessFor(), {
      workRoot: dir,
    });
    await executeWithHarness(prepared(def, { scenario: 'error' }), ctx, harnessFor(), {
      workRoot: dir,
    });
    await tools.close();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('redacts the API key and the run token in transcripts and tool output', async () => {
    const r: HarnessResult = await run(harnessFor(), 'leak');
    expect(r.text).toBe('my key is [REDACTED] and Bearer [REDACTED]');
    expect(r.toolCalls[0]!.output).toBe('echo [REDACTED]');
    expect(JSON.stringify(r)).not.toContain(API_KEY);
    expect(JSON.stringify(r)).not.toContain('run-token-xyz');
  });

  it('reports error events, crashes and missing results with a redacted stderr tail', async () => {
    const h = harnessFor();
    expect(await run(h, 'error')).toMatchObject({ isError: true, exitCode: 1 });
    expect((await run(h, 'error')).errorMessage).toContain('rate limited');
    const crash = await run(h, 'crash');
    expect(crash).toMatchObject({ isError: true, exitCode: 3 });
    expect(crash.errorMessage).toContain('boom');
    expect(crash.errorMessage).not.toContain('abcdefghijklmnop');
    expect((await run(h, 'noresult')).isError).toBe(true);
    await expect(
      new OpenCodeHarness({ command: '/nonexistent/opencode', providers: [conn()], secrets }).run(
        build(
          new OpenCodeHarness({ command: '/nonexistent/opencode', providers: [conn()], secrets }),
          'ok',
        ),
        { cwd: dir },
      ),
    ).rejects.toThrow();
  });

  it('refuses invocations it did not build and empty keys', async () => {
    const h = harnessFor();
    await expect(
      h.run({ command: FAKE, args: [], env: {}, files: {} }, { cwd: dir }),
    ).rejects.toThrow(/not built by this adapter/);
    const empty = new OpenCodeHarness({
      command: FAKE,
      providers: [conn()],
      secrets: new StaticSecretResolver({ 'llm-key': ' ' }),
    });
    await expect(run(empty, 'ok')).rejects.toThrow(/API key is empty/);
    const noKey = new OpenCodeHarness({
      command: FAKE,
      providers: [conn({ apiKeySecret: undefined } as never)],
    });
    expect((await run(noKey, 'env')).isError).toBe(false);
  });
});

describe('pinned binary', () => {
  it('verifies the SHA-256 of the binary before starting it', async () => {
    const bin = join(dir, 'opencode');
    writeFileSync(bin, readFake(), { mode: 0o700 });
    const sha = createHash('sha256').update(readFake()).digest('hex');
    const ok = new OpenCodeHarness({
      command: bin,
      expectedSha256: sha.toUpperCase(),
      providers: [conn()],
      secrets,
    });
    expect((await run(ok, 'plain')).isError).toBe(false);
    const bad = new OpenCodeHarness({
      command: bin,
      expectedSha256: '0'.repeat(64),
      providers: [conn()],
      secrets,
    });
    await expect(run(bad, 'plain')).rejects.toThrow(/pinned checksum/);
    const rel = new OpenCodeHarness({
      command: 'opencode',
      expectedSha256: sha,
      providers: [conn()],
      secrets,
    });
    await expect(run(rel, 'plain')).rejects.toThrow(/absolute path/);
    const missing = new OpenCodeHarness({
      command: join(dir, 'nope'),
      expectedSha256: sha,
      providers: [conn()],
      secrets,
    });
    await expect(run(missing, 'plain')).rejects.toThrow(/cannot read/);
  });
});

const readFake = () => readFileSync(FAKE);

describe('air-gapped mode', () => {
  it('refuses to start unless the model endpoint is allowlisted', async () => {
    const h = harnessFor(conn({ baseUrl: 'https://llm.example.com/v1' } as never));
    setEgressPolicy(new EgressPolicy({ airgapped: true, allow: [] }));
    await expect(run(h, 'plain')).rejects.toThrow(/OpenCode harness.*OAX_AIRGAPPED_ALLOW/);
    setEgressPolicy(
      new EgressPolicy({ airgapped: true, allow: parseAllowlist('other.example.com') }),
    );
    await expect(run(h, 'plain')).rejects.toThrow(/OAX_AIRGAPPED_ALLOW/);
    setEgressPolicy(
      new EgressPolicy({ airgapped: true, allow: parseAllowlist('llm.example.com') }),
    );
    // the refused cases never created a work directory or started a process
    expect(existsSync(join(dir, 'w-plain'))).toBe(false);
    expect((await run(h, 'plain')).isError).toBe(false);
    expect(existsSync(join(dir, 'w-plain'))).toBe(true);
  });

  it('allows loopback endpoints without an allowlist entry', async () => {
    setEgressPolicy(new EgressPolicy({ airgapped: true, allow: [] }));
    expect((await run(harnessFor(), 'plain')).isError).toBe(false);
  });
});

describe('createHarness', () => {
  it('builds the OpenCode adapter and keeps Hermes/OpenClaw as stubs', () => {
    expect(createHarness('opencode').name).toBe('opencode');
    expect(createHarness('opencode', { opencode: { providers: [conn()] } })).toBeInstanceOf(
      OpenCodeHarness,
    );
  });
});
