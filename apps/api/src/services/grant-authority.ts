import {
  ROLE_PERMISSIONS,
  USE_CASE_PERMISSIONS,
  appliedAt,
  isRole,
  pathIds,
  useCaseCovers,
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

/**
 * Node-level permissions of the actor at `node` (platform admin: admin; token scopes apply).
 * Bindings limited to a use case never count here: they are not node-level, and a use-case
 * administrator's authority over grants is {@link useCaseGrantAuthority}. Bindings that reach a node
 * only through an attached child (`source: attached`) do not give the right to change the tree or
 * its grants either.
 */
export function permissionsAt(actor: Actor, node: RoleNode, now: Date): Set<Permission> {
  const out = new Set<Permission>();
  for (const b of appliedAt(actor.raw, node, { now })) {
    // Team, agent and use-case scoped bindings never give the right to change the tree or its grants.
    if (b.source !== 'direct' && b.source !== 'inherited' && b.source !== 'platform') continue;
    if (b.useCase !== null) continue;
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
 * A "tenant admin" at `node` in the sense of ADR 0014 section 7, rule 7: an unexpired `admin`
 * binding without use case that applies at the node (bound there, or on an ancestor with
 * `inherit`), or a platform admin. Team and agent bindings and use-case admins never count, and
 * neither does a token whose scopes lack `users:write`.
 */
export function isTenantAdminAt(actor: Actor, node: RoleNode, now: Date): boolean {
  if (actor.scopes && !actor.scopes.includes('users:write')) return false;
  if (actor.platformAdmin) return true;
  return appliedAt(actor.raw, node, { now, implicitPlatformAdmin: false }).some(
    (b) =>
      b.role === 'admin' &&
      b.useCase === null &&
      (b.source === 'direct' || b.source === 'inherited'),
  );
}

/**
 * Whether the actor's authority covers the whole subtree of `node` as a tenant administrator: an
 * unexpired `admin` binding without use case that inherits and sits on `node` or an ancestor, or a
 * platform admin (a token needs the `users:write` scope). This is the authority to change
 * **role restrictions** at `node` (ADR 0014 section 5): a restriction narrows the bindings of every
 * node below, so the writer must administer all of them, exactly like an inheriting grant. A
 * non-inheriting administrator of the node, a use-case administrator, an administrator reached
 * only through an attached node and a team or agent admin do not qualify.
 */
export function mayManageRestrictions(actor: Actor, node: RoleNode, now: Date): boolean {
  if (actor.scopes && !actor.scopes.includes('users:write')) return false;
  if (actor.platformAdmin) return true;
  return inheritingOnChain(actor, node, now).some((b) => b.role === 'admin');
}

/** One use case an actor may grant roles for (ADR 0014 section 7, rule 3). */
export interface UseCaseGrantAuthority {
  useCase: string;
  role: Role;
  /** The binding itself inherits (it also covers the nodes attached to the use case). */
  inherit: boolean;
  /** The permissions the binding gives (the role's, limited to the use-case permissions). */
  permissions: ReadonlySet<Permission>;
}

/**
 * The use cases the actor administers **at `node`**: the actor's own use-case bindings bound on
 * the node (not inherited ones: a use-case binding applies at its node only) that carry
 * `users:write`, and a token that is allowed to use it. Rule 3: a use-case administrator grants
 * roles for the own use case and its sub-use cases on that node, nothing else; tenant
 * administrators are not in this list (they have {@link permissionsAt}).
 */
export function useCaseGrantAuthority(
  actor: Actor,
  node: RoleNode,
  now: Date,
  /** `users:write` to grant, change or revoke; `users:read` to list the bindings of the use case. */
  permission: 'users:read' | 'users:write' = 'users:write',
): UseCaseGrantAuthority[] {
  if (actor.platformAdmin) return [];
  if (actor.scopes && !actor.scopes.includes(permission)) return [];
  const out: UseCaseGrantAuthority[] = [];
  for (const b of appliedAt(actor.raw, node, { now, implicitPlatformAdmin: false })) {
    if (b.useCase === null || b.source !== 'direct' || b.tenantId !== node.id) continue;
    if (!b.permissions.includes(permission)) continue;
    const permissions = new Set<Permission>(
      b.permissions.filter((p) => USE_CASE_PERMISSIONS.includes(p)),
    );
    if (actor.scopes)
      for (const perm of permissions) if (!actor.scopes.includes(perm)) permissions.delete(perm);
    out.push({ useCase: b.useCase, role: b.role, inherit: b.inherit, permissions });
  }
  return out;
}

/**
 * Whether a use-case administrator may hold `role` for `useCase` at the node (rules 1 to 3 for a
 * grant limited to a use case): some own use-case binding covers `useCase` (the same use case or a
 * sub-use case), gives every permission the grantee's binding would carry (the role's, limited to
 * the use-case permissions), and, for an inheriting grant, itself inherits. `pentest` never has a
 * use case.
 */
export function mayGrantInUseCase(
  authority: readonly UseCaseGrantAuthority[],
  useCase: string,
  role: Role,
  inherit: boolean,
): { ok: true } | { ok: false; code: 'grant_exceeds_own' | 'inheritance_required' } {
  if (role === 'pentest') return { ok: false, code: 'grant_exceeds_own' };
  const wanted = ROLE_PERMISSIONS[role].filter((p) => USE_CASE_PERMISSIONS.includes(p));
  const covering = authority.filter((a) => useCaseCovers(a.useCase, useCase));
  const sufficient = covering.filter((a) => wanted.every((p) => a.permissions.has(p)));
  if (sufficient.length === 0) return { ok: false, code: 'grant_exceeds_own' };
  // An inheriting grant also reaches the nodes attached to the use case, where the grantee holds the
  // whole role: the grantor's own binding must inherit and be at least as strong there.
  if (
    inherit &&
    !sufficient.some(
      (a) => a.inherit && ROLE_PERMISSIONS[role].every((p) => ROLE_PERMISSIONS[a.role].includes(p)),
    )
  )
    return { ok: false, code: 'inheritance_required' };
  return { ok: true };
}

/**
 * Rule 7 of ADR 0014 section 7: who may grant `pentest`, and for how long. Only a tenant admin of
 * the node (no use case) or above, or a platform admin (`403 pentest_grant_forbidden`); `expiresAt`
 * is required (`422 expiry_required`) and at most `maxDays` from now (`422 expiry_too_long`, the
 * boundary itself is allowed). A longer period is a new grant, never a longer update.
 */
export function assertPentestGrant(
  actor: Actor,
  node: RoleNode,
  expiresAt: Date | null | undefined,
  now: Date,
  maxDays: number,
): void {
  if (!isTenantAdminAt(actor, node, now))
    throw new HttpError(
      403,
      'pentest_grant_forbidden',
      'only a tenant administrator of this tenant or above, or a platform operator, may grant pentest',
    );
  if (expiresAt === null || expiresAt === undefined)
    throw new HttpError(422, 'expiry_required', 'a pentest binding needs an expiry (expiresAt)');
  if (!(expiresAt.getTime() > now.getTime()))
    throw new HttpError(422, 'validation_failed', 'expiresAt must be in the future');
  if (expiresAt.getTime() > now.getTime() + maxDays * 86_400_000)
    throw new HttpError(
      422,
      'expiry_too_long',
      `a pentest binding may last at most ${maxDays} days`,
    );
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
  /**
   * Nodes whose users the actor may see although it holds no node-level `users:read` there: the
   * node of a use-case administrator's own binding (slice S8, rule 3). Nothing else is added.
   */
  alsoCovered: readonly string[] = [],
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
    .filter((n) => permissionsAt(actor, n, now).has('users:read') || alsoCovered.includes(n.id))
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
