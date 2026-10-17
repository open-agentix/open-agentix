import type { LifecyclePolicy, Principal } from '@openagentix/core';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { agentReviews, type agentDraftRevisions } from '../db/schema.js';
import type { AgentRow } from './agent-revisions.js';
import type { ForeignSecret } from './secret-resolution.js';
import { reviewPolicy, type AgentReviewsService, type Evaluation } from './agent-reviews.js';

/**
 * The approval gate of publish (ADR 0017 section 4.3, slice S3). It runs inside the publish
 * transaction, **after** the tree lock, the binding lock and the agent row lock are held and the
 * head revision was read under them, and it decides one thing: may this head revision be published
 * now, and under which review.
 *
 * The decision uses the one implementation of "who counts as an approver" that decisions use
 * (`AgentReviewsService.evaluateForPublish`: rules A1 to A8 and A10 re-run for every stored approval
 * against the bindings, the grant chains and the policy of this moment), plus the checks that only
 * publish makes: the digests the caller names, the expansion and the secret resolution recomputed
 * from the revision's source, the installation's read path for bindings and `publishBy`.
 *
 * There is no way around it: no parameter, role, setting or endpoint publishes without the approvals
 * that are required (ADR 0017 decision 11, no break-glass). The only exception is the deterministic
 * demo seed, which does not go through here (see `AgentsService.publishDemoSeed`).
 */

type ReviewRow = typeof agentReviews.$inferSelect;
type RevisionRow = typeof agentDraftRevisions.$inferSelect;

/** What the caller of `POST /v1/agents/{id}/publish` names. Both are required when approval is. */
export interface PublishApprovalInput {
  reviewId?: string | undefined;
  expectedDigest?: string | undefined;
}

/** Why publish was refused: a stable code, the status, and details a client can show. */
export interface GateRefusal {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  /** The review the refusal is about, for the audit entry. */
  reviewId: string | null;
}

/** What a version published under approval records (ADR 0017 section 4.2). */
export interface ApprovalRecord {
  reviewId: string;
  /** Distinct reviewers whose approvals counted, sorted. */
  approvedBy: string[];
  policyDigest: string;
  expansionDigest: string;
  resolutionDigest: string;
  /** The decisions that counted. */
  decisionIds: string[];
}

export type GateOutcome =
  /** Approval is not required; an open review (advisory) is closed by the publish. */
  | { kind: 'not_required'; advisoryReviewId: string | null }
  | { kind: 'approved'; review: ReviewRow; record: ApprovalRecord }
  | { kind: 'refused'; refusal: GateRefusal };

export interface GateInput {
  principal: Principal;
  /** The agent row as read under the lock. */
  agent: AgentRow;
  /** The head revision read under the lock; its digest is the digest of the draft. */
  head: RevisionRow;
  /** Use case label of the head revision's source. */
  useCase: string | null;
  /** The connection catalog, read before the locks; the expansion is recomputed from it. */
  catalog: Awaited<ReturnType<AgentReviewsService['catalogOf']>>;
  /** The effective policy at the agent's node (read under the lock). */
  policy: LifecyclePolicy;
  input: PublishApprovalInput;
  /**
   * Scoped secrets owned by another node than the agent's (inherited): their presence makes approval
   * required whatever the policy says (ADR 0017 section 13.3, review of slice S4).
   */
  foreignSecrets?: readonly ForeignSecret[];
}

const refuse = (
  status: number,
  code: string,
  message: string,
  reviewId: string | null,
  details?: unknown,
): GateOutcome => ({
  kind: 'refused',
  refusal: { status, code, message, reviewId, ...(details === undefined ? {} : { details }) },
});

/** Approvals of the current revision that failed a re-check, by the reason they failed. */
function failedWith(ev: Evaluation, reason: string): boolean {
  return ev.approvals.some(
    (a) => a.decision === 'approve' && a.current && a.reasons.includes(reason),
  );
}

export class PublishGate {
  constructor(
    private readonly ctx: AppContext,
    private readonly reviews: AgentReviewsService,
  ) {}

  /**
   * The policy and the open review that decide whether approval is required. The open review keeps
   * the stricter of its own snapshot and the policy now (S1 review finding 2): loosening the policy
   * never lets the publisher skip a review that is open.
   */
  async decide(tx: Db, g: GateInput): Promise<GateOutcome> {
    const [open] = await tx
      .select()
      .from(agentReviews)
      .where(and(eq(agentReviews.agentId, g.agent.id), eq(agentReviews.status, 'open')))
      .for('update');
    const policy = open ? reviewPolicy(open, g.policy) : g.policy;
    // `production-only` uses the union of the base version's and the draft's use case.
    const required =
      (g.foreignSecrets?.length ?? 0) > 0 ||
      this.reviews.approvalRequired(
        policy,
        g.agent.latestVersionId ? g.agent.useCase : null,
        g.useCase,
      );
    if (!required) return { kind: 'not_required', advisoryReviewId: open?.id ?? null };
    return this.enforce(tx, g, open, policy);
  }

