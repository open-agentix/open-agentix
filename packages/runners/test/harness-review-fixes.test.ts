import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StaticSecretResolver, type AgentSpec } from '@openagentix/core';
import type { ProviderConfig } from '@openagentix/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeCodeHarness,
  OpenCodeHarness,
  assertLoaderEnv,
  assertProxyInvocation,
  executeWithHarness,
  type ExternalHarness,
  type HarnessInvocation,
  type HarnessResult,
  type ModelProxyEndpoint,
} from '../src/index.js';
import { runHarnessProcess } from '../src/harness/process.js';
import { HttpControlPlane } from '../src/http-control-plane.js';
import { agentFile, prepared, setup } from './helpers.js';

const FAKE_OPENCODE = fileURLToPath(new URL('./fixtures/fake-opencode.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const GATE = {
  serverName: 'oax-gate',
  url: 'http://127.0.0.1:1234/mcp',
  runToken: 'run-token-xyz',
};
const TOKEN = 'oaxmt.eyJ2IjoxfQ.c2lnbmF0dXJl';
const TOOLS = `    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }`;
const endpoint = (): ModelProxyEndpoint => ({
  protocol: 'openai',
  baseUrl: 'https://control.example.org/v1/model-proxy/openai/',
  token: TOKEN,
  model: 'sim-1',
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oax-harness-review-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What OpenCode does to the configuration file: text-level substitution, then JSON.parse. */
interface Loaded {
  model: string;
  agent: { oax: { prompt: string } };
  provider: Record<string, { options: { apiKey: string; headers: Record<string, string> } }>;
}
function openCodeLoad(text: string, env: Record<string, string>): Loaded {
  const substituted = text
    .replace(/\{env:([^}]+)\}/g, (_m, name: string) => env[name] ?? '')
    .replace(/\{file:([^}]+)\}/g, (_m, p: string) => readFileSync(p, 'utf8'));
  return JSON.parse(substituted) as Loaded;
}

const HOSTILE = ['{env:OAX_OPENCODE_API_KEY}', '{file:/x}', 'a {ENV:OAX_OPENCODE_API_KEY} b'];

describe('OpenCode config: placeholder substitution cannot be abused (M1)', () => {
  const secretFile = () => {
    const f = join(dir, 'run-token');
    writeFileSync(f, 'oaxrt.SECRET-RUN-TOKEN');
    return f;
  };

  it.each(HOSTILE)('keeps %s in the instructions literal (proxy)', (bad) => {
    const h = new OpenCodeHarness({ command: FAKE_OPENCODE });
    const def = agentFile(TOOLS);
    const agent = { ...def.agents[0]!, instructions: bad.replace('/x', secretFile()) };
    const inv = h.buildInvocation(def, agent, 'p', GATE, undefined, endpoint());
    const text = inv.files['.openagentix/opencode.json']!;
    // Only the generated API key placeholder is left for the CLI to substitute.
    expect(text.match(/\{(?:env|file):[^}]*\}/gi)).toEqual(['{env:OAX_OPENCODE_API_KEY}']);
    const loaded = openCodeLoad(text, { OAX_OPENCODE_API_KEY: TOKEN });
    const prompt = loaded.agent.oax.prompt as string;
    expect(prompt).toContain(bad.replace('/x', secretFile()));
    expect(prompt).not.toContain(TOKEN);
    expect(prompt).not.toContain('SECRET-RUN-TOKEN');
    expect(loaded.provider['oax-proxy']!.options.apiKey).toBe(TOKEN);
  });

  it('keeps hostile model ids literal and an exact marker lookalike is not a placeholder', () => {
    const h = new OpenCodeHarness({ command: FAKE_OPENCODE });
    const def = agentFile(TOOLS);
    const model = '{env:OAX_OPENCODE_API_KEY}';
    const agent = {
      ...def.agents[0]!,
      model,
      instructions: 'oax-placeholder-x-OAX_OPENCODE_API_KEY',
    };
    const ep = { ...endpoint(), model };
    const inv = h.buildInvocation(def, agent, 'p', GATE, undefined, ep);
    const loaded = openCodeLoad(inv.files['.openagentix/opencode.json']!, {
      OAX_OPENCODE_API_KEY: TOKEN,
    });
    expect(loaded.model).toBe(`oax-proxy/${model}`);
    expect(JSON.stringify(loaded.agent)).not.toContain(TOKEN);
  });

  it.each(HOSTILE)(
    'keeps %s literal in the BYOK variant, header and key placeholders still work',
    (bad) => {
      const cfg = {
        kind: 'openai-compatible',
        name: 'simulated',
        baseUrl: 'http://127.0.0.1:9/v1/',
        apiKeySecret: 'llm-key',
        headerSecrets: { 'X-Org': 'hdr' },
      } as unknown as ProviderConfig;
      const h = new OpenCodeHarness({
        command: FAKE_OPENCODE,
        providers: [cfg],
        secrets: new StaticSecretResolver({
          'llm-key': 'sk-real-0123456789',
          hdr: 'hdr-value-123456',
        }),
      });
      const def = agentFile(TOOLS);
      const agent: AgentSpec = { ...def.agents[0]!, instructions: bad };
      const inv = h.buildInvocation(def, agent, 'p', GATE);
      const loaded = openCodeLoad(inv.files['.openagentix/opencode.json']!, {
        OAX_OPENCODE_API_KEY: 'sk-real-0123456789',
        OAX_OPENCODE_HEADER_0: 'hdr-value-123456',
      });
      expect(loaded.agent.oax.prompt as string).toContain(bad);
      expect(loaded.agent.oax.prompt as string).not.toContain('sk-real-0123456789');
      expect(loaded.provider.simulated!.options.apiKey).toBe('sk-real-0123456789');
      expect(loaded.provider.simulated!.options.headers['X-Org']).toBe('hdr-value-123456');
    },
  );
});

