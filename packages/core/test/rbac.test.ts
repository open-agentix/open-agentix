import { describe, expect, it } from 'vitest';
import {
  BINDING_ROLES,
  GRANTABLE_ROLES,
  PENTEST_MAX_DAYS_LIMIT,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  USE_CASE_PERMISSIONS,
  effectivePermissions,
  hasPermission,
  hasPermissionIn,
  hasUseCasePermission,
  isValidUseCase,
  minimalUseCases,
  useCaseCovers,
  useCaseScopes,
  isPermission,
  isRole,
  visibleAgents,
  visibleTeams,
  type Principal,
} from '../src/index.js';

const user = (bindings: Principal['bindings'], scopes?: Principal['scopes']): Principal => ({
  kind: 'user',
  userId: 'u1',
  tenantId: 't1',
  platformAdmin: false,
  displayName: 'U',
  bindings,
  scopes,
});

describe('rbac', () => {
  it('admin has every permission', () => {
    expect(ROLE_PERMISSIONS.admin).toEqual(PERMISSIONS);
    for (const r of ROLES) expect(ROLE_PERMISSIONS[r].length).toBeGreaterThan(0);
  });

  it('checks team scoped bindings', () => {
    const p = user([{ role: 'operator', teamId: 'sec' }]);
    expect(hasPermission(p, 'runs:approve')).toBe(true);
    expect(hasPermission(p, 'runs:approve', 'sec')).toBe(true);
    expect(hasPermission(p, 'runs:approve', 'ops')).toBe(false);
    expect(hasPermission(p, 'audit:read')).toBe(false);
  });

  it('global bindings apply to every team', () => {
    const p = user([{ role: 'auditor', teamId: null }]);
    expect(hasPermission(p, 'audit:export', 'any')).toBe(true);
    expect(visibleTeams(p, 'runs:read')).toBe('all');
  });

  it('restricts by token scopes', () => {
    const p = user([{ role: 'admin', teamId: null }], ['runs:read']);
    expect(hasPermission(p, 'runs:read')).toBe(true);
    expect(hasPermission(p, 'agents:write')).toBe(false);
    expect(visibleTeams(p, 'agents:read')).toEqual([]);
    expect(effectivePermissions(p)).toEqual(['runs:read']);
  });

  it('lists visible teams and effective permissions', () => {
    const p = user([
      { role: 'viewer', teamId: 'a' },
      { role: 'operator', teamId: 'b' },
    ]);
    expect(visibleTeams(p, 'runs:read')).toEqual(['a', 'b']);
    expect(visibleTeams(p, 'runs:approve')).toEqual(['b']);
    expect(effectivePermissions(p)).toContain('runs:cancel');
  });

  it('type guards', () => {
    expect(isRole('auditor')).toBe(true);
    expect(isRole('root')).toBe(false);
    expect(isPermission('runs:read')).toBe(true);
    expect(isPermission('runs:delete')).toBe(false);
  });
});

describe('agent-scoped bindings', () => {
  const p = user([
    { role: 'agent-maintainer', teamId: 'sec', agentId: 'agent-1' },
    { role: 'viewer', teamId: 'ops' },
  ]);

  it('grants the role for exactly one agent', () => {
    expect(hasPermission(p, 'agents:publish')).toBe(true);
    expect(hasPermission(p, 'agents:publish', 'sec', 'agent-1')).toBe(true);
    expect(hasPermission(p, 'agents:publish', 'sec', 'agent-3')).toBe(false);
    expect(hasPermission(p, 'agents:read', 'sec', 'agent-3')).toBe(false);
    expect(hasPermission(p, 'agents:read', 'sec')).toBe(false);
    expect(hasPermission(p, 'agents:publish', undefined, 'agent-1')).toBe(true);
    expect(hasPermission(p, 'agents:publish', undefined, 'agent-2')).toBe(false);
    expect(hasPermission(p, 'agents:read', 'ops', 'agent-9')).toBe(true);
  });

  it('does not grant team-wide visibility', () => {
    expect(visibleTeams(p, 'agents:read')).toEqual(['ops']);
    expect(visibleAgents(p, 'agents:read')).toEqual(['agent-1']);
    expect(visibleAgents(p, 'runs:approve')).toEqual([]);
    expect(
      visibleAgents(
        user([{ role: 'admin', teamId: null, agentId: 'a' }], ['runs:read']),
        'agents:read',
      ),
    ).toEqual([]);
  });
});

describe('pentest role (ADR 0014 S6)', () => {
  it('is a binding role but not a grantable role', () => {
    expect(BINDING_ROLES).toContain('pentest');
    expect((GRANTABLE_ROLES as readonly string[]).includes('pentest')).toBe(false);
    expect(PENTEST_MAX_DAYS_LIMIT).toBe(30);
  });
  it('holds read permissions only: no write, execute, approve, cancel, publish, export or token creation', () => {
    const perms = ROLE_PERMISSIONS.pentest;
    expect(perms.length).toBeGreaterThan(0);
    for (const p of perms) expect(p, p).toMatch(/:(read|verify)$/);
    expect(perms).not.toContain('tokens:write');
    expect(perms).not.toContain('audit:export');
  });
  it('is never wider than admin and has no permission viewer lacks that is not a read', () => {
    for (const p of ROLE_PERMISSIONS.pentest) expect(ROLE_PERMISSIONS.admin).toContain(p);
  });
});

