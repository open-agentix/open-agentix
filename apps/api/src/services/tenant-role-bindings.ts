import { randomUUID } from 'node:crypto';
import {
  BINDING_ROLES as ALL_BINDING_ROLES,
  ROLE_PERMISSIONS,
  isValidUseCase,
  useCaseCovers,
  type Permission,
  type GrantableRole,
  type Principal,
  type Role,
  type RoleNode,
} from '@openagentix/core';
import { and, asc, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { tenantRoleBindings, tenants, users } from '../db/schema.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { useCaseMatch } from './use-case-scope.js';
import { decodeTimeCursor, encodeTimeCursor } from '../pagination.js';
import type { AuditService } from './audit.js';
import type { IdentityService, TenantRow } from './identity.js';
import { lockBindings, lockTreeShared } from './tree-lock.js';
import {
  assertNotLastAdmin,
  assertPentestGrant,
  coversSubtree,
  isTenantAdminAt,
  loadActor,
  mayGrantInUseCase,
  permissionsAt,
  useCaseGrantAuthority,
  visibleUser,
  type Actor,
  type UseCaseGrantAuthority,
} from './grant-authority.js';
import { PENTEST_WARNING_MS, type PentestService } from './pentest.js';
import { TenantAccess } from './tenant-access.js';
import { TenantTree } from './tenant-tree.js';

/**
 * The role-binding API (ADR 0014 section 4.2, 7 and 10, slice S4): who may give which user which
 * role on which node, and the audit trail of it.
 *
 * Every write runs in one transaction that takes the tree lock of the organisation in shared mode
 * (a grant never races a node creation or move, section 6.2) and a per-organisation exclusive
 * binding lock (binding writes of one organisation are serialised, so the grantor's coverage and
 * the last-admin check are read after every earlier write committed), then **re-reads the grantor's
 * grants from the database** (never from the cached principal) and evaluates the nine grant rules
 * with the same resolver the request path uses. Epoch bumps come from the triggers
 * of migration 0021; cached principals of the grantee are dropped after the commit.
 *
 * Node-level authority only: team and agent scoped bindings never give the right to grant.
 */

const LIST_NODE_CAP = 50;
/**
 * `created_at` as the API sees it. The database keeps microseconds, a JavaScript date (and so the
 * cursor) only milliseconds: ordering and paging on the truncated value keeps a page boundary from
 * returning the same row twice.
 */
const createdMs = sql`date_trunc('milliseconds', ${tenantRoleBindings.createdAt})`;
const LIST_ITEM_CAP = 500;

export type BindingSource = 'mirror' | 'grant';

export interface BindingView {
  id: string;
  tenantId: string;
  role: string;
  useCase: string | null;
  inherit: boolean;
  expiresAt: Date | null;
  source: BindingSource;
  grantedBy: string | null;
  createdAt: Date;
  user: { id: string; email: string; displayName: string };
}

export interface BindingInput {
  userId: string;
  role: Role;
  inherit: boolean;
  expiresAt?: Date | null | undefined;
  useCase?: string | null | undefined;
}

export interface BindingPatch {
  role?: Role | undefined;
  inherit?: boolean | undefined;
  expiresAt?: Date | null | undefined;
}

export interface InheritancePreview {
  dryRun: boolean;
  roles: GrantableRole[];
  bindings: number;
  users: number;
  truncated: boolean;
  items: {
    bindingId: string;
    role: string;
    source: BindingSource;
    user: { id: string; email: string; displayName: string };
    tenant: { id: string; slug: string; slugPath: string; name: string };
    nodeCount: number;
    nodes: { id: string; slug: string; slugPath: string; name: string }[];
  }[];
}

type Row = typeof tenantRoleBindings.$inferSelect;

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.cause?.code ?? err.code;
}

const deny = (code: string, message: string) => new HttpError(403, code, message);

