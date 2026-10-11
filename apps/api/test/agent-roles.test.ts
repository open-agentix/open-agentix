import { ROLE_PERMISSIONS } from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { routeIndex } from '../src/http/app.js';
import { CVE_TRIAGE, agentSource } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0017 slice S10 (#290): the fixed roles `agent-developer` and `agent-maintainer` can be granted
 * everywhere a role can (global, node with and without inherit, team, agent); a developer cannot
 * publish, a maintainer can; `agent-engineer` is an unknown role. Permissions only: publishing and
 * approvals behave as before.
 */
const PW = 'long-password-123';
const ZERO = '00000000-0000-0000-0000-000000000000';

let n: TestNode;
let team: string;
const uid: Record<string, string> = {};
const tok: Record<string, string> = {};

const mk = async (key: string, globalRoles: string[] = []) => {
  const res = await n.req({
    method: 'POST',
    url: '/v1/users',
    payload: { email: `${key}@example.org`, displayName: key, password: PW, globalRoles },
  });
  expect(res.statusCode, res.body).toBe(201);
  uid[key] = res.json().id;
  tok[key] = await n.login(`${key}@example.org`, PW);
};
const bind = (userKey: string, role: string, inherit?: boolean) =>
  n.req({
    method: 'POST',
    url: `/v1/tenants/${DEFAULT_TENANT_ID}/role-bindings`,
    payload: { userId: uid[userKey], role, ...(inherit === undefined ? {} : { inherit }) },
  });

beforeAll(async () => {
  n = await testNode();
  team = (
    await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-security', name: 'Security' },
    })
  ).json().id;
  await mk('dev');
  await mk('maint');
  await mk('plain');
  await n.req({
    method: 'PUT',
    url: `/v1/teams/${team}/members`,
    payload: {
      members: [
        { userId: uid['dev'], role: 'agent-developer' },
        { userId: uid['maint'], role: 'agent-maintainer' },
      ],
    },
  });
});
afterAll(async () => n.close());