describe('harness environment (L2)', () => {
  const base = (): HarnessInvocation => ({
    command: 'x',
    args: ['--permission-mode', 'dontAsk'],
    env: { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: TOKEN },
    files: {},
    limits: { timeoutMs: 1000 },
    modelProxy: { protocol: 'anthropic', baseUrl: 'https://c/v1/model-proxy/anthropic' },
  });

  it.each([
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_CUSTOM_HEADERS',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_PERMISSION',
    'BUN_CONFIG_REGISTRY',
  ])('refuses %s', (key) => {
    const env = { ...base().env, [key]: '1' };
    expect(() => assertProxyInvocation(base(), undefined, env)).toThrow(/must not reach/);
    expect(() => assertLoaderEnv(env)).toThrow(/must not reach/);
  });

  it('refuses variables outside the allowlist and a foreign ANTHROPIC_BASE_URL', () => {
    expect(() => assertProxyInvocation(base(), undefined, { ...base().env, FOO: 'x' })).toThrow(
      /allowlist/,
    );
    expect(() =>
      assertProxyInvocation(base(), undefined, {
        ...base().env,
        ANTHROPIC_BASE_URL: 'https://evil.example.org',
      }),
    ).toThrow(/ANTHROPIC_BASE_URL/);
    expect(() =>
      assertProxyInvocation(base(), undefined, {
        ...base().env,
        ANTHROPIC_BASE_URL: 'https://c/v1/model-proxy/anthropic',
        HOME: '/h',
      }),
    ).not.toThrow();
  });

  it('checks the environment that is really passed to spawn (Claude Code)', async () => {
    const h = new ClaudeCodeHarness({ command: FAKE_CLAUDE });
    const def = agentFile(TOOLS);
    const inv = h.buildInvocation(def, def.agents[0]!, 'proxy-env', GATE, undefined, {
      ...endpoint(),
      protocol: 'anthropic',
      baseUrl: 'https://c/v1/model-proxy/anthropic',
    });
    // Added after the builder ran, e.g. by a subclass or a changed adapter.
    const saved = process.env.NODE_OPTIONS;
    inv.env.NODE_OPTIONS = '--require /tmp/x.js';
    try {
      await expect(h.run(inv, { cwd: join(dir, 'w') })).rejects.toThrow(/NODE_OPTIONS/);
    } finally {
      if (saved === undefined) delete process.env.NODE_OPTIONS;
    }
  });

  it('checks the final OpenCode environment too (BYOK and proxy)', async () => {
    const h = new OpenCodeHarness({ command: FAKE_OPENCODE });
    const def = agentFile(TOOLS);
    const inv = h.buildInvocation(
      def,
      def.agents[0]!,
      'scenario: plain',
      GATE,
      undefined,
      endpoint(),
    );
    inv.env.OPENCODE_CONFIG_CONTENT = '{}';
    await expect(h.run(inv, { cwd: join(dir, 'w1') })).rejects.toThrow(/OPENCODE_CONFIG_CONTENT/);
  });
});

