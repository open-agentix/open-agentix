import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  bindingPermissions,
  isRole,
  type BindingSource,
  type Permission,
  type Role,
  type RoleBinding,
} from '../rbac.js';
import { MAX_TENANT_DEPTH, isValidPath, pathIds } from './path.js';

/**
 * Role resolution over the tenant tree (ADR 0014 section 3.2).
 *
 * Everything here is pure: raw grants and the acting node go in, the classic `RoleBinding[]` the
 * services already understand comes out. There is no database access, no clock (the caller passes
 * `now`) and no recursion: the chain of a node is the id list in its own `path`.
 *
 * The rules, without exception:
 *
 * - **Down only, by opt-in.** A node binding applies at its own node, and at a strict descendant
 *   only when `inherit` is true. Nothing applies at an ancestor or a sibling.
 * - **Never across organisations.** Nothing applies at a node of another organisation than the
 *   user's home organisation (the database enforces the same with a trigger).
 * - **Team and agent bindings never inherit**: they apply at the node that owns the team or agent.
 * - **Union, minus restrictions.** Restrictions only ever remove permissions, never from `admin`
 *   and never for bindings that sit above the restricting node.
 * - **Fail closed.** Anything that does not look right (a malformed node path, an unknown role, a
 *   `pentest` binding without an expiry, a use-case binding before slice S8) contributes nothing.
 */

/** The permissions an inherited binding may use while the first slices of ADR 0014 are live. */
export const INHERITED_READ_ONLY: readonly Permission[] = PERMISSIONS.filter(
  (p) => p.endsWith(':read') || p === 'audit:verify',
);

/** The placement of a node: what the resolver needs to know about the acting node. */
export interface RoleNode {
  id: string;
  rootId: string;
  /** `/<root>/.../<id>/` (ADR 0013 section 2). */
  path: string;
}

/** One row of `tenant_role_bindings`. */
export interface NodeRoleGrant {
  tenantId: string;
  role: Role;
  useCase: string | null;
  inherit: boolean;
  expiresAt: Date | null;
}

/** A team membership, tagged with the node that owns the team. */
export interface TeamRoleGrant {
  tenantId: string;
  teamId: string;
  role: Role;
}

/** An agent-scoped binding, tagged with the node that owns the agent. */
export interface AgentRoleGrant {
  tenantId: string;
  agentId: string;
  /** The agent's team; `null` for an agent without one. */
  teamId: string | null;
  role: Role;
}

/** Everything the resolver needs to know about one principal (ADR 0014 section 3.1). */
export interface RawGrants {
  userId: string;
  homeTenantId: string;
  /** `tenants.root_id` of the home tenant: the only organisation the grants may apply in. */
  homeRootId: string;
  platformAdmin: boolean;
  nodeBindings: readonly NodeRoleGrant[];
  teamBindings: readonly TeamRoleGrant[];
  agentBindings: readonly AgentRoleGrant[];
}

/** A permission removed from a role for bindings at a node and below (ADR 0014 section 5). */
export interface RoleRestriction {
  tenantId: string;
  role: Role;
  permission: Permission;
}

export interface ResolveOptions {
  now: Date;
  /** Restrictions on the chain of the acting node; anything else is ignored. */
  restrictions?: readonly RoleRestriction[] | undefined;
  /**
   * Clamp inherited bindings to {@link INHERITED_READ_ONLY} (default `true`). Slice S5 of ADR 0014
   * turns it off; until then no write authority may flow down the tree.
   */
  clampInherited?: boolean | undefined;
  /**
   * A platform admin is `admin` at every node (ADR 0013 7.1; default `true`). The shadow check of
   * slice S1 passes `false` because today a platform admin acts with the roles of the home tenant.
   */
  implicitPlatformAdmin?: boolean | undefined;
}

/** A binding as the resolver returns it: the classic shape with the extra fields filled in. */
export interface EffectiveBinding extends RoleBinding {
  permissions: readonly Permission[];
  useCase: string | null;
  source: BindingSource;
}

/**
 * A binding that applies at a node, with where it comes from: the {@link EffectiveBinding} the
 * services consume plus the anchor of the grant. `GET /v1/me` shows it; nothing authorises from
 * the extra fields.
 */
export interface AppliedBinding extends EffectiveBinding {
  /** The node the grant is bound on (the acting node itself for `direct`, `team` and `agent`). */
  tenantId: string;
  inherit: boolean;
  expiresAt: Date | null;
}

/** The ids of a node's chain, root first, or `undefined` when the placement is not coherent. */
function chainOf(node: RoleNode): string[] | undefined {
  if (!isValidPath(node.path)) return undefined;
  const ids = pathIds(node.path);
  if (ids[0] !== node.rootId || ids[ids.length - 1] !== node.id) return undefined;
  // A chain longer than the tree can be deep, or one that names a node twice, is not a chain: a
  // repeated id would put a descendant into the "ancestors" and let its grants flow up.
  if (ids.length > MAX_TENANT_DEPTH + 1 || new Set(ids).size !== ids.length) return undefined;
  return ids;
}

/**
 * Effective bindings of a principal at `node`: what the services consume as `principal.bindings`
 * while acting in that node. Pure and total; an unusable input yields fewer bindings, never more.
 */
export function effectiveAt(
  raw: RawGrants,
  node: RoleNode,
  opts: ResolveOptions,
): EffectiveBinding[] {
  return appliedAt(raw, node, opts).map((b) => ({
    role: b.role,
    teamId: b.teamId,
    ...(b.agentId ? { agentId: b.agentId } : {}),
    permissions: b.permissions,
    useCase: b.useCase,
    source: b.source,
  }));
}

