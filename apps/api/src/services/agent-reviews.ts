import { randomUUID } from 'node:crypto';
import {
  checkApprover,
  expandProfiles,
  isProductionUseCase,
  lifecyclePolicyDigest,
  loadAgentDefinition,
  policyFromSnapshot,
  requiredApprovals,
  reviewState,
  stricterPolicy,
  stripInvisible,
  summariseDecisions,
  REFUSAL_STATUS,
  type ApproverActor,
  type ApproverAuth,
  type ApproverBinding,
  type ApproverFacts,
  type DecisionFact,
  type LifecyclePolicy,
  type Principal,
  type RefusalCode,
  type ReviewState,
} from '@openagentix/core';
import { and, asc, count, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import {
  agentDraftRevisions,
  agentReviewDecisions,
  agentReviewHoldClears,
  agentReviews,
  agentVersions,
  tenants,
} from '../db/schema.js';
import { HttpError, forbidden, notFound } from '../errors.js';
import {
  agentsWithoutRevision,
  ensureHead,
  lockAgent,
  revisionById,
  type AgentRow,
  type RevisionRow,
} from './agent-revisions.js';
import { followGrantChain, loadApproverFacts } from './approver-facts.js';
import type { AgentsService } from './agents.js';
import type { AuditService } from './audit.js';
import type { CatalogService } from './catalog.js';
import { isTenantAdminAt, loadActor } from './grant-authority.js';
import type { LifecyclePolicyService } from './lifecycle-policy.js';
import type { SecretResolution } from './secret-resolution.js';
import { reviewContributors, reviewHeadOf } from './review-contributors.js';
import { lockBindings, lockTreeShared } from './tree-lock.js';

/**
 * Reviews and approval records (ADR 0017 sections 2 to 5, slice S1): opening a review on the
 * current draft revision, deciding it (approve, request changes, reject), withdrawing it, and
 * computing the state of a review. Publish enforces approval in `publish-gate.ts` (slice S3), which
 * uses {@link AgentReviewsService.evaluateForPublish} so that the gate and a decision judge the same
 * way.
 *
 * Trust boundaries, in the order a decision crosses them:
 *
 * 1. the route (`agents:approve`, token scopes, use-case bindings never) and the acting tenant;
 * 2. the review belongs to the acting tenant (otherwise the same 404 as an unknown id);
 * 3. inside one transaction: the organisation's tree and binding locks, then the agent row lock, so
 *    that a draft save, a withdrawal, another decision and a binding change are serialised with it;
 * 4. the rule module (`checkApprover`) on facts read in that transaction, never from the cached
 *    principal: contributors (every author since the base version, the opener), the reviewer's
 *    bindings traced to their rows and grantors, the authentication, the policy;
 * 5. the digests the reviewer says they saw against the digests of the head revision, recomputed in
 *    that transaction; the stored record carries the recomputed ones.
 */

type ReviewRow = typeof agentReviews.$inferSelect;
type DecisionRow = typeof agentReviewDecisions.$inferSelect;
type VersionRow = typeof agentVersions.$inferSelect;

export const MAX_COMMENT_LENGTH = 10_000;

/** Withdrawn or rejected reviews of one agent that no administrator released; more refuse a new review. */
export const MAX_UNCLEARED_CLOSED_REVIEWS = 25;

export type ReviewStatus = 'open' | 'withdrawn' | 'rejected' | 'published';

export type DecisionKind = 'approve' | 'request_changes' | 'reject';

export interface DecisionInput {
  decision: DecisionKind;
  /** The digest of the revision the reviewer looked at (A10). */
  expectedDigest: string;
  expectedExpansionDigest?: string | undefined;
  expectedResolutionDigest?: string | undefined;
  expectedPolicyDigest?: string | undefined;
  comment?: string | undefined;
}

/** What the digests of a revision are now; an approval binds to exactly these. */
export interface Binding {
  digest: string;
  expansionDigest: string;
  resolutionDigest: string;
  policyDigest: string;
}

export interface ApprovalView {
  id: string;
  reviewerId: string;
  decision: DecisionKind;
  revisionId: string;
  digest: string;
  expansionDigest: string;
  resolutionDigest: string;
  baseVersionId: string | null;
  policyDigest: string;
  reviewerAuth: string;
  actingTenantId: string;
  bindingRefs: { id: string; role: string; source: string; grantedBy: string | null }[];
  comment: string | null;
  decidedAt: Date;
  expiresAt: Date | null;
  /** The latest decision of this reviewer on the head revision. */
  current: boolean;
  /** Counts towards the required approvals now. */
  counted: boolean;
  /** Why it does not count (stale revision, expired, no longer eligible, digests changed). */
  reasons: string[];
}

export interface ReviewView {
  id: string;
  agentId: string;
  status: ReviewStatus;
  /** `status` for a closed review; otherwise computed from the decisions. */
  state: ReviewState | Exclude<ReviewStatus, 'open'>;
  openedBy: string;
  openedAt: Date;
  openedRevisionId: string;
  closedAt: Date | null;
  closedBy: string | null;
  baseVersion: { id: string; version: string; digest: string } | null;
  revision: {
    id: string;
    seq: number;
    digest: string;
    authorId: string | null;
    authorKind: string;
    createdAt: Date;
  };
  requiredApprovals: number;
  approvalRequired: boolean;
  digests: Binding;
  contributors: string[];
  unknownAuthor: boolean;
  approvals: ApprovalView[];
  you: { eligible: boolean; code: RefusalCode | null; message: string | null };
}

const authString = (a: ApproverAuth): string =>
  a.kind === 'session' ? 'session' : `token:${a.tokenId}`;
const parseAuth = (s: string): ApproverAuth =>
  s.startsWith('token:') ? { kind: 'token', tokenId: s.slice(6) } : { kind: 'session' };

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.cause?.code ?? err.code;
}

