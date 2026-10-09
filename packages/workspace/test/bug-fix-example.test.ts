import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateAgentSource } from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import { workspaceToolGrants } from '../src/index.js';

const source = readFileSync(
  fileURLToPath(new URL('../../../examples/agents/bug-fix-agent.md', import.meta.url)),
  'utf8',
);
const result = validateAgentSource(source);
const def = result.definition!;

describe('examples/agents/bug-fix-agent.md', () => {
  it('validates cleanly', () => {
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('has the budgets of the dogfooding plan and no network', () => {
    expect(def.budget).toMatchObject({
      maxCostUsd: 2,
      maxSteps: 40,
      maxToolCalls: 80,
      timeoutSeconds: 1200,
    });
    expect(def.runtime.egress).toEqual([]);
    expect(def.runtime.runner).toBe('container');
    expect(def.triggers).toEqual([{ type: 'manual' }]);
  });

  it('starts on Haiku with the harness and a pull-request output', () => {
    const [fix] = def.agents;
    expect(def.agents).toHaveLength(1);
    expect(fix).toMatchObject({
      id: 'fix',
      model: 'claude-haiku-4-5',
      access: 'write',
      runtime: { harness: 'claude-code' },
      outputs: [{ format: 'pull-request', target: 'dogfood-sandbox' }],
    });
  });

  it('grants exactly the workspace tools, identical to workspaceToolGrants()', () => {
    const tools = def.agents[0]!.tools;
    expect(tools.every((t) => t.server === 'workspace')).toBe(true);
    const want = workspaceToolGrants();
    expect(tools.map((t) => t.tool).sort()).toEqual(want.map((t) => t.tool).sort());
    for (const w of want) {
      const got = tools.find((t) => t.tool === w.tool)!;
      expect(got.maxCallsPerRun, w.tool).toBe(w.maxCallsPerRun);
      // the schema adds `required: false` to optional arguments; everything else must be equal
      const norm = (v: unknown) =>
        JSON.parse(JSON.stringify(v ?? {}), (_k, x) => x) as Record<
          string,
          Record<string, unknown>
        >;
      const strip = (a: Record<string, Record<string, unknown>>) =>
        Object.fromEntries(
          Object.entries(a).map(([k, d]) => [
            k,
            Object.fromEntries(
              Object.entries(d).filter(([f, x]) => !(f === 'required' && x === false)),
            ),
          ]),
        );
      expect(strip(norm(got.args)), w.tool).toEqual(strip(norm(w.args)));
    }
  });

  it('only the write tools carry the src/test path constraint', () => {
    const tools = def.agents[0]!.tools;
    for (const name of ['edit_file', 'write_file'])
      expect(JSON.stringify(tools.find((t) => t.tool === name)!.args)).toContain('(src|test)/');
  });

  it('contains no real secret or personal data', () => {
    expect(source).not.toMatch(/ghp_|github_pat_|sk-ant|oaxrt\.|oaxmt\./);
    expect(source).not.toMatch(/@gmail\.|@weisser/);
  });
});
