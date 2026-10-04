import { z } from 'zod';
import { CLASSIFICATIONS, classificationRank } from './classification.js';
import type { PolicyBundle } from './policy/engine.js';

/**
 * Versioned development guidelines and the deterministic part of the hardening agent.
 * Guidelines resolve global -> tenant -> agent; the stricter rule always wins, so lower levels can
 * only tighten what higher levels require.
 */
export const GUIDELINE_SCOPES = ['global', 'tenant', 'agent'] as const;
export type GuidelineScope = (typeof GUIDELINE_SCOPES)[number];

export const GuidelineRulesSchema = z.strictObject({
  /** Package names (globs with `*`) that must not be added. */
  forbiddenDependencies: z.array(z.string().min(1)).default([]),
  /** Minimum line coverage in percent for code changes. */
  minCoverage: z.number().min(0).max(100).optional(),
  /** Commit subjects must follow Conventional Commits. */
  conventionalCommits: z.boolean().default(false),
  /** Code changes must include tests. */
  requireTests: z.boolean().default(false),
  /** Tools (globs over `server/tool`) that always need a human approval (e.g. merge, deploy). */
  requireApprovalTools: z.array(z.string().min(1)).default([]),
  forbiddenTools: z.array(z.string().min(1)).default([]),
  forbiddenArgPatterns: z
    .array(
      z.strictObject({
        pattern: z.string().min(1),
        reason: z.string().default('forbidden by guideline'),
      }),
    )
    .default([]),
  maxClassification: z.enum(CLASSIFICATIONS).optional(),
});
export type GuidelineRules = z.infer<typeof GuidelineRulesSchema>;

export interface GuidelineSet {
  name: string;
  version: string;
  scope: GuidelineScope;
  rules: GuidelineRules;
}

const uniq = <T>(xs: T[], key: (x: T) => string = String) => [
  ...new Map(xs.map((x) => [key(x), x])).values(),
];

/** Effective rules: union of lists, strictest numbers/levels, OR of booleans (order-independent). */
export function resolveGuidelines(sets: readonly GuidelineSet[]): GuidelineRules {
  const order: Record<GuidelineScope, number> = { global: 0, tenant: 1, agent: 2 };
  const sorted = [...sets].sort((a, b) => order[a.scope] - order[b.scope]);
  const out: GuidelineRules = {
    forbiddenDependencies: [],
    conventionalCommits: false,
    requireTests: false,
    requireApprovalTools: [],
    forbiddenTools: [],
    forbiddenArgPatterns: [],
  };
  for (const { rules: r } of sorted) {
    out.forbiddenDependencies = uniq([...out.forbiddenDependencies, ...r.forbiddenDependencies]);
    out.requireApprovalTools = uniq([...out.requireApprovalTools, ...r.requireApprovalTools]);
    out.forbiddenTools = uniq([...out.forbiddenTools, ...r.forbiddenTools]);
    out.forbiddenArgPatterns = uniq(
      [...out.forbiddenArgPatterns, ...r.forbiddenArgPatterns],
      (p) => p.pattern,
    );
    out.conventionalCommits ||= r.conventionalCommits;
    out.requireTests ||= r.requireTests;
    if (r.minCoverage !== undefined)
      out.minCoverage = Math.max(out.minCoverage ?? 0, r.minCoverage);
    if (
      r.maxClassification &&
      (!out.maxClassification ||
        classificationRank(r.maxClassification) < classificationRank(out.maxClassification))
    ) {
      out.maxClassification = r.maxClassification;
    }
  }
  return out;
}

/** The tool-call part of the guidelines, enforced by the policy gate before every tool call. */
export function guidelinesToPolicyBundle(rules: GuidelineRules): PolicyBundle {
  return {
    forbiddenTools: rules.forbiddenTools,
    forbiddenArgPatterns: rules.forbiddenArgPatterns,
    requireApprovalTools: rules.requireApprovalTools,
    ...(rules.maxClassification ? { maxClassification: rules.maxClassification } : {}),
  };
}

export interface ChangeArtifact {
  addedDependencies?: string[];
  coveragePercent?: number;
  commitMessages?: string[];
  changedFiles?: string[];
}

export interface GuidelineFinding {
  rule: 'forbidden_dependency' | 'coverage' | 'conventional_commits' | 'tests_missing';
  message: string;
}

const CONVENTIONAL =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?: .{1,100}$/;
const glob = (g: string, v: string) =>
  new RegExp(
    `^${g
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  ).test(v);

/**
 * Deterministic review of a development agent's output (e.g. a pull request) by the hardening
 * agent. Findings block the change; an optional LLM reviewer may only add findings.
 */
export function reviewChange(rules: GuidelineRules, change: ChangeArtifact): GuidelineFinding[] {
  const findings: GuidelineFinding[] = [];
  for (const dep of change.addedDependencies ?? []) {
    const hit = rules.forbiddenDependencies.find((g) => glob(g, dep));
    if (hit)
      findings.push({
        rule: 'forbidden_dependency',
        message: `dependency "${dep}" is forbidden (${hit})`,
      });
  }
  if (rules.minCoverage !== undefined && (change.coveragePercent ?? 0) < rules.minCoverage) {
    findings.push({
      rule: 'coverage',
      message: `coverage ${change.coveragePercent ?? 0} % is below ${rules.minCoverage} %`,
    });
  }
  if (rules.conventionalCommits) {
    for (const m of change.commitMessages ?? []) {
      const subject = m.split('\n')[0] ?? '';
      if (!CONVENTIONAL.test(subject))
        findings.push({
          rule: 'conventional_commits',
          message: `commit "${subject}" is not a Conventional Commit`,
        });
    }
  }
  if (rules.requireTests) {
    const files = change.changedFiles ?? [];
    const code = files.some(
      (f) =>
        !/(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./.test(f) &&
        /\.(ts|tsx|js|py|go|java|rs)$/.test(f),
    );
    const tests = files.some((f) => /(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./.test(f));
    if (code && !tests)
      findings.push({ rule: 'tests_missing', message: 'code changed without tests' });
  }
  return findings;
}

/** Fixed label of the dark software factory mode (UI, docs and CLI show it verbatim). */
export const DARK_FACTORY_NOTICE =
  'Recommended for MVP and proof-of-concept development only. Not for production changes without review.';