export class TenantRoleBindingsService {
  private readonly access: TenantAccess;
  private readonly tree: TenantTree;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
    private readonly pentest: PentestService,
  ) {
    this.access = new TenantAccess(ctx);
    this.tree = new TenantTree(ctx);
  }

  // ------------------------------------------------------------------ helpers

  /** The node, if the principal may see it; unknown and invisible nodes are the same 404. */
  private async visibleNode(p: Principal, id: string): Promise<TenantRow> {
    const [row] = await this.ctx.db.select().from(tenants).where(eq(tenants.id, id));
    if (!row || !TenantAccess.allows(await this.access.reach(p), row)) throw notFound('tenant');
    return row;
  }

  private async lock(tx: Db, rootId: string): Promise<void> {
    await lockTreeShared(tx, rootId);
    await lockBindings(tx, rootId);
  }

  private permissionsAt(actor: Actor, node: RoleNode): Set<Permission> {
    return permissionsAt(actor, node, this.ctx.now());
  }

  /** Rules 1 and 2 for one tuple: nothing above the grantor's own authority, coverage for `inherit`. */
  private assertMayHold(
    actor: Actor,
    perms: ReadonlySet<Permission>,
    node: RoleNode,
    role: Role,
    inherit: boolean,
  ): void {
    if (!ROLE_PERMISSIONS[role].every((perm) => perms.has(perm)))
      throw deny('grant_exceeds_own', `role ${role} gives more than the permissions you hold here`);
    if (inherit && !coversSubtree(actor, node, role, this.ctx.now()))
      throw deny(
        'inheritance_required',
        'an inheriting binding needs an inheriting binding of at least the same role on this ' +
          'tenant or an ancestor',
      );
  }

  /** `pentest` only takes effect on the resolver read path; elsewhere a grant would do nothing. */
  private assertPentestReadable(): void {
    if (this.ctx.config.auth.roleBindingsRead !== 'bindings')
      throw new HttpError(
        409,
        'pentest_requires_bindings_read',
        'pentest needs OAX_ROLE_BINDINGS_READ=bindings; with the legacy read path it would have no effect',
      );
  }

  /** Whether a binding's use case is one a use-case administrator administers. */
  private inScope(useCases: readonly UseCaseGrantAuthority[], useCase: string | null): boolean {
    return useCase !== null && useCases.some((a) => useCaseCovers(a.useCase, useCase));
  }

  /** A use-case binding only takes effect on the resolver read path; elsewhere it would do nothing. */
  private assertUseCaseReadable(): void {
    if (this.ctx.config.auth.roleBindingsRead !== 'bindings')
      throw new HttpError(
        409,
        'use_case_requires_bindings_read',
        'use-case bindings need OAX_ROLE_BINDINGS_READ=bindings; with the legacy read path they would have no effect',
      );
  }

  /**
   * What the actor holds at the node for `permission` (`users:read` or `users:write`): the
   * node-level permission (tenant administrators, directly or inherited), or, failing that, the
   * use cases it administers through its own use-case bindings on the node (rule 3).
   */
  private authority(
    actor: Actor,
    node: RoleNode,
    permission: 'users:read' | 'users:write',
  ): { nodeWide: boolean; perms: Set<Permission>; useCases: UseCaseGrantAuthority[] } {
    const perms = this.permissionsAt(actor, node);
    const nodeWide = perms.has(permission);
    return {
      nodeWide,
      perms,
      useCases: nodeWide ? [] : useCaseGrantAuthority(actor, node, this.ctx.now(), permission),
    };
  }

  /**
   * Rules 1 to 3 for one tuple `(use case, role, inherit)`: a node-level grantor passes the usual
   * checks (nothing above its own permissions, coverage for `inherit`); a use-case administrator
   * only grants for its own use case and its sub-use cases (never node-wide, never `pentest`), and
   * an inheriting grant needs its own binding to inherit.
   */
  private assertAuthority(
    actor: Actor,
    auth: { nodeWide: boolean; perms: Set<Permission>; useCases: UseCaseGrantAuthority[] },
    node: RoleNode,
    tuple: { useCase: string | null; role: Role; inherit: boolean },
  ): void {
    if (auth.nodeWide) {
      this.assertMayHold(actor, auth.perms, node, tuple.role, tuple.inherit);
      return;
    }
    if (tuple.useCase === null)
      throw deny(
        'grant_exceeds_own',
        'a use-case administrator grants roles for the own use case only',
      );
    const r = mayGrantInUseCase(auth.useCases, tuple.useCase, tuple.role, tuple.inherit);
    if (!r.ok)
      throw deny(
        r.code,
        r.code === 'inheritance_required'
          ? 'an inheriting binding needs an inheriting binding of your own for this use case'
          : `role ${tuple.role} for use case ${tuple.useCase} gives more than the permissions you hold here`,
      );
  }

  /** The notice, audit-free (the grant is already audited): who is told about a new pentest grant. */
  private async noticeGranted(
    tx: Db,
    node: TenantRow,
    b: { id: string; userId: string; inherit: boolean; expiresAt: Date | null },
    grantedBy: string,
    reason: 'granted' | 'changed',
  ): Promise<void> {
    await this.pentest.notify(
      tx,
      node,
      'pentest_granted',
      {
        bindingId: b.id,
        userId: b.userId,
        role: 'pentest',
        inherit: b.inherit,
        expiresAt: b.expiresAt?.toISOString() ?? null,
        grantedBy,
        reason,
      },
      [grantedBy],
    );
  }

  /** Revoking or changing a pentest binding needs the authority to grant it (rule 9 with rule 7). */
  private assertPentestAuthority(actor: Actor, node: RoleNode): void {
    if (!isTenantAdminAt(actor, node, this.ctx.now()))
      throw deny(
        'pentest_grant_forbidden',
        'only a tenant administrator of this tenant or above, or a platform operator, may change pentest',
      );
  }

  private checkExpiry(expiresAt: Date | null | undefined): void {
    if (expiresAt === null || expiresAt === undefined) return;
    if (!(expiresAt.getTime() > this.ctx.now().getTime()))
      throw new HttpError(422, 'validation_failed', 'expiresAt must be in the future');
  }

  /**
   * Rule 4 (and 5): the grantee must be visible to the grantor, otherwise `404 user`, the same
   * answer and the same queries as for an id that does not exist. Visible = the user's home node is
   * in the grantor's `users:read` coverage, or the user already holds a binding (node, team or
   * agent) inside it. Platform admins see every user but still cannot cross organisations.
   */
  private async grantee(
    tx: Db,
    actor: Actor,
    node: TenantRow,
    userId: string,
    alsoCovered: readonly string[] = [],
  ) {
    const u = await visibleUser(tx, actor, node, userId, this.ctx.now(), alsoCovered);
    const [home] = await tx
      .select({ rootId: tenants.rootId })
      .from(tenants)
      .where(eq(tenants.id, u.tenantId));
    if (!home || home.rootId !== node.rootId)
      throw new HttpError(
        422,
        'cross_organisation_grant',
        'a role can only be bound inside the organisation of the user',
      );
    // After the visibility check, so a disabled user is not an oracle for hidden users.
    if (u.disabled)
      throw new HttpError(422, 'grantee_disabled', 'a role cannot be bound to a disabled user');
    return u;
  }

  private async viewOf(tx: Db, id: string): Promise<BindingView> {
    const rows = await this.views(tx, eq(tenantRoleBindings.id, id));
    return rows[0]!;
  }

  private async views(
    db: Db,
    where: ReturnType<typeof and>,
    opts: { limit?: number } = {},
  ): Promise<BindingView[]> {
    const q = db
      .select({
        b: tenantRoleBindings,
        email: users.email,
        displayName: users.displayName,
      })
      .from(tenantRoleBindings)
      .innerJoin(users, eq(users.id, tenantRoleBindings.userId))
      .where(where)
      .orderBy(asc(createdMs), asc(tenantRoleBindings.id));
    const rows = await (opts.limit ? q.limit(opts.limit) : q);
    return rows.map((r) => ({
      id: r.b.id,
      tenantId: r.b.tenantId,
      role: r.b.role,
      useCase: r.b.useCase,
      inherit: r.b.inherit,
      expiresAt: r.b.expiresAt,
      source: r.b.source as BindingSource,
      grantedBy: r.b.grantedBy,
      createdAt: r.b.createdAt,
      user: { id: r.b.userId, email: r.email, displayName: r.displayName },
    }));
  }

  private async afterWrite(userIds: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(userIds)].map((u) => this.identity.invalidateUserTokens(u)));
  }

  // ------------------------------------------------------------------ reads

  /** `users:read` on the node (rule 1 for reads); bindings of the node itself, oldest first. */
  async list(
    p: Principal,
    tenantId: string,
    q: { userId?: string | undefined; limit: number; cursor?: string | undefined },
  ): Promise<{ items: BindingView[]; nextCursor: string | null }> {
    const node = await this.visibleNode(p, tenantId);
    const actor = await loadActor(this.ctx.db, p);
    const auth = this.authority(actor, node, 'users:read');
    if (!auth.nodeWide && auth.useCases.length === 0) throw forbidden();
    const cursor = decodeTimeCursor(q.cursor);
    const where = and(
      eq(tenantRoleBindings.tenantId, node.id),
      // A use-case administrator sees the bindings of its own use cases, nothing else of the node.
      auth.nodeWide
        ? undefined
        : useCaseMatch(
            tenantRoleBindings.useCase,
            auth.useCases.map((a) => a.useCase),
          ),
      q.userId ? eq(tenantRoleBindings.userId, q.userId) : undefined,
      cursor
        ? or(
            gt(createdMs, sql`${cursor.t.toISOString()}::timestamptz`),
            and(
              eq(createdMs, sql`${cursor.t.toISOString()}::timestamptz`),
              gt(tenantRoleBindings.id, cursor.id),
            ),
          )
        : undefined,
    );
    const rows = await this.views(this.ctx.db, where, { limit: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor: rows.length > q.limit && last ? encodeTimeCursor(last.createdAt, last.id) : null,
    };
  }

  // ------------------------------------------------------------------ writes

  async create(p: Principal, tenantId: string, input: BindingInput): Promise<BindingView> {
    const node = await this.visibleNode(p, tenantId);
    const max = this.ctx.config.tenancy.maxBindingsPerUser;
    const view = await this.ctx.db
      .transaction(async (t) => {
        const tx = t as unknown as Db;
        await this.lock(tx, node.rootId);
        const actor = await loadActor(tx, p);
        // Rule 1 (permission): users:write at this node, or, for a use-case administrator, the own
        // use-case binding on this node (rule 3).
        const auth = this.authority(actor, node, 'users:write');
        if (!auth.nodeWide && auth.useCases.length === 0) throw forbidden();
        const useCase = input.useCase ?? null;
        if (useCase !== null) {
          if (!isValidUseCase(useCase))
            throw new HttpError(
              422,
              'validation_failed',
              'useCase must be segments of letters, digits, ".", "_" or "-" separated by "/"',
            );
          if (input.role === 'pentest')
            throw new HttpError(
              422,
              'validation_failed',
              'pentest cannot be limited to a use case; it is granted for a tenant',
            );
          this.assertUseCaseReadable();
        }
        // Rule 6: nobody widens their own access (platform admins excepted).
        if (input.userId === actor.userId && !actor.platformAdmin)
          throw deny('self_grant', 'you cannot grant a role to yourself');
        // Rules 1 to 3.
        this.assertAuthority(actor, auth, node, {
          useCase,
          role: input.role,
          inherit: input.inherit,
        });
        // Rule 7: pentest is time-boxed and granted by tenant administrators only.
        if (input.role === 'pentest') {
          this.assertPentestReadable();
          assertPentestGrant(
            actor,
            node,
            input.expiresAt,
            this.ctx.now(),
            this.ctx.config.tenancy.pentestMaxDays,
          );
        }
        this.checkExpiry(input.expiresAt);
        // Rules 4 and 5.
        const user = await this.grantee(
          tx,
          actor,
          node,
          input.userId,
          auth.nodeWide ? [] : [node.id],
        );
        const [held] = await tx
          .select({ n: count() })
          .from(tenantRoleBindings)
          .where(eq(tenantRoleBindings.userId, user.id));
        if (Number(held?.n ?? 0) >= max)
          throw new HttpError(
            422,
            'binding_limit_exceeded',
            `a user can hold at most ${max} role bindings`,
          );
        const id = randomUUID();
        const expiresAt = input.expiresAt ?? null;
        await tx.insert(tenantRoleBindings).values({
          id,
          userId: user.id,
          tenantId: node.id,
          role: input.role,
          useCase,
          inherit: input.inherit,
          expiresAt,
          // A grant that ends within the notice period is its own notice: no second one.
          expiryWarnedAt:
            input.role === 'pentest' &&
            expiresAt !== null &&
            expiresAt.getTime() - this.ctx.now().getTime() <= PENTEST_WARNING_MS
              ? this.ctx.now()
              : null,
          grantedBy: actor.userId,
          source: 'grant',
        });
        await this.audit.append(
          {
            actor: actor.userId,
            tenantId: node.id,
            action: 'tenant.role_bound',
            target: id,
            payload: {
              bindingId: id,
              userId: user.id,
              role: input.role,
              useCase,
              inherit: input.inherit,
              expiresAt: input.expiresAt?.toISOString() ?? null,
              grantedBy: actor.userId,
            },
          },
          tx,
        );
        if (input.role === 'pentest')
          await this.noticeGranted(
            tx,
            node,
            { id, userId: user.id, inherit: input.inherit, expiresAt },
            actor.userId,
            'granted',
          );
        return this.viewOf(tx, id);
      })
      .catch((e: unknown) => {
        if (pgCode(e) === '23505') throw conflict('this role is already bound to the user here');
        if (pgCode(e) === '23514')
          throw new HttpError(
            422,
            'cross_organisation_grant',
            'a role can only be bound inside the organisation of the user',
          );
        if (pgCode(e) === '23503') throw notFound('user');
        throw e;
      });
    await this.afterWrite([view.user.id]);
    return view;
  }

  async update(
    p: Principal,
    tenantId: string,
    bindingId: string,
    patch: BindingPatch,
  ): Promise<BindingView> {
    const node = await this.visibleNode(p, tenantId);
    const view = await this.ctx.db
      .transaction(async (t) => {
        const tx = t as unknown as Db;
        await this.lock(tx, node.rootId);
        const actor = await loadActor(tx, p);
        const auth = this.authority(actor, node, 'users:write');
        if (!auth.nodeWide && auth.useCases.length === 0) throw forbidden();
        const row = await this.binding(tx, node, bindingId);
        // A use-case administrator only sees the bindings of its own use cases: any other binding
        // of the node answers like one that does not exist.
        if (!auth.nodeWide && !this.inScope(auth.useCases, row.useCase))
          throw notFound('role binding');
        if (row.useCase !== null && patch.role === 'pentest')
          throw new HttpError(
            422,
            'validation_failed',
            'pentest cannot be limited to a use case; it is granted for a tenant',
          );
        if (row.source === 'mirror' && (patch.role !== undefined || patch.expiresAt !== undefined))
          throw new HttpError(
            409,
            'mirror_binding',
            'this binding mirrors the global roles of the user; only inherit can be changed here',
          );
        const next = {
          role: (patch.role ?? row.role) as Role,
          inherit: patch.inherit ?? row.inherit,
          expiresAt: patch.expiresAt === undefined ? row.expiresAt : patch.expiresAt,
        };
        const changes: { field: 'role' | 'inherit' | 'expiresAt'; from: unknown; to: unknown }[] =
          [];
        if (next.role !== row.role) changes.push({ field: 'role', from: row.role, to: next.role });
        if (next.inherit !== row.inherit)
          changes.push({ field: 'inherit', from: row.inherit, to: next.inherit });
        if ((next.expiresAt?.getTime() ?? null) !== (row.expiresAt?.getTime() ?? null))
          changes.push({
            field: 'expiresAt',
            from: row.expiresAt?.toISOString() ?? null,
            to: next.expiresAt?.toISOString() ?? null,
          });
        if (changes.length === 0) return this.viewOf(tx, row.id);
        // Rule 6, also for flipping inherit on one's own binding.
        if (row.userId === actor.userId && !actor.platformAdmin)
          throw deny('self_grant', 'you cannot change your own role bindings');
        // Rule 9: who may grant may revoke. The old tuple is taken away, the new one is granted;
        // both must be within the grantor's authority, so a PATCH is never a way around rules 1 to 6.
        this.assertAuthority(actor, auth, node, {
          useCase: row.useCase,
          role: row.role as Role,
          inherit: row.inherit,
        });
        this.assertAuthority(actor, auth, node, {
          useCase: row.useCase,
          role: next.role,
          inherit: next.inherit,
        });
        // Rule 7 for every change that touches a pentest binding, in its old or new state.
        if (next.role === 'pentest' && row.role !== 'pentest') {
          // becoming pentest is a grant: authority, required and bounded expiry
          this.assertPentestReadable();
          assertPentestGrant(
            actor,
            node,
            next.expiresAt,
            this.ctx.now(),
            this.ctx.config.tenancy.pentestMaxDays,
          );
        } else if (row.role === 'pentest') {
          this.assertPentestAuthority(actor, node);
          const moved = changes.some((c) => c.field === 'expiresAt');
          if (next.role === 'pentest' && moved) {
            // Only shortening: extending means a new grant (delete and grant again, which is a
            // fresh `tenant.role_bound`). The maximum is checked only when the expiry changes.
            if (next.expiresAt === null)
              throw new HttpError(422, 'expiry_required', 'a pentest binding needs an expiry');
            if (row.expiresAt !== null && next.expiresAt.getTime() > row.expiresAt.getTime())
              throw new HttpError(
                422,
                'expiry_extension_requires_new_grant',
                'a pentest binding cannot be extended; remove it and grant it again',
              );
          }
        }
        if (changes.some((c) => c.field === 'expiresAt')) this.checkExpiry(next.expiresAt);
        await assertNotLastAdmin(tx, actor, node, row, next);
        const expiryChanged = changes.some((c) => c.field === 'expiresAt' || c.field === 'role');
        await tx
          .update(tenantRoleBindings)
          .set({
            role: next.role,
            inherit: next.inherit,
            expiresAt: next.expiresAt,
            ...(expiryChanged
              ? {
                  expiryWarnedAt:
                    next.role === 'pentest' &&
                    next.expiresAt !== null &&
                    next.expiresAt.getTime() - this.ctx.now().getTime() <= PENTEST_WARNING_MS
                      ? this.ctx.now()
                      : null,
                }
              : {}),
          })
          .where(eq(tenantRoleBindings.id, row.id));
        for (const c of changes)
          await this.audit.append(
            {
              actor: actor.userId,
              tenantId: node.id,
              action: 'tenant.role_binding_changed',
              target: row.id,
              payload: { bindingId: row.id, field: c.field, from: c.from, to: c.to },
            },
            tx,
          );
        if (next.role === 'pentest' && changes.length > 0)
          await this.noticeGranted(
            tx,
            node,
            { id: row.id, userId: row.userId, inherit: next.inherit, expiresAt: next.expiresAt },
            actor.userId,
            row.role === 'pentest' ? 'changed' : 'granted',
          );
        return this.viewOf(tx, row.id);
      })
      .catch((e: unknown) => {
        if (pgCode(e) === '23505') throw conflict('this role is already bound to the user here');
        throw e;
      });
    await this.afterWrite([view.user.id]);
    return view;
  }

  async remove(p: Principal, tenantId: string, bindingId: string): Promise<void> {
    const node = await this.visibleNode(p, tenantId);
    const userId = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await this.lock(tx, node.rootId);
      const actor = await loadActor(tx, p);
      const auth = this.authority(actor, node, 'users:write');
      const [found] = await tx
        .select()
        .from(tenantRoleBindings)
        .where(and(eq(tenantRoleBindings.id, bindingId), eq(tenantRoleBindings.tenantId, node.id)))
        .for('update');
      const own = found !== undefined && found.userId === actor.userId;
      // Rule 9: a user may always leave; everybody else needs users:write. Missing and foreign
      // bindings answer alike for a caller without it.
      if (!own && !auth.nodeWide && auth.useCases.length === 0) throw forbidden();
      if (!found) throw notFound('role binding');
      if (!own && !auth.nodeWide && !this.inScope(auth.useCases, found.useCase))
        throw notFound('role binding');
      if (found.source === 'mirror')
        throw new HttpError(
          409,
          'mirror_binding',
          'this binding mirrors the global roles of the user; change the global roles instead',
        );
      if (!own)
        this.assertAuthority(actor, auth, node, {
          useCase: found.useCase,
          role: found.role as Role,
          inherit: found.inherit,
        });
      if (!own && found.role === 'pentest') this.assertPentestAuthority(actor, node);
      await assertNotLastAdmin(tx, actor, node, found, null);
      await tx.delete(tenantRoleBindings).where(eq(tenantRoleBindings.id, found.id));
      await this.audit.append(
        {
          actor: actor.userId,
          tenantId: node.id,
          action: 'tenant.role_unbound',
          target: found.id,
          payload: {
            bindingId: found.id,
            userId: found.userId,
            role: found.role,
            useCase: found.useCase,
            reason: own ? 'self' : 'revoked',
          },
        },
        tx,
      );
      return found.userId;
    });
    await this.afterWrite([userId]);
  }

  private async binding(tx: Db, node: TenantRow, id: string): Promise<Row> {
    const [row] = await tx
      .select()
      .from(tenantRoleBindings)
      .where(and(eq(tenantRoleBindings.id, id), eq(tenantRoleBindings.tenantId, node.id)))
      .for('update');
    if (!row) throw notFound('role binding');
    return row;
  }

  // ------------------------------------------------------------------ bulk opt-in

  /**
   * `POST /v1/tenants/{rootId}/role-bindings/enable-inheritance` (platform admins only): turns
   * every plain binding of the given roles in the organisation into an inheriting one, after
   * reporting who and which nodes gain access. Bindings of disabled users and expired bindings are
   * left alone. With `dryRun` nothing changes.
   */
  async enableInheritance(
    p: Principal,
    rootId: string,
    input: { roles: GrantableRole[]; dryRun: boolean },
  ): Promise<InheritancePreview> {
    // Before any lookup: everybody else gets the same 403, whether or not the tenant exists.
    if (!p.platformAdmin) throw forbidden('platform operator access required');
    // Token scopes apply to operators too: a dry run reads users, the change writes bindings.
    const need: Permission = input.dryRun ? 'users:read' : 'users:write';
    if (p.scopes && !p.scopes.includes(need)) throw forbidden(`token scope ${need} required`);
    const [root] = await this.ctx.db.select().from(tenants).where(eq(tenants.id, rootId));
    if (!root) throw notFound('tenant');
    if (root.parentId !== null)
      throw new HttpError(422, 'validation_failed', 'the tenant is not an organisation root');
    const roles = [...new Set(input.roles)];
    const run = async (tx: Db): Promise<InheritancePreview> => {
      const actor = await loadActor(tx, p);
      if (!actor.platformAdmin) throw forbidden('platform operator access required');
      const orgNodes = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.rootId, root.id))
        .orderBy(asc(tenants.depth), asc(tenants.slug));
      const slugPaths = await this.tree.slugPaths(orgNodes);
      const byId = new Map(orgNodes.map((n) => [n.id, n]));
      const targets = await tx
        .select({ b: tenantRoleBindings, email: users.email, displayName: users.displayName })
        .from(tenantRoleBindings)
        .innerJoin(users, eq(users.id, tenantRoleBindings.userId))
        .innerJoin(tenants, eq(tenants.id, tenantRoleBindings.tenantId))
        .where(
          and(
            eq(tenants.rootId, root.id),
            inArray(tenantRoleBindings.role, roles),
            isNull(tenantRoleBindings.useCase),
            eq(tenantRoleBindings.inherit, false),
            or(
              isNull(tenantRoleBindings.expiresAt),
              gt(tenantRoleBindings.expiresAt, this.ctx.now()),
            ),
            eq(users.disabled, false),
          ),
        )
        .orderBy(asc(tenantRoleBindings.createdAt), asc(tenantRoleBindings.id));
      const reach = { kind: 'all' } as const;
      const items: InheritancePreview['items'] = [];
      for (const t of targets) {
        const at = byId.get(t.b.tenantId);
        if (!at) continue;
        const below = orgNodes.filter(
          (n) => n.id !== at.id && n.path.startsWith(at.path) && TenantAccess.allows(reach, n),
        );
        items.push({
          bindingId: t.b.id,
          role: t.b.role,
          source: t.b.source as BindingSource,
          user: { id: t.b.userId, email: t.email, displayName: t.displayName },
          tenant: {
            id: at.id,
            slug: at.slug,
            slugPath: slugPaths.get(at.id) ?? at.slug,
            name: at.name,
          },
          nodeCount: below.length,
          nodes: below.slice(0, LIST_NODE_CAP).map((n) => ({
            id: n.id,
            slug: n.slug,
            slugPath: slugPaths.get(n.id) ?? n.slug,
            name: n.name,
          })),
        });
      }
      const result: InheritancePreview = {
        dryRun: input.dryRun,
        roles,
        bindings: targets.length,
        users: new Set(targets.map((t) => t.b.userId)).size,
        truncated: items.length > LIST_ITEM_CAP,
        items: items.slice(0, LIST_ITEM_CAP),
      };
      if (input.dryRun || targets.length === 0) return result;
      await tx
        .update(tenantRoleBindings)
        .set({ inherit: true })
        .where(
          inArray(
            tenantRoleBindings.id,
            targets.map((t) => t.b.id),
          ),
        );
      for (const t of targets)
        await this.audit.append(
          {
            actor: actor.userId,
            tenantId: t.b.tenantId,
            action: 'tenant.role_binding_changed',
            target: t.b.id,
            payload: { bindingId: t.b.id, field: 'inherit', from: false, to: true },
          },
          tx,
        );
      await this.audit.append(
        {
          actor: actor.userId,
          tenantId: root.id,
          action: 'tenant.inheritance_enabled',
          target: root.id,
          payload: { roles, bindings: result.bindings, users: result.users },
        },
        tx,
      );
      return result;
    };
    if (input.dryRun) return run(this.ctx.db);
    const result = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await this.lock(tx, root.id);
      return run(tx);
    });
    // The epoch bump of the triggers already invalidates every cached principal of the organisation;
    // dropping the entries of the users listed here is a courtesy for the (unlikely) legacy path.
    await this.afterWrite(result.items.map((i) => i.user.id));
    return result;
  }
}

/** Roles the role-binding API accepts: the six legacy ones and the time-boxed `pentest` (S6). */
export const BINDING_ROLES = ALL_BINDING_ROLES;