  private async enforce(
    tx: Db,
    g: GateInput,
    open: ReviewRow | undefined,
    policy: LifecyclePolicy,
  ): Promise<GateOutcome> {
    const reviewId = open?.id ?? null;
    // The stored chains and the binding lock only hold on the resolver read path (docs).
    if (this.ctx.config.auth.roleBindingsRead !== 'bindings')
      return refuse(
        409,
        'role_bindings_read_required',
        'approval is required for this agent and the approvals can only be checked race-free with OAX_ROLE_BINDINGS_READ=bindings',
        reviewId,
      );
    const named = this.named(g.input, reviewId, g.foreignSecrets ?? []);
    if (named) return named;
    if (!open)
      return refuse(409, 'review_closed', 'the review is not open', null, {
        reviewId: g.input.reviewId,
      });
    if (g.input.expectedDigest !== g.head.digest)
      return refuse(409, 'draft_changed', 'the draft is not the revision you checked', reviewId);
    // Recomputed from the revision's source under the lock, with the policy that applies to the
    // review: an approval that bound to another expansion or resolution no longer counts.
    const { binding, useCase } = await this.reviews.bindingOf(
      tx,
      g.agent,
      g.head.source,
      g.head.digest,
      policy,
      g.catalog,
    );
    const ev = await this.reviews.evaluateForPublish(tx, g.agent, open, g.policy, {
      head: g.head,
      binding,
      useCase,
    });
    return this.verdict(g, open, ev, policy);
  }

  /** `approval_required` when the caller named no review or digest; the review must be the open one. */
  private named(
    input: PublishApprovalInput,
    openId: string | null,
    foreign: readonly ForeignSecret[],
  ): GateOutcome | null {
    const missing = (
      [
        ['reviewId', input.reviewId],
        ['expectedDigest', input.expectedDigest],
      ] as const
    )
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);
    if (missing.length > 0 && foreign.length > 0)
      return refuse(
        409,
        'approval_required_for_foreign_secret',
        `this version uses a secret of a higher node; approval is required whatever the policy says: name ${missing.join(' and ')} of an approved review`,
        openId,
        { missing, foreignSecrets: foreign },
      );
    if (missing.length > 0)
      return refuse(
        409,
        'approval_required',
        `approval is required to publish this agent: name ${missing.join(' and ')} of an approved review`,
        openId,
        { missing },
      );
    if (openId !== null && input.reviewId !== openId)
      return refuse(
        409,
        'review_closed',
        'the review is not the open review of this agent',
        openId,
      );
    return null;
  }

  private verdict(
    g: GateInput,
    open: ReviewRow,
    ev: Evaluation,
    policy: LifecyclePolicy,
  ): GateOutcome {
    // ADR 4.3 steps 2 and 3: the approvals bound to another expansion or secret resolution than the
    // one the revision has now.
    if (failedWith(ev, 'expansion_changed'))
      return refuse(
        409,
        'approval_stale',
        'the profile expansion changed since the approval',
        open.id,
        {
          reason: 'expansion_changed',
        },
      );
    if (failedWith(ev, 'secret_resolution_changed'))
      return refuse(
        409,
        'approval_stale',
        'the secret resolution changed since the approval',
        open.id,
        { reason: 'secret_resolution_changed' },
      );
    const counted = ev.approvals.filter((a) => a.counted && a.decision === 'approve');
    if (ev.state !== 'approved')
      return refuse(
        409,
        'approval_insufficient',
        `${counted.length} of ${ev.required} required approvals are valid now${ev.state === 'changes_requested' ? ' and a reviewer requested changes' : ''}`,
        open.id,
        {
          required: ev.required,
          counted: counted.length,
          changesRequested: ev.state === 'changes_requested',
          approvals: ev.approvals
            .filter((a) => a.decision === 'approve' || a.decision === 'request_changes')
            .map((a) => ({
              id: a.id,
              decision: a.decision,
              current: a.current,
              reasons: a.reasons,
            })),
        },
      );
    const approvedBy = [...new Set(counted.map((a) => a.reviewerId))].sort();
    // `publishBy: approver-only`: the person who presses publish is one of the approvers.
    if (policy.publishBy === 'approver-only' && !approvedBy.includes(g.principal.userId))
      return refuse(
        403,
        'publisher_not_approver',
        'the tenant policy lets only an approver of the review publish',
        open.id,
      );
    return {
      kind: 'approved',
      review: open,
      record: {
        reviewId: open.id,
        approvedBy,
        policyDigest: ev.binding.policyDigest,
        expansionDigest: ev.binding.expansionDigest,
        resolutionDigest: ev.binding.resolutionDigest,
        decisionIds: counted.map((a) => a.id).sort(),
      },
    };
  }
}