describe('granting the agent roles', () => {
  it.each(['agent-developer', 'agent-maintainer'])(
    'binds %s on a node with and without inherit',
    async (role) => {
      for (const inherit of [false, true]) {
        const res = await bind('plain', role, inherit);
        expect(res.statusCode, res.body).toBe(201);
        expect(res.json()).toMatchObject({ role, inherit });
        await n.req({
          method: 'DELETE',
          url: `/v1/tenants/${DEFAULT_TENANT_ID}/role-bindings/${res.json().id}`,
        });
      }
    },
  );

  it.each(['agent-developer', 'agent-maintainer'])(
    'accepts %s as a global role, a team member and an agent member',
    async (role) => {
      const created = await n.req({
        method: 'POST',
        url: '/v1/users',
        payload: {
          email: `global-${role}@example.org`,
          displayName: 'G',
          password: PW,
          globalRoles: [role],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().globalRoles).toEqual([role]);
      const members = await n.req({
        method: 'PUT',
        url: `/v1/teams/${team}/members`,
        payload: {
          members: [
            { userId: uid['dev'], role: 'agent-developer' },
            { userId: uid['maint'], role: 'agent-maintainer' },
            { userId: uid['plain'], role },
          ],
        },
      });
      expect(members.statusCode, members.body).toBeLessThan(300);
      const agent = await n.req({
        method: 'POST',
        url: '/v1/agents',
        payload: { source: agentSource(`roles-${role}`, 'team-security') },
      });
      expect(agent.statusCode, agent.body).toBe(201);
      const agentMembers = await n.req({
        method: 'PUT',
        url: `/v1/agents/${agent.json().id}/members`,
        payload: { members: [{ userId: uid['plain'], role }] },
      });
      expect(agentMembers.statusCode, agentMembers.body).toBeLessThan(300);
      const listed = await n.req({ method: 'GET', url: `/v1/agents/${agent.json().id}/members` });
      expect(listed.json().items).toMatchObject([{ role }]);
    },
  );

  it('refuses agent-engineer as an unknown role on every write path', async () => {
    const node = await bind('plain', 'agent-engineer');
    expect(node.statusCode).toBe(400);
    const user = await n.req({
      method: 'POST',
      url: '/v1/users',
      payload: {
        email: 'old@example.org',
        displayName: 'Old',
        password: PW,
        globalRoles: ['agent-engineer'],
      },
    });
    expect(user.statusCode).toBe(400);
    const members = await n.req({
      method: 'PUT',
      url: `/v1/teams/${team}/members`,
      payload: { members: [{ userId: uid['plain'], role: 'agent-engineer' }] },
    });
    expect(members.statusCode).toBe(400);
    const patch = await n.req({
      method: 'PATCH',
      url: `/v1/users/${uid['plain']}`,
      payload: { globalRoles: ['agent-engineer'] },
    });
    expect(patch.statusCode).toBe(400);
  });

  it('does not let an Agent Maintainer or Developer grant any role (grant rules unchanged)', async () => {
    for (const who of ['dev', 'maint']) {
      for (const role of ['agent-developer', 'agent-maintainer', 'viewer']) {
        const res = await n.req({
          method: 'POST',
          url: `/v1/tenants/${DEFAULT_TENANT_ID}/role-bindings`,
          token: tok[who]!,
          payload: { userId: uid['plain'], role, inherit: false },
        });
        expect(res.statusCode, `${who} grants ${role}: ${res.body}`).toBe(403);
      }
      const users = await n.req({
        method: 'POST',
        url: '/v1/users',
        token: tok[who]!,
        payload: { email: `x-${who}@example.org`, displayName: 'x', password: PW },
      });
      expect(users.statusCode).toBe(403);
    }
  });

  it('exposes both roles and their permissions in the settings API', async () => {
    const res = await n.req({ method: 'GET', url: '/v1/settings' });
    const body = res.json();
    expect(body.roles).toEqual(expect.arrayContaining(['agent-developer', 'agent-maintainer']));
    expect(body.roles).not.toContain('agent-engineer');
    expect(body.rolePermissions['agent-maintainer']).toEqual([
      ...ROLE_PERMISSIONS['agent-maintainer'],
    ]);
  });
});

describe('publishing by role', () => {
  let agentId: string;

  it('lets an Agent Developer create a draft but not publish it', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      token: tok['dev']!,
      payload: { source: CVE_TRIAGE },
    });
    expect(created.statusCode, created.body).toBe(201);
    agentId = created.json().id;
    const publish = await n.req({
      method: 'POST',
      url: `/v1/agents/${agentId}/publish`,
      token: tok['dev']!,
    });
    expect(publish.statusCode).toBe(403);
  });

  it('lets an Agent Maintainer publish', async () => {
    const publish = await n.req({
      method: 'POST',
      url: `/v1/agents/${agentId}/publish`,
      token: tok['maint']!,
    });
    expect(publish.statusCode, publish.body).toBe(201);
  });

  it('route table: an Agent Developer gets 403 on every agents:publish route, a Maintainer does not', async () => {
    const routes = routeIndex(n.app).filter((r) => String(r.access) === 'agents:publish');
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      const url = r.url.replace(/:[A-Za-z]+/g, ZERO);
      const payload = r.method === 'GET' || r.method === 'DELETE' ? undefined : {};
      const dev = await n.req({ method: r.method as 'POST', url, token: tok['dev']!, payload });
      expect(dev.statusCode, `${r.method} ${r.url}`).toBe(403);
      const maint = await n.req({ method: r.method as 'POST', url, token: tok['maint']!, payload });
      expect(maint.statusCode, `${r.method} ${r.url}`).not.toBe(403);
    }
  });

  it('leaves the existing run approval path to the operator only', async () => {
    const approve = routeIndex(n.app).filter((r) => String(r.access) === 'runs:approve');
    expect(approve.length).toBeGreaterThan(0);
    for (const r of approve) {
      const url = r.url.replace(/:[A-Za-z]+/g, ZERO);
      for (const who of ['dev', 'maint']) {
        const res = await n.req({
          method: r.method as 'POST',
          url,
          token: tok[who]!,
          payload: {},
        });
        expect(res.statusCode, `${who} ${r.method} ${r.url}`).toBe(403);
      }
    }
  });
});
