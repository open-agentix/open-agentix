import { describe, expect, it } from 'vitest';
import {
  DARK_FACTORY_NOTICE,
  GuidelineRulesSchema,
  evaluateToolCall,
  guidelinesToPolicyBundle,
  resolveGuidelines,
  reviewChange,
  ToolGrantSchema,
  validateAgentSource,
  type GuidelineSet,
} from '../src/index.js';
import { MINIMAL_FM, withFrontMatter } from './fixtures.js';

const set = (scope: GuidelineSet['scope'], rules: object, name = scope): GuidelineSet => ({
  name,
  version: '1.0.0',
  scope,
  rules: GuidelineRulesSchema.parse(rules),
});

describe('resolveGuidelines', () => {
  it('lets the stricter rule win across global -> tenant -> agent', () => {
    const r = resolveGuidelines([
      set('agent', {
        minCoverage: 60,
        maxClassification: 'confidential',
        forbiddenDependencies: ['left-pad'],
      }),
      set('global', {
        minCoverage: 80,
        conventionalCommits: true,
        requireApprovalTools: ['*/merge_*'],
        maxClassification: 'internal',
      }),
      set('tenant', {
        requireTests: true,
        forbiddenTools: ['shell/*'],
        forbiddenArgPatterns: [{ pattern: 'rm -rf' }],
        forbiddenDependencies: ['left-pad', 'event-stream'],
      }),
    ]);
    expect(r).toEqual({
      forbiddenDependencies: ['left-pad', 'event-stream'],
      minCoverage: 80,
      conventionalCommits: true,
      requireTests: true,
      requireApprovalTools: ['*/merge_*'],
      forbiddenTools: ['shell/*'],
      forbiddenArgPatterns: [{ pattern: 'rm -rf', reason: 'forbidden by guideline' }],
      maxClassification: 'internal',
    });
    expect(resolveGuidelines([])).toMatchObject({ forbiddenTools: [], requireTests: false });
  });

  it('feeds the policy gate (hardening agent cannot be bypassed by agent files)', () => {
    const bundle = guidelinesToPolicyBundle(
      resolveGuidelines([set('global', { requireApprovalTools: ['git/merge_*'] })]),
    );
    const d = evaluateToolCall(
      { server: 'git', tool: 'merge_pr', args: {} },
      {
        definition: { classification: 'internal' },
        agent: { id: 'dev', tools: [ToolGrantSchema.parse({ server: 'git', tool: '*' })] },
        bundles: [bundle],
      },
    );
    expect(d.effect).toBe('require_approval');
    expect(
      guidelinesToPolicyBundle(resolveGuidelines([set('tenant', { maxClassification: 'public' })]))
        .maxClassification,
    ).toBe('public');
  });
});

describe('reviewChange', () => {
  const rules = resolveGuidelines([
    set('global', {
      forbiddenDependencies: ['lodash*'],
      minCoverage: 80,
      conventionalCommits: true,
      requireTests: true,
    }),
  ]);

  it('reports every violated guideline', () => {
    const findings = reviewChange(rules, {
      addedDependencies: ['lodash.merge', 'zod'],
      coveragePercent: 71,
      commitMessages: ['feat(core): add x', 'WIP stuff'],
      changedFiles: ['src/a.ts', 'README.md'],
    });
    expect(findings.map((f) => f.rule)).toEqual([
      'forbidden_dependency',
      'coverage',
      'conventional_commits',
      'tests_missing',
    ]);
  });

  it('passes a compliant change', () => {
    expect(
      reviewChange(rules, {
        coveragePercent: 90,
        commitMessages: ['fix: y\n\nbody'],
        changedFiles: ['src/a.ts', 'test/a.test.ts'],
      }),
    ).toEqual([]);
    expect(reviewChange(resolveGuidelines([]), {})).toEqual([]);
    expect(reviewChange(rules, { coveragePercent: 80 }).map((f) => f.rule)).toEqual([]);
  });
});

describe('dark-factory mode and guideline references', () => {
  it('parses mode and guidelines and warns with the fixed notice', () => {
    const src = withFrontMatter(
      MINIMAL_FM + '\nmode: dark-factory\nguidelines: [secure-coding@1.2.0]',
    );
    const r = validateAgentSource(src);
    expect(r.definition).toMatchObject({
      mode: 'dark-factory',
      guidelines: ['secure-coding@1.2.0'],
    });
    expect(r.warnings.map((w) => w.message)).toContain(`dark-factory mode: ${DARK_FACTORY_NOTICE}`);
    expect(validateAgentSource(withFrontMatter(MINIMAL_FM + '\nguidelines: [nope]')).valid).toBe(
      false,
    );
    expect(validateAgentSource(withFrontMatter(MINIMAL_FM)).definition?.mode).toBe('standard');
  });
});
