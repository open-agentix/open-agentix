import { loadAgentDefinition, type Principal } from '@openagentix/core';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { agentVersionDeprecations, agentVersions, agents, tenants } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import { freshNode } from './agent-publish.js';
import { lockAgent } from './agent-revisions.js';
import type { AgentReviewsService } from './agent-reviews.js';
import { cleanReason, MAX_DISABLE_REASON_LENGTH, type AgentsService } from './agents.js';
import type { AuditService } from './audit.js';
import type { LifecyclePolicyService } from './lifecycle-policy.js';
import { lockTreeShared } from './tree-lock.js';

/**
 * Version deprecation and rollback (ADR 0017 section 3.1, slice S3).
 *
 * Deprecating a version stops new runs that are pinned to it (`409 version_deprecated`, checked at
 * admission under the agent row lock). Deprecating the **latest** version is a rollback: the agent
 * goes back to the newest older version that is not deprecated and, where approval is required for
 * the agent today, was published under an approved review. A rollback creates no version, needs no
 * approval and is audited. It is the way out of an incident (there is no break-glass publish): when
 * no such version exists, `409 rollback_target_unapproved` or `409 no_rollback_target` say so and the
 * agent has to be disabled. Deprecation cannot be undone: publish a newer version.
 */

export interface DeprecationResult {
  versionId: string;
  version: string;
  deprecatedAt: Date;
  rollbackTo: { id: string; version: string } | null;
}

export class AgentDeprecationService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
    private readonly reviews: AgentReviewsService,
    private readonly policy: LifecyclePolicyService,
  ) {}

  async deprecate(
    principal: Principal,
    agentId: string,
    version: string,
    reason?: string | null,
  ): Promise<DeprecationResult> {
    const found = await this.agents.get(agentId, principal);
    await this.agents.assertAccess(principal, found, 'agents:publish');
    const cleaned = cleanReason(reason);
    if (cleaned && cleaned.length > MAX_DISABLE_REASON_LENGTH)
      throw new HttpError(400, 'validation_failed', 'reason is too long');
    return this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const [placed] = await tx.select().from(tenants).where(eq(tenants.id, found.tenantId));
      if (!placed) throw notFound('tenant');
      await lockTreeShared(tx, placed.rootId);
      // Read again under the tree lock: a tenant move changes the chain whose policies apply.
      const node = await freshNode(tx, placed.id);
      // Serialises with run admission (`for share` on the agent row) and with a publish.
      const agent = await lockAgent(tx, agentId);
      const [target] = await tx
        .select()
        .from(agentVersions)
        .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)));
      if (!target) throw notFound('agent version');
      const [already] = await tx
        .select()
        .from(agentVersionDeprecations)
        .where(eq(agentVersionDeprecations.versionId, target.id));
      if (already)
        throw new HttpError(409, 'already_deprecated', `version ${version} is already deprecated`);
      const rollbackTo =
        agent.latestVersionId === target.id
          ? await this.rollbackTarget(tx, agent, target, await this.policy.effectiveFor(node, tx))
          : null;
      // A rollback puts the agent back under the use case of the version it returns to: that is a
      // relabel, which a use-case administrator may not do into a use case they do not hold.
      if (rollbackTo)
        this.agents.assertLabelInScope(
          principal,
          'agents:publish',
          agent,
          loadAgentDefinition(rollbackTo.source).labels.useCase || null,
        );
      const now = this.ctx.now();
      await tx.insert(agentVersionDeprecations).values({
        versionId: target.id,
        agentId,
        deprecatedBy: principal.userId,
        deprecatedAt: now,
        reason: cleaned,
        rollbackToVersionId: rollbackTo?.id ?? null,
      });
      if (rollbackTo)
        await tx
          .update(agents)
          .set({
            latestVersionId: rollbackTo.id,
            latestVersion: rollbackTo.version,
            useCase: loadAgentDefinition(rollbackTo.source).labels.useCase || null,
          })
          .where(eq(agents.id, agentId));
      await this.audit.append(
        {
          actor: principal.userId,
          tenantId: agent.tenantId,
          action: 'agent.version.deprecated',
          target: agentId,
          payload: {
            version: target.version,
            versionId: target.id,
            ...(rollbackTo ? { rollbackTo: rollbackTo.version, rollbackToId: rollbackTo.id } : {}),
          },
        },
        tx,
      );
      await this.ctx.cache.del(`agent-latest:${agentId}`);
      return {
        versionId: target.id,
        version: target.version,
        deprecatedAt: now,
        rollbackTo: rollbackTo ? { id: rollbackTo.id, version: rollbackTo.version } : null,
      };
    });
  }

  /**
   * The version the agent goes back to: the newest other version that is not deprecated and, where
   * approval is required today (the policy now, `production-only` with the union of the use cases of
   * the version left and the version gone back to), was published under an approved review.
   */
  private async rollbackTarget(
    tx: Db,
    agent: typeof agents.$inferSelect,
    leaving: typeof agentVersions.$inferSelect,
    policy: Awaited<ReturnType<LifecyclePolicyService['effectiveFor']>>,
  ) {
    const candidates = await tx
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.agentId, agent.id),
          notInArray(agentVersions.id, [leaving.id]),
          sql`not exists (select 1 from ${agentVersionDeprecations} d where d.version_id = ${agentVersions.id})`,
        ),
      )
      .orderBy(desc(agentVersions.publishedAt), desc(agentVersions.id));
    if (candidates.length === 0)
      throw new HttpError(
        409,
        'no_rollback_target',
        'there is no older version that is not deprecated to go back to; disable the agent instead',
      );
    const leavingUseCase = loadAgentDefinition(leaving.source).labels.useCase || null;
    const approved = candidates.find(
      (c) =>
        !this.reviews.approvalRequired(
          policy,
          leavingUseCase,
          loadAgentDefinition(c.source).labels.useCase || null,
        ) || c.reviewId !== null,
    );
    if (!approved)
      throw new HttpError(
        409,
        'rollback_target_unapproved',
        'no older version was published under an approved review, and approval is required for this agent; disable the agent instead',
      );
    return approved;
  }
}
