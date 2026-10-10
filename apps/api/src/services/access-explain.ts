import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  isRole,
  appliedAt,
  bindingPermissions,
  pathIds,
  type AppliedBinding,
  type BindingSource,
  type Permission,
  type Principal,
  type RoleBinding,
  type RoleNode,
} from '@openagentix/core';
import type { AppContext } from '../context.js';
import type { users } from '../db/schema.js';
import { forbidden, notFound } from '../errors.js';
import { loadActor, permissionsAt, visibleUser } from './grant-authority.js';
import { loadRawGrants } from './role-bindings.js';
import { TenantAccess } from './tenant-access.js';
import type { TenantRow } from './identity.js';
import { TenantTree } from './tenant-tree.js';

/**
 * "Why may this user do that here?" (ADR 0014 section 14, slice S5): the effective permissions of a
 * user at one node, each with the kinds of binding that give it, plus the bindings with the node
 * they are bound on. Built by the resolver the request path uses (`appliedAt`), so the answer
 * cannot drift from what is enforced; the basis for the `actions` block of the detail views (#160).
 */

export interface AccessBinding {
  role: string;
  teamId: string | null;
  agentId: string | null;
  tenantId: string;
  tenantSlugPath: string;
  inherit: boolean;
  expiresAt: Date | null;
  source: BindingSource;
}

export interface AccessView {
  tenant: { id: string; slug: string; slugPath: string; name: string };
  user: { id: string; email: string; displayName: string } | null;
  platformAdmin: boolean;
  /** True when API token scopes removed permissions the bindings would give. */
  limitedByToken: boolean;
  bindings: AccessBinding[];
  permissions: { permission: Permission; sources: BindingSource[] }[];
}

const SOURCE_ORDER: BindingSource[] = [
  'direct',
  'inherited',
  'attached',
  'team',
  'agent',
  'platform',
];

export class AccessExplainService {
  private readonly access: TenantAccess;
  private readonly tree: TenantTree;

  constructor(private readonly ctx: AppContext) {
    this.access = new TenantAccess(ctx);
    this.tree = new TenantTree(ctx);
  }

  /**
   * `GET /v1/me/access?tenant=`: the caller's own permissions at `ref` (id or slug path; the acting
   * node when omitted). A node outside the caller's reach is the same `404 tenant` as an unknown one.
   */
  async forMe(p: Principal, ref: string | undefined): Promise<AccessView> {
    const node =
      ref === undefined ? await this.actingNode(p) : await this.access.resolveVisible(p, ref);
    if (!node) throw notFound('tenant');
    const applied = await this.appliedFor(p, node);
    return this.view(node, null, p.platformAdmin, applied, p.scopes);
  }

  /**
   * `GET /v1/tenants/{id}/access?userId=`: another user's permissions at the node in the path.
   * Needs `users:read` at **that node** (never the acting node) and a user the caller may see
   * (the rule-4 visibility of the grant API; otherwise `404 user`).
   */
  async forUser(p: Principal, tenantId: string, userId: string): Promise<AccessView> {
    const node = await this.access.resolveVisible(p, tenantId);
    if (!node) throw notFound('tenant');
    const now = this.ctx.now();
    const db = this.ctx.db;
    const legacy = this.ctx.config.auth.roleBindingsRead === 'legacy';
    const actor = await loadActor(db, p);
    // The legacy read path decides from the global roles of the home node, as everywhere else.
    const mayRead = legacy
      ? hasPermission(p, 'users:read')
      : permissionsAt(actor, node, now).has('users:read');
    if (!mayRead) throw forbidden();
    const user = await visibleUser(db, actor, node, userId, now);
    const applied = user.disabled ? [] : await this.userBindings(user, node, legacy, now);
    const shown = { id: user.id, email: user.email, displayName: user.displayName };
    return this.view(node, shown, user.platformAdmin, applied, undefined);
  }