/**
 * {@link effectiveAt} with the anchor of every grant (node, `inherit`, expiry). The single
 * implementation of the rules; `effectiveAt` only drops the extra fields.
 */
export function appliedAt(raw: RawGrants, node: RoleNode, opts: ResolveOptions): AppliedBinding[] {
  const chain = chainOf(node);
  if (!chain) return [];
  if (raw.platformAdmin && opts.implicitPlatformAdmin !== false) {
    return [
      {
        role: 'admin',
        teamId: null,
        permissions: ROLE_PERMISSIONS.admin,
        useCase: null,
        source: 'platform',
        tenantId: node.id,
        inherit: false,
        expiresAt: null,
      },
    ];
  }
  // Never across organisations: a node of another organisation gets nothing from this user's grants.
  if (node.rootId !== raw.homeRootId) return [];

  const now = opts.now.getTime();
  const clamp = opts.clampInherited !== false;
  const position = new Map(chain.map((id, i) => [id, i] as const));
  const restrictions = opts.restrictions ?? [];

  /** Permissions of `role` for a binding anchored at chain position `at`, after restrictions. */
  const permissionsFor = (role: Role, at: number): Permission[] => {
    const base = ROLE_PERMISSIONS[role];
    // `admin` can never be restricted (a node must not be able to lock out its administrators).
    if (role === 'admin') return [...base];
    const removed = new Set<Permission>();
    for (const r of restrictions) {
      const i = position.get(r.tenantId);
      // A restriction applies to bindings at the restricting node and below, never above it.
      if (r.role === role && i !== undefined && i <= at) removed.add(r.permission);
    }
    return base.filter((p) => !removed.has(p));
  };

  const out: AppliedBinding[] = [];

  for (const b of raw.nodeBindings) {
    if (!isRole(b.role)) continue;
    // Use-case bindings are refused until the services can scope them (slice S8): fail closed.
    if (b.useCase !== null) continue;
    // `pentest` is time-boxed by definition; without an expiry it never applies.
    if (b.role === 'pentest' && b.expiresAt === null) continue;
    // Expiry is evaluated per call, never at cache time. Only `null` means "no expiry"; anything
    // that is not a valid date in the future (an invalid date, a string from a JSON cache, an
    // invalid `now`) ends the binding instead of keeping it forever.
    if (b.expiresAt !== null) {
      const expires = b.expiresAt instanceof Date ? b.expiresAt.getTime() : Number.NaN;
      if (!(expires > now)) continue;
    }
    const at = position.get(b.tenantId);
    if (at === undefined) continue; // not in the chain: below, beside or in another organisation
    let source: BindingSource;
    if (b.tenantId === node.id) source = 'direct';
    else if (b.inherit) source = 'inherited';
    else continue; // an ancestor's binding that did not opt in
    let permissions = permissionsFor(b.role, at);
    if (source === 'inherited' && clamp)
      permissions = permissions.filter((p) => INHERITED_READ_ONLY.includes(p));
    out.push({
      role: b.role,
      teamId: null,
      permissions,
      useCase: null,
      source,
      tenantId: b.tenantId,
      inherit: b.inherit,
      expiresAt: b.expiresAt,
    });
  }

  const here = chain.length - 1;
  for (const t of raw.teamBindings) {
    if (t.tenantId !== node.id || !isRole(t.role)) continue;
    out.push({
      role: t.role,
      teamId: t.teamId,
      permissions: permissionsFor(t.role, here),
      useCase: null,
      source: 'team',
      tenantId: node.id,
      inherit: false,
      expiresAt: null,
    });
  }
  for (const a of raw.agentBindings) {
    if (a.tenantId !== node.id || !isRole(a.role)) continue;
    out.push({
      role: a.role,
      teamId: a.teamId,
      agentId: a.agentId,
      permissions: permissionsFor(a.role, here),
      useCase: null,
      source: 'agent',
      tenantId: node.id,
      inherit: false,
      expiresAt: null,
    });
  }
  return out;
}

/**
 * The nodes of `tree` where the principal holds at least one effective binding (ADR 0014 section
 * 1, "visible nodes"). `tree` is a snapshot of the nodes to consider; nodes it does not list are
 * never returned.
 */
export function visibleNodeIds(
  raw: RawGrants,
  tree: readonly RoleNode[],
  opts: ResolveOptions,
): string[] {
  return tree.filter((n) => effectiveAt(raw, n, opts).length > 0).map((n) => n.id);
}

/**
 * A canonical, order-independent description of what a list of bindings grants: one line per
 * distinct `(role, team, agent, permissions)`. Two lists with the same fingerprint are
 * indistinguishable to `hasPermission`, `visibleTeams`, `visibleAgents`, the approval role check
 * and `effectivePermissions`.
 */
export function bindingFingerprint(bindings: readonly RoleBinding[]): string[] {
  const lines = bindings.map((b) =>
    [
      b.role,
      b.teamId ?? '',
      b.agentId ?? '',
      [...new Set(bindingPermissions(b))].sort().join(','),
    ].join('|'),
  );
  return [...new Set(lines)].sort();
}

/** True when two binding lists grant exactly the same (see {@link bindingFingerprint}). */
export function sameBindings(a: readonly RoleBinding[], b: readonly RoleBinding[]): boolean {
  const fa = bindingFingerprint(a);
  const fb = bindingFingerprint(b);
  return fa.length === fb.length && fa.every((line, i) => line === fb[i]);
}