/**
 * The policy an open review is judged by: the **stricter** of the policy it was opened under (its
 * snapshot) and the policy now. Loosening the policy (or switching approval off) therefore never
 * relaxes a review that is already open, and tightening it applies at once (S1 review finding 2). A
 * closed review is read against the current policy, as before. A snapshot that cannot be read leaves
 * the current policy, which is the policy of a review opened a moment ago.
 */
export function reviewPolicy(
  review: Pick<ReviewRow, 'status' | 'policySnapshot'>,
  current: LifecyclePolicy,
): LifecyclePolicy {
  if (review.status !== 'open') return current;
  const snapshot = policyFromSnapshot(review.policySnapshot);
  return snapshot ? stricterPolicy(snapshot, current) : current;
}

export interface Evaluation {
  review: ReviewRow;
  head: RevisionRow;
  base: VersionRow | null;
  policy: LifecyclePolicy;
  binding: Binding;
  contributors: Set<string>;
  unknownAuthor: boolean;
  approvals: ApprovalView[];
  state: ReviewState;
  required: number;
  approvalRequired: boolean;
}

export class AgentReviewsService {
  private readonly refusedAt = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
    private readonly policy: LifecyclePolicyService,
    private readonly catalog: CatalogService,
    private readonly secretResolution: SecretResolution,
  ) {}

  // ------------------------------------------------------------------ revisions

  async revisions(
    p: Principal,
    agentId: string,
    q: { limit: number; cursor?: string | undefined },
  ) {
    const agent = await this.agents.get(agentId, p);
    await this.agents.assertAccess(p, agent, 'agents:read');
    const before = q.cursor === undefined ? null : Number(q.cursor);
    if (before !== null && !Number.isInteger(before))
      throw new HttpError(400, 'invalid_cursor', 'cursor is invalid');
    const rows = await this.ctx.db
      .select()
      .from(agentDraftRevisions)
      .where(
        and(
          eq(agentDraftRevisions.agentId, agent.id),
          before === null ? undefined : lte(agentDraftRevisions.seq, before),
        ),
      )
      .orderBy(desc(agentDraftRevisions.seq))
      .limit(q.limit + 1);
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextCursor: rows.length > q.limit ? String(rows[q.limit]!.seq) : null,
      head: agent.draftRevisionId,
    };
  }

  async revision(p: Principal, agentId: string, seq: number): Promise<RevisionRow> {
    const agent = await this.agents.get(agentId, p);
    await this.agents.assertAccess(p, agent, 'agents:read');
    const [row] = await this.ctx.db
      .select()
      .from(agentDraftRevisions)
      .where(and(eq(agentDraftRevisions.agentId, agent.id), eq(agentDraftRevisions.seq, seq)));
    if (!row) throw notFound('revision');
    return row;
  }

  /**
   * Gives every agent from before migration 0032 its one system revision (author unknown), in
   * batches, at start-up. Idempotent and safe with several replicas: each agent is handled under
   * its row lock and skipped when another replica was faster.
   */
  async backfillRevisions(batch = 100): Promise<number> {
    let done = 0;
    for (;;) {
      const ids = await agentsWithoutRevision(this.ctx.db, batch);
      if (ids.length === 0) return done;
      for (const id of ids) {
        await this.ctx.db.transaction(async (t) => {
          const tx = t as unknown as Db;
          const agent = await lockAgent(tx, id);
          if (agent.draftRevisionId) return;
          await ensureHead(tx, agent, (r) => this.auditRevision(tx, agent, r, true));
          done++;
        });
      }
    }
  }

  private async auditRevision(tx: Db, agent: AgentRow, r: RevisionRow, upgrade: boolean) {
    await this.audit.append(
      {
        actor: r.authorId ?? 'system',
        tenantId: agent.tenantId,
        action: 'agent.revision.created',
        target: agent.id,
        payload: { revision: r.id, seq: r.seq, digest: r.digest, author: r.authorId, upgrade },
      },
      tx,
    );
  }

  // ------------------------------------------------------------------ digests and policy

  /** The digests of a revision's source now: what an approval binds to. */
  /**
   * The connection catalog the profile expansion runs against, read from the pool. It is read
   * before a transaction takes its locks and handed in: the catalog service uses its own connection,
   * which a transaction that holds the only connection (PGlite) would wait for forever.
   */
  catalogOf(agent: AgentRow) {
    return this.catalog.accessCatalog({
      tenantId: agent.tenantId,
      teamId: agent.teamId,
      agentId: agent.id,
    });
  }

  /**
   * The digests an approval binds to, for a source and the policy that applies (slice S3 recomputes
   * them under the lock). The secret resolution is read from `db` (ADR 0017 section 13.3): every
   * credential reference with the owning node and secret id it resolves to now, so a reviewer
   * approves concrete credentials and a secret created later at a nearer node leaves the approval
   * stale. `resolved` carries what publish pins and checks.
   */
  async bindingOf(
    db: Db,
    agent: AgentRow,
    source: string,
    digest: string,
    policy: LifecyclePolicy,
    catalog: Awaited<ReturnType<AgentReviewsService['catalogOf']>>,
  ) {
    const def = loadAgentDefinition(source);
    const { definition } = expandProfiles(def, catalog);
    const secrets = await this.secretResolution.pinsFor(
      db,
      { tenantId: agent.tenantId, teamId: agent.teamId },
      def,
    );
    const binding: Binding = {
      digest,
      expansionDigest: definition.expansionDigest ?? '',
      resolutionDigest: secrets.digest,
      policyDigest: lifecyclePolicyDigest(policy),
    };
    return { binding, useCase: def.labels.useCase || null, secrets };
  }

  /** Whether publishing this agent needs an approval under the effective policy (section 6). */
  approvalRequired(policy: LifecyclePolicy, ...useCases: (string | null)[]): boolean {
    if (policy.requireApprovalForPublish === 'on') return true;
    if (policy.requireApprovalForPublish === 'off') return false;
    // `production-only` uses the union of the base version's and the draft's use case.
    return useCases.some((u) => isProductionUseCase(u, policy.productionUseCases));
  }

  // ------------------------------------------------------------------ contributors

  contributorsOf(
    db: Db,
    agent: AgentRow,
    review: Pick<ReviewRow, 'openedBy' | 'baseVersionId'>,
    head: RevisionRow,
  ) {
    return reviewContributors(db, agent, review, head);
  }

  // ------------------------------------------------------------------ evaluation

  /** The state of a review, with every approval re-checked against the bindings and policy of now. */
  async evaluateForPublish(
    db: Db,
    agent: AgentRow,
    review: ReviewRow,
    currentPolicy: LifecyclePolicy,
    cached: { head: RevisionRow; binding: Binding; useCase: string | null },
  ): Promise<Evaluation> {
    return this.evaluate(db, agent, review, currentPolicy, cached);
  }

  private async evaluate(
    db: Db,
    agent: AgentRow,
    review: ReviewRow,
    currentPolicy: LifecyclePolicy,
    cached?: { head: RevisionRow; binding: Binding; useCase: string | null },
  ): Promise<Evaluation> {
    const policy = reviewPolicy(review, currentPolicy);
    const head = cached?.head ?? (await reviewHead(db, agent, review));
    const computed = cached ?? {
      head,
      ...(await this.bindingOf(
        db,
        agent,
        head.source,
        head.digest,
        policy,
        await this.catalogOf(agent),
      )),
    };
    const {
      set: contributors,
      unknownAuthor,
      base,
    } = await this.contributorsOf(db, agent, review, head);
    const rows = await db
      .select()
      .from(agentReviewDecisions)
      .where(eq(agentReviewDecisions.reviewId, review.id))
      .orderBy(asc(agentReviewDecisions.decidedAt), asc(agentReviewDecisions.id));
    const now = this.ctx.now();
    const expiryMs = policy.approvalExpiryHours * 3_600_000;
    const effectiveExpiry = (d: DecisionRow): Date | null =>
      d.expiresAt
        ? new Date(Math.min(d.expiresAt.getTime(), d.decidedAt.getTime() + expiryMs))
        : null;
    const facts: DecisionFact[] = rows.map((d) => ({
      id: d.id,
      reviewerId: d.reviewerId,
      decision: d.decision as DecisionKind,
      revisionId: d.revisionId,
      decidedAt: d.decidedAt,
      expiresAt: effectiveExpiry(d),
    }));
    const summary = summariseDecisions(facts, head.id, now);
    const latest = new Map<string, DecisionRow>();
    for (const d of rows) latest.set(d.reviewerId, d);
    const views: ApprovalView[] = [];
    const counted = new Set<string>();
    for (const d of rows) {
      const isLatest = latest.get(d.reviewerId)?.id === d.id;
      const reasons: string[] = [];
      let ok = false;
      if (d.revisionId !== head.id) reasons.push('revision_changed');
      else if (!isLatest) reasons.push('superseded');
      else if (d.decision === 'approve') {
        if (summary.stale.some((s) => s.decisionId === d.id && s.reason === 'expired'))
          reasons.push('expired');
        if (d.expansionDigest !== computed.binding.expansionDigest)
          reasons.push('expansion_changed');
        if (d.resolutionDigest !== computed.binding.resolutionDigest)
          reasons.push('secret_resolution_changed');
        if (reasons.length === 0 && review.status !== 'open') ok = true;
        else if (reasons.length === 0) {
          // The reviewer must still be an approver under the policy and the bindings of now.
          const f = await loadApproverFacts(db, {
            userId: d.reviewerId,
            agent,
            actor: 'user',
            auth: parseAuth(d.reviewerAuth),
            now,
          });
          const verdict = checkApprover(
            f,
            this.approvalContext(contributors, policy, {
              expected: head.digest,
              current: head.digest,
            }),
          );
          if (!verdict.ok) reasons.push(verdict.code);
          else ok = true;
        }
      } else ok = true;
      if (ok && d.decision === 'approve') counted.add(d.id);
      views.push({
        id: d.id,
        reviewerId: d.reviewerId,
        decision: d.decision as DecisionKind,
        revisionId: d.revisionId,
        digest: d.digest,
        expansionDigest: d.expansionDigest,
        resolutionDigest: d.resolutionDigest,
        baseVersionId: d.baseVersionId,
        policyDigest: d.policyDigest,
        reviewerAuth: d.reviewerAuth,
        actingTenantId: d.actingTenantId,
        bindingRefs: d.bindingRefs,
        comment: d.comment,
        decidedAt: d.decidedAt,
        expiresAt: d.expiresAt,
        current: isLatest && d.revisionId === head.id,
        counted: counted.has(d.id),
        reasons,
      });
    }
    // Only approvals that survived the re-check count (A2: distinct reviewers, once each).
    const approvers = new Set(
      views.filter((v) => v.counted && v.decision === 'approve').map((v) => v.reviewerId),
    );
    const effective = {
      ...summary,
      approvers: [...approvers].sort(),
    };
    const required = requiredApprovals(Math.max(review.requiredApprovals, policy.minApprovals));
    const state = reviewState(effective, required);
    return {
      review,
      head,
      base,
      policy,
      binding: computed.binding,
      contributors,
      unknownAuthor,
      approvals: views,
      state,
      required,
      approvalRequired: this.approvalRequired(
        policy,
        base ? agent.useCase : null,
        computed.useCase,
      ),
    };
  }

  private async viewOf(p: Principal, agent: AgentRow, ev: Evaluation): Promise<ReviewView> {
    const you = await this.verdictFor(this.ctx.db, p, agent, ev, ev.binding.digest);
    return {
      id: ev.review.id,
      agentId: ev.review.agentId,
      status: ev.review.status as ReviewStatus,
      state:
        ev.review.status === 'open'
          ? ev.state
          : (ev.review.status as Exclude<ReviewStatus, 'open'>),
      openedBy: ev.review.openedBy,
      openedAt: ev.review.openedAt,
      openedRevisionId: ev.review.openedRevisionId,
      closedAt: ev.review.closedAt,
      closedBy: ev.review.closedBy,
      baseVersion: ev.base
        ? { id: ev.base.id, version: ev.base.version, digest: ev.base.digest }
        : null,
      revision: {
        id: ev.head.id,
        seq: ev.head.seq,
        digest: ev.head.digest,
        authorId: ev.head.authorId,
        authorKind: ev.head.authorKind,
        createdAt: ev.head.createdAt,
      },
      requiredApprovals: ev.required,
      approvalRequired: ev.approvalRequired,
      digests: ev.binding,
      contributors: [...ev.contributors].sort(),
      unknownAuthor: ev.unknownAuthor,
      approvals: ev.approvals,
      you: you.ok
        ? { eligible: true, code: null, message: null }
        : { eligible: false, code: you.code, message: you.message },
    };
  }

  /** The context of `checkApprover`: contributors, the policy of the review and the installation switch. */
  private approvalContext(
    contributors: ReadonlySet<string>,
    policy: LifecyclePolicy,
    view: { expected: string; current: string },
  ) {
    return {
      contributors,
      policy,
      view,
      unknownGrantor: this.ctx.config.lifecycle.unknownGrantor,
    };
  }

  private principalAuth(p: Principal): ApproverAuth {
    return p.kind === 'token'
      ? { kind: 'token', tokenId: p.tokenId ?? 'unknown' }
      : { kind: 'session' };
  }

  /** The caller's own verdict under the rules (shown to the console; the decision re-runs it). */
  private async verdictFor(
    db: Db,
    p: Principal,
    agent: AgentRow,
    ev: Pick<Evaluation, 'contributors' | 'policy'>,
    digest: string,
  ) {
    const facts = await this.factsOf(db, p, agent);
    return checkApprover(
      facts,
      this.approvalContext(ev.contributors, ev.policy, { expected: digest, current: digest }),
    );
  }

  private factsOf(db: Db, p: Principal, agent: AgentRow): Promise<ApproverFacts> {
    return loadApproverFacts(db, {
      userId: p.userId,
      agent,
      actor: 'user' satisfies ApproverActor,
      auth: this.principalAuth(p),
      now: this.ctx.now(),
      scopes: p.scopes,
    });
  }

  // ------------------------------------------------------------------ reads

  async loadReview(p: Principal, reviewId: string, db: Db = this.ctx.db) {
    const [review] = await db.select().from(agentReviews).where(eq(agentReviews.id, reviewId));
    // One answer for an unknown id and for the review of another tenant.
    if (!review || review.tenantId !== p.tenantId) {
      if (review)
        await this.audit.append({
          actor: p.userId,
          tenantId: p.tenantId,
          action: 'access.denied',
          target: reviewId,
          payload: { permission: 'agents:read', resource: 'review' },
        });
      throw notFound('review');
    }
    const agent = await this.agents.get(review.agentId, p).catch((e: unknown) => {
      throw e instanceof HttpError && e.statusCode === 404 ? notFound('review') : e;
    });
    return { review, agent };
  }

  /** The view of a review the caller already loaded and may read (the inbox). */
  async viewFor(p: Principal, agent: AgentRow, review: ReviewRow, policy: LifecyclePolicy) {
    return this.viewOf(p, agent, await this.evaluate(this.ctx.db, agent, review, policy));
  }

  async get(p: Principal, reviewId: string): Promise<ReviewView> {
    const { review, agent } = await this.loadReview(p, reviewId);
    await this.agents.assertAccess(p, agent, 'agents:read').catch((e: unknown) => {
      throw e instanceof HttpError && e.statusCode === 404 ? notFound('review') : e;
    });
    const policy = await this.policy.effectiveForTenant(agent.tenantId);
    return this.viewOf(p, agent, await this.evaluate(this.ctx.db, agent, review, policy));
  }

  async list(p: Principal, agentId: string, q: { limit: number; cursor?: string | undefined }) {
    const agent = await this.agents.get(agentId, p);
    await this.agents.assertAccess(p, agent, 'agents:read');
    const before =
      q.cursor === undefined ? null : new Date(Buffer.from(q.cursor, 'base64url').toString());
    if (before !== null && Number.isNaN(before.getTime()))
      throw new HttpError(400, 'invalid_cursor', 'cursor is invalid');
    const rows = await this.ctx.db
      .select()
      .from(agentReviews)
      .where(
        and(
          eq(agentReviews.agentId, agent.id),
          before === null
            ? undefined
            : sql`${agentReviews.openedAt} < ${before.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(agentReviews.openedAt), desc(agentReviews.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const policy = await this.policy.effectiveForTenant(agent.tenantId);
    const items = [];
    for (const r of page)
      items.push(await this.viewOf(p, agent, await this.evaluate(this.ctx.db, agent, r, policy)));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > q.limit && last
          ? Buffer.from(last.openedAt.toISOString()).toString('base64url')
          : null,
    };
  }

  // ------------------------------------------------------------------ open

  async open(p: Principal, agentId: string): Promise<ReviewView> {
    const found = await this.agents.get(agentId, p);
    await this.agents.assertAccess(p, found, 'agents:write');
    const catalog = await this.catalogOf(found);
    let created: { agent: AgentRow; review: ReviewRow } | undefined;
    try {
      created = await this.ctx.db.transaction(async (t) => {
        const tx = t as unknown as Db;
        const node = await this.nodeOf(tx, found.tenantId);
        await lockTreeShared(tx, node.rootId);
        const agent = await lockAgent(tx, agentId);
        if (agent.tenantId !== p.tenantId) throw notFound('agent');
        const [existing] = await tx
          .select({ id: agentReviews.id })
          .from(agentReviews)
          .where(and(eq(agentReviews.agentId, agent.id), eq(agentReviews.status, 'open')));
        if (existing)
          throw new HttpError(409, 'review_open', 'the agent already has an open review', {
            reviewId: existing.id,
          });
        // Open, withdraw, repeat must not pile up holds without bound (#356): an administrator
        // releases abandoned ones with `clear-hold`.
        const [held] = await tx
          .select({ n: count() })
          .from(agentReviews)
          .where(
            and(
              eq(agentReviews.agentId, agent.id),
              inArray(agentReviews.status, ['withdrawn', 'rejected']),
              sql`not exists (select 1 from ${agentReviewHoldClears} c where c.review_id = ${agentReviews.id})`,
            ),
          );
        if (Number(held?.n ?? 0) >= MAX_UNCLEARED_CLOSED_REVIEWS)
          throw new HttpError(
            429,
            'review_hold_limit',
            `this agent has ${MAX_UNCLEARED_CLOSED_REVIEWS} withdrawn or rejected reviews that no administrator released; an administrator has to release them (clear-hold) first`,
          );
        const head = await ensureHead(tx, agent, (r) => this.auditRevision(tx, agent, r, true));
        const policy = await this.policy.effectiveFor(node, tx);
        const { binding } = await this.bindingOf(
          tx,
          agent,
          head.source,
          head.digest,
          policy,
          catalog,
        );
        let base: VersionRow | null = null;
        if (agent.latestVersionId) {
          const [v] = await tx
            .select()
            .from(agentVersions)
            .where(eq(agentVersions.id, agent.latestVersionId));
          base = v ?? null;
        }
        if (base && base.digest === head.digest)
          throw new HttpError(
            409,
            'nothing_to_review',
            'the draft equals the latest published version',
          );
        const required = requiredApprovals(policy.minApprovals);
        const [review] = await tx
          .insert(agentReviews)
          .values({
            id: randomUUID(),
            agentId: agent.id,
            tenantId: agent.tenantId,
            openedBy: p.userId,
            openedRevisionId: head.id,
            baseVersionId: base?.id ?? null,
            policySnapshot: { policy, rules: [] } as unknown as Record<string, unknown>,
            policyDigest: binding.policyDigest,
            requiredApprovals: required,
          })
          .returning();
        await this.audit.append(
          {
            actor: p.userId,
            tenantId: agent.tenantId,
            action: 'agent.review.opened',
            target: agent.id,
            payload: {
              review: review!.id,
              revision: head.id,
              digest: binding.digest,
              expansionDigest: binding.expansionDigest,
              resolutionDigest: binding.resolutionDigest,
              policyDigest: binding.policyDigest,
              requiredApprovals: required,
              baseVersion: base?.version ?? null,
            },
          },
          tx,
        );
        // `ensureHead` may have appended a revision: the view reads the head from this row
        return { agent: { ...agent, draftRevisionId: head.id }, review: review! };
      });
    } catch (e) {
      // The partial unique index is the backstop of the lock: one open review per agent.
      if (pgCode(e) === '23505')
        throw new HttpError(409, 'review_open', 'the agent already has an open review');
      throw e;
    }
    const policy = await this.policy.effectiveForTenant(created.agent.tenantId);
    return this.viewOf(
      p,
      created.agent,
      await this.evaluate(this.ctx.db, created.agent, created.review, policy),
    );
  }

  private async nodeOf(db: Db, tenantId: string) {
    const [node] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!node) throw notFound('tenant');
    return node;
  }

  // ------------------------------------------------------------------ decide

  async decide(
    p: Principal,
    reviewId: string,
    input: DecisionInput,
  ): Promise<{ review: ReviewView; decision: ApprovalView }> {
    const { agent: foundAgent } = await this.loadReview(p, reviewId);
    await this.agents.assertAccess(p, foundAgent, 'agents:approve').catch((e: unknown) => {
      throw e instanceof HttpError && e.statusCode === 404 ? notFound('review') : e;
    });
    const comment = this.cleanComment(input);
    const catalog = await this.catalogOf(foundAgent);
    type Outcome =
      | { kind: 'refused'; code: RefusalCode; message: string; agent: AgentRow }
      | { kind: 'done'; agent: AgentRow; decisionId: string };
    const outcome = await this.ctx.db.transaction(async (t): Promise<Outcome> => {
      const tx = t as unknown as Db;
      const node = await this.nodeOf(tx, foundAgent.tenantId);
      // Lock order (tree-lock.ts): tree, bindings, then the agent row, then the audit chain.
      await lockTreeShared(tx, node.rootId);
      await lockBindings(tx, node.rootId);
      const agent = await lockAgent(tx, foundAgent.id);
      const [review] = await tx
        .select()
        .from(agentReviews)
        .where(eq(agentReviews.id, reviewId))
        .for('update');
      if (!review || review.tenantId !== p.tenantId) throw notFound('review');
      if (review.status !== 'open')
        throw new HttpError(409, 'review_closed', `the review is ${review.status}`);
      // The stricter of the policy the review was opened under and the policy now (finding 2).
      const policy = reviewPolicy(review, await this.policy.effectiveFor(node, tx));
      const head = await ensureHead(tx, agent, (r) => this.auditRevision(tx, agent, r, true));
      const { set: contributors } = await this.contributorsOf(tx, agent, review, head);
      const facts = await this.factsOf(tx, p, agent);
      const verdict = checkApprover(
        facts,
        this.approvalContext(contributors, policy, {
          expected: input.expectedDigest,
          current: head.digest,
        }),
      );
      if (!verdict.ok)
        return { kind: 'refused', code: verdict.code, message: verdict.message, agent };
      const { binding, useCase } = await this.bindingOf(
        tx,
        agent,
        head.source,
        head.digest,
        policy,
        catalog,
      );
      // An approval binds to the expansion, the secret resolution and the policy the reviewer saw
      // (A10): a client that leaves them out would bind it to something it never looked at. They are
      // required for every approval, and for any decision while approval is required (finding 3).
      const required = this.approvalRequired(
        policy,
        review.baseVersionId ? agent.useCase : null,
        useCase,
      );
      if (input.decision === 'approve' || required) {
        const missing = (
          [
            ['expectedExpansionDigest', input.expectedExpansionDigest],
            ['expectedResolutionDigest', input.expectedResolutionDigest],
            ['expectedPolicyDigest', input.expectedPolicyDigest],
          ] as const
        )
          .filter(([, v]) => v === undefined)
          .map(([k]) => k);
        if (missing.length > 0)
          throw new HttpError(
            400,
            'validation_failed',
            `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required: a decision binds to the digests you looked at`,
            missing.map((path) => ({ path, message: 'required' })),
          );
      }
      const stale = (
        [
          ['expectedExpansionDigest', input.expectedExpansionDigest, binding.expansionDigest],
          ['expectedResolutionDigest', input.expectedResolutionDigest, binding.resolutionDigest],
          ['expectedPolicyDigest', input.expectedPolicyDigest, binding.policyDigest],
        ] as const
      ).find(([, expected, current]) => expected !== undefined && expected !== current);
      if (stale)
        return {
          kind: 'refused',
          code: 'stale_view',
          message: `the ${stale[0].replace('expected', '').replace(/^./, (c) => c.toLowerCase())} changed since you loaded it`,
          agent,
        };
      const now = this.ctx.now();
      const decisionId = randomUUID();
      await tx.insert(agentReviewDecisions).values({
        id: decisionId,
        reviewId: review.id,
        revisionId: head.id,
        digest: head.digest,
        expansionDigest: binding.expansionDigest,
        resolutionDigest: binding.resolutionDigest,
        baseVersionId: review.baseVersionId,
        policyDigest: binding.policyDigest,
        reviewerId: p.userId,
        reviewerAuth: authString(facts.auth),
        actingTenantId: p.tenantId,
        bindingRefs: verdict.via.map((b: ApproverBinding) => ({
          id: b.id,
          role: b.role,
          source: b.source,
          grantedBy: b.grantedBy,
        })),
        decision: input.decision,
        comment,
        decidedAt: now,
        expiresAt:
          input.decision === 'approve'
            ? new Date(now.getTime() + policy.approvalExpiryHours * 3_600_000)
            : null,
      });
      await this.audit.append(
        {
          actor: p.userId,
          tenantId: agent.tenantId,
          action: 'agent.review.decided',
          target: agent.id,
          payload: {
            review: review.id,
            revision: head.id,
            digest: head.digest,
            decision: input.decision,
            reviewer: p.userId,
            // not `auth`: the audit scrubber redacts keys of that name
            authMethod: authString(facts.auth),
            eligibleVia: verdict.via.map((b) => ({ id: b.id, role: b.role, source: b.source })),
            expansionDigest: binding.expansionDigest,
            resolutionDigest: binding.resolutionDigest,
            policyDigest: binding.policyDigest,
          },
        },
        tx,
      );
      if (input.decision === 'reject') {
        await tx
          .update(agentReviews)
          .set({
            status: 'rejected',
            closedAt: now,
            closedBy: p.userId,
            closedRevisionId: agent.draftRevisionId,
          })
          .where(eq(agentReviews.id, review.id));
        await this.audit.append(
          {
            actor: p.userId,
            tenantId: agent.tenantId,
            action: 'agent.review.closed',
            target: agent.id,
            payload: { review: review.id, outcome: 'rejected' },
          },
          tx,
        );
      }
      return { kind: 'done', agent, decisionId };
    });
    if (outcome.kind === 'refused') {
      await this.auditRefusal(p, reviewId, outcome.agent, outcome.code);
      throw new HttpError(REFUSAL_STATUS[outcome.code], outcome.code, outcome.message);
    }
    const [review] = await this.ctx.db
      .select()
      .from(agentReviews)
      .where(eq(agentReviews.id, reviewId));
    const policy = await this.policy.effectiveForTenant(outcome.agent.tenantId);
    const agent = await this.agents.get(outcome.agent.id, p);
    const ev = await this.evaluate(this.ctx.db, agent, review!, policy);
    const decision = ev.approvals.find((a) => a.id === outcome.decisionId)!;
    return { review: await this.viewOf(p, agent, ev), decision };
  }

  private cleanComment(input: DecisionInput): string | null {
    const text = input.comment === undefined ? '' : stripInvisible(input.comment).text.trim();
    if (text.length > MAX_COMMENT_LENGTH)
      throw new HttpError(
        400,
        'validation_failed',
        `comment must not exceed ${MAX_COMMENT_LENGTH} characters`,
      );
    if (input.decision !== 'approve' && text.length === 0)
      throw new HttpError(
        400,
        'validation_failed',
        'a comment is required to request changes or reject',
      );
    return text.length > 0 ? text : null;
  }

  /** `agent.review.refused`, rate-limited to one entry per review, user and code and minute. */
  private async auditRefusal(p: Principal, reviewId: string, agent: AgentRow, code: RefusalCode) {
    const key = `${reviewId}:${p.userId}:${code}`;
    const now = this.ctx.now().getTime();
    const last = this.refusedAt.get(key);
    if (last !== undefined && now - last < 60_000) return;
    if (this.refusedAt.size > 2000) this.refusedAt.clear();
    this.refusedAt.set(key, now);
    await this.audit.append({
      actor: p.userId,
      tenantId: agent.tenantId,
      action: 'agent.review.refused',
      target: agent.id,
      payload: { review: reviewId, code },
    });
  }

  // ------------------------------------------------------------------ withdraw

  async withdraw(p: Principal, reviewId: string): Promise<ReviewView> {
    const { agent: foundAgent } = await this.loadReview(p, reviewId);
    await this.agents.assertAccess(p, foundAgent, 'agents:write').catch((e: unknown) => {
      throw e instanceof HttpError && e.statusCode === 404 ? notFound('review') : e;
    });
    const agent = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const node = await this.nodeOf(tx, foundAgent.tenantId);
      await lockTreeShared(tx, node.rootId);
      const locked = await lockAgent(tx, foundAgent.id);
      const [review] = await tx
        .select()
        .from(agentReviews)
        .where(eq(agentReviews.id, reviewId))
        .for('update');
      if (!review || review.tenantId !== p.tenantId) throw notFound('review');
      // Whether the caller administers the agent's node is read from the database here, not from the
      // cached principal (a revoked or narrowed binding must not still withdraw) and for the node
      // of the agent, not any node (S1 review finding 8).
      if (
        review.openedBy !== p.userId &&
        !isTenantAdminAt(await loadActor(tx, p), node, this.ctx.now())
      )
        throw forbidden(
          'only the person who opened the review or an administrator can withdraw it',
        );
      if (review.status !== 'open')
        throw new HttpError(409, 'review_closed', `the review is ${review.status}`);
      await tx
        .update(agentReviews)
        .set({
          status: 'withdrawn',
          closedAt: this.ctx.now(),
          closedBy: p.userId,
          closedRevisionId: locked.draftRevisionId,
        })
        .where(eq(agentReviews.id, reviewId));
      await this.audit.append(
        {
          actor: p.userId,
          tenantId: locked.tenantId,
          action: 'agent.review.closed',
          target: locked.id,
          payload: { review: reviewId, outcome: 'withdrawn' },
        },
        tx,
      );
      return locked;
    });
    return this.get(p, reviewId).then((v) => ({ ...v, agentId: agent.id }));
  }

  // ------------------------------------------------------------------ clear hold

  /**
   * Releases a withdrawn or rejected review from the policy-loosening hold (#356). Needs an
   * administrator of the agent's node who is not a contributor of the review and whose own authority
   * does not come from one (the same chain as the loosening guard). Audited as
   * `agent.review.hold_cleared`; the row is append-only.
   */
  async clearHold(
    p: Principal,
    reviewId: string,
    reason: string,
  ): Promise<{ reviewId: string; clearedBy: string; clearedAt: Date }> {
    const { agent: foundAgent } = await this.loadReview(p, reviewId);
    return this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const node = await this.nodeOf(tx, foundAgent.tenantId);
      await lockTreeShared(tx, node.rootId);
      await lockBindings(tx, node.rootId);
      const locked = await lockAgent(tx, foundAgent.id);
      if (!isTenantAdminAt(await loadActor(tx, p), node, this.ctx.now()))
        throw forbidden("only an administrator of the agent's tenant can release a hold");
      const [review] = await tx
        .select()
        .from(agentReviews)
        .where(eq(agentReviews.id, reviewId))
        .for('update');
      if (!review || review.tenantId !== p.tenantId) throw notFound('review');
      if (review.status !== 'withdrawn' && review.status !== 'rejected')
        throw new HttpError(
          409,
          'not_held',
          `the review is ${review.status}; only a withdrawn or rejected review is held`,
        );
      const [done] = await tx
        .select()
        .from(agentReviewHoldClears)
        .where(eq(agentReviewHoldClears.reviewId, reviewId));
      if (done) throw new HttpError(409, 'not_held', 'the hold was already released');
      const chain = await followGrantChain(
        tx,
        [{ userId: p.userId, unknown: false }],
        this.ctx.now(),
      );
      const mine = new Set([p.userId, ...chain.users]);
      const head = await reviewHeadOf(tx, locked, review);
      const contributors = head ? (await reviewContributors(tx, locked, review, head)).set : null;
      const untraceable = chain.unknown && this.ctx.config.lifecycle.unknownGrantor !== 'allow';
      // A review whose head cannot be read cannot be shown to be free of the caller; a platform
      // operator may still release it (the way out of an unreadable head, #356).
      const unreadableButOperator = contributors === null && p.platformAdmin;
      if (
        !unreadableButOperator &&
        (contributors === null || untraceable || [...contributors].some((c) => mine.has(c)))
      )
        throw new HttpError(
          403,
          'hold_clear_by_contributor',
          'you, or somebody your authority comes from, contributed to this review (or your authority cannot be traced); another administrator has to release the hold',
        );
      const clearedAt = this.ctx.now();
      await tx
        .insert(agentReviewHoldClears)
        .values({ reviewId, clearedBy: p.userId, clearedAt, reason });
      await this.audit.append(
        {
          actor: p.userId,
          tenantId: locked.tenantId,
          action: 'agent.review.hold_cleared',
          target: locked.id,
          payload: { review: reviewId, status: review.status },
        },
        tx,
      );
      return { reviewId, clearedBy: p.userId, clearedAt };
    });
  }
}

/**
 * The revision a review is about: the head of the draft while it is open; once it is closed, the
 * revision of its last decision (or the one it was opened on), so that a closed review keeps
 * showing what was decided and not what the draft became afterwards.
 */
export async function reviewHead(db: Db, agent: AgentRow, review: ReviewRow): Promise<RevisionRow> {
  if (review.status === 'open') return ensureHeadReadOnly(db, agent);
  const [last] = await db
    .select({ revisionId: agentReviewDecisions.revisionId })
    .from(agentReviewDecisions)
    .where(eq(agentReviewDecisions.reviewId, review.id))
    .orderBy(desc(agentReviewDecisions.decidedAt), desc(agentReviewDecisions.id))
    .limit(1);
  const rev = await revisionById(db, last?.revisionId ?? review.openedRevisionId);
  if (!rev) throw notFound('revision');
  return rev;
}

/** The head revision of an agent for a read-only caller; fails if the backfill has not run yet. */
async function ensureHeadReadOnly(db: Db, agent: AgentRow): Promise<RevisionRow> {
  if (agent.draftRevisionId) {
    const head = await revisionById(db, agent.draftRevisionId);
    if (head) return head;
  }
  throw new HttpError(
    409,
    'revisions_pending',
    'the draft revisions of this agent are being created',
  );
}