  /**
   * A user's bindings at `node`, only those on the chain of the node. A platform operator is
   * `admin` at the node (ADR 0013 7.1) and the answer never names their home node. With the legacy
   * read path the global roles of the user's home node are the bindings.
   */
  private async userBindings(
    user: typeof users.$inferSelect,
    node: TenantRow,
    legacy: boolean,
    now: Date,
  ): Promise<AppliedBinding[]> {
    if (legacy) {
      if (user.tenantId !== node.id) return [];
      return user.globalRoles.filter(isRole).map((role) => ({
        role,
        teamId: null,
        permissions: ROLE_PERMISSIONS[role],
        useCase: null,
        source: 'direct' as const,
        tenantId: node.id,
        inherit: false,
        expiresAt: null,
      }));
    }
    const loaded = await loadRawGrants(this.ctx.db, {
      id: user.id,
      tenantId: user.tenantId,
      platformAdmin: user.platformAdmin,
    });
    if (!loaded) return [];
    const chain = new Set(pathIds(node.path));
    return appliedAt(loaded.raw, this.roleNode(node), { now }).filter((b) => chain.has(b.tenantId));
  }

  private roleNode(n: TenantRow): RoleNode {
    return { id: n.id, rootId: n.rootId, path: n.path };
  }

  private async actingNode(p: Principal): Promise<TenantRow | undefined> {
    return this.tree.node(p.tenantId);
  }

  /**
   * The bindings of the caller at `node`, as `GET /v1/me` shows them: from the resolver when the
   * read path is `bindings`; with `legacy` only the home node can be asked about and the legacy
   * bindings are described as direct, team and agent bindings.
   */
  private async appliedFor(p: Principal, node: TenantRow): Promise<AppliedBinding[]> {
    if (p.grants)
      return appliedAt(p.grants.raw, p.platformAdmin ? p.grants.home : this.roleNode(node), {
        now: this.ctx.now(),
        implicitPlatformAdmin: false,
      });
    return p.bindings.map((b: RoleBinding) => ({
      role: b.role,
      teamId: b.teamId,
      ...(b.agentId ? { agentId: b.agentId } : {}),
      permissions: bindingPermissions(b),
      useCase: null,
      source: b.agentId ? ('agent' as const) : b.teamId ? ('team' as const) : ('direct' as const),
      tenantId: node.id,
      inherit: false,
      expiresAt: null,
    }));
  }

  private async view(
    node: TenantRow,
    user: AccessView['user'],
    platformAdmin: boolean,
    applied: AppliedBinding[],
    scopes: readonly Permission[] | undefined,
  ): Promise<AccessView> {
    const slugPath = (await this.tree.slugPaths([node])).get(node.id)!;
    const segments = slugPath.split('/');
    // The anchor of a binding is on the chain of the node, so its slug path is a prefix of the
    // node's own: no further lookup, and nothing is named that is not already on the breadcrumb.
    const chain = pathIds(node.path);
    const anchorPath = (id: string): string => {
      const i = chain.indexOf(id);
      return i < 0 ? slugPath : segments.slice(0, i + 1).join('/');
    };
    const bySource = new Map<Permission, Set<BindingSource>>();
    for (const b of applied)
      for (const perm of b.permissions) {
        const set = bySource.get(perm) ?? new Set<BindingSource>();
        set.add(b.source);
        bySource.set(perm, set);
      }
    let limitedByToken = false;
    const permissions = PERMISSIONS.filter((perm) => bySource.has(perm))
      .filter((perm) => {
        const allowed = !scopes || scopes.includes(perm);
        if (!allowed) limitedByToken = true;
        return allowed;
      })
      .map((permission) => ({
        permission,
        sources: SOURCE_ORDER.filter((s) => bySource.get(permission)!.has(s)),
      }));
    return {
      tenant: { id: node.id, slug: node.slug, slugPath, name: node.name },
      user,
      platformAdmin,
      limitedByToken,
      bindings: applied.map((b) => ({
        role: b.role,
        teamId: b.teamId,
        agentId: b.agentId ?? null,
        tenantId: b.tenantId,
        tenantSlugPath: anchorPath(b.tenantId),
        inherit: b.inherit,
        expiresAt: b.expiresAt,
        source: b.source,
      })),
      permissions,
    };
  }
}
