import { NotImplementedError } from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeHarness, createHarness } from '../src/index.js';
import { agentFile } from './helpers.js';

describe('external harnesses', () => {
  it('builds a Claude Code invocation that only sees the policy gate', () => {
    const def = agentFile(`    tools:
      - { server: tickets, tool: add_comment }
      - { server: cve-db, tool: "lookup_*" }`);
    const inv = new ClaudeCodeHarness().buildInvocation(def, def.agents[0]!, 'Triage this', {
      serverName: 'oax-gate',
      url: 'https://oax.example/v1/worker/runs/r1/mcp',
      runToken: 'oaxrt.t',
    });
    expect(inv.command).toBe('claude');
    expect(inv.args).toContain('--strict-mcp-config');
    expect(inv.args[inv.args.indexOf('--allowedTools') + 1]).toBe(
      'mcp__oax-gate__tickets__add_comment,mcp__oax-gate__cve-db__lookup_*',
    );
    expect(JSON.parse(inv.files['.openagentix/mcp.json']!)).toEqual({
      mcpServers: {
        'oax-gate': {
          type: 'http',
          url: 'https://oax.example/v1/worker/runs/r1/mcp',
          headers: { Authorization: 'Bearer oaxrt.t' },
        },
      },
    });
  });
  it('stubs other harnesses', async () => {
    for (const name of ['claude-code', 'opencode', 'hermes', 'openclaw'] as const) {
      const h = createHarness(name);
      expect(h.name).toBe(name);
      await expect(h.run({ command: '', args: [], env: {}, files: {} })).rejects.toThrow(
        NotImplementedError,
      );
      if (name !== 'claude-code')
        expect(() => h.buildInvocation({} as never, {} as never, '', {} as never)).toThrow(
          NotImplementedError,
        );
    }
  });
});
