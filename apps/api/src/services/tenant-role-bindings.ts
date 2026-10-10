import { randomUUID } from 'node:crypto';
import {
  GRANTABLE_ROLES,
  ROLE_PERMISSIONS,
  appliedAt,
  isRole,
  pathIds,
  type Permission,
  type GrantableRole,
  type Principal,
  type RawGrants,
  type Role,
  type RoleNode,
} from '@openagentix/core';
import { and, asc, count, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
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
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { decodeTimeCursor, encodeTimeCursor } from '../pagination.js';
import type { AuditService } from './audit.js';
import type { IdentityService, TenantRow } from './identity.js';
import { loadRawGrants } from './role-bindings.js';
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
 * with the same resolver the request path uses, clamp included. Epoch bumps come from the triggers
 * of migration 0021; cached principals of the grantee are dropped after the commit.
 *
 * Node-level authority only: team and agent scoped bindings never give the right to grant.
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
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
  role: GrantableRole;
  inherit: boolean;
  expiresAt?: Date | null | undefined;
  useCase?: string | null | undefined;
}

export interface BindingPatch {
  role?: GrantableRole | undefined;
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

/** What the grantor holds, read inside the transaction. */
interface Actor {
  userId: string;
  platformAdmin: boolean;
  raw: RawGrants;
  scopes: readonly Permission[] | undefined;
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
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${rootId}))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`role-bindings:${rootId}`}))`);
  }

  private async loadActor(tx: Db, p: Principal): Promise<Actor> {
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

  /** Node-level permissions of the grantor at `node` (platform admin: admin; token scopes apply). */
  private permissionsAt(actor: Actor, node: RoleNode): Set<Permission> {
    const out = new Set<Permission>();
    for (const b of appliedAt(actor.raw, node, { now: this.ctx.now() })) {
      if (b.source !== 'direct' && b.source !== 'inherited' && b.source !== 'platform') continue;
      for (const perm of b.permissions) out.add(perm);
    }
    if (actor.scopes) for (const perm of out) if (!actor.scopes.includes(perm)) out.delete(perm);
    return out;
  }

  /**
   * Whether the grantor's inheriting bindings on `node` or an ancestor together cover everything
   * `role` gives (ADR 0014 rule 2: a grant that inherits is a grant on the whole subtree).
   */
  private coversSubtree(actor: Actor, node: RoleNode, role: Role): boolean {
    if (actor.platformAdmin) return true;
    const chain = new Set(pathIds(node.path));
    const now = this.ctx.now().getTime();
    const have = new Set<Permission>();
    for (const b of actor.raw.nodeBindings) {
      if (!b.inherit || b.useCase !== null || !isRole(b.role) || !chain.has(b.tenantId)) continue;
      if (b.expiresAt !== null && !(b.expiresAt.getTime() > now)) continue;
      for (const perm of ROLE_PERMISSIONS[b.role]) have.add(perm);
    }
    return ROLE_PERMISSIONS[role].every((perm) => have.has(perm));
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
    if (inherit && !this.coversSubtree(actor, node, role))
      throw deny(
        'inheritance_required',
        'an inheriting binding needs an inheriting binding of at least the same role on this ' +
          'tenant or an ancestor',
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
  private async grantee(tx: Db, actor: Actor, node: TenantRow, userId: string) {
    const [u] = await tx.select().from(users).where(eq(users.id, userId));
    if (actor.platformAdmin) {
      if (!u) throw notFound('user');
    } else {
      const nodes = await tx
        .select({ id: tenants.id, rootId: tenants.rootId, path: tenants.path })
        .from(tenants)
        .where(eq(tenants.rootId, node.rootId));
      const covered = nodes
        .filter((n) => this.permissionsAt(actor, n).has('users:read'))
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
    }
    const [home] = await tx
      .select({ rootId: tenants.rootId })
      .from(tenants)
      .where(eq(tenants.id, u!.tenantId));
    if (!home || home.rootId !== node.rootId)
      throw new HttpError(
        422,
        'cross_organisation_grant',
        'a role can only be bound inside the organisation of the user',
      );
    return u!;
  }

  /** Rule 8: would this change leave the organisation root without an inheriting admin? */
  private async assertNotLastAdmin(
    tx: Db,
    actor: Actor,
    node: TenantRow,
    before: Row,
    after: { role: string; inherit: boolean; expiresAt: Date | null } | null,
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
          or(
            isNull(tenantRoleBindings.expiresAt),
            gt(tenantRoleBindings.expiresAt, this.ctx.now()),
          ),
          eq(users.disabled, false),
          ne(tenantRoleBindings.id, before.id),
        ),
      );
    if (Number(others?.n ?? 0) === 0)
      throw new HttpError(
        409,
        'last_admin',
        'this is the last inheriting administrator of the organisation',
      );
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
    const actor = await this.loadActor(this.ctx.db, p);
    if (!this.permissionsAt(actor, node).has('users:read')) throw forbidden();
    const cursor = decodeTimeCursor(q.cursor);
    const where = and(
      eq(tenantRoleBindings.tenantId, node.id),
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
        const actor = await this.loadActor(tx, p);
        const perms = this.permissionsAt(actor, node);
        // Rule 1 (permission): users:write at this node.
        if (!perms.has('users:write')) throw forbidden();
        // Use-case bindings cannot be scoped by the services before S8 (fail closed).
        if (input.useCase !== null && input.useCase !== undefined)
          throw new HttpError(
            422,
            'use_case_bindings_unsupported',
            'use-case bindings are not supported yet',
          );
        // Rule 6: nobody widens their own access (platform admins excepted).
        if (input.userId === actor.userId && !actor.platformAdmin)
          throw deny('self_grant', 'you cannot grant a role to yourself');
        // Rules 1 and 2.
        this.assertMayHold(actor, perms, node, input.role, input.inherit);
        this.checkExpiry(input.expiresAt);
        // Rules 4 and 5.
        const user = await this.grantee(tx, actor, node, input.userId);
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
        await tx.insert(tenantRoleBindings).values({
          id,
          userId: user.id,
          tenantId: node.id,
          role: input.role,
          useCase: null,
          inherit: input.inherit,
          expiresAt: input.expiresAt ?? null,
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
              useCase: null,
              inherit: input.inherit,
              expiresAt: input.expiresAt?.toISOString() ?? null,
              grantedBy: actor.userId,
            },
          },
          tx,
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
        const actor = await this.loadActor(tx, p);
        const perms = this.permissionsAt(actor, node);
        if (!perms.has('users:write')) throw forbidden();
        const row = await this.binding(tx, node, bindingId);
        if (row.useCase !== null)
          throw new HttpError(
            422,
            'use_case_bindings_unsupported',
            'use-case bindings are not supported yet',
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
        this.assertMayHold(actor, perms, node, row.role as Role, row.inherit);
        this.assertMayHold(actor, perms, node, next.role, next.inherit);
        if (changes.some((c) => c.field === 'expiresAt')) this.checkExpiry(next.expiresAt);
        await this.assertNotLastAdmin(tx, actor, node, row, next);
        await tx
          .update(tenantRoleBindings)
          .set({ role: next.role, inherit: next.inherit, expiresAt: next.expiresAt })
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
      const actor = await this.loadActor(tx, p);
      const perms = this.permissionsAt(actor, node);
      const [found] = await tx
        .select()
        .from(tenantRoleBindings)
        .where(and(eq(tenantRoleBindings.id, bindingId), eq(tenantRoleBindings.tenantId, node.id)))
        .for('update');
      const own = found !== undefined && found.userId === actor.userId;
      // Rule 9: a user may always leave; everybody else needs users:write. Missing and foreign
      // bindings answer alike for a caller without it.
      if (!own && !perms.has('users:write')) throw forbidden();
      if (!found) throw notFound('role binding');
      if (found.source === 'mirror')
        throw new HttpError(
          409,
          'mirror_binding',
          'this binding mirrors the global roles of the user; change the global roles instead',
        );
      if (!own) this.assertMayHold(actor, perms, node, found.role as Role, found.inherit);
      await this.assertNotLastAdmin(tx, actor, node, found, null);
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
    const [root] = await this.ctx.db.select().from(tenants).where(eq(tenants.id, rootId));
    if (!root) throw notFound('tenant');
    if (root.parentId !== null)
      throw new HttpError(422, 'validation_failed', 'the tenant is not an organisation root');
    const roles = [...new Set(input.roles)];
    const run = async (tx: Db): Promise<InheritancePreview> => {
      const actor = await this.loadActor(tx, p);
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

/** Roles the API accepts (the six grantable ones until `pentest` arrives with S6). */
export const BINDING_ROLES = GRANTABLE_ROLES;