describe('use-case bindings (slice S8)', () => {
  const uc = (role: Principal['bindings'][number]['role'], useCase: string) =>
    ({
      role,
      teamId: null,
      useCase,
      permissions: ROLE_PERMISSIONS[role].filter((p) => USE_CASE_PERMISSIONS.includes(p)),
    }) satisfies Principal['bindings'][number];

  it('never count as a node-wide binding (fail closed for services that do not know them)', () => {
    const p = user([uc('admin', 'security')]);
    for (const perm of PERMISSIONS) {
      expect(hasPermission(p, perm), perm).toBe(false);
      expect(hasPermission(p, perm, 'team'), perm).toBe(false);
      expect(visibleTeams(p, perm), perm).toEqual([]);
      expect(visibleAgents(p, perm), perm).toEqual([]);
    }
  });

  it('are read through useCaseScopes and hasPermissionIn', () => {
    const p = user([
      uc('operator', 'security'),
      uc('viewer', 'security/appsec'),
      uc('viewer', 'ops'),
    ]);
    expect(useCaseScopes(p, 'runs:read')).toEqual(['ops', 'security']);
    expect(useCaseScopes(p, 'runs:approve')).toEqual(['security']);
    expect(useCaseScopes(p, 'connections:read')).toEqual([]);
    expect(hasUseCasePermission(p, 'runs:execute')).toBe(true);
    expect(hasUseCasePermission(p, 'agents:write')).toBe(false);
    const inSecurity = { useCase: 'security/appsec/x', teamId: 't1', agentId: 'a1' };
    expect(hasPermissionIn(p, 'runs:approve', inSecurity)).toBe(true);
    expect(hasPermissionIn(p, 'runs:approve', { useCase: 'ops' })).toBe(false);
    // per segment, not per character; no label, no match
    expect(hasPermissionIn(p, 'runs:read', { useCase: 'securityx' })).toBe(false);
    expect(hasPermissionIn(p, 'runs:read', { useCase: null })).toBe(false);
    expect(hasPermissionIn(p, 'runs:read', {})).toBe(false);
  });

  it('combine with node-wide and team bindings as a union', () => {
    const p = user([{ role: 'viewer', teamId: 'sec' }, uc('operator', 'ops')]);
    expect(hasPermissionIn(p, 'runs:read', { teamId: 'sec', useCase: 'other' })).toBe(true);
    expect(hasPermissionIn(p, 'runs:execute', { teamId: 'sec', useCase: 'other' })).toBe(false);
    expect(hasPermissionIn(p, 'runs:execute', { useCase: 'ops/oncall' })).toBe(true);
    // on an agent of a team a use-case binding gives the read side only
    expect(hasPermissionIn(p, 'runs:execute', { teamId: 'x', useCase: 'ops/oncall' })).toBe(false);
    expect(hasPermissionIn(p, 'runs:read', { teamId: 'x', useCase: 'ops/oncall' })).toBe(true);
  });

  it('honour token scopes and the use-case permission list', () => {
    const scoped = user([uc('admin', 'security')], ['runs:read']);
    expect(useCaseScopes(scoped, 'runs:read')).toEqual(['security']);
    expect(useCaseScopes(scoped, 'agents:read')).toEqual([]);
    // a binding that claims more than the use-case permissions cannot widen them
    const forged = user([
      { role: 'admin', teamId: null, useCase: 'security' } as Principal['bindings'][number],
    ]);
    expect(useCaseScopes(forged, 'settings:write')).toEqual([]);
    expect(useCaseScopes(forged, 'connections:write')).toEqual([]);
    expect(useCaseScopes(forged, 'runs:cancel')).toEqual(['security']);
  });

  it('are ignored when they are team or agent scoped (a use case never narrows those)', () => {
    const odd = user([
      { role: 'admin', teamId: 't1', useCase: 'security' },
      { role: 'admin', teamId: null, agentId: 'a1', useCase: 'security' },
    ]);
    expect(useCaseScopes(odd, 'runs:read')).toEqual([]);
  });
});

describe('use-case syntax', () => {
  it('accepts segments of letters, digits and . _ -', () => {
    for (const v of ['a', 'security', 'security/appsec', 'a.b_c-d/e1', 'A/B/C'])
      expect(isValidUseCase(v), v).toBe(true);
  });
  it('rejects anything that could change the matching rules', () => {
    for (const v of [
      '',
      '/',
      'a/',
      '/a',
      'a//b',
      'a b',
      'a%',
      'a_%',
      '-a',
      '.a',
      'a/..',
      'ä',
      ' a',
      'a\n',
      'x'.repeat(201),
    ])
      expect(isValidUseCase(v), JSON.stringify(v)).toBe(false);
    expect(isValidUseCase(null)).toBe(false);
    expect(isValidUseCase(7)).toBe(false);
  });
  it('covers per segment', () => {
    expect(useCaseCovers('support', 'support')).toBe(true);
    expect(useCaseCovers('support', 'support/billing/refunds')).toBe(true);
    expect(useCaseCovers('support', 'supported')).toBe(false);
    expect(useCaseCovers('support/billing', 'support')).toBe(false);
    expect(useCaseCovers('support', null)).toBe(false);
    expect(useCaseCovers('support/', 'support/x')).toBe(false); // invalid scope covers nothing
    expect(minimalUseCases(['a/b', 'a', 'b', 'a', 'bad scope'])).toEqual(['a', 'b']);
  });
});
