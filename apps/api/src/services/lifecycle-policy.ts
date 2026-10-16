import {
  lifecycleDefaults,
  lifecyclePolicyDigest,
  parseLifecycleInput,
  pathIds,
  proposeLifecyclePolicy,
  resolveLifecyclePolicy,
  wideningKeys,
  LIFECYCLE_KEYS,
  type LifecycleKey,
  type LifecyclePolicy,
  type LifecyclePolicyInput,
  type Principal,
} from '@openagentix/core';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { agentReviews, agents, tenants } from '../db/schema.js';
import { HttpError, forbidden, notFound } from '../errors.js';
import { revisionById } from './agent-revisions.js';
import type { AuditService } from './audit.js';
import { loadActor, permissionsAt } from './grant-authority.js';
import { reviewContributors } from './review-contributors.js';
import { lockBindings, lockTreeShared } from './tree-lock.js';
import { TenantAccess } from './tenant-access.js';

/**
 * The agent lifecycle policy of a tenant node (ADR 0017 section 6): reading the effective policy
 * and writing the values a node stores itself. The resolution and the narrowing rules live in
 * `@openagentix/core` (`lifecycle-policy.ts`, pure); this service loads the chain, authorises and
 * audits. Folds into the general effective-settings resolver of W13-2 when that exists.
 */

type TenantRow = typeof tenants.$inferSelect;

export interface PolicyView {
  tenantId: string;
  /** What this node stores itself (sparse). */
  own: LifecyclePolicyInput;
  /** What applies at this node: the chain resolved, never looser than the parent's. */
  effective: LifecyclePolicy;
  /** Digest of the effective policy (no agent rules yet), as approval records bind it. */
  policyDigest: string;
}

/** `null` removes a value the node stored (the node then inherits). */
export type PolicyPatch = Partial<Record<LifecycleKey, unknown>>;

const storedOf = (row: Pick<TenantRow, 'settings'>): LifecyclePolicyInput => {
  const raw = (row.settings as Record<string, unknown> | null)?.['agentLifecycle'];
  const parsed = parseLifecycleInput(raw ?? {});
  // A stored object that no longer parses (hand-edited, from a future version) contributes nothing:
  // the node then inherits, which can only be as strict as its parent (fail closed).
  return parsed.ok ? parsed.value : {};
};

export class LifecyclePolicyService {
  private readonly access: TenantAccess;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {
    this.access = new TenantAccess(ctx);
  }

  /** Installation defaults: `OAX_LIFECYCLE_*`, with `auto` resolved by the number of tenants. */
  async installationDefaults(db: Db = this.ctx.db): Promise<LifecyclePolicy> {
    const c = this.ctx.config.lifecycle;
    let requireApprovalForPublish: LifecyclePolicy['requireApprovalForPublish'];
    if (c.requireApproval === 'auto') {
      const [row] = await db.select({ n: count() }).from(tenants);
      requireApprovalForPublish = (row?.n ?? 0) > 1 ? 'on' : 'off';
    } else requireApprovalForPublish = c.requireApproval;
    return lifecycleDefaults({
      requireApprovalForPublish,
      minApprovals: c.minApprovals,
      allowedApproverRoles: c.allowedApproverRoles,
      approvalExpiryHours: c.approvalExpiryHours,
      allowTokenApprovals: c.allowTokenApprovals,
    });
  }

  /**
   * Refuses a change that makes the effective policy of `node` looser when the caller is a
   * contributor of an open review in the subtree of `node` (S1 review finding 2): they would be
   * relaxing the rules of their own review. A second administrator (who is not a contributor) makes
   * the change instead. Open reviews are judged by the stricter of their own snapshot and the
   * current policy as well, so this is the second line, not the only one.
   */
  private async assertNoOwnOpenReview(
    tx: Db,
    userId: string,
    node: TenantRow,
    keys: readonly LifecycleKey[],
  ): Promise<void> {
    const open = await tx
      .select({ review: agentReviews, agent: agents })
      .from(agentReviews)
      .innerJoin(agents, eq(agents.id, agentReviews.agentId))
      .innerJoin(tenants, eq(tenants.id, agentReviews.tenantId))
      .where(
        and(
          eq(agentReviews.status, 'open'),
          eq(tenants.rootId, node.rootId),
          sql`starts_with(${tenants.path}, ${node.path})`,
        ),
      )
      .limit(1000);
    for (const { review, agent } of open) {
      const head = agent.draftRevisionId
        ? await revisionById(tx, agent.draftRevisionId)
        : undefined;
      // A review whose head cannot be read cannot be shown to be free of the caller: fail closed.
      const contributors = head ? (await reviewContributors(tx, agent, review, head)).set : null;
      if (contributors === null || contributors.has(userId))
        throw new HttpError(
          403,
          'policy_loosening_by_contributor',
          `you contributed to an open review in this subtree; another administrator has to loosen ${keys.join(', ')}`,
        );
    }
  }

  /** The stored values of the chain of a node, root first. */
  private async chain(db: Db, node: Pick<TenantRow, 'path'>): Promise<LifecyclePolicyInput[]> {
    const ids = pathIds(node.path);
    const rows = await db.select().from(tenants).where(inArray(tenants.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const row = byId.get(id);
      return row ? storedOf(row) : {};
    });
  }