describe('process handling (L1, L3)', () => {
  const parser = {
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
  };
  const inv = (script: string): HarnessInvocation => ({
    command: process.execPath,
    args: [script],
    env: { PATH: process.env.PATH ?? '' },
    files: {},
    limits: { timeoutMs: 20_000 },
  });
  const opts = (secrets: string[] = []) => ({
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    secrets,
    signal: undefined,
  });

  it('does not hang when a grandchild holds stdout open after the CLI exited', async () => {
    const pidFile = join(dir, 'sleep.pid');
    const script = join(dir, 'fake-cli.mjs');
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const c = spawn('sleep', ['30'], { stdio: 'inherit', detached: false });
writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
process.exit(0);`,
    );
    const started = Date.now();
    const res = await runHarnessProcess(inv(script), opts(), parser);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res.exitCode).toBe(0);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('redacts stderr before truncating it', async () => {
    const secret = 'oaxmt.' + 'A'.repeat(40);
    const script = join(dir, 'noisy.mjs');
    // The secret straddles the 300 character cut.
    writeFileSync(
      script,
      `process.stderr.write('x'.repeat(280) + ${JSON.stringify(secret)} + 'tail');
process.exit(1);`,
    );
    const res = await runHarnessProcess(inv(script), opts([secret]), {
      ...parser,
      finalize: () => ({ ...parser.finalize(), complete: false }),
    });
    expect(res.isError).toBe(true);
    expect(res.errorMessage).toContain('[REDACTED]');
    expect(res.errorMessage).not.toContain('AAAA');
  });
});

describe('token hygiene in recorded steps (M1, L3)', () => {
  it('sanitises a malformed model token response (no ZodError text with the token)', async () => {
    const leaky = { token: TOKEN + 'LEAK', protocol: 'bogus-protocol', baseUrl: 5 };
    const cp = new HttpControlPlane({
      baseUrl: 'http://127.0.0.1:1',
      runToken: 'oaxrt.x',
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify(leaky), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    const err = await cp.issueHarnessModelToken('run-1234567', 'a', 'opencode').catch((e) => e);
    expect(err).toMatchObject({ code: 'model_token_response_invalid' });
    expect(String(err.message)).not.toContain('LEAK');
    expect(String(err.message)).not.toContain('bogus-protocol');
  });

  it('redacts tokens in the args of gate calls and in harness errors', async () => {
    const def = agentFile(TOOLS);
    class Harness implements ExternalHarness {
      readonly name = 'opencode' as const;
      buildInvocation(): HarnessInvocation {
        return { command: 'x', args: [], env: {}, files: {}, limits: { maxTurns: 1 } };
      }
      run(): Promise<HarnessResult> {
        return Promise.reject(new Error(`boom ${TOKEN}`));
      }
    }
    const { ctx, control, tools } = setup(def);
    const r = await executeWithHarness(prepared(def), ctx, new Harness(), {
      modelProxy: () => Promise.resolve(endpoint()),
    });
    await tools.close();
    expect(r.status).toBe('failed');
    expect(JSON.stringify(control.steps)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('redacts tokens in the args of recorded gate calls', async () => {
    const def = agentFile(TOOLS);
    let gateToken = '';
    class Harness implements ExternalHarness {
      readonly name = 'opencode' as const;
      private gate?: { url: string; runToken: string };
      buildInvocation(
        _d: unknown,
        _a: unknown,
        _p: string,
        gate: { url: string; runToken: string },
      ): HarnessInvocation {
        this.gate = gate;
        gateToken = gate.runToken;
        return { command: 'x', args: [], env: {}, files: {}, limits: { maxTurns: 1 } };
      }
      async run(): Promise<HarnessResult> {
        await fetch(this.gate!.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${this.gate!.runToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'cve-db__lookup_cve',
              arguments: {
                cveId: 'CVE-2024-3094',
                note: `use ${TOKEN} and ${this.gate!.runToken}`,
              },
            },
          }),
        });
        return {
          exitCode: 0,
          text: 'ok',
          isError: false,
          turns: 1,
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          toolCalls: [],
          terminated: 'none',
        };
      }
    }
    const { ctx, control, tools } = setup(def);
    await executeWithHarness(prepared(def), ctx, new Harness(), {
      modelProxy: () => Promise.resolve(endpoint()),
    });
    await tools.close();
    const decision = control.steps.find((st) => st.kind === 'policy_decision');
    expect(decision).toBeDefined();
    expect(JSON.stringify(control.steps)).not.toContain(TOKEN);
    expect(gateToken.length).toBeGreaterThan(8);
    expect(JSON.stringify(control.steps)).not.toContain(gateToken);
  });
});
