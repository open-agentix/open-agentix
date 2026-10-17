import { randomUUID } from 'node:crypto';
import {
  MAX_PATTERN_CHARS,
  MAX_POLICY_GLOBS,
  MAX_POLICY_PATTERNS,
  checkPatternList,
  globIssue,
  patternSetIssue,
  GuidelineRulesSchema,
  guidelinesToPolicyBundle,
  isSemver,
  resolveGuidelines,
  reviewChange,
  type AgentDefinition,
  type ChangeArtifact,
  type GuidelineFinding,
  type GuidelineScope,
  type GuidelineSet,
  type PolicyBundle,
  type Principal,
  type TenantActor,
} from '@openagentix/core';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import { guidelines } from '../db/schema.js';
import { HttpError, conflict, forbidden } from '../errors.js';
import type { AuditService } from './audit.js';

export type GuidelineRow = typeof guidelines.$inferSelect;

const SCOPE_ORDER: Record<GuidelineScope, number> = { global: 0, tenant: 1, agent: 2 };

const toSet = (r: GuidelineRow): GuidelineSet => ({
  name: r.name,
  version: r.version,
  scope: r.scope as GuidelineScope,
  rules: GuidelineRulesSchema.parse(r.rules),
});

/**
 * Development guidelines (versioned, immutable) and the deterministic hardening agent:
 * global and tenant sets always apply; agent sets apply when the agent references them.
 */
