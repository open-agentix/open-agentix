import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAgentDefinition, validateAgentSource } from '@openagentix/core';
import { runCli, type CliIo } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const PLAN = 'examples/plans/payment-ticket-analysis.plan.yaml';
const CONNECTIONS = 'examples/plans/connections.json';

function io(files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readFile: async (p) => files[p] ?? readFile(root + p, 'utf8'),
    env: {},
  };
  return { cli, out, err };
}

const PLAN_OF = (extra: string) => `apiVersion: openagentix.io/v1alpha1
kind: AgentPlan
name: p
version: 1.0.0
description: d
steps:
  - id: a
    purpose: x
    ${extra}
`;

describe('oax plan', () => {
  it('check: the example plan is clean against its connections', async () => {
    const a = io();
    expect(await runCli(['plan', 'check', PLAN, '--connections', CONNECTIONS], a.cli)).toBe(0);
    expect(a.out).toHaveLength(1);
    expect(a.out[0]).toMatch(/^sha256:[0-9a-f]{64} errors=0 warnings=0 info=0$/);
    expect(a.err).toEqual([]);
  });

  it('check --json prints the AgentPlanLint document', async () => {
    const a = io();
    expect(
      await runCli(['plan', 'check', PLAN, '--connections', CONNECTIONS, '--json'], a.cli),
    ).toBe(0);
    const doc = JSON.parse(a.out.join('\n'));
    expect(doc).toMatchObject({
      kind: 'AgentPlanLint',
      lintVersion: 1,
      findings: [],
      summary: { error: 0 },
    });
  });

  it('check without connections notes that capabilities are not verified', async () => {
    const a = io();
    // offline: tool capabilities count as write, so the read-only research step is an error
    expect(await runCli(['plan', 'check', PLAN], a.cli)).toBe(1);
    expect(a.err[0]).toMatch(/not verified/);
    expect(a.out.some((l) => l.includes('LP006'))).toBe(true);
  });

  it('check: findings are printed and error findings give exit code 1', async () => {
    const a = io({ 'bad.yaml': PLAN_OF('capabilities: [ghost:read]\n    access: write') });
    expect(await runCli(['plan', 'check', 'bad.yaml', '--connections', CONNECTIONS], a.cli)).toBe(
      1,
    );
    expect(a.out[0]).toBe(
      'error   LP004 steps.0.capabilities.0: capability ghost:read is not offered: connection "ghost" is not available',
    );
  });

  it('check: warnings only exit 0', async () => {
    const a = io({ 'w.yaml': PLAN_OF('capabilities: [jira:write]\n    access: write') });
    expect(await runCli(['plan', 'check', 'w.yaml', '--connections', CONNECTIONS], a.cli)).toBe(0);
    expect(a.out[0]).toMatch(/^warning LP001 /);
  });

  it('check: invalid plans and bad arguments', async () => {
    const a = io({ 'x.yaml': 'kind: nope' });
    expect(await runCli(['plan', 'check', 'x.yaml'], a.cli)).toBe(1);
    expect(a.out).toEqual(['invalid plan']);
    expect(a.err.length).toBeGreaterThan(0);
    const b = io();
    expect(await runCli(['plan', 'check'], b.cli)).toBe(2);
    expect(await runCli(['plan', 'frobnicate', PLAN], b.cli)).toBe(2);
    expect(await runCli(['plan', '--help'], b.cli)).toBe(0);
    expect(b.out.join('\n')).toContain('oax plan check');
    const c = io({ 'c.json': '[{"name":"Bad Name"}]' });
    expect(await runCli(['plan', 'check', PLAN, '--connections', 'c.json'], c.cli)).toBe(2);
  });

  it('generate: prints a draft that parses and keeps read-only steps read-only', async () => {
    const a = io();
    expect(
      await runCli(
        [
          'plan',
          'generate',
          PLAN,
          '--connections',
          CONNECTIONS,
          '--owner',
          'team-support',
          '--provider',
          'anthropic',
          '--model',
          'claude-x',
        ],
        a.cli,
      ),
    ).toBe(0);
    const draft = a.out.join('\n') + '\n';
    expect(validateAgentSource(draft).errors).toEqual([]);
    const def = parseAgentDefinition(draft);
    expect(def.owner).toBe('team-support');
    expect(def.agents.map((x) => [x.id, x.access])).toEqual([
      ['research', 'read-only'],
      ['analysis', 'read-only'],
      ['action', 'write'],
    ]);
    expect(def.agents[0]?.tools.map((t) => t.tool)).toEqual(['get_customer']);
    // deterministic
    const b = io();
    await runCli(
      [
        'plan',
        'generate',
        PLAN,
        '--connections',
        CONNECTIONS,
        '--owner',
        'team-support',
        '--provider',
        'anthropic',
        '--model',
        'claude-x',
      ],
      b.cli,
    );
    expect(b.out).toEqual(a.out);
  });

  it('generate: refuses plans with error findings and prints the findings', async () => {
    const a = io({ 'bad.yaml': PLAN_OF('capabilities: [jira:write]\n    access: read-only') });
    expect(
      await runCli(['plan', 'generate', 'bad.yaml', '--connections', CONNECTIONS], a.cli),
    ).toBe(1);
    expect(a.out).toEqual(['no draft: the plan has error findings']);
    expect(a.err.some((l) => l.includes('LP006'))).toBe(true);
  });
});
