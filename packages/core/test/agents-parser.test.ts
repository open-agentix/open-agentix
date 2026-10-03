import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  effectiveBudget,
  normalizeSource,
  parseAgentDefinition,
  parseMarkdownSections,
  splitFrontMatter,
} from '../src/index.js';
import { MINIMAL_FM, PIPELINE_SOURCE, withFrontMatter } from './fixtures.js';

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.issues.map((i) => `${i.path}: ${i.message}`);
    throw e;
  }
  return [];
}

describe('parseAgentDefinition', () => {
  it('parses a pipeline with sections, defaults and digest', () => {
    const def = parseAgentDefinition(PIPELINE_SOURCE);
    expect(def.name).toBe('cve-triage');
    expect(def.pipeline).toEqual(['triage', 'notify']);
    expect(def.agents[0]?.instructions).toContain('You triage CVEs.');
    expect(def.agents[0]?.instructions).toContain('not-a-heading');
    expect(def.agents[1]?.instructions).toBe('You write the ticket comment.');
    expect(def.agents[1]?.tools[0]?.approval).toBe('required');
    expect(def.agents[0]?.tools[0]?.allowAdditionalArgs).toBe(false);
    expect(def.agents[0]?.outputs).toEqual([{ format: 'markdown' }]);
    expect(def.overview).toBe('Looks at CVE findings and updates tickets.');
    expect(def.sections).toEqual({ Notes: 'Free text.' });
    expect(def.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(def.approvals.approverRoles).toEqual(['operator']);
  });

  it('produces the same digest regardless of line endings', () => {
    const crlf = PIPELINE_SOURCE.replace(/\n/g, '\r\n');
    expect(parseAgentDefinition(crlf).digest).toBe(parseAgentDefinition(PIPELINE_SOURCE).digest);
  });

  it('applies defaults for a minimal agent', () => {
    const def = parseAgentDefinition(withFrontMatter(MINIMAL_FM));
    expect(def.classification).toBe('internal');
    expect(def.triggers).toEqual([{ type: 'manual' }]);
    expect(def.pipeline).toEqual(['a']);
    expect(def.approvals.timeoutSeconds).toBe(3600);
  });

  it('accepts inline instructions', () => {
    const fm = MINIMAL_FM + '\n    instructions: Inline text';
    const def = parseAgentDefinition(withFrontMatter(fm, '# Title only\n'));
    expect(def.agents[0]?.instructions).toBe('Inline text');
  });

  it('requires front matter', () => {
    expect(issuesOf(() => parseAgentDefinition('# no front matter'))).toEqual([
      ': missing front matter',
    ]);
  });

  it('reports YAML errors', () => {
    const issues = issuesOf(() => parseAgentDefinition(withFrontMatter('a: [unclosed')));
    expect(issues.length).toBeGreaterThan(0);
  });

  it('reports duplicate YAML keys', () => {
    expect(
      issuesOf(() => parseAgentDefinition(withFrontMatter(MINIMAL_FM + '\nname: again'))),
    ).not.toEqual([]);
  });

  it('reports schema errors with paths', () => {
    const issues = issuesOf(() =>
      parseAgentDefinition(withFrontMatter(MINIMAL_FM.replace('name: mini', 'name: Not A Slug'))),
    );
    expect(issues.some((i) => i.startsWith('name:'))).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    const issues = issuesOf(() => parseAgentDefinition(withFrontMatter(MINIMAL_FM + '\nfoo: bar')));
    expect(issues.join()).toMatch(/foo/);
  });

  it('rejects an empty front matter', () => {
    expect(issuesOf(() => parseAgentDefinition('---\n\n---\n')).length).toBeGreaterThan(0);
  });

  it('requires instructions and matching sections', () => {
    const issues = issuesOf(() =>
      parseAgentDefinition(withFrontMatter(MINIMAL_FM, '## Agent: ghost\n\ntext\n')),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/needs instructions/);
    expect(issues[1]).toMatch(/no matching agent/);
  });
});

describe('markdown helpers', () => {
  it('splits sections and keeps overview', () => {
    const md = parseMarkdownSections('intro\n## A\nbody a\n## B\nbody b');
    expect(md.title).toBeNull();
    expect(md.overview).toBe('intro');
    expect(md.sections).toEqual([
      { heading: 'A', body: 'body a' },
      { heading: 'B', body: 'body b' },
    ]);
  });
  it('normalises sources', () => {
    expect(normalizeSource('\uFEFFa\r\nb\r\n\r\n')).toBe('a\nb\n');
    expect(splitFrontMatter('---\na: 1\n---').body).toBe('');
  });
});

describe('effectiveBudget', () => {
  it('takes the stricter value per field', () => {
    expect(
      effectiveBudget({ maxSteps: 10, maxTokens: 100 }, { maxSteps: 5, timeoutSeconds: 9 }),
    ).toEqual({
      maxSteps: 5,
      maxTokens: 100,
      timeoutSeconds: 9,
    });
    expect(effectiveBudget({ maxSteps: 3 }, { maxSteps: 5 })).toEqual({ maxSteps: 3 });
    expect(effectiveBudget({ maxSteps: 3 })).toEqual({ maxSteps: 3 });
  });
});
