/** Roles from the product spec; permissions are granted per role, optionally scoped to a team. */
export const ROLES = [
  'admin',
  'agent-engineer',
  'integrator',
  'operator',
  'auditor',
  'viewer',
] as const;
export type Role = (typeof ROLES)[number];

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
};

export interface RoleBinding {
  role: Role;
  /** `null` = global (all teams). */
  teamId: string | null;
}

export interface Principal {
  kind: 'user' | 'token';
  userId: string;
  displayName: string;
  bindings: RoleBinding[];
  /** API tokens may be restricted to a subset of permissions; `undefined` = no restriction. */
  scopes?: readonly Permission[] | undefined;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
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
): boolean {
  if (principal.scopes && !principal.scopes.includes(permission)) return false;
  return principal.bindings.some(
    (b) =>
      ROLE_PERMISSIONS[b.role].includes(permission) &&
      (teamId === undefined || b.teamId === null || b.teamId === teamId),
  );
}

/** Team ids the principal can see for `permission`; `'all'` for global bindings. */
export function visibleTeams(principal: Principal, permission: Permission): 'all' | string[] {
  if (principal.scopes && !principal.scopes.includes(permission)) return [];
  const teams = new Set<string>();
  for (const b of principal.bindings) {
    if (!ROLE_PERMISSIONS[b.role].includes(permission)) continue;
    if (b.teamId === null) return 'all';
    teams.add(b.teamId);
  }
  return [...teams];
}

/** Union of permissions over all bindings (used to cap the scopes of newly created API tokens). */
export function effectivePermissions(principal: Principal): Permission[] {
  const set = new Set<Permission>();
  for (const b of principal.bindings) for (const p of ROLE_PERMISSIONS[b.role]) set.add(p);
  return PERMISSIONS.filter(
    (p) => set.has(p) && (!principal.scopes || principal.scopes.includes(p)),
  );
}
