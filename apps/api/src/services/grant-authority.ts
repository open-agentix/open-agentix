import {
  ROLE_PERMISSIONS,
  appliedAt,
  isRole,
  pathIds,
  type Permission,
  type Principal,
  type RawGrants,
  type Role,
  type RoleNode,
} from '@openagentix/core';
import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  agentRoleBindings,
  agents,
  teamMembers,
  teams,
  tenantRoleBindings,
  tenants,
  users,
} from '../db/schema.js';
import { HttpError, forbidden, notFound } from '../errors.js';
import { loadRawGrants } from './role-bindings.js';

/**
 * What a principal may do to the tenant tree, decided from grants read inside the transaction
 * (never from the cached principal) with the same resolver the request path uses (ADR 0014
 * section 7). Shared by the role-binding API, tenant creation and rename, and the access
 * explanation, so there is exactly one implementation of "what does P hold at node N".
 */

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** What the grantor holds, read inside the transaction. */
export interface Actor {
  userId: string;
  platformAdmin: boolean;
  raw: RawGrants;
  scopes: readonly Permission[] | undefined;
}

export async function loadActor(tx: Db, p: Principal): Promise<Actor> {
  const [u] = await tx.select().from(users).where(eq(users.id, p.userId));
  if (!u || u.disabled) throw forbidden();
  const loaded = await loadRawGrants(tx, {
    id: u.id,
    tenantId: u.tenantId,
    platformAdmin: u.platformAdmin,
  });
  if (!loaded) throw forbidden();
  return { userId: u.id, platformAdmin: u.platformAdmin, raw: loaded.raw, scopes: p.scopes };
}

/** Node-level permissions of the actor at `node` (platform admin: admin; token scopes apply). */
export function permissionsAt(actor: Actor, node: RoleNode, now: Date): Set<Permission> {
  const out = new Set<Permission>();
  for (const b of appliedAt(actor.raw, node, { now })) {
    // Team and agent scoped bindings never give the right to change the tree or its grants.
    if (b.source !== 'direct' && b.source !== 'inherited' && b.source !== 'platform') continue;
    for (const perm of b.permissions) out.add(perm);
  }
  if (actor.scopes) for (const perm of out) if (!actor.scopes.includes(perm)) out.delete(perm);
  return out;
}

/** An unexpired, use-case free binding of the actor that inherits and sits on `node`'s chain. */
function inheritingOnChain(actor: Actor, node: RoleNode, now: Date) {
  const chain = new Set(pathIds(node.path));
  return actor.raw.nodeBindings.filter(
    (b) =>
      b.inherit &&
      b.useCase === null &&
      isRole(b.role) &&
      chain.has(b.tenantId) &&
      (b.expiresAt === null || b.expiresAt.getTime() > now.getTime()),
  );
}

/**
 * Whether the actor's inheriting bindings on `node` or an ancestor together cover everything
 * `role` gives (ADR 0014 rule 2: a grant that inherits is a grant on the whole subtree).
 */
export function coversSubtree(actor: Actor, node: RoleNode, role: Role, now: Date): boolean {
  if (actor.platformAdmin) return true;
  const have = new Set<Permission>();
  for (const b of inheritingOnChain(actor, node, now))
    for (const perm of ROLE_PERMISSIONS[b.role]) have.add(perm);
  return ROLE_PERMISSIONS[role].every((perm) => have.has(perm));
}

/**
 * A "tenant admin" in the sense of ADR 0014 section 4.2: an `admin` binding without use case that
 * inherits and sits on `node` or an ancestor. The condition for creating a child of `node`
 * (the creator must administer what they create).
 */
export function isInheritingAdminAt(actor: Actor, node: RoleNode, now: Date): boolean {
  if (actor.platformAdmin) return true;
  if (actor.scopes && !actor.scopes.includes('settings:write')) return false;
  return inheritingOnChain(actor, node, now).some((b) => b.role === 'admin');
}

/**
 * Rule 4 of ADR 0014 section 7: the user must be visible to the actor, otherwise `404 user`, the
 * same answer and the same queries as for an id that does not exist. Visible = the user's home
 * node is in the actor's `users:read` coverage, or the user already holds a binding (node, team
 * or agent) inside it. Platform admins see every user.
 */