  /** The effective policy that applies at a node (own values resolved down the chain). */
  async effectiveFor(
    node: Pick<TenantRow, 'path'>,
    db: Db = this.ctx.db,
  ): Promise<LifecyclePolicy> {
    return resolveLifecyclePolicy(await this.installationDefaults(db), await this.chain(db, node));
  }

  /** The effective policy of the node with this id. */
  async effectiveForTenant(tenantId: string, db: Db = this.ctx.db): Promise<LifecyclePolicy> {
    const [node] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!node) throw notFound('tenant');
    return this.effectiveFor(node, db);
  }

  private async visibleNode(p: Principal, id: string): Promise<TenantRow> {
    const [row] = await this.ctx.db.select().from(tenants).where(eq(tenants.id, id));
    if (!row || !TenantAccess.allows(await this.access.reach(p), row)) throw notFound('tenant');
    return row;
  }

  private view(
    node: TenantRow,
    chain: LifecyclePolicyInput[],
    defaults: LifecyclePolicy,
  ): PolicyView {
    const effective = resolveLifecyclePolicy(defaults, chain);
    return {
      tenantId: node.id,
      own: chain[chain.length - 1] ?? {},
      effective,
      policyDigest: lifecyclePolicyDigest(effective),
    };
  }

  async get(p: Principal, tenantId: string): Promise<PolicyView> {
    const node = await this.visibleNode(p, tenantId);
    const actor = await loadActor(this.ctx.db, p);
    if (!permissionsAt(actor, node, this.ctx.now()).has('settings:read')) throw forbidden();
    return this.view(node, await this.chain(this.ctx.db, node), await this.installationDefaults());
  }

  /**
   * Writes the values this node stores. Narrowing only: below a parent, a value that would make the
   * node's effective policy looser than the parent's is refused with `422 not_narrowing` and the
   * keys named; the root of an organisation chooses freely. Serialised per organisation with the
   * binding lock, so a parent and a child cannot be written past each other.
   */
  async patch(p: Principal, tenantId: string, patch: PolicyPatch): Promise<PolicyView> {
    const node = await this.visibleNode(p, tenantId);
    const unknown = Object.keys(patch).filter((k) => !(LIFECYCLE_KEYS as string[]).includes(k));
    if (unknown.length > 0)
      throw new HttpError(
        400,
        'validation_failed',
        `unknown key ${unknown.map((k) => `"${k}"`).join(', ')}`,
        unknown.map((k) => ({ path: k, message: 'unknown key' })),
      );
    if (Object.keys(patch).length === 0)
      throw new HttpError(400, 'validation_failed', 'no key to change');
    const outcome = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await lockTreeShared(tx, node.rootId);
      await lockBindings(tx, node.rootId);
      const actor = await loadActor(tx, p);
      if (!permissionsAt(actor, node, this.ctx.now()).has('settings:write')) throw forbidden();
      const [fresh] = await tx.select().from(tenants).where(eq(tenants.id, node.id)).for('update');
      if (!fresh) throw notFound('tenant');
      const defaults = await this.installationDefaults(tx);
      const chain = await this.chain(tx, fresh);
      const before = chain[chain.length - 1] ?? {};
      const merged: Record<string, unknown> = { ...before };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      const parsed = parseLifecycleInput(merged);
      if (!parsed.ok)
        throw new HttpError(400, 'validation_failed', 'invalid lifecycle policy', parsed.issues);
      const next = parsed.value;
      if (chain.length > 1) {
        const parentEffective = resolveLifecyclePolicy(defaults, chain.slice(0, -1));
        const widening = wideningKeys(
          parentEffective,
          proposeLifecyclePolicy(parentEffective, next),
        );
        if (widening.length > 0)
          throw new HttpError(
            422,
            'not_narrowing',
            `a node may only narrow the policy of its parent; looser: ${widening.join(', ')}`,
            widening.map((k) => ({ path: k, message: 'looser than the parent' })),
          );
      }
      // Loosening the policy of a subtree where the caller contributed to an open review would let
      // the author relax the rules of their own review: another administrator has to do it.
      const loosened = wideningKeys(
        resolveLifecyclePolicy(defaults, chain),
        resolveLifecyclePolicy(defaults, [...chain.slice(0, -1), next]),
      );
      if (loosened.length > 0) await this.assertNoOwnOpenReview(tx, p.userId, fresh, loosened);
      const fields = (Object.keys(patch) as LifecycleKey[]).filter(
        (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(next[k] ?? null),
      );
      const settings = { ...(fresh.settings as Record<string, unknown>) };
      if (Object.keys(next).length > 0) settings['agentLifecycle'] = next;
      else delete settings['agentLifecycle'];
      if (fields.length > 0) {
        await tx.update(tenants).set({ settings }).where(eq(tenants.id, node.id));
        await this.audit.append(
          {
            actor: p.userId,
            tenantId: node.id,
            action: 'tenant.lifecycle_policy_changed',
            target: node.id,
            payload: {
              fields,
              ...(loosened.length > 0 ? { loosened } : {}),
              from: Object.fromEntries(fields.map((k) => [k, before[k] ?? null])),
              to: Object.fromEntries(fields.map((k) => [k, next[k] ?? null])),
            },
          },
          tx,
        );
      }
      return this.view(fresh, [...chain.slice(0, -1), next], defaults);
    });
    return outcome;
  }
}
