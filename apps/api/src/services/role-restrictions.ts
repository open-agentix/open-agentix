import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  isRole,
  type Permission,
  type Principal,
  type Role,
} from '@openagentix/core';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { tenantRoleRestrictions, tenants } from '../db/schema.js';
import { HttpError, forbidden, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import {
  isTenantAdminAt,
  loadActor,
  mayManageRestrictions,
  permissionsAt,
  type Actor,
} from './grant-authority.js';
import type { TenantRow } from './identity.js';
import { TenantAccess } from './tenant-access.js';
import { lockBindings, lockTreeShared } from './tree-lock.js';

/**
 * Role restrictions (ADR 0014 section 5, slice S9): permissions removed from a role for the
 * bindings at a node and below. This module only stores and audits them; the effect is the
 * resolver's (`appliedAt` in `@openagentix/core`), which reads them with the principal's grants, so
 * there is exactly one implementation of "what does a restriction do".
 *
 * Who may write: an inheriting tenant administrator of the node or an ancestor, or a platform
 * operator ({@link mayManageRestrictions}). A restriction narrows every binding of the role in the
 * whole subtree, so the writer must administer the whole subtree. Never a use-case administrator,
 * never an administrator reached through an attached node, never a team or agent role, never a
 * non-inheriting administrator of the node; the restricted role cannot lift its own restriction
 * because `admin`, the only role with `users:write`, cannot be restricted.
 *
 * Every write runs in one transaction that takes the tree lock (shared) and the binding lock of the
 * organisation, in the order the grant paths use, then re-reads the writer's grants from the
 * database. The authz epoch of the organisation is bumped by the trigger of migration 0033, in the
 * same transaction, so cached principals are rebuilt on their next request.
 */

export interface RestrictionView {
  role: Role;
  /** In the order of the permission list. */
  permissions: Permission[];
  /** The latest change to the role's restrictions at this node; null when there are none. */
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface RestrictionList {
  items: RestrictionView[];
  /**
   * False while `OAX_ROLE_BINDINGS_READ=legacy`: the stored restrictions are not applied by the
   * legacy read path, and cannot be changed there.
   */
  enforced: boolean;
}

const PERMISSION_ORDER = new Map<string, number>(PERMISSIONS.map((p, i) => [p, i]));
const byPermission = (a: string, b: string) =>
  (PERMISSION_ORDER.get(a) ?? 0) - (PERMISSION_ORDER.get(b) ?? 0);

const isPermission = (v: string): v is Permission => PERMISSION_ORDER.has(v);

export class RoleRestrictionsService {
  private readonly access: TenantAccess;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {
    this.access = new TenantAccess(ctx);
  }

  /** The node, if the principal may see it; unknown and invisible nodes are the same 404. */
  private async visibleNode(p: Principal, id: string): Promise<TenantRow> {
    const [row] = await this.ctx.db.select().from(tenants).where(eq(tenants.id, id));
    if (!row || !TenantAccess.allows(await this.access.reach(p), row)) throw notFound('tenant');
    return row;
  }

  private get enforced(): boolean {
    return this.ctx.config.auth.roleBindingsRead === 'bindings';
  }

  /** Restrictions only take effect on the resolver read path; elsewhere a write would do nothing. */
  private assertEnforced(): void {
    if (!this.enforced)
      throw new HttpError(
        409,
        'role_restrictions_require_bindings_read',
        'role restrictions need OAX_ROLE_BINDINGS_READ=bindings; with the legacy read path they would have no effect',
      );
  }

  /** The write authority; see the class comment. */
  private assertMayWrite(actor: Actor, node: TenantRow): void {
    const now = this.ctx.now();
    if (!isTenantAdminAt(actor, node, now)) throw forbidden();
    if (!mayManageRestrictions(actor, node, now))
      throw new HttpError(
        403,
        'inheritance_required',
        'changing role restrictions needs an inheriting administrator binding on this tenant or an ancestor',
      );
  }

  /** A role a restriction can name: any role but `admin`, which is never restricted. */
  private parseRole(role: string): Role {
    if (role === 'admin')
      throw new HttpError(
        422,
        'restriction_on_admin',
        'the admin role cannot be restricted (a tenant must not be able to lock out its own administrators)',
      );
    if (!isRole(role)) throw new HttpError(422, 'unknown_role', `unknown role ${role}`);
    return role;
  }

  private parsePermission(role: Role, permission: string): Permission {
    if (!isPermission(permission))
      throw new HttpError(422, 'unknown_permission', `unknown permission ${permission}`);
    if (!ROLE_PERMISSIONS[role].includes(permission))
      throw new HttpError(
        422,
        'permission_not_in_role',
        `role ${role} does not hold ${permission}, so there is nothing to restrict`,
      );
    return permission;
  }

  private async lock(tx: Db, rootId: string): Promise<void> {
    await lockTreeShared(tx, rootId);
    await lockBindings(tx, rootId);
  }

  // ------------------------------------------------------------------ read

  /** `users:read` on the node (rule 1 for reads); the restrictions set on this node itself. */
  async list(p: Principal, tenantId: string): Promise<RestrictionList> {
    const node = await this.visibleNode(p, tenantId);
    const actor = await loadActor(this.ctx.db, p);
    if (!permissionsAt(actor, node, this.ctx.now()).has('users:read')) throw forbidden();
    return { items: await this.views(this.ctx.db, node.id), enforced: this.enforced };
  }

  private async views(db: Db, tenantId: string, role?: Role): Promise<RestrictionView[]> {
    const rows = await db
      .select()
      .from(tenantRoleRestrictions)
      .where(
        and(
          eq(tenantRoleRestrictions.tenantId, tenantId),
          role ? eq(tenantRoleRestrictions.role, role) : undefined,
        ),
      )
      .orderBy(asc(tenantRoleRestrictions.role), asc(tenantRoleRestrictions.permission));
    const byRole = new Map<string, RestrictionView>();
    for (const r of rows) {
      if (!isRole(r.role) || !isPermission(r.permission)) continue;
      const v = byRole.get(r.role) ?? {
        role: r.role,
        permissions: [],
        updatedAt: r.createdAt,
        updatedBy: r.createdBy,
      };
      v.permissions.push(r.permission);
      if (v.updatedAt === null || r.createdAt.getTime() >= v.updatedAt.getTime()) {
        v.updatedAt = r.createdAt;
        v.updatedBy = r.createdBy;
      }
      byRole.set(r.role, v);
    }
    return [...byRole.values()].map((v) => ({
      ...v,
      permissions: v.permissions.sort(byPermission),
    }));
  }

  // ------------------------------------------------------------------ writes

  /**
   * `PUT`: makes the restrictions of `role` at the node exactly `permissions` (an empty list
   * removes them all). Idempotent: the same call twice changes, audits and bumps nothing the second
   * time.
   */
  async set(
    p: Principal,
    tenantId: string,
    input: { role: string; permissions: readonly string[] },
  ): Promise<RestrictionView> {
    const node = await this.visibleNode(p, tenantId);
    const max = this.ctx.config.tenancy.maxRoleRestrictionsPerNode;
    return this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await this.lock(tx, node.rootId);
      const actor = await loadActor(tx, p);
      this.assertMayWrite(actor, node);
      this.assertEnforced();
      const role = this.parseRole(input.role);
      const wanted = [...new Set(input.permissions.map((x) => this.parsePermission(role, x)))];
      const current = await tx
        .select({ permission: tenantRoleRestrictions.permission })
        .from(tenantRoleRestrictions)
        .where(
          and(eq(tenantRoleRestrictions.tenantId, node.id), eq(tenantRoleRestrictions.role, role)),
        );
      const have = new Set(current.map((r) => r.permission));
      const add = wanted.filter((x) => !have.has(x));
      const remove = [...have].filter((x) => !wanted.includes(x as Permission));
      if (add.length > 0) {
        const [total] = await tx
          .select({ n: count() })
          .from(tenantRoleRestrictions)
          .where(eq(tenantRoleRestrictions.tenantId, node.id));
        if (Number(total?.n ?? 0) - remove.length + add.length > max)
          throw new HttpError(
            422,
            'restriction_limit_exceeded',
            `a tenant can carry at most ${max} role restrictions`,
          );
        await tx.insert(tenantRoleRestrictions).values(
          add.map((permission) => ({
            tenantId: node.id,
            role,
            permission,
            createdBy: actor.userId,
          })),
        );
      }
      if (remove.length > 0)
        await tx
          .delete(tenantRoleRestrictions)
          .where(
            and(
              eq(tenantRoleRestrictions.tenantId, node.id),
              eq(tenantRoleRestrictions.role, role),
              inArray(tenantRoleRestrictions.permission, remove),
            ),
          );
      if (add.length > 0) await this.record(tx, actor, node, 'tenant.role_restricted', role, add);
      if (remove.length > 0)
        await this.record(
          tx,
          actor,
          node,
          'tenant.role_restriction_removed',
          role,
          remove.filter((x): x is Permission => isPermission(x)),
        );
      return (
        (await this.views(tx, node.id, role))[0] ?? {
          role,
          permissions: [],
          updatedAt: null,
          updatedBy: null,
        }
      );
    });
  }

  /**
   * `DELETE`: removes the restrictions of `role` at the node, or only the one of `permission`.
   * Idempotent: nothing to remove is not an error and writes nothing.
   */
  async remove(
    p: Principal,
    tenantId: string,
    input: { role: string; permission?: string | undefined },
  ): Promise<void> {
    const node = await this.visibleNode(p, tenantId);
    await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await this.lock(tx, node.rootId);
      const actor = await loadActor(tx, p);
      this.assertMayWrite(actor, node);
      this.assertEnforced();
      const role = this.parseRole(input.role);
      // A permission that is no permission is refused; one the role does not hold is simply absent.
      if (input.permission !== undefined && !isPermission(input.permission))
        throw new HttpError(422, 'unknown_permission', `unknown permission ${input.permission}`);
      const deleted = await tx
        .delete(tenantRoleRestrictions)
        .where(
          and(
            eq(tenantRoleRestrictions.tenantId, node.id),
            eq(tenantRoleRestrictions.role, role),
            input.permission === undefined
              ? undefined
              : eq(tenantRoleRestrictions.permission, input.permission),
          ),
        )
        .returning({ permission: tenantRoleRestrictions.permission });
      if (deleted.length === 0) return;
      await this.record(
        tx,
        actor,
        node,
        'tenant.role_restriction_removed',
        role,
        deleted.map((r) => r.permission).filter(isPermission),
      );
    });
  }

  /** Audit entry in the partition of the restricted node: names only, `role` and `permissions`. */
  private async record(
    tx: Db,
    actor: Actor,
    node: TenantRow,
    action: 'tenant.role_restricted' | 'tenant.role_restriction_removed',
    role: Role,
    permissions: readonly Permission[],
  ): Promise<void> {
    await this.audit.append(
      {
        actor: actor.userId,
        tenantId: node.id,
        action,
        target: node.id,
        payload: { role, permissions: [...permissions].sort(byPermission) },
      },
      tx,
    );
  }
}
