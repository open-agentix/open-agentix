import { randomUUID } from 'node:crypto';
import {
  checkPublish,
  declaredSecretReferences,
  LEGACY_REMOVED_CODE,
  legacyRemovedMessage,
  type LegacyPhase,
  type PublishedDefinition,
  type AgentDefinition,
  type Principal,
} from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { agentReviews, agentVersions, agents, tenants } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import { ensureHead, lockAgent, type AgentRow, type RevisionRow } from './agent-revisions.js';
import type { AgentReviewsService } from './agent-reviews.js';
import type { AuditService } from './audit.js';
import type { LifecyclePolicyService } from './lifecycle-policy.js';
import type {
  ApprovalRecord,
  GateOutcome,
  GateRefusal,
  PublishApprovalInput,
  PublishGate,
} from './publish-gate.js';
import { convertDefinition, storeConversion, teamLookup } from './legacy-awp.js';
import { lockBindings, lockTreeShared } from './tree-lock.js';

/**
 * The transaction of a publish (ADR 0017 section 4.3). Everything that decides whether the version
 * exists happens here, in one transaction, in this order:
 *
 * 1. the organisation's tree lock (shared), its binding lock, then the agent row lock (the order of
 *    `tree-lock.ts`), so a draft save, a decision, a binding change, a policy change under the
 *    binding lock and another publish are serialised with it;
 * 2. the head revision is read under the lock and must be the draft the caller's checks were made on
 *    (`409 draft_changed` otherwise); the version is published from the **revision's** source, never
 *    from a value read earlier;
 * 3. the published versions are read again and the version rule is applied again (a concurrent publish
 *    of the same version or a newer one);
 * 4. the approval gate (`publish-gate.ts`) decides under the same locks;
 * 5. the version row (with its approval record), `agents.latest_version_id`, the review (closed as
 *    `published`) and the audit entries are written, all in this transaction.
 */

export interface CommitParams {
  principal: Principal;
  agentId: string;
  /** The definition of the draft the pre-lock checks ran on; the head revision must have its digest. */
  def: AgentDefinition;
  /** The same definition after profile expansion (stored with the version). */
  expanded: AgentDefinition;
  catalog: Awaited<ReturnType<AgentReviewsService['catalogOf']>>;
  input: PublishApprovalInput;
  onRevision: (tx: Db, agent: AgentRow, revision: RevisionRow) => Promise<void>;
  /** The deterministic demo seed only (see `AgentsService.publishDemoSeed`): no approval gate. */
  seed?: boolean;
  /** AWP-3b: release N or N+1 of the legacy format (from the build version). */
  legacyPhase: LegacyPhase;
}

export interface CommitResult {
  version: typeof agentVersions.$inferSelect;
  approval: ApprovalRecord | null;
}

/** Refusal audit entries are written at most once per agent, user and code and minute. */
const REFUSAL_AUDIT_WINDOW_MS = 60_000;
const REFUSAL_AUDIT_MAX_KEYS = 2000;

/** The tenant row as it is now; call it after the tree lock is held. */
export async function freshNode(tx: Db, id: string) {
  const [row] = await tx.select().from(tenants).where(eq(tenants.id, id));
  if (!row) throw notFound('tenant');
  return row;
}

