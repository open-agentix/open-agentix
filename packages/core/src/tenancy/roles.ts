import {
  ROLE_PERMISSIONS,
  USE_CASE_PERMISSIONS,
  bindingPermissions,
  isRole,
  type BindingSource,
  type Permission,
  type Role,
  type RoleBinding,
} from '../rbac.js';
import { MAX_TENANT_DEPTH, isValidPath, pathIds } from './path.js';
import { isValidUseCase } from './use-case.js';

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
 * - **The role is the ceiling.** An inherited binding gives what its role gives at the node where
 *   it applies, after restrictions, never more (write inheritance, slice S5; the read-only clamp of
 *   the first slices is gone). What an inheriting administrator may do to the tree and to grants is
 *   decided by the grant rules, not here.
 * - **Union, minus restrictions.** Restrictions only ever remove permissions, never from `admin`
 *   and never for bindings that sit above the restricting node.
 * - **Use-case bindings (slice S8).** A binding with a use case applies at its own node only, as a
 *   binding limited to that use case (`useCase` stays on the result; it carries the permissions of
 *   the role that resources with a use case have, never node-wide ones). With `inherit` it also
 *   applies, **unrestricted**, in the child nodes attached to the use case and their whole subtree
 *   (ADR 0014 section 3.3, owner decision 6: attached nodes only with `inherit = true`). The
 *   attachment is data the loader resolved into `attachedNodeIds`; without it nothing is attached.
 * - **Fail closed.** Anything that does not look right (a malformed node path, an unknown role, a
 *   `pentest` binding without an expiry, a malformed use case, a use-case `pentest`) contributes
 *   nothing.
 */

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
  /**
   * For a use-case binding that inherits: the ids of the child nodes of `tenantId` whose
   * `tenants.use_case` is the binding's use case or a sub-use case of it (ADR 0014 section 3.3),
   * resolved by the loader. The binding applies in these nodes and their whole subtrees. Anything
   * else (absent, not a list of child ids) means nothing is attached.
   */
  attachedNodeIds?: readonly string[] | undefined;
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
  /**
   * The role restrictions that can narrow this principal's bindings (ADR 0014 section 5, slice S9):
   * every restriction of the organisation on a node that is the anchor of one of the principal's
   * node, team or agent bindings or an ancestor of it. The loader picks them with the principal's
   * grants, so a cached principal carries them and an authz epoch bump (a restriction is written)
   * drops both together. Restrictions on nodes off the chain of the node being resolved are
   * ignored by the resolver. Absent = none.
   */
  restrictions?: readonly RoleRestriction[] | undefined;
}

/** A permission removed from a role for bindings at a node and below (ADR 0014 section 5). */
export interface RoleRestriction {
  tenantId: string;
  role: Role;
  permission: Permission;
}

/** A permission a restriction removed from a binding, and the node whose restriction did it. */
export interface RestrictedPermission {
  permission: Permission;
  /** The restricting node (on the chain of the binding's node, the binding's own node included). */
  tenantId: string;
}

export interface ResolveOptions {
  now: Date;
  /**
   * Restrictions on the chain of the acting node; anything else is ignored. They are applied in
   * addition to `raw.restrictions` (restrictions only ever remove, so the union is the safe way to
   * combine two sources).
   */
  restrictions?: readonly RoleRestriction[] | undefined;
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
  /**
   * Permissions of the binding's role that a role restriction removed, with the restricting node
   * (the deepest one when several remove the same permission). Empty when nothing was removed.
   * Explanation only (`role_restricted` in the access views); `permissions` already excludes them.
   */
  restrictedBy: readonly RestrictedPermission[];
}

type RestrictionIndex = Map<Role, Map<string, Permission[]>>;
const indexCache = new WeakMap<readonly RoleRestriction[], RestrictionIndex>();

/**
 * Restrictions by role and node, built once per list (the list object is the cache key, so every
 * resolution against the same grants shares it). `undefined` for no restrictions.
 */
