import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotImplementedError } from '@openagentix/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeCodeHarness,
  applyStreamEvent,
  createHarness,
  newStreamState,
  type HarnessInvocation,
} from '../src/index.js';
import { agentFile } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oax-harness-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const inv = (prompt: string, limits: HarnessInvocation['limits'] = {}): HarnessInvocation => ({
  command: process.execPath,
  args: [FAKE],
  env: { PATH: process.env.PATH ?? '' },
  files: {},
  stdin: prompt,
  limits,
});

describe('ClaudeCodeHarness.buildInvocation', () => {
  const gate = {
    serverName: 'oax-gate',
    url: 'http://127.0.0.1:1234/mcp',
    runToken: 'secret-run-token',
  };

  it('only sees the policy gate and maps the agent contract to flags', () => {
    const def = agentFile(
      `    tools:
      - { server: tickets, tool: add_comment }
      - { server: cve-db, tool: "lookup_*" }
    budget: { maxSteps: 4, maxCostUsd: 0.25, timeoutSeconds: 90 }`,
    );
    const i = new ClaudeCodeHarness({ home: '/home/x' }).buildInvocation(
      def,
      def.agents[0]!,
      'Triage this',
      gate,
    );
    const arg = (flag: string) => i.args[i.args.indexOf(flag) + 1];
    expect(i.command).toBe('claude');
    expect(i.stdin).toBe('Triage this');
    expect(i.args).not.toContain('Triage this'); // prompt never on the command line
    expect(i.args).toContain('--strict-mcp-config');
    expect(i.args).toContain('--restricted');
    expect(arg('--tools')).toBe('');
    expect(arg('--permission-mode')).toBe('dontAsk');
    expect(arg('--allowedTools')).toBe(
      'mcp__oax-gate__tickets__add_comment,mcp__oax-gate__cve-db__lookup_*',
    );
    expect(arg('--max-turns')).toBe('4');
    expect(arg('--max-budget-usd')).toBe('0.25');
    expect(i.limits).toEqual({ maxTurns: 4, maxBudgetUsd: 0.25, timeoutMs: 90_000 });
    expect(i.env.HOME).toBe('/home/x');
    expect(Object.keys(i.env).sort()).toEqual(
      [
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'DISABLE_AUTOUPDATER',
        'HOME',
        'LANG',
        'NO_COLOR',
        'PATH',
      ].sort(),
    );
    expect(JSON.stringify(i.args)).not.toContain('secret-run-token');
    expect(JSON.parse(i.files['.openagentix/mcp.json']!)).toEqual({
      mcpServers: {
        'oax-gate': {
          type: 'http',
          url: gate.url,
          headers: { Authorization: 'Bearer secret-run-token' },
        },
      },
    });
  });

  it('prefers the exact served tools and has a default turn limit', () => {
    const def = agentFile(`    tools:
      - { server: cve-db, tool: "lookup_*" }`);
    const i = new ClaudeCodeHarness({ defaultMaxTurns: 7 }).buildInvocation(
      def,
      def.agents[0]!,
      'p',
      gate,
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
    expect(i.args[i.args.indexOf('--allowedTools') + 1]).toBe('mcp__oax-gate__cve-db__lookup_cve');
    expect(i.limits).toEqual({ maxTurns: 7 });
    expect(i.args).not.toContain('--max-budget-usd');
  });

  it('does not put HOME into the environment when an OAuth token file is used', () => {
    const def = agentFile('');
    const i = new ClaudeCodeHarness({ oauthTokenFile: '/run/secrets/t' }).buildInvocation(
      def,
      def.agents[0]!,
      'p',
      gate,
    );
    expect(i.env.HOME).toBeUndefined();
  });
});

describe('stream-json parsing', () => {
  it('folds events and tolerates odd shapes', () => {
    const s = newStreamState();
    applyStreamEvent(s, { type: 'assistant', message: { content: 'x' } });
    applyStreamEvent(s, { type: 'user', message: {} });
    applyStreamEvent(s, { type: 'result', is_error: true, subtype: 'weird' });
    expect(s.turnIds.size).toBe(1);
    expect(s.isError).toBe(true);
    expect(s.errorMessage).toContain('weird');
  });
});

describe('ClaudeCodeHarness.run (fake binary)', () => {
  const harness = new ClaudeCodeHarness();

  it('parses a successful run: answer, tool calls, tokens, cost', async () => {
    const r = await harness.run(inv('ok'), { cwd: dir });
    expect(r).toMatchObject({
      exitCode: 0,
      isError: false,
      text: 'final answer',
      turns: 2,
      costUsd: 0.0123,
      tokensIn: 20,
      tokensOut: 7,
      model: 'fake-model',
      sessionId: 'sess-1',
      terminated: 'none',
    });
    expect(r.toolCalls).toEqual([
      {
        id: 't1',
        name: 'mcp__oax-gate__x',
        input: { a: 1 },
        isError: false,
        output: 'tool says hi',
      },
    ]);
  });

  it('truncates and records tool errors', async () => {
    const r = await harness.run(inv('string-result'), { cwd: dir });
    expect(r.toolCalls[0]).toMatchObject({ name: 'Bash', isError: true });
    expect(r.toolCalls[0]!.output).toHaveLength(2000);
  });

  it('writes files with restrictive modes, refuses path escapes and uses a minimal environment', async () => {
    const i = {
      ...inv('env'),
      files: { '.openagentix/mcp.json': '{"a":1}' },
      env: { PATH: process.env.PATH ?? '', HOME: '/h' },
    };
    const r = await harness.run(i, { cwd: dir });
    expect(readFileSync(join(dir, '.openagentix/mcp.json'), 'utf8')).toBe('{"a":1}');
    const seen = JSON.parse(r.text) as { keys: string[]; home: string; token: null };
    expect(seen.keys).toEqual(expect.arrayContaining(['HOME', 'PATH']));
    expect(seen.keys.length).toBeLessThanOrEqual(6); // PATH, HOME + a few runtime-added vars
    expect(seen.keys).not.toContain('GH_TOKEN');
    expect(seen.token).toBeNull();
    await expect(
      harness.run({ ...inv('ok'), files: { '../escape': 'x' } }, { cwd: dir }),
    ).rejects.toThrow(/escapes workdir/);
  });

  it('hands an OAuth token file to the child only, with an isolated HOME, and redacts it', async () => {
    const tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, 'tok-1234567890-abcdef\n');
    const h = new ClaudeCodeHarness({ oauthTokenFile: tokenFile });
    const seen = JSON.parse((await h.run(inv('env'), { cwd: join(dir, 'w') })).text) as {
      token: string;
      home: string;
    };
    expect(seen.token).toBe('match');
    expect(seen.home).toBe(join(dir, 'w', '.home'));
    const leaked = await h.run(inv('string-result'), { cwd: join(dir, 'w2') });
    expect(leaked.text).toBe('leaked [REDACTED]');
    writeFileSync(tokenFile, '\n');
    await expect(h.run(inv('ok'), { cwd: join(dir, 'w3') })).rejects.toThrow(/token file is empty/);
  });

  it('maps the harness limits and errors to terminations', async () => {
    expect(await harness.run(inv('maxturns'), { cwd: dir })).toMatchObject({
      isError: true,
      terminated: 'turns',
    });
    expect(await harness.run(inv('maxbudget'), { cwd: dir })).toMatchObject({
      terminated: 'budget',
    });
    const err = await harness.run(inv('error'), { cwd: dir });
    expect(err).toMatchObject({ isError: true, terminated: 'none' });
    expect(err.errorMessage).toContain('error_during_execution');
  });

  it('enforces the turn limit itself (kills a runaway harness)', async () => {
    const r = await harness.run(inv('turns', { maxTurns: 3 }), { cwd: dir });
    expect(r).toMatchObject({ isError: true, terminated: 'turns' });
    expect(r.errorMessage).toContain('turns');
  });

  it('enforces the timeout and cancellation', async () => {
    const t = await harness.run(inv('hang', { timeoutMs: 300 }), { cwd: dir });
    expect(t).toMatchObject({ isError: true, terminated: 'timeout' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const c = await harness.run(inv('hang'), { cwd: dir, signal: ac.signal });
    expect(c.terminated).toBe('cancelled');
    const pre = new AbortController();
    pre.abort();
    expect((await harness.run(inv('hang'), { cwd: dir, signal: pre.signal })).terminated).toBe(
      'cancelled',
    );
  });

  it('caps the output volume', async () => {
    const r = await harness.run(inv('big'), { cwd: dir });
    expect(r.terminated).toBe('output_limit');
  }, 60_000);

  it('reports crashes with a redacted stderr tail and missing binaries as errors', async () => {
    const c = await harness.run(inv('crash'), { cwd: dir });
    expect(c).toMatchObject({ isError: true, exitCode: 3 });
    expect(c.errorMessage).toContain('boom');
    expect(c.errorMessage).not.toContain('abcdefghijklmnop');
    await expect(
      harness.run({ ...inv('ok'), command: '/nonexistent/claude' }, { cwd: dir }),
    ).rejects.toThrow(/cannot start/);
  });
});

describe('other harnesses are documented stubs', () => {
  it('shares the interface and throws NotImplementedError', async () => {
    for (const name of ['opencode', 'hermes', 'openclaw'] as const) {
      const h = createHarness(name);
      expect(h.name).toBe(name);
      await expect(h.run(inv('x'), { cwd: dir })).rejects.toThrow(NotImplementedError);
      expect(() => h.buildInvocation({} as never, {} as never, '', {} as never)).toThrow(
        NotImplementedError,
      );
    }
    expect(createHarness('claude-code').name).toBe('claude-code');
  });
});