export class AgentPublisher {
  private readonly refusedAt = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly gate: PublishGate,
    private readonly policy: LifecyclePolicyService,
  ) {}

  /** Publishes or throws the refusal of the gate (audited, rate-limited) as an `HttpError`. */
  async commit(p: CommitParams): Promise<CommitResult> {
    // AWP-3b, release N+1: no path creates a version from a legacy file (publish through an approved
    // review included; every version is created below).
    if (p.legacyPhase === 'removed')
      throw new HttpError(400, LEGACY_REMOVED_CODE, legacyRemovedMessage());
    type Outcome = { kind: 'refused'; refusal: GateRefusal } | ({ kind: 'done' } & CommitResult);
    const outcome = await this.ctx.db.transaction(async (t): Promise<Outcome> => {
      const tx = t as unknown as Db;
      const [found] = await tx.select().from(agents).where(eq(agents.id, p.agentId));
      if (!found || found.tenantId !== p.principal.tenantId) throw notFound('agent');
      const [placed] = await tx.select().from(tenants).where(eq(tenants.id, found.tenantId));
      if (!placed) throw notFound('tenant');
      await lockTreeShared(tx, placed.rootId);
      await lockBindings(tx, placed.rootId);
      // A tenant move holds the tree lock exclusively and changes `path` (the chain whose policies
      // apply): the node is read again now that no move can commit before this transaction ends.
      const node = await freshNode(tx, placed.id);
      const agent = await lockAgent(tx, p.agentId);
      const head = await ensureHead(tx, agent, (r) => p.onRevision(tx, agent, r));
      if (head.digest !== p.def.digest)
        throw new HttpError(409, 'draft_changed', 'the draft changed while publishing; try again');
      await this.assertVersionRule(tx, agent.id, p.def);
      const gated = await this.decide(tx, p, { agent, head, node });
      if (gated.kind === 'refused') return { kind: 'refused', refusal: gated.refusal };
      const record = gated.kind === 'approved' ? gated.record : null;
      const version = await this.insertVersion(tx, p, head, record);
      await this.storeAwpConversion(tx, agent, version);
      await tx
        .update(agents)
        .set({
          latestVersionId: version.id,
          latestVersion: version.version,
          useCase: p.def.labels.useCase || null,
        })
        .where(eq(agents.id, agent.id));
      const closed = gated.kind === 'approved' ? gated.review.id : gated.advisoryReviewId;
      if (closed) await this.closeReview(tx, p.principal, agent, closed, version.id);
      await this.auditPublished(tx, p, version, record, closed);
      return { kind: 'done', version, approval: record };
    });
    if (outcome.kind === 'refused') {
      await this.auditRefusal(p.principal, p.agentId, outcome.refusal);
      throw new HttpError(
        outcome.refusal.status,
        outcome.refusal.code,
        outcome.refusal.message,
        outcome.refusal.details,
      );
    }
    return { version: outcome.version, approval: outcome.approval };
  }

  private async decide(
    tx: Db,
    p: CommitParams,
    at: { agent: AgentRow; head: RevisionRow; node: typeof tenants.$inferSelect },
  ): Promise<GateOutcome> {
    if (p.seed) return { kind: 'not_required', advisoryReviewId: null };
    return this.gate.decide(tx, {
      principal: p.principal,
      agent: at.agent,
      head: at.head,
      useCase: p.def.labels.useCase || null,
      catalog: p.catalog,
      policy: await this.policy.effectiveFor(at.node, tx),
      input: p.input,
    });
  }

  /** The version rule against the versions as they are under the lock (another publish may have run). */
  private async assertVersionRule(tx: Db, agentId: string, def: AgentDefinition): Promise<void> {
    const published = await tx
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId));
    if (checkPublish(published, def) === 'unchanged')
      throw new HttpError(409, 'draft_changed', 'the draft was published meanwhile; try again');
  }

  /**
   * AWP-3b: the effective AWP manifest is stored next to the version (never in it); a refusal is
   * stored as `legacy-unconvertible`. The row is written in a savepoint: a database error is logged
   * and does not fail the publish; the one-time conversion (or the read path) converts it later.
   */
  private async storeAwpConversion(
    tx: Db,
    agent: AgentRow,
    version: typeof agentVersions.$inferSelect,
  ): Promise<void> {
    try {
      const conversion = await convertDefinition(
        agent,
        version.definition as PublishedDefinition,
        teamLookup(tx, agent.tenantId),
      );
      await tx.transaction((sp) => storeConversion(sp as unknown as Db, version, conversion));
    } catch (e) {
      this.ctx.logger.warn(
        { err: e, agent: agent.id, version: version.version },
        'AWP conversion not stored',
      );
    }
  }

  private async insertVersion(
    tx: Db,
    p: CommitParams,
    head: RevisionRow,
    record: ApprovalRecord | null,
  ) {
    const [v] = await tx
      .insert(agentVersions)
      .values({
        id: randomUUID(),
        agentId: p.agentId,
        version: p.def.version,
        digest: p.def.digest,
        // From the revision the checks were made on, never from a value read earlier.
        source: head.source,
        definition: p.expanded as unknown as object,
        publishedBy: p.principal.userId,
        revisionId: head.id,
        secretResolution: declaredSecretReferences(p.def),
        ...(record
          ? {
              reviewId: record.reviewId,
              approvedBy: record.approvedBy,
              policyDigest: record.policyDigest,
              expansionDigest: record.expansionDigest,
              resolutionDigest: record.resolutionDigest,
            }
          : {}),
      })
      .returning();
    return v!;
  }

  /** ADR 4.3 step 6: the review ends as `published` and names its version. */
  private async closeReview(
    tx: Db,
    principal: Principal,
    agent: AgentRow,
    reviewId: string,
    versionId: string,
  ): Promise<void> {
    await tx
      .update(agentReviews)
      .set({
        status: 'published',
        closedAt: this.ctx.now(),
        closedBy: principal.userId,
        publishedVersionId: versionId,
      })
      .where(eq(agentReviews.id, reviewId));
    await this.audit.append(
      {
        actor: principal.userId,
        tenantId: agent.tenantId,
        action: 'agent.review.closed',
        target: agent.id,
        payload: { review: reviewId, outcome: 'published', version: versionId },
      },
      tx,
    );
  }

  private async auditPublished(
    tx: Db,
    p: CommitParams,
    version: typeof agentVersions.$inferSelect,
    record: ApprovalRecord | null,
    reviewId: string | null,
  ): Promise<void> {
    await this.audit.append(
      {
        actor: p.principal.userId,
        tenantId: p.principal.tenantId,
        action: 'agent.published',
        target: p.agentId,
        payload: {
          version: version.version,
          digest: version.digest,
          revision: version.revisionId,
          review: reviewId,
          approved: record !== null,
          ...(record
            ? {
                approvedBy: record.approvedBy,
                policyDigest: record.policyDigest,
                expansionDigest: record.expansionDigest,
                resolutionDigest: record.resolutionDigest,
              }
            : {}),
          ...(p.seed ? { seed: true } : {}),
        },
      },
      tx,
    );
  }

  /** `agent.publish.refused { code, review }`, rate-limited; the transaction rolled back, so this is outside it. */
  private async auditRefusal(
    principal: Principal,
    agentId: string,
    refusal: GateRefusal,
  ): Promise<void> {
    const key = `${agentId}:${principal.userId}:${refusal.code}`;
    const now = this.ctx.now().getTime();
    const last = this.refusedAt.get(key);
    if (last !== undefined && now - last < REFUSAL_AUDIT_WINDOW_MS) return;
    if (this.refusedAt.size > REFUSAL_AUDIT_MAX_KEYS) this.refusedAt.clear();
    this.refusedAt.set(key, now);
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: 'agent.publish.refused',
      target: agentId,
      payload: { code: refusal.code, review: refusal.reviewId },
    });
  }
}
