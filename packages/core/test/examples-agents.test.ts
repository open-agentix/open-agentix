import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isProfileGrant, validateAgentSource } from '../src/index.js';

const dir = fileURLToPath(new URL('../../../examples/agents/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.md'));

describe('examples/agents', () => {
  it('contains at least one example', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s validates without errors or warnings', (file) => {
    const r = validateAgentSource(readFileSync(`${dir}${file}`, 'utf8'));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe('code-quality-reviewer example', () => {
  const source = readFileSync(`${dir}code-quality-reviewer.md`, 'utf8');
  const def = validateAgentSource(source).definition!;

  it('has a pipeline budget and a budget on every step', () => {
    expect(def.budget?.maxCostUsd).toBeLessThanOrEqual(0.25);
    for (const a of def.agents) expect(a.budget?.maxTokens).toBeGreaterThan(0);
  });

  it('is read-only except for one approved PR comment', () => {
    const writers = def.agents.filter((a) => a.access !== 'read-only');
    expect(writers.map((a) => a.id)).toEqual(['publish']);
    const grants = [...def.agents.flatMap((a) => [...a.tools, ...(a.profileGrants ?? [])])];
    for (const g of grants) {
      const text = JSON.stringify(g);
      expect(text).not.toMatch(/merge|push|delete|approve|label|release/i);
    }
    const publish = def.agents.find((a) => a.id === 'publish')!;
    const pg = (publish.profileGrants ?? []).filter(isProfileGrant);
    expect(pg).toHaveLength(1);
    expect(pg[0]).toMatchObject({ profile: 'pr-comment', approval: 'required', maxCallsPerRun: 1 });
  });

  it('uses each catalogue rule id as a valid id with its section', () => {
    const ids = [...source.matchAll(/\| (QG-(\d{2})\.\d{1,2}) \|/g)];
    expect(ids.length).toBeGreaterThanOrEqual(30);
    const seen = new Set<string>();
    for (const [, id, section] of ids) {
      expect(seen.has(id!)).toBe(false);
      seen.add(id!);
      expect(Number(section)).toBeGreaterThanOrEqual(1);
      expect(Number(section)).toBeLessThanOrEqual(29);
    }
  });
});