export class GuidelinesService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {}

  /** Global sets (every tenant) plus the tenant's own sets. */
  async list(tenantId: string): Promise<GuidelineRow[]> {
    return this.ctx.db
      .select()
      .from(guidelines)
      .where(or(isNull(guidelines.tenantId), eq(guidelines.tenantId, tenantId)))
      .orderBy(asc(guidelines.scope), asc(guidelines.name), asc(guidelines.version));
  }

  /** Global sets need a platform operator, tenant and agent sets belong to the actor's tenant. */
  async create(
    actor: Principal,
    input: {
      scope: GuidelineScope;
      name: string;
      version: string;
      content: string;
      rules: unknown;
    },
  ): Promise<GuidelineRow> {
    if (input.scope === 'global' && !actor.platformAdmin)
      throw forbidden('global guidelines need platform operator access');
    if (!isSemver(input.version))
      throw new HttpError(400, 'validation_failed', 'version must be SemVer');
    const rules = GuidelineRulesSchema.parse(input.rules);
    // Guideline patterns become policy patterns of every run: same limits and rules as a policy.
    const bad = checkPatternList(
      rules.forbiddenArgPatterns.map((f) => f.pattern),
      MAX_POLICY_PATTERNS,
    );
    if (bad)
      throw new HttpError(
        400,
        'validation_failed',
        bad.index === null
          ? `forbiddenArgPatterns: ${bad.message}`
          : `invalid pattern in forbiddenArgPatterns.${bad.index}: ${bad.message}`,
      );
    for (const g of [
      ...rules.forbiddenTools,
      ...rules.requireApprovalTools,
      ...rules.forbiddenDependencies,
    ]) {
      const issue = globIssue(g);
      if (issue)
        throw new HttpError(400, 'validation_failed', `invalid glob ${g.slice(0, 64)}: ${issue}`);
    }
    if (rules.forbiddenTools.length + rules.requireApprovalTools.length > MAX_POLICY_GLOBS)
      throw new HttpError(
        400,
        'validation_failed',
        `at most ${MAX_POLICY_GLOBS} tool globs (forbiddenTools and requireApprovalTools together) per guideline set`,
      );
    await this.assertMergedLimits(actor.tenantId, {
      scope: input.scope,
      name: input.name,
      version: input.version,
      rules,
    });
    const [exists] = await this.ctx.db
      .select({ id: guidelines.id })
      .from(guidelines)
      .where(
        and(
          eq(guidelines.scope, input.scope),
          input.scope === 'global'
            ? isNull(guidelines.tenantId)
            : eq(guidelines.tenantId, actor.tenantId),
          eq(guidelines.name, input.name),
          eq(guidelines.version, input.version),
        ),
      );
    if (exists)
      throw conflict(
        `guideline ${input.name}@${input.version} already exists (versions are immutable)`,
      );
    const [row] = await this.ctx.db
      .insert(guidelines)
      .values({
        id: randomUUID(),
        tenantId: input.scope === 'global' ? null : actor.tenantId,
        scope: input.scope,
        name: input.name,
        version: input.version,
        content: input.content,
        rules,
        createdBy: actor.userId,
      })
      .returning();
    await this.ctx.cache.delPrefix('guidelines:');
    await this.audit.append({
      actor: actor.userId,
      tenantId: input.scope === 'global' ? null : actor.tenantId,
      action: 'guideline.created',
      target: `${input.name}@${input.version}`,
      payload: { scope: input.scope, rules },
    });
    return row!;
  }

  /**
   * Guideline sets are merged (union of patterns, every version of every set) into ONE policy that
   * applies to every tool call, so the limits of a policy hold for the merge, not for a set alone.
   * A global set may use half of them, so that every tenant keeps room for its own. Refused with 422
   * at write time; at run time a merge above the limits would deny every call of the tenant.
   */
  private async assertMergedLimits(tenantId: string, added: GuidelineSet): Promise<void> {
    const existing = (await this.list(tenantId))
      .filter((r) => r.scope === 'global' || r.scope === 'tenant')
      .map(toSet);
    const merged = (sets: GuidelineSet[], max: number, maxChars: number) =>
      patternSetIssue(
        resolveGuidelines(sets).forbiddenArgPatterns.map((f) => f.pattern),
        max,
      ) ??
      (resolveGuidelines(sets).forbiddenArgPatterns.reduce((n, f) => n + f.pattern.length, 0) >
      maxChars
        ? `the merged patterns are limited to ${maxChars} characters`
        : null);
    const globalOnly = [...existing.filter((x) => x.scope === 'global'), added].filter(
      (x) => x.scope === 'global',
    );
    const mergedGlobs = (sets: GuidelineSet[], max: number): string | null => {
      const r = resolveGuidelines(sets);
      return r.forbiddenTools.length + r.requireApprovalTools.length > max
        ? `the merged tool globs are limited to ${max}`
        : null;
    };
    const issue =
      added.scope === 'global'
        ? (merged(globalOnly, MAX_POLICY_PATTERNS / 2, MAX_PATTERN_CHARS / 2) ??
          mergedGlobs(globalOnly, MAX_POLICY_GLOBS / 2))
        : (merged([...existing, added], MAX_POLICY_PATTERNS, MAX_PATTERN_CHARS) ??
          mergedGlobs([...existing, added], MAX_POLICY_GLOBS));
    if (issue)
      throw new HttpError(
        422,
        'guideline_limits_exceeded',
        `the guideline sets that apply together (all versions merged): ${issue}`,
      );
  }

  /** Global and tenant sets plus the agent sets referenced by the definition. */
  async setsFor(
    def: Pick<AgentDefinition, 'guidelines'>,
    tenantId: string,
  ): Promise<GuidelineSet[]> {
    const all = await cached(this.ctx.cache, `guidelines:${tenantId}`, 30_000, () =>
      this.list(tenantId),
    );
    const refs = new Set(def.guidelines ?? []);
    return all
      .map((r) => ({ ...r, createdAt: new Date(r.createdAt) }))
      .filter(
        (r) => r.scope === 'global' || r.scope === 'tenant' || refs.has(`${r.name}@${r.version}`),
      )
      .map(toSet)
      .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
  }

  async bundleFor(
    def: Pick<AgentDefinition, 'guidelines'>,
    tenantId: string,
  ): Promise<PolicyBundle | null> {
    const sets = await this.setsFor(def, tenantId);
    return sets.length ? guidelinesToPolicyBundle(resolveGuidelines(sets)) : null;
  }

  /** Hardening agent review of a change; findings are audited. */
  async review(
    actor: TenantActor,
    def: Pick<AgentDefinition, 'guidelines' | 'name'>,
    change: ChangeArtifact,
  ): Promise<{ findings: GuidelineFinding[]; applied: string[] }> {
    const sets = await this.setsFor(def, actor.tenantId);
    const findings = reviewChange(resolveGuidelines(sets), change);
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: findings.length ? 'hardening.blocked' : 'hardening.passed',
      target: def.name,
      payload: { findings, applied: sets.map((s) => `${s.scope}:${s.name}@${s.version}`) },
    });
    return { findings, applied: sets.map((s) => `${s.scope}:${s.name}@${s.version}`) };
  }
}
