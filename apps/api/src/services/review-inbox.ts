import { hasPermissionIn, type Principal } from '@openagentix/core';
import { desc, eq, and } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { agentReviews, agents } from '../db/schema.js';
import type { AgentReviewsService } from './agent-reviews.js';
import type { LifecyclePolicyService } from './lifecycle-policy.js';

/**
 * The review inbox (`GET /v1/me/reviews`, ADR 0017 section 10): the open reviews of the acting
 * tenant the caller could decide right now under the same rules a decision runs (A1 to A7), for
 * agents the caller can read. Reviews the caller may not decide are not listed: the inbox is a
 * work queue, not a way to learn what exists. Bounded: at most `SCAN` newest open reviews are
 * looked at, so a tenant with very many open reviews shows the newest eligible ones.
 */

const SCAN = 100;

export interface InboxItem {
  reviewId: string;
  agentId: string;
  agentName: string;
  state: string;
  openedBy: string;
  openedAt: Date;
  revisionSeq: number;
  requiredApprovals: number;
  countedApprovals: number;
  /** The caller's own latest decision on the current revision, if any. */
  yourDecision: 'approve' | 'request_changes' | 'reject' | null;
}

export class ReviewInboxService {
  constructor(
    private readonly ctx: AppContext,
    private readonly reviews: AgentReviewsService,
    private readonly policy: LifecyclePolicyService,
  ) {}

  async list(p: Principal, limit: number): Promise<InboxItem[]> {
    const candidates = await this.ctx.db
      .select({ review: agentReviews, agent: agents })
      .from(agentReviews)
      .innerJoin(agents, eq(agents.id, agentReviews.agentId))
      .where(and(eq(agentReviews.tenantId, p.tenantId), eq(agentReviews.status, 'open')))
      .orderBy(desc(agentReviews.openedAt), desc(agentReviews.id))
      .limit(SCAN);
    const policy = await this.policy.effectiveForTenant(p.tenantId);
    const out: InboxItem[] = [];
    for (const { review, agent } of candidates) {
      if (out.length >= limit) break;
      const ref = { teamId: agent.teamId, agentId: agent.id, useCase: agent.useCase };
      // Cheap pre-filter before the full evaluation: the permissions a decision needs.
      if (!hasPermissionIn(p, 'agents:read', ref) || !hasPermissionIn(p, 'agents:approve', ref))
        continue;
      const view = await this.reviews.viewFor(p, agent, review, policy);
      if (!view.you.eligible) continue;
      const mine = view.approvals.find((a) => a.reviewerId === p.userId && a.current);
      out.push({
        reviewId: view.id,
        agentId: agent.id,
        agentName: agent.name,
        state: view.state,
        openedBy: view.openedBy,
        openedAt: view.openedAt,
        revisionSeq: view.revision.seq,
        requiredApprovals: view.requiredApprovals,
        countedApprovals: view.approvals.filter((a) => a.counted).length,
        yourDecision: mine?.decision ?? null,
      });
    }
    return out;
  }
}
