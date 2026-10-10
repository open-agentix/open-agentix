/**
 * Roles that may be granted today (user create/patch, team and agent members, group mapping).
 * `pentest` needs an expiry and its own grant rules (ADR 0014 sections 7 and 8, slice S6), so it is
 * refused everywhere a role is accepted until then.
 */
export const GRANTABLE_ROLES = [
  'admin',
  'agent-engineer',
  'integrator',
  'operator',
  'auditor',
  'viewer',
] as const;

/**
 * Roles from the product spec; permissions are granted per role, optionally scoped to a team.
 * `pentest` (ADR 0014 section 8: time-boxed read-only access for penetration tests) exists in the
 * role set so the resolver and the database know it, but nothing can grant it before slice S6.
 */
export const ROLES = [...GRANTABLE_ROLES, 'pentest'] as const;
export type Role = (typeof ROLES)[number];
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export const PERMISSIONS = [
  'agents:read',
  'agents:write',
  'agents:publish',
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

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  admin: PERMISSIONS,
  'agent-engineer': [
    ...READ_BASICS,
    'agents:write',
    'agents:publish',
    'runs:execute',
    'runs:cancel',
    'sources:read',
    'connections:read',
    'policies:read',
    'tokens:read',
    'tokens:write',
  ],
  integrator: [
    ...READ_BASICS,
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
    'runs:execute',
    'runs:cancel',
    'runs:approve',
    'sources:read',
    'tokens:read',
  ],
  auditor: [
    ...READ_BASICS,
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
   * visibility (person A may be agent-engineer for agent 1 without seeing agents 3-5).
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
