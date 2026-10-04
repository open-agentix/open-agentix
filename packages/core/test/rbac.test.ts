import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  effectivePermissions,
  hasPermission,
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
    { role: 'agent-engineer', teamId: 'sec', agentId: 'agent-1' },
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