export async function visibleUser(
  tx: Db,
  actor: Actor,
  node: { rootId: string },
  userId: string,
  now: Date,
): Promise<typeof users.$inferSelect> {
  const [u] = await tx.select().from(users).where(eq(users.id, userId));
  if (actor.platformAdmin) {
    if (!u) throw notFound('user');
    return u;
  }
  const nodes = await tx
    .select({ id: tenants.id, rootId: tenants.rootId, path: tenants.path })
    .from(tenants)
    .where(eq(tenants.rootId, node.rootId));
  const covered = nodes
    .filter((n) => permissionsAt(actor, n, now).has('users:read'))
    .map((n) => n.id);
  const probe = u?.id ?? NIL_UUID;
  const hit = async (q: PromiseLike<{ n: number }[]>) => Number((await q)[0]?.n ?? 0) > 0;
  const none = covered.length === 0;
  const ids = none ? [NIL_UUID] : covered;
  const visible =
    (await hit(
      tx
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.id, probe), inArray(users.tenantId, ids))),
    )) ||
    (await hit(
      tx
        .select({ n: count() })
        .from(tenantRoleBindings)
        .where(
          and(eq(tenantRoleBindings.userId, probe), inArray(tenantRoleBindings.tenantId, ids)),
        ),
    )) ||
    (await hit(
      tx
        .select({ n: count() })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(and(eq(teamMembers.userId, probe), inArray(teams.tenantId, ids))),
    )) ||
    (await hit(
      tx
        .select({ n: count() })
        .from(agentRoleBindings)
        .innerJoin(agents, eq(agents.id, agentRoleBindings.agentId))
        .where(and(eq(agentRoleBindings.userId, probe), inArray(agents.tenantId, ids))),
    ));
  if (!u || none || !visible) throw notFound('user');
  return u;
}

type BindingRow = typeof tenantRoleBindings.$inferSelect;

/**
 * Rule 8 of ADR 0014 section 7: would this change leave the organisation root without an
 * inheriting, unexpiring `admin`? `after` is the state of the binding afterwards (`null`: gone).
 * Platform operators are exempt; only roots are protected. Callers hold the binding lock.
 */
export async function assertNotLastAdmin(
  tx: Db,
  actor: Actor,
  node: { id: string; parentId: string | null },
  before: BindingRow,
  after: { role: string; inherit: boolean; expiresAt: Date | null } | null,
  /** The whole user goes away (disabled): none of their other bindings count as a co-admin. */
  userLeaves = false,
): Promise<void> {
  if (actor.platformAdmin || node.parentId !== null) return;
  const counts = (b: { role: string; inherit: boolean; expiresAt: Date | null }) =>
    b.role === 'admin' && b.inherit && b.expiresAt === null;
  if (before.useCase !== null || !counts(before) || (after && counts(after))) return;
  const [others] = await tx
    .select({ n: count() })
    .from(tenantRoleBindings)
    .innerJoin(users, eq(users.id, tenantRoleBindings.userId))
    .where(
      and(
        eq(tenantRoleBindings.tenantId, node.id),
        eq(tenantRoleBindings.role, 'admin'),
        isNull(tenantRoleBindings.useCase),
        eq(tenantRoleBindings.inherit, true),
        // Same shape as `counts`: a co-admin whose binding expires does not keep the organisation
        // administered (it would be left without one at that second).
        isNull(tenantRoleBindings.expiresAt),
        eq(users.disabled, false),
        ne(tenantRoleBindings.id, before.id),
        userLeaves ? ne(tenantRoleBindings.userId, before.userId) : undefined,
      ),
    );
  if (Number(others?.n ?? 0) === 0)
    throw new HttpError(
      409,
      'last_admin',
      'this is the last inheriting administrator of the organisation',
    );
}

/** What is being done to another user's account (ADR 0014 S5, user lifecycle across the tree). */
export type UserChange =
  | { kind: 'disable' }
  | { kind: 'roles'; wanted: readonly Role[] }
  | { kind: 'profile' }
  | { kind: 'tokens' };

