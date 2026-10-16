import {
  diffSummaries,
  expandProfiles,
  loadAgentDefinition,
  summariseDefinition,
  type LifecyclePolicy,
  type PublishedDefinition,
  type Principal,
  type SemanticChanges,
  type SemanticFacts,
} from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { agentVersions } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import { reviewHead, reviewPolicy, type AgentReviewsService } from './agent-reviews.js';
import type { AgentsService } from './agents.js';
import type { LifecyclePolicyService } from './lifecycle-policy.js';

/**
 * What a reviewer looks at besides the comments (ADR 0017 section 9): the base and head sources for
 * the diff, the semantic summary of both and what changed between them, and the expanded grants
 * (the tools of the summary with the profile each came from). The head is expanded against the
 * connection catalog of now, as the expansion digest an approval binds to is; the base is what was
 * stored when it was published. Needs the same permission as reading the review.
 */

export interface ReviewChanges {
  reviewId: string;
  revision: { id: string; seq: number; digest: string };
  base: { id: string; version: string; digest: string; source: string } | null;
  headSource: string;
  facts: { base: SemanticFacts | null; head: SemanticFacts };
  changes: SemanticChanges;
  /** The part of the tenant policy a reviewer needs to understand who may decide and why. */
  policy: Pick<
    LifecyclePolicy,
    | 'requireApprovalForPublish'
    | 'minApprovals'
    | 'allowedApproverRoles'
    | 'approverScope'
    | 'approvalExpiryHours'
    | 'allowTokenApprovals'
  >;
  /** Agent rules arrive with ADR 0017 S8; until then no requirement is listed. */
  rules: { available: false; requirements: never[] };
}

export class ReviewChangesService {
  constructor(
    private readonly ctx: AppContext,
    private readonly agents: AgentsService,
    private readonly reviews: AgentReviewsService,
    private readonly policy: LifecyclePolicyService,
  ) {}

  async get(p: Principal, reviewId: string): Promise<ReviewChanges> {
    const { review, agent } = await this.reviews.loadReview(p, reviewId);
    await this.agents.assertAccess(p, agent, 'agents:read').catch((e: unknown) => {
      throw e instanceof HttpError && e.statusCode === 404 ? notFound('review') : e;
    });
    const head = await reviewHead(this.ctx.db, agent, review);
    const [base] = review.baseVersionId
      ? await this.ctx.db
          .select()
          .from(agentVersions)
          .where(eq(agentVersions.id, review.baseVersionId))
      : [];
    const declared = loadAgentDefinition(head.source);
    const catalog = await this.reviews.catalogOf(agent);
    const headFacts = summariseDefinition(expandProfiles(declared, catalog).definition, declared);
    const baseFacts = base ? baseFactsOf(base.source, base.definition) : null;
    // the policy this review is judged by: the stricter of its snapshot and the current one
    const policy = reviewPolicy(review, await this.policy.effectiveForTenant(agent.tenantId));
    return {
      reviewId: review.id,
      revision: { id: head.id, seq: head.seq, digest: head.digest },
      base: base
        ? { id: base.id, version: base.version, digest: base.digest, source: base.source }
        : null,
      headSource: head.source,
      facts: { base: baseFacts, head: headFacts },
      changes: diffSummaries(baseFacts, headFacts),
      policy: {
        requireApprovalForPublish: policy.requireApprovalForPublish,
        minApprovals: policy.minApprovals,
        allowedApproverRoles: policy.allowedApproverRoles,
        approverScope: policy.approverScope,
        approvalExpiryHours: policy.approvalExpiryHours,
        allowTokenApprovals: policy.allowTokenApprovals,
      },
      rules: { available: false, requirements: [] },
    };
  }
}

/** The stored expansion of a published version; `null` where the stored definition is unusable. */
function baseFactsOf(source: string, stored: unknown): SemanticFacts | null {
  try {
    const declared = loadAgentDefinition(source);
    return summariseDefinition(stored as PublishedDefinition, declared);
  } catch {
    return null;
  }
}
