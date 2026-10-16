import type { GrantsAndHome } from './tenancy/grants-codec.js';

/**
 * Roles that user create/patch, team and agent members and group mappings accept. `pentest` needs
 * an expiry and its own grant rules (ADR 0014 sections 7 and 8, slice S6), so only the
 * role-binding API accepts it ({@link BINDING_ROLES}); everywhere else it stays refused.
 */
export const GRANTABLE_ROLES = [
  'admin',
  'agent-developer',
  'agent-maintainer',
  'integrator',
  'operator',
  'auditor',
  'viewer',
] as const;

/**
 * Roles from the product spec; permissions are granted per role, optionally scoped to a team.
 * `pentest` (ADR 0014 section 8: time-boxed read-only access for penetration tests) is granted
 * through the role-binding API only, with a mandatory expiry (slice S6).
 */
export const ROLES = [...GRANTABLE_ROLES, 'pentest'] as const;
/** Roles the role-binding API accepts: the legacy six plus the time-boxed `pentest`. */
export const BINDING_ROLES = ROLES;
/** Upper bound of `OAX_PENTEST_MAX_DAYS` (ADR 0014 section 7, rule 7). */
export const PENTEST_MAX_DAYS_LIMIT = 30;
export type Role = (typeof ROLES)[number];
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export const PERMISSIONS = [
  'agents:read',
  'agents:write',
  'agents:publish',
  'agents:review',
  'agents:approve',
  'agents:rules',
  'runs:read',
  'runs:execute',
  'runs:cancel',
  'runs:approve',
  'events:read',
  'sources:read',
  'sources:write',
  'connections:read',
  'connections:write',
  'policies:read',
  'policies:write',
  'audit:read',
  'audit:verify',
  'audit:export',
  'costs:read',
  'users:read',
  'users:write',
  'tokens:read',
  'tokens:write',
  'settings:read',
  'settings:write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_BASICS: Permission[] = ['agents:read', 'runs:read', 'events:read', 'costs:read'];

/**
 * What an Agent Developer may do (ADR 0017 section 5.2): build and change agents, open reviews and
 * comment, run published versions. `agents:approve` is held but only counts where the tenant or an
 * agent rule lists the role; it never includes `agents:publish`, `users:write`, `settings:write`
 * or anything that grants access. The Agent Maintainer adds publish and rules on top.
 */
const AGENT_DEVELOPER_PERMISSIONS: readonly Permission[] = [
  ...READ_BASICS,
  'agents:write',
  'agents:review',
  'agents:approve',
  'runs:execute',
  'runs:cancel',
  'sources:read',
  'connections:read',
  'policies:read',
  'tokens:read',
  'tokens:write',
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  admin: PERMISSIONS,
  'agent-developer': AGENT_DEVELOPER_PERMISSIONS,
  'agent-maintainer': [...AGENT_DEVELOPER_PERMISSIONS, 'agents:publish', 'agents:rules'],
  integrator: [
    ...READ_BASICS,
    'agents:review',
    'sources:read',
    'sources:write',
    'connections:read',
    'connections:write',
    'policies:read',
    'tokens:read',
    'tokens:write',
  ],
  operator: [
    ...READ_BASICS,
    'agents:review',
    'agents:approve',
    'runs:execute',
    'runs:cancel',
    'runs:approve',
    'sources:read',
    'tokens:read',
  ],
  auditor: [
    ...READ_BASICS,
    'agents:review',
    'audit:read',
    'audit:verify',
    'audit:export',
    'policies:read',
    'connections:read',
    'sources:read',
    'users:read',
    'settings:read',
  ],
  viewer: READ_BASICS,
  pentest: [
    ...READ_BASICS,
    'sources:read',
    'connections:read',
    'policies:read',
    'audit:read',
    'audit:verify',
    'users:read',
    'tokens:read',
    'settings:read',
  ],
};

/** Where an effective binding comes from (ADR 0014 section 3.2). */
export type BindingSource = 'direct' | 'inherited' | 'attached' | 'team' | 'agent' | 'platform';

export interface RoleBinding {
  role: Role;
  /** `null` = global (all teams). */
  teamId: string | null;
  /**
   * Resource-scoped binding: the role applies to exactly this agent and grants no team-wide
   * visibility (person A may be agent-maintainer for agent 1 without seeing agents 3-5).
   */
  agentId?: string | null;
  /**
   * Permissions this binding grants. Set by the tenant role resolver (the role's permissions after
   * restrictions and the inheritance clamp); when absent the role's permissions apply. It can only
   * narrow: {@link bindingPermissions} never returns a permission the role does not have.
   */
  permissions?: readonly Permission[] | undefined;
  /** Use case the binding is limited to (ADR 0014 section 3.3); informational until slice S8. */
  useCase?: string | null | undefined;
  /** Where the binding comes from; informational, never read by a permission check. */
  source?: BindingSource | undefined;
}

/**
 * The permissions one binding grants: its own `permissions` (intersected with the role's, so a
 * malformed value can never widen a role) or the role's permissions.
 */
export function bindingPermissions(b: RoleBinding): readonly Permission[] {
  const base = ROLE_PERMISSIONS[b.role];
  if (!b.permissions) return base;
  return b.permissions.filter((p) => base.includes(p));
}

/** Who acts inside which tenant: the minimum every tenant-scoped service call needs. */
export interface TenantActor {
  userId: string;
  tenantId: string;
}

export interface Principal extends TenantActor {
  kind: 'user' | 'token';
  displayName: string;
  /** Platform operators manage tenants and may switch the tenant they act in. */
  platformAdmin: boolean;
  bindings: RoleBinding[];
  /**
   * The user's own tenant while `tenantId` is another node of the tree (`X-OAX-Tenant`). Absent
   * when the principal acts in its home tenant. Bindings are always anchored at the home tenant.
   */
  homeTenantId?: string | undefined;
  /**
   * Raw grants of the user's home organisation (ADR 0014 section 3.1). Set only while the read
   * path is `bindings` (`OAX_ROLE_BINDINGS_READ`); `bindings` above is then the resolver's result
   * at the acting node, and the grants let the API evaluate another node without a second load.
   * Never serialised, never sent to a client.
   */
  grants?: GrantsAndHome | undefined;
  /** The authz epoch of the home organisation the principal was built under (with `grants`). */
  authzEpoch?: number | undefined;
  /** API tokens may be restricted to a subset of permissions; `undefined` = no restriction. */
  scopes?: readonly Permission[] | undefined;
}

/** The tenant the principal belongs to, whichever node it currently acts in. */
export function homeTenantOf(principal: Pick<Principal, 'tenantId' | 'homeTenantId'>): string {
  return principal.homeTenantId ?? principal.tenantId;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** True for a role that may be granted today (everything but `pentest`, see GRANTABLE_ROLES). */
export function isGrantableRole(value: string): value is GrantableRole {
  return (GRANTABLE_ROLES as readonly string[]).includes(value);
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Checks whether the principal holds `permission`.
 * Without `teamId` any binding counts (route-level check); with `teamId` only global bindings
 * or bindings for that team count (resource-level check).
 */
export function hasPermission(
  principal: Principal,
  permission: Permission,
  teamId?: string | null,
  agentId?: string | null,
): boolean {
  if (principal.scopes && !principal.scopes.includes(permission)) return false;
  return principal.bindings.some((b) => {
    if (!bindingPermissions(b).includes(permission)) return false;
    if (b.agentId) {
      // Route-level check (no resource given) passes; resource checks need the same agent.
      return teamId === undefined
        ? agentId === undefined || agentId === b.agentId
        : agentId === b.agentId;
    }
    return teamId === undefined || b.teamId === null || b.teamId === teamId;
  });
}

/** Team ids the principal can see for `permission`; `'all'` for global bindings. */
export function visibleTeams(principal: Principal, permission: Permission): 'all' | string[] {
  if (principal.scopes && !principal.scopes.includes(permission)) return [];
  const teams = new Set<string>();
  for (const b of principal.bindings) {
    if (!bindingPermissions(b).includes(permission) || b.agentId) continue;
    if (b.teamId === null) return 'all';
    teams.add(b.teamId);
  }
  return [...teams];
}

/** Agent ids visible through agent-scoped bindings only (in addition to `visibleTeams`). */
export function visibleAgents(principal: Principal, permission: Permission): string[] {
  if (principal.scopes && !principal.scopes.includes(permission)) return [];
  const agents = new Set<string>();
  for (const b of principal.bindings) {
    if (b.agentId && bindingPermissions(b).includes(permission)) agents.add(b.agentId);
  }
  return [...agents];
}

/** Union of permissions over all bindings (used to cap the scopes of newly created API tokens). */
export function effectivePermissions(principal: Principal): Permission[] {
  const set = new Set<Permission>();
  for (const b of principal.bindings) for (const p of bindingPermissions(b)) set.add(p);
  return PERMISSIONS.filter(
    (p) => set.has(p) && (!principal.scopes || principal.scopes.includes(p)),
  );
}