function restrictionIndex(
  list: readonly RoleRestriction[] | undefined,
): RestrictionIndex | undefined {
  if (!list || list.length === 0) return undefined;
  let index = indexCache.get(list);
  if (index) return index;
  index = new Map();
  for (const r of list) {
    let byNode = index.get(r.role);
    if (!byNode) index.set(r.role, (byNode = new Map()));
    const perms = byNode.get(r.tenantId);
    if (perms) perms.push(r.permission);
    else byNode.set(r.tenantId, [r.permission]);
  }
  indexCache.set(list, index);
  return index;
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
        restrictedBy: [],
      },
    ];
  }
  // Never across organisations: a node of another organisation gets nothing from this user's grants.
  if (node.rootId !== raw.homeRootId) return [];

  const now = opts.now.getTime();
  const position = new Map(chain.map((id, i) => [id, i] as const));
  // Platform admins returned above, so nothing here can narrow them. `admin` is never narrowed
  // below, whatever the restriction list says (the database refuses such rows, too).
  // Platform operators are never narrowed (ADR 0014 section 5), also when they act with the roles
  // of their home node (`implicitPlatformAdmin: false`): their own restrictions are not consulted.
  const indexes = [
    raw.platformAdmin ? undefined : restrictionIndex(raw.restrictions),
    restrictionIndex(opts.restrictions),
  ].filter((x): x is RestrictionIndex => x !== undefined);

  /**
   * Permissions of `role` for a binding anchored at chain position `at`, after restrictions, and
   * what was removed. A restriction applies iff its node is on the chain at `at` or above, that
   * is: the binding's own node or one of its ancestors (ADR 0014 section 5). A restriction below
   * the binding's node (between it and the acting node) never narrows it: the binding comes from
   * above that node.
   */
  const permissionsFor = (
    role: Role,
    at: number,
  ): { permissions: Permission[]; restrictedBy: RestrictedPermission[] } => {
    const base = ROLE_PERMISSIONS[role];
    // `admin` can never be restricted (a node must not be able to lock out its administrators).
    if (role === 'admin') return { permissions: [...base], restrictedBy: [] };
    const removed = new Map<Permission, number>();
    // Walk only the chain positions 0..at (the binding's node and its ancestors) and look each up in
    // the index: the cost does not depend on how many restrictions the organisation holds.
    for (const index of indexes) {
      const byNode = index.get(role);
      if (!byNode) continue;
      for (let i = 0; i <= at; i++) {
        const perms = byNode.get(chain[i]!);
        if (!perms) continue;
        for (const p of perms) {
          if (!base.includes(p)) continue;
          const prev = removed.get(p);
          if (prev === undefined || i > prev) removed.set(p, i);
        }
      }
    }
    return {
      permissions: base.filter((p) => !removed.has(p)),
      restrictedBy: base
        .filter((p) => removed.has(p))
        .map((p) => ({ permission: p, tenantId: chain[removed.get(p)!]! })),
    };
  };

  const out: AppliedBinding[] = [];

  for (const b of raw.nodeBindings) {
    if (!isRole(b.role)) continue;
    const useCase = b.useCase;
    if (useCase !== null) {
      // A use case that is not in the canonical syntax cannot scope anything (fail closed), and a
      // use-case `pentest` does not exist: pentest is granted by tenant administrators for a node.
      if (!isValidUseCase(useCase) || b.role === 'pentest') continue;
    }
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
    if (b.tenantId === node.id) {
      source = 'direct';
    } else if (useCase !== null) {
      // Attached nodes (section 3.3): only with `inherit`, only the child of the binding's node
      // that is on the chain (the attachment is of that child and its whole subtree), and only
      // when the loader listed that child as attached to this use case.
      const child = chain[at + 1];
      if (
        !b.inherit ||
        child === undefined ||
        !Array.isArray(b.attachedNodeIds) ||
        !b.attachedNodeIds.includes(child)
      )
        continue;
      source = 'attached';
    } else if (b.inherit) {
      source = 'inherited';
    } else {
      continue; // an ancestor's binding that did not opt in
    }
    // No further clamp for inherited bindings (slice S5): the role, minus restrictions, is the
    // ceiling at the node where it applies, exactly as for a binding held there directly. A
    // use-case binding is limited to the permissions that have a use case at its own node; in an
    // attached node it is the unrestricted binding of the same role.
    const scoped = useCase !== null && source === 'direct';
    const narrowed = permissionsFor(b.role, at);
    const permissions = scoped
      ? narrowed.permissions.filter((p) => USE_CASE_PERMISSIONS.includes(p))
      : narrowed.permissions;
    const restrictedBy = scoped
      ? narrowed.restrictedBy.filter((r) => USE_CASE_PERMISSIONS.includes(r.permission))
      : narrowed.restrictedBy;
    out.push({
      role: b.role,
      teamId: null,
      permissions,
      useCase: scoped ? useCase : null,
      source,
      tenantId: b.tenantId,
      inherit: b.inherit,
      expiresAt: b.expiresAt,
      restrictedBy,
    });
  }

  const here = chain.length - 1;
  for (const t of raw.teamBindings) {
    if (t.tenantId !== node.id || !isRole(t.role)) continue;
    const narrowed = permissionsFor(t.role, here);
    out.push({
      role: t.role,
      teamId: t.teamId,
      permissions: narrowed.permissions,
      useCase: null,
      source: 'team',
      tenantId: node.id,
      inherit: false,
      expiresAt: null,
      restrictedBy: narrowed.restrictedBy,
    });
  }
  for (const a of raw.agentBindings) {
    if (a.tenantId !== node.id || !isRole(a.role)) continue;
    const narrowed = permissionsFor(a.role, here);
    out.push({
      role: a.role,
      teamId: a.teamId,
      agentId: a.agentId,
      permissions: narrowed.permissions,
      useCase: null,
      source: 'agent',
      tenantId: node.id,
      inherit: false,
      expiresAt: null,
      restrictedBy: narrowed.restrictedBy,
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
 * distinct `(role, team, agent, use case, permissions)`. Two lists with the same fingerprint are
 * indistinguishable to `hasPermission`, `visibleTeams`, `visibleAgents`, the approval role check
 * and `effectivePermissions`.
 */
export function bindingFingerprint(bindings: readonly RoleBinding[]): string[] {
  const lines = bindings.map((b) =>
    [
      b.role,
      b.teamId ?? '',
      b.agentId ?? '',
      b.useCase ?? '',
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
