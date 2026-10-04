import { randomUUID } from 'node:crypto';
import {
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
} from '@openagentix/core';
import { and, asc, eq } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import { DEFAULT_TENANT_ID, guidelines } from '../db/schema.js';
import { HttpError, conflict } from '../errors.js';
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

  async list(): Promise<GuidelineRow[]> {
    return this.ctx.db
      .select()
      .from(guidelines)
      .orderBy(asc(guidelines.scope), asc(guidelines.name), asc(guidelines.version));
  }

  async create(
    actor: string,
    input: {
      scope: GuidelineScope;
      name: string;
      version: string;
      content: string;
      rules: unknown;
    },
  ): Promise<GuidelineRow> {
    if (!isSemver(input.version))
      throw new HttpError(400, 'validation_failed', 'version must be SemVer');
    const rules = GuidelineRulesSchema.parse(input.rules);
    const [exists] = await this.ctx.db
      .select({ id: guidelines.id })
      .from(guidelines)
      .where(
        and(
          eq(guidelines.scope, input.scope),
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
        tenantId: input.scope === 'global' ? null : DEFAULT_TENANT_ID,
        scope: input.scope,
        name: input.name,
        version: input.version,
        content: input.content,
        rules,
        createdBy: actor,
      })
      .returning();
    await this.ctx.cache.delPrefix('guidelines:');
    await this.audit.append({
      actor,
      action: 'guideline.created',
      target: `${input.name}@${input.version}`,
      payload: { scope: input.scope, rules },
    });
    return row!;
  }

  /** Global and tenant sets plus the agent sets referenced by the definition. */
  async setsFor(def: Pick<AgentDefinition, 'guidelines'>): Promise<GuidelineSet[]> {
    const all = await cached(this.ctx.cache, 'guidelines:all', 30_000, () => this.list());
    const refs = new Set(def.guidelines ?? []);
    return all
      .map((r) => ({ ...r, createdAt: new Date(r.createdAt) }))
      .filter(
        (r) => r.scope === 'global' || r.scope === 'tenant' || refs.has(`${r.name}@${r.version}`),
      )
      .map(toSet)
      .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
  }

  async bundleFor(def: Pick<AgentDefinition, 'guidelines'>): Promise<PolicyBundle | null> {
    const sets = await this.setsFor(def);
    return sets.length ? guidelinesToPolicyBundle(resolveGuidelines(sets)) : null;
  }

  /** Hardening agent review of a change; findings are audited. */
  async review(
    actor: string,
    def: Pick<AgentDefinition, 'guidelines' | 'name'>,
    change: ChangeArtifact,
  ): Promise<{ findings: GuidelineFinding[]; applied: string[] }> {
    const sets = await this.setsFor(def);
    const findings = reviewChange(resolveGuidelines(sets), change);
    await this.audit.append({
      actor,
      action: findings.length ? 'hardening.blocked' : 'hardening.passed',
      target: def.name,
      payload: { findings, applied: sets.map((s) => `${s.scope}:${s.name}@${s.version}`) },
    });
    return { findings, applied: sets.map((s) => `${s.scope}:${s.name}@${s.version}`) };
  }
}
