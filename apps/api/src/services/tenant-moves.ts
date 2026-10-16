import {
  OaxError,
  appliedAt,
  hasPermission,
  isRole,
  pathIds,
  rebasePath,
  subtreePrefix,
  type Permission,
  type Principal,
  type RoleNode,
  type RoleRestriction,
} from '@openagentix/core';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import {
  agentRoleBindings,
  agents,
  teamMembers,
  teams,
  tenantRoleBindings,
  tenantRoleRestrictions,
  tenants,
  users,
} from '../db/schema.js';
import { HttpError, forbidden, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import { assertNoCapAbove } from './budget-cap-guard.js';
import {
  isInheritingAdminAt,
  loadActor,
  mayManageRestrictions,
  notInheritingError,
  permissionsAt,
  type Actor,
} from './grant-authority.js';
import type { TenantRow } from './identity.js';
import { loadRawGrants } from './role-bindings.js';
import { TenantAccess, type TenantReach } from './tenant-access.js';
import { TenantTree } from './tenant-tree.js';
import { lockBindings, lockTreeExclusive, lockTreeShared } from './tree-lock.js';

/**
 * Moving a tenant inside its organisation (ADR 0013 section 9.1, ADR 0014 section 7 "escalation via
 * moves", slice S10). `POST /v1/tenants/{id}/move { parentId, dryRun }` re-parents a node together
 * with its whole subtree.
 *
 * What a move changes, and nothing else: `parent_id`, `path` and `depth` of the subtree (and the
 * node's own `use_case`, which is cleared). Every table refers to a tenant by id, so no data moves;
 * grants are resolved from the live tree, so bindings **on** moved nodes move with them, bindings
 * inherited from the old ancestors stop and those inheriting from the new ancestors start. The
 * authz epoch of the organisation is bumped by the database in the same transaction (migration 0021,
 * for every row whose parent or path changes), so every cached principal is rebuilt.
 *
 * Rules, in the order they are decided (all of them from state read **inside** the transaction,
 * under the exclusive tree lock and the binding lock, never from the cached principal):
 *
 * 1. Only with the resolver read path (`409 role_bindings_read_required` otherwise): with `legacy`
 *    the consequences of a move for access cannot be shown or enforced.
 * 2. The node and the new parent must be visible to the caller (otherwise the same `404 tenant` as
 *    for an id that does not exist).
 * 3. Authority: platform operator (with `settings:write`), or an **inheriting** `admin` binding
 *    (without use case) covering the moved node, the old parent **and** the new parent
 *    (`403 inheritance_required` / `403`). The mover therefore gains no coverage of any node it
 *    did not already administer: after the move the mover's authority over the subtree is the same
 *    inheriting admin it held before, and nothing outside the subtree changes.
 * 4. Structure: not a root and not into another organisation (`422 move_not_supported`, W13-15),
 *    not into itself or one of its descendants (`422 move_cycle`), not to where it already is
 *    (`409 move_noop`), the depth limit for the deepest moved node (`422 tenant_depth_exceeded`).
 * 5. Budgets are per node until W13-4: a tenant admin cannot move a node below a capped node
 *    (`403 budget_capped`), as for creation.
 * 6. Restrictions (ADR 0014 section 5): a restriction narrows the bindings bound on its node and
 *    below. Moving a subtree out from under a node with restrictions would widen the bindings
 *    anchored in the subtree, so a tenant admin needs the authority to manage restrictions on that
 *    node as well (`403 restriction_removal_forbidden`); moving under restrictions only narrows.
 * 7. The node is detached from its use case: the attachment named a use case of the **old** parent
 *    and would otherwise attach the node to a same-named use case of the new parent, giving its
 *    inheriting administrators access nobody granted. Re-attach through `PATCH /v1/tenants/{id}`.
 *
 * The dry run answers with the same checks and lists who gains and loses access, computed with the
 * same resolver (`appliedAt`) on the tree before and after, restricted to the principals the caller
 * may see (ADR 0014 section 7 rule 4) and bounded.
 */

/** Most principals evaluated and listed by a dry run; more are reported as `truncated`. */
export const MOVE_REPORT_LIMIT = 100;
/** Most restriction entries listed per direction. */
const RESTRICTION_LIST_LIMIT = 100;

export interface MovePrincipalChange {
  userId: string;
  /** Moved nodes where the principal holds a permission it did not hold before. */
  gainedNodes: number;
  /** Moved nodes where the principal loses a permission. */
  lostNodes: number;
  permissionsGained: Permission[];
  permissionsLost: Permission[];
}

export interface MoveRestrictionChange {
  /** The node that sets the restriction (an old or a new ancestor of the moved node). */
  nodeId: string;
  role: string;
  permissions: string[];
}

export interface MoveReport {
  dryRun: boolean;
  nodeId: string;
  fromParentId: string;
  toParentId: string;
  /** Nodes that move: the node and everything below it. */
  nodes: number;
  /** New depth of the node minus its old depth. */
  depthChange: number;
  slugPath: { from: string; to: string };
  /** The use case the node is detached from, or `null`. */
  detachesUseCase: string | null;
  /** Restrictions of ancestors the node leaves: they stop narrowing the bindings bound inside. */
  restrictionsDropped: MoveRestrictionChange[];
  /** Restrictions of ancestors the node joins: they start narrowing the bindings bound inside. */
  restrictionsApplied: MoveRestrictionChange[];
  /** Dry run only; empty after an applied move. */
  principals: MovePrincipalChange[];
  /** More principals changed than are listed. */
  truncated: boolean;
}

type Node = Pick<TenantRow, 'id' | 'rootId' | 'path'>;

const asNode = (n: Node): RoleNode => ({ id: n.id, rootId: n.rootId, path: n.path });

export class TenantMoves {
  private readonly access: TenantAccess;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {
    this.access = new TenantAccess(ctx);
  }

  /** A node the caller may see; unknown and invisible nodes are the same `404 tenant`. */
  private async visible(reach: TenantReach | undefined, id: string): Promise<TenantRow> {
    const [row] = await this.ctx.db.select().from(tenants).where(eq(tenants.id, id));
    if (!row || !TenantAccess.allows(reach, row)) throw notFound('tenant');
    return row;
  }

  async move(
    p: Principal,
    id: string,
    input: { parentId: string; dryRun: boolean },
  ): Promise<MoveReport> {
    if (this.ctx.config.auth.roleBindingsRead !== 'bindings')
      throw new HttpError(
        409,
        'role_bindings_read_required',
        'moving a tenant needs OAX_ROLE_BINDINGS_READ=bindings; with the legacy read path the effect on access cannot be shown or enforced',
      );
    if (p.platformAdmin && !hasPermission(p, 'settings:write')) throw forbidden();
    // Visibility first (404 parity): both nodes are named in the request, neither is the acting node.
    const reach = await this.access.reach(p);
    const node = await this.visible(reach, id);
    const target = await this.visible(reach, input.parentId);
    const now = this.ctx.now();
    const maxDepth = this.ctx.config.tenancy.maxDepth;
    let movedIds: string[] = [];
    const report = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      // A dry run only reads: the shared lock keeps the tree still while it computes, but does not
      // stop the organisation's other writers the way an applied move does.
      if (input.dryRun) await lockTreeShared(tx, node.rootId);
      else await lockTreeExclusive(tx, node.rootId);
      await lockBindings(tx, node.rootId);
      // Everything below is decided from the rows as they are now.
      const [fresh] = await tx.select().from(tenants).where(eq(tenants.id, node.id));
      const [newParent] = await tx.select().from(tenants).where(eq(tenants.id, target.id));
      if (!fresh || !newParent) throw notFound('tenant');
      const [oldParent] =
        fresh.parentId === null
          ? []
          : await tx.select().from(tenants).where(eq(tenants.id, fresh.parentId));

      const actor = p.platformAdmin ? undefined : await loadActor(tx, p);
      if (actor) this.assertAuthority(actor, [fresh, oldParent, newParent], now);
      // Structure, after authority: every node named here is visible to the caller by now.
      if (fresh.parentId === null || !oldParent)
        throw new HttpError(
          p.platformAdmin ? 422 : 403,
          p.platformAdmin ? 'move_not_supported' : 'move_not_allowed',
          'an organisation (root) cannot be moved',
        );
      if (fresh.rootId !== newParent.rootId)
        throw new HttpError(
          422,
          'move_not_supported',
          'moving a tenant into another organisation is not available yet',
        );
      if (newParent.path.startsWith(fresh.path))
        throw new HttpError(422, 'move_cycle', 'a tenant cannot be moved into its own subtree');
      if (newParent.id === oldParent.id)
        throw new HttpError(409, 'move_noop', 'the tenant is already below this parent');

      // Structural lookups inside the transaction (same connection, same snapshot).
      const tree = new TenantTree({ ...this.ctx, db: tx });
      const subtree = await tree.subtree(fresh);
      const deepest = subtree.reduce((m, n) => Math.max(m, n.depth), fresh.depth);
      const newDepth = newParent.depth + 1;
      if (deepest - fresh.depth + newDepth > maxDepth)
        throw new OaxError(
          'tenant_depth_exceeded',
          `moving would put a tenant at depth ${deepest - fresh.depth + newDepth}, above ${maxDepth}`,
        );
      if (actor) await assertNoCapAbove(tx, newParent);

      const oldAncestors = pathIds(fresh.path).slice(0, -1);
      const newChain = pathIds(newParent.path);
      const lost = oldAncestors.filter((x) => !newChain.includes(x));
      const gained = newChain.filter((x) => !oldAncestors.includes(x));
      const roles = await this.rolesInSubtree(tx, fresh);
      const dropped = await this.restrictionsOn(tx, lost, roles);
      const applied = await this.restrictionsOn(tx, gained, roles);
      if (actor) await this.assertMayDrop(tx, actor, dropped, now);

      const newPath = `${newParent.path}${fresh.id}/`;
      const slugs = await tree.slugPaths([fresh, newParent]);
      const report: MoveReport = {
        dryRun: input.dryRun,
        nodeId: fresh.id,
        fromParentId: oldParent.id,
        toParentId: newParent.id,
        nodes: subtree.length,
        depthChange: newDepth - fresh.depth,
        slugPath: { from: slugs.get(fresh.id)!, to: `${slugs.get(newParent.id)!}/${fresh.slug}` },
        detachesUseCase: fresh.useCase,
        restrictionsDropped: this.visibleRestrictions(reach, dropped),
        restrictionsApplied: this.visibleRestrictions(reach, applied),
        principals: [],
        truncated: false,
      };

      if (input.dryRun) {
        const changes = await this.principalChanges(tx, actor, {
          subtree,
          from: fresh.path,
          to: newPath,
          watched: [...new Set([...oldAncestors, ...newChain])],
          now,
        });
        report.principals = changes.items;
        report.truncated = changes.truncated;
        return report;
      }

      await this.apply(tx, fresh, newParent, newPath, newDepth - fresh.depth);
      movedIds = subtree.map((n) => n.id);
      await this.auditMove(tx, p, fresh, oldParent, newParent, report);
      return report;
    });
    // After the commit: the cached slug paths of the moved nodes are stale (30 s TTL otherwise).
    for (const moved of movedIds) await this.ctx.cache.del(`tenant-slug-path:${moved}`);
    return report;
  }

  /**
   * The authority of rule 3: the moved node, the old parent and the new parent each need an
   * inheriting `admin` of the caller (a platform operator is checked by the caller).
   */
  private assertAuthority(
    actor: Actor,
    nodes: readonly (TenantRow | undefined)[],
    now: Date,
  ): void {
    // The scope of a token is checked by `isInheritingAdminAt` (`settings:write`); a move also
    // changes who can do what, so `users:write` is required as well.
    if (actor.scopes && !actor.scopes.includes('users:write')) throw forbidden();
    for (const n of nodes) {
      // A root has no old parent; the structural rule below answers for it.
      if (!n) continue;
      if (!isInheritingAdminAt(actor, n, now)) throw notInheritingError(actor, n, now);
    }
  }

  /** The roles of every binding (node, team, agent) anchored in the subtree of `node`. */
  private async rolesInSubtree(tx: Db, node: Pick<TenantRow, 'path'>): Promise<Set<string>> {
    const prefix = subtreePrefix(node.path);
    const inTree = tx.select({ id: tenants.id }).from(tenants).where(like(tenants.path, prefix));
    const [a, b, c] = await Promise.all([
      tx
        .selectDistinct({ role: tenantRoleBindings.role })
        .from(tenantRoleBindings)
        .where(inArray(tenantRoleBindings.tenantId, inTree)),
      tx
        .selectDistinct({ role: teamMembers.role })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(inArray(teams.tenantId, inTree)),
      tx
        .selectDistinct({ role: agentRoleBindings.role })
        .from(agentRoleBindings)
        .innerJoin(agents, eq(agents.id, agentRoleBindings.agentId))
        .where(inArray(agents.tenantId, inTree)),
    ]);
    return new Set([...a, ...b, ...c].map((r) => r.role));
  }

  /** The restrictions set on `nodeIds` for roles that are held inside the moved subtree. */
  private async restrictionsOn(
    tx: Db,
    nodeIds: readonly string[],
    roles: ReadonlySet<string>,
  ): Promise<MoveRestrictionChange[]> {
    if (nodeIds.length === 0 || roles.size === 0) return [];
    const rows = await tx
      .select()
      .from(tenantRoleRestrictions)
      .where(
        and(
          inArray(tenantRoleRestrictions.tenantId, [...nodeIds]),
          inArray(tenantRoleRestrictions.role, [...roles]),
        ),
      )
      .orderBy(
        asc(tenantRoleRestrictions.tenantId),
        asc(tenantRoleRestrictions.role),
        asc(tenantRoleRestrictions.permission),
      );
    const out = new Map<string, MoveRestrictionChange>();
    for (const r of rows) {
      const key = `${r.tenantId}/${r.role}`;
      const e = out.get(key) ?? { nodeId: r.tenantId, role: r.role, permissions: [] };
      e.permissions.push(r.permission);
      out.set(key, e);
    }
    return [...out.values()];
  }

  /** Only restrictions set on nodes the caller may see are listed (no leak of hidden ancestors). */
  private visibleRestrictions(
    reach: TenantReach | undefined,
    list: readonly MoveRestrictionChange[],
  ): MoveRestrictionChange[] {
    return list
      .filter((r) => reach?.kind === 'all' || (reach?.kind === 'nodes' && reach.ids.has(r.nodeId)))
      .slice(0, RESTRICTION_LIST_LIMIT);
  }

  /** Rule 6: leaving a node whose restrictions narrow bindings inside needs the authority to lift them. */
  private async assertMayDrop(
    tx: Db,
    actor: Actor,
    dropped: readonly MoveRestrictionChange[],
    now: Date,
  ): Promise<void> {
    if (dropped.length === 0) return;
    const nodes = await tx
      .select()
      .from(tenants)
      .where(
        inArray(
          tenants.id,
          dropped.map((d) => d.nodeId),
        ),
      );
    for (const n of nodes)
      if (!mayManageRestrictions(actor, n, now))
        throw new HttpError(
          403,
          'restriction_removal_forbidden',
          'moving this tenant out from under a role restriction needs an inheriting administrator binding on the tenant that sets it',
        );
  }

  /**
   * Who gains or loses a permission inside the moved subtree, from the same resolver as every
   * request: for each principal that holds a binding that can matter (anchored in the subtree, or
   * inheriting on a node the move leaves or joins) the permissions at every moved node are
   * resolved on the tree as it is and on the tree as it will be, with all role restrictions of the
   * organisation. Principals the caller may not see are left out (rule 4 of ADR 0014 section 7).
   */
  private async principalChanges(
    tx: Db,
    actor: Actor | undefined,
    q: {
      subtree: readonly TenantRow[];
      from: string;
      to: string;
      watched: readonly string[];
      now: Date;
    },
  ): Promise<{ items: MovePrincipalChange[]; truncated: boolean }> {
    const prefix = subtreePrefix(q.from);
    const inTree = tx.select({ id: tenants.id }).from(tenants).where(like(tenants.path, prefix));
    // (user, node the binding is anchored on) for every binding that can matter.
    const anchored = await Promise.all([
      tx
        .select({ userId: tenantRoleBindings.userId, node: tenantRoleBindings.tenantId })
        .from(tenantRoleBindings)
        .where(inArray(tenantRoleBindings.tenantId, inTree)),
      q.watched.length === 0
        ? Promise.resolve([] as { userId: string; node: string }[])
        : tx
            .select({ userId: tenantRoleBindings.userId, node: tenantRoleBindings.tenantId })
            .from(tenantRoleBindings)
            .where(
              and(
                inArray(tenantRoleBindings.tenantId, [...q.watched]),
                eq(tenantRoleBindings.inherit, true),
              ),
            ),
      tx
        .select({ userId: teamMembers.userId, node: teams.tenantId })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(inArray(teams.tenantId, inTree)),
      tx
        .select({ userId: agentRoleBindings.userId, node: agents.tenantId })
        .from(agentRoleBindings)
        .innerJoin(agents, eq(agents.id, agentRoleBindings.agentId))
        .where(inArray(agents.tenantId, inTree)),
    ]);
    const nodesOf = new Map<string, Set<string>>();
    for (const r of anchored.flat()) {
      const set = nodesOf.get(r.userId) ?? new Set<string>();
      set.add(r.node);
      nodesOf.set(r.userId, set);
    }
    if (nodesOf.size === 0) return { items: [], truncated: false };
    const people = await tx
      .select({
        id: users.id,
        tenantId: users.tenantId,
        platformAdmin: users.platformAdmin,
        disabled: users.disabled,
      })
      .from(users)
      .where(inArray(users.id, [...nodesOf.keys()]))
      .orderBy(asc(users.id));
    // Nodes of the organisation whose users the caller may see (`users:read`), as for every user
    // lookup: a principal is listed only when its home node or one of the bindings above is there.
    let covered: Set<string> | undefined;
    if (actor) {
      const org = await tx
        .select({ id: tenants.id, rootId: tenants.rootId, path: tenants.path })
        .from(tenants)
        .where(eq(tenants.rootId, q.subtree[0]!.rootId));
      covered = new Set(
        org.filter((n) => permissionsAt(actor, n, q.now).has('users:read')).map((n) => n.id),
      );
    }
    // Platform operators are admin everywhere and never change; disabled users hold nothing.
    const candidates = people.filter(
      (u) =>
        !u.platformAdmin &&
        !u.disabled &&
        (covered === undefined ||
          covered.has(u.tenantId) ||
          [...(nodesOf.get(u.id) ?? [])].some((n) => covered.has(n))),
    );
    const truncated = candidates.length > MOVE_REPORT_LIMIT;
    const restrictions: RoleRestriction[] = (
      await tx
        .select({
          tenantId: tenantRoleRestrictions.tenantId,
          role: tenantRoleRestrictions.role,
          permission: tenantRoleRestrictions.permission,
        })
        .from(tenantRoleRestrictions)
        .innerJoin(tenants, eq(tenants.id, tenantRoleRestrictions.tenantId))
        .where(eq(tenants.rootId, q.subtree[0]!.rootId))
    )
      .filter((r) => isRole(r.role))
      .map((r) => ({
        tenantId: r.tenantId,
        role: r.role as RoleRestriction['role'],
        permission: r.permission as Permission,
      }));
    const before = q.subtree.map((n) => asNode(n));
    const after = q.subtree.map((n) => ({
      id: n.id,
      rootId: n.rootId,
      path: rebasePath(n.path, q.from, q.to),
    }));
    const items: MovePrincipalChange[] = [];
    for (const u of candidates.slice(0, MOVE_REPORT_LIMIT)) {
      const loaded = await loadRawGrants(tx, {
        id: u.id,
        tenantId: u.tenantId,
        platformAdmin: false,
      });
      if (!loaded) continue;
      // The restrictions of the whole organisation replace the ones the loader picked for the old
      // placement; the resolver ignores those off the chain of the node it resolves.
      const raw = { ...loaded.raw, restrictions: undefined };
      const opts = { now: q.now, restrictions, implicitPlatformAdmin: false };
      const gainedPerms = new Set<Permission>();
      const lostPerms = new Set<Permission>();
      let gainedNodes = 0;
      let lostNodes = 0;
      for (let i = 0; i < before.length; i++) {
        const was = new Set(appliedAt(raw, before[i]!, opts).flatMap((b) => b.permissions));
        const will = new Set(appliedAt(raw, after[i]!, opts).flatMap((b) => b.permissions));
        let gain = false;
        let loss = false;
        for (const perm of will)
          if (!was.has(perm)) {
            gainedPerms.add(perm);
            gain = true;
          }
        for (const perm of was)
          if (!will.has(perm)) {
            lostPerms.add(perm);
            loss = true;
          }
        if (gain) gainedNodes++;
        if (loss) lostNodes++;
      }
      if (gainedNodes === 0 && lostNodes === 0) continue;
      items.push({
        userId: u.id,
        gainedNodes,
        lostNodes,
        permissionsGained: [...gainedPerms].sort(),
        permissionsLost: [...lostPerms].sort(),
      });
    }
    return { items, truncated };
  }

  /** Rewrites the placement of the subtree in one statement; the database verifies the result. */
  private async apply(
    tx: Db,
    node: TenantRow,
    newParent: TenantRow,
    newPath: string,
    depthChange: number,
  ): Promise<void> {
    // Declares the move to the guard trigger of migration 0034 (transaction local).
    await tx.execute(sql`select set_config('oax.tenant_move_root', ${node.rootId}, true)`);
    const cut = node.path.length + 1;
    const moved = await tx
      .update(tenants)
      .set({
        path: sql`${newPath}::text || substr(${tenants.path}, ${cut}::int)`,
        depth: sql`${tenants.depth} + ${depthChange}::int`,
        parentId: sql`case when ${tenants.id} = ${node.id}::uuid then ${newParent.id}::uuid else ${tenants.parentId} end`,
        // The attachment named a use case of the old parent (rule 7).
        useCase: sql`case when ${tenants.id} = ${node.id}::uuid then null else ${tenants.useCase} end`,
      })
      .where(like(tenants.path, subtreePrefix(node.path)))
      .returning({ id: tenants.id });
    if (moved.length === 0) throw notFound('tenant');
    // Deferred triggers verify the final placement at commit; run them now so a failure surfaces
    // as an error of this call, before the audit entries are written.
    await tx.execute(sql`set constraints "tenants_tree_verify_trg" immediate`);
  }

  /**
   * `tenant.moved` in the partitions of the node, the old and the new parent (ids and numbers
   * only), and `tenant.detached` where the node left a use case.
   */
  private async auditMove(
    tx: Db,
    p: Principal,
    node: TenantRow,
    oldParent: TenantRow,
    newParent: TenantRow,
    report: MoveReport,
  ): Promise<void> {
    const authority = p.platformAdmin ? ('platform' as const) : ('inheriting_admin' as const);
    const partitions = [...new Set([node.id, oldParent.id, newParent.id])];
    for (const tenantId of partitions)
      await this.audit.append(
        {
          actor: p.userId,
          tenantId,
          action: 'tenant.moved',
          target: node.id,
          payload: {
            nodeId: node.id,
            fromParentId: oldParent.id,
            toParentId: newParent.id,
            nodes: report.nodes,
            depthChange: report.depthChange,
            authority,
          },
        },
        tx,
      );
    if (node.useCase !== null)
      for (const tenantId of [node.id, oldParent.id])
        await this.audit.append(
          {
            actor: p.userId,
            tenantId,
            action: 'tenant.detached',
            target: node.id,
            payload: {
              nodeId: node.id,
              parentId: oldParent.id,
              useCase: node.useCase,
              reason: 'moved',
              authority,
            },
          },
          tx,
        );
  }
}