/**
 * Why `actor` may not manage `targetId`'s account, or `null`. A user is managed through the node
 * they live on, but their grants can sit on other nodes, above the manager: whoever manages them
 * must hold `users:write` on **every** node they are bound on (and cover its subtree when the
 * binding inherits), so a subordinate administrator can never lock out or demote a superior.
 * Platform operator accounts are managed by operators only. Operators are exempt.
 */
export async function userManagementViolation(
  tx: Db,
  actor: Actor,
  target: { id: string; platformAdmin: boolean },
  now: Date,
): Promise<string | null> {
  if (actor.platformAdmin || target.id === actor.userId) return null;
  if (target.platformAdmin) return 'platform operator accounts are managed by operators';
  const rows = await tx
    .select({ b: tenantRoleBindings, node: tenants })
    .from(tenantRoleBindings)
    .innerJoin(tenants, eq(tenants.id, tenantRoleBindings.tenantId))
    .where(eq(tenantRoleBindings.userId, target.id));
  for (const { b, node } of rows) {
    if (b.expiresAt !== null && !(b.expiresAt.getTime() > now.getTime())) continue;
    const perms = permissionsAt(actor, node, now);
    if (!perms.has('users:write')) return 'the user holds a role on a tenant you cannot manage';
    if (!isRole(b.role) || !ROLE_PERMISSIONS[b.role].every((p) => perms.has(p)))
      return 'the user holds a role above your own';
    if (b.inherit && !coversSubtree(actor, node, b.role, now))
      return 'the user holds an inheriting role your bindings do not cover';
  }
  // Team memberships and agent bindings sit on the node that owns the team or agent; they never
  // inherit, but a user who is bound in a node above the manager is not the manager's to change.
  const teamNodes = await tx
    .select({ node: tenants, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(tenants, eq(tenants.id, teams.tenantId))
    .where(eq(teamMembers.userId, target.id));
  const agentNodes = await tx
    .select({ node: tenants, role: agentRoleBindings.role })
    .from(agentRoleBindings)
    .innerJoin(agents, eq(agents.id, agentRoleBindings.agentId))
    .innerJoin(tenants, eq(tenants.id, agents.tenantId))
    .where(eq(agentRoleBindings.userId, target.id));
  for (const { node, role } of [...teamNodes, ...agentNodes]) {
    const perms = permissionsAt(actor, node, now);
    if (!perms.has('users:write')) return 'the user is bound in a tenant you cannot manage';
    if (!isRole(role) || !ROLE_PERMISSIONS[role].every((p) => perms.has(p)))
      return 'the user holds a role above your own';
  }
  return null;
}

/**
 * The write-side guard for disabling a user, changing their global roles and revoking their API
 * tokens: {@link userManagementViolation} (`403`) plus the last-admin rule (`409`) for the changes
 * that can remove an inheriting root administrator. The caller holds the tree lock (shared) and the
 * binding lock and passes the transaction. No-op for operators and for the user themselves
 * (except that leaving as the last admin is still refused).
 */
export async function assertMayChangeUser(
  tx: Db,
  actor: Actor,
  target: { id: string; platformAdmin: boolean },
  change: UserChange,
  now: Date,
): Promise<void> {
  const why = await userManagementViolation(tx, actor, target, now);
  if (why !== null) throw forbidden(why);
  if (actor.platformAdmin || change.kind === 'tokens' || change.kind === 'profile') return;
  const rows = await tx
    .select({ b: tenantRoleBindings, node: tenants })
    .from(tenantRoleBindings)
    .innerJoin(tenants, eq(tenants.id, tenantRoleBindings.tenantId))
    .where(eq(tenantRoleBindings.userId, target.id));
  for (const { b, node } of rows) {
    // Roles: only the mirror rows follow `global_roles`; explicit grants are not touched by it.
    const removed =
      change.kind === 'disable' ||
      (b.source === 'mirror' && b.tenantId === node.id && !change.wanted.includes(b.role as Role));
    if (removed) await assertNotLastAdmin(tx, actor, node, b, null, change.kind === 'disable');
  }
}
