import { describe, expect, it } from 'vitest';
import {
  GRANTABLE_ROLES,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
  isGrantableRole,
  isRole,
  type Permission,
  type Principal,
  type Role,
} from '../src/index.js';

/** ADR 0017 section 5.2 and 10 (slice S10): the Agent Developer and Agent Maintainer roles. */
const READ_BASICS: Permission[] = ['agents:read', 'runs:read', 'events:read', 'costs:read'];

const DEVELOPER: Permission[] = [
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
  'secrets:read',
];

/** The permissions the removed role `agent-engineer` held before this slice. */
const OLD_ENGINEER: Permission[] = [
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
];

const NEW_PERMISSIONS: Permission[] = [
  'agents:review',
  'agents:approve',
  'agents:rules',
  'secrets:read',
];

const sorted = (p: readonly Permission[]) => [...p].sort();

describe('agent roles', () => {
  it('knows the two roles and no longer the old name', () => {
    for (const r of ['agent-developer', 'agent-maintainer']) {
      expect(isRole(r)).toBe(true);
      expect(isGrantableRole(r)).toBe(true);
    }
    expect(isRole('agent-engineer')).toBe(false);
    expect(isGrantableRole('agent-engineer')).toBe(false);
    expect(ROLES).not.toContain('agent-engineer');
    expect(GRANTABLE_ROLES).toEqual([
      'admin',
      'agent-developer',
      'agent-maintainer',
      'integrator',
      'operator',
      'auditor',
      'viewer',
    ]);
  });

  it('gives the Agent Developer exactly the permissions of section 5.2', () => {
    expect(sorted(ROLE_PERMISSIONS['agent-developer'])).toEqual(sorted(DEVELOPER));
    expect(ROLE_PERMISSIONS['agent-developer']).not.toContain('agents:publish');
    expect(ROLE_PERMISSIONS['agent-developer']).not.toContain('agents:rules');
  });

  it('gives the Agent Maintainer the developer plus publish and rules, nothing else', () => {
    expect(sorted(ROLE_PERMISSIONS['agent-maintainer'])).toEqual(
      sorted([...DEVELOPER, 'agents:publish', 'agents:rules']),
    );
  });

  it('keeps every permission the old agent-engineer had and adds only the new agent permissions', () => {
    const maintainer = new Set<Permission>(ROLE_PERMISSIONS['agent-maintainer']);
    for (const p of OLD_ENGINEER) expect(maintainer.has(p), p).toBe(true);
    const added = [...maintainer].filter((p) => !OLD_ENGINEER.includes(p));
    expect(sorted(added)).toEqual(sorted(NEW_PERMISSIONS));
  });

  it.each(['agent-developer', 'agent-maintainer'] as const)(
    '%s holds nothing that manages access, settings, audit or connections',
    (role) => {
      const perms = ROLE_PERMISSIONS[role];
      for (const forbidden of [
        'users:read',
        'users:write',
        'settings:read',
        'settings:write',
        'sources:write',
        'connections:write',
        'policies:write',
        'audit:read',
        'audit:verify',
        'audit:export',
        'runs:approve',
      ] as const)
        expect(perms, forbidden).not.toContain(forbidden);
      // strictly below admin: a maintainer is not an admin
      expect(perms.length).toBeLessThan(ROLE_PERMISSIONS.admin.length);
    },
  );

  it('matches the role matrix of section 10 for the three new permissions', () => {
    const holders = (p: Permission) => ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(p)).sort();
    expect(holders('agents:review')).toEqual(
      ['admin', 'agent-developer', 'agent-maintainer', 'auditor', 'integrator', 'operator'].sort(),
    );
    expect(holders('agents:approve')).toEqual(
      ['admin', 'agent-developer', 'agent-maintainer', 'operator'].sort(),
    );
    expect(holders('agents:rules')).toEqual(['admin', 'agent-maintainer']);
    expect(holders('agents:publish')).toEqual(['admin', 'agent-maintainer']);
  });

  it('leaves the viewer without any of the new permissions (the pentest role sees secret metadata only)', () => {
    for (const role of ['viewer'] as Role[])
      for (const p of NEW_PERMISSIONS)
        expect(ROLE_PERMISSIONS[role], `${role} ${p}`).not.toContain(p);
    expect(sorted(ROLE_PERMISSIONS.viewer)).toEqual(sorted(READ_BASICS));
  });

  it('keeps the other roles unchanged except for the review and approve permissions', () => {
    const before: Record<string, Permission[]> = {
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
    };
    for (const [role, old] of Object.entries(before)) {
      const now = ROLE_PERMISSIONS[role as Role].filter((p) => !old.includes(p));
      // ADR 0017 section 13.4: integrator manages secrets, the auditor sees their metadata.
      const added: Record<string, Permission[]> = {
        operator: ['agents:review', 'agents:approve'],
        integrator: ['agents:review', 'secrets:read', 'secrets:write'],
        auditor: ['agents:review', 'secrets:read'],
      };
      expect(sorted(now), role).toEqual(sorted(added[role]!));
      for (const p of old) expect(ROLE_PERMISSIONS[role as Role], `${role} ${p}`).toContain(p);
    }
  });

  it('lets admin hold every permission', () => {
    expect(ROLE_PERMISSIONS.admin).toEqual(PERMISSIONS);
  });

  it('enforces publish by role through hasPermission', () => {
    const as = (role: Role): Principal => ({
      kind: 'user',
      userId: 'u',
      tenantId: 't',
      displayName: 'U',
      platformAdmin: false,
      bindings: [{ role, teamId: null }],
    });
    expect(hasPermission(as('agent-developer'), 'agents:publish')).toBe(false);
    expect(hasPermission(as('agent-maintainer'), 'agents:publish')).toBe(true);
    expect(hasPermission(as('agent-developer'), 'agents:approve')).toBe(true);
    expect(hasPermission(as('agent-developer'), 'agents:rules')).toBe(false);
  });
});
