import { randomUUID } from 'node:crypto';
import { type Principal, type Role } from '@openagentix/core';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT_ID,
  agentRoleBindings,
  agentVersions,
  agents,
  teamMembers,
  auditLog,
  tenantRoleBindings,
  tenantRoleRestrictions,
  tenants,
  users as usersTable,
} from '../src/db/schema.js';
import { currentAuthzEpoch } from '../src/services/role-bindings.js';
import { sqlTargets } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0014 slice S9 (#194): role restrictions per node. The three invariants (restrictions never add
 * a permission, never narrow a binding from above the restricting node, never affect platform
 * admins) are property-tested in packages/core; here the whole stack: the API, who may write, 404
 * parity, audit, the authz epoch and cached principals, limits, idempotency, concurrency, the
 * legacy read path, and the services that compute permissions (access views, locate). Runs on
 * PGlite and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 *
 *   org-a ─┬─ div-1 ─── team-1        org-b ─── x-unit
 *          └─ div-2
 */
const PW = 'long-password-123';
type Mode = 'legacy' | 'bindings';

describe.each(sqlTargets)('role restrictions (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let target: Awaited<ReturnType<typeof open>>;
  let n: TestNode;
  const id = {} as Record<string, string>;
  const tok = {} as Record<string, string>;
  const uid = {} as Record<string, string>;
  const op = (): Principal => ({
    kind: 'user',
    userId: randomUUID(),
    tenantId: DEFAULT_TENANT_ID,
    displayName: 'op',
    platformAdmin: true,
    bindings: [],
  });
  const setMode = (m: Mode) => {
    (n.ctx.config.auth as unknown as { roleBindingsRead: Mode }).roleBindingsRead = m;
  };
  const bind = (
    user: string,
    tenant: string,
    role: Role,
    inherit: boolean,
    useCase: string | null = null,
  ) =>
    n.ctx.db.insert(tenantRoleBindings).values({
      id: randomUUID(),
      userId: uid[user]!,
      tenantId: id[tenant]!,
      role,
      inherit,
      useCase,
      source: 'grant',
    });
  const mkUser = async (key: string, home: string, roles: Role[] = []) => {
    const email = `${key}@example.org`;
    const u = await n.services.identity.createLocalUser(
      { userId: op().userId, tenantId: id[home]! },
      { email, displayName: key, password: PW, globalRoles: roles },
    );
    uid[key] = u.id;
    tok[key] = await n.login(email, PW);
  };
  const url = (tenant: string) => `/v1/tenants/${id[tenant] ?? tenant}/role-restrictions`;
  const put = (who: string | null, tenant: string, body: Record<string, unknown>) =>
    n.req({
      method: 'PUT',
      url: url(tenant),
      payload: body,
      ...(who === null ? {} : { token: tok[who]! }),
    });
  const del = (who: string, tenant: string, query: string) =>
    n.req({ method: 'DELETE', url: `${url(tenant)}?${query}`, token: tok[who]! });
  const get = (who: string, tenant: string) =>
    n.req({ method: 'GET', url: url(tenant), token: tok[who]! });
  const rows = async (tenant: string) =>
    n.ctx.db
      .select()
      .from(tenantRoleRestrictions)
      .where(eq(tenantRoleRestrictions.tenantId, id[tenant]!));
  const audit = async (action: string, tenant: string) =>
    (
      await n.ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, action))
        .orderBy(asc(auditLog.seq))
    ).filter((e) => e.tenantId === id[tenant]);
  const epoch = (slug: string) => currentAuthzEpoch(n.ctx.db, id[slug]!);
  /** 404 `run` = the route let the caller in; 403 = the permission `runs:cancel` is missing. */
  const cancel = async (who: string, acting?: string) =>
    (
      await n.req({
        method: 'POST',
        url: `/v1/runs/${randomUUID()}/cancel`,
        token: tok[who]!,
        ...(acting ? { headers: { 'x-oax-tenant': id[acting]! } } : {}),
      })
    ).statusCode;
  const access = async (who: string, tenant: string) =>
    (
      await n.req({
        method: 'GET',
        url: `/v1/me/access?tenant=${id[tenant]}`,
        token: tok[who]!,
      })
    ).json() as {
      permissions: { permission: string }[];
      denied: {
        permission: string;
        reason: string;
        role: string;
        restrictedAt: { tenantId: string; tenantSlugPath: string };
      }[];
    };
  const clear = async () => {
    await n.ctx.db.delete(tenantRoleRestrictions);
  };

  beforeAll(async () => {
    target = await open();
    n = await testNode({
      OAX_DATABASE_URL: target.url,
      OAX_ROLE_BINDINGS_READ: 'bindings',
      OAX_RATE_LIMIT_LOGIN_MAX: '100000',
      OAX_RATE_LIMIT_RESTRICTION_MAX: '100000',
      OAX_BINDING_REAPER_INTERVAL_SECONDS: '0',
    });
    id.default = DEFAULT_TENANT_ID;
    for (const slug of ['org-a', 'org-b'])
      id[slug] = (await n.services.tenants.create(op(), { slug, name: `Org ${slug}` })).id;
    const child = async (parent: string, slug: string) => {
      id[slug] = (await n.services.tenants.createChild(op(), id[parent]!, { slug, name: slug })).id;
    };
    await child('org-a', 'div-1');
    await child('div-1', 'team-1');
    await child('org-a', 'div-2');
    await child('org-b', 'x-unit');
    await mkUser('root-admin', 'org-a');
    await bind('root-admin', 'org-a', 'admin', true);
    await mkUser('admin-d1', 'div-1');
    await bind('admin-d1', 'div-1', 'admin', true);
    await mkUser('direct-admin', 'org-a', ['admin']); // admin of org-a that does not inherit
    await mkUser('uc-admin', 'org-a');
    await bind('uc-admin', 'org-a', 'admin', true, 'security'); // use-case administrator
    await mkUser('op-root', 'org-a');
    await bind('op-root', 'org-a', 'operator', true); // operator from above everything
    await mkUser('op-d1', 'div-1');
    await bind('op-d1', 'div-1', 'operator', false); // operator bound at div-1 only
    await mkUser('op-both', 'org-a');
    await bind('op-both', 'org-a', 'operator', true);
    await bind('op-both', 'div-1', 'operator', false);
    await mkUser('legacy-op', 'org-a', ['operator']); // a global role: the legacy sources know it
    await mkUser('viewer', 'org-a');
    await bind('viewer', 'org-a', 'viewer', true);
    await mkUser('auditor', 'org-a');
    await bind('auditor', 'org-a', 'auditor', true);
    await mkUser('admin-b', 'org-b');
    await bind('admin-b', 'org-b', 'admin', true);
    await mkUser('team-op', 'org-a');
    await mkUser('agent-op', 'org-a');
    const team = await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'blue', name: 'blue' },
      headers: { 'x-oax-tenant': id['div-1']! },
      token: tok['root-admin']!,
    });
    expect(team.statusCode, team.body).toBe(201);
    await n.ctx.db
      .insert(teamMembers)
      .values({ teamId: team.json().id, userId: uid['team-op']!, role: 'operator' });
    id.agent = randomUUID();
    await n.ctx.db.insert(agents).values({
      id: id.agent,
      tenantId: id['div-1']!,
      name: 'bound-agent',
      teamId: null,
      draftSource: '# agent',
    });
    await n.ctx.db
      .insert(agentRoleBindings)
      .values({ agentId: id.agent, userId: uid['agent-op']!, role: 'operator' });
    await mkUser('platform-op', 'org-a', ['operator']);
    await n.ctx.db
      .update(usersTable)
      .set({ platformAdmin: true })
      .where(eq(usersTable.id, uid['platform-op']!));
    tok['platform-op'] = await n.login('platform-op@example.org', PW);
    await mkUser('platform', 'org-a');
    await n.ctx.db
      .update(usersTable)
      .set({ platformAdmin: true })
      .where(eq(usersTable.id, uid.platform!));
    tok.platform = await n.login('platform@example.org', PW);
  }, 180_000);
  afterAll(async () => {
    await n.close();
    await target.close();
  });

  describe('the effect (resolver read path)', () => {
    it('a restriction at a node narrows bindings bound there or below, at once, for cached principals', async () => {
      await clear();
      // warm the caches of every token
      expect(await cancel('op-root', 'div-1')).toBe(404);
      expect(await cancel('op-d1')).toBe(404);
      const before = await epoch('org-a');
      const r = await put('root-admin', 'org-a', {
        role: 'operator',
        permissions: ['runs:cancel'],
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ role: 'operator', permissions: ['runs:cancel'] });
      expect(await epoch('org-a')).toBeGreaterThan(before!);
      // the binding bound at org-a (op-root) and the one bound below it (op-d1) are narrowed
      expect(await cancel('op-root', 'div-1')).toBe(403);
      expect(await cancel('op-root', 'org-a')).toBe(403);
      expect(await cancel('op-d1')).toBe(403);
      // other roles and other permissions are untouched
      expect((await access('op-root', 'div-1')).permissions.map((p) => p.permission)).toContain(
        'runs:execute',
      );
      const after = await epoch('org-a');
      expect((await del('root-admin', 'org-a', 'role=operator')).statusCode).toBe(204);
      expect(await epoch('org-a')).toBeGreaterThan(after!);
      expect(await cancel('op-root', 'div-1')).toBe(404);
      expect(await cancel('op-d1')).toBe(404);
    });

    it('a restriction at div-1 narrows what is bound at div-1 and not what comes from above it', async () => {
      await clear();
      expect(
        (await put('admin-d1', 'div-1', { role: 'operator', permissions: ['runs:cancel'] }))
          .statusCode,
      ).toBe(200);
      // bound at div-1 only: narrowed
      expect(await cancel('op-d1')).toBe(403);
      // bound above div-1 (org-a, inheriting): the restriction of a descendant cannot narrow it
      expect(await cancel('op-root', 'div-1')).toBe(404);
      // both: the binding from above still gives the permission, the one at div-1 does not
      expect(await cancel('op-both', 'div-1')).toBe(404);
      const acc = await access('op-both', 'div-1');
      expect(acc.permissions.map((p) => p.permission)).toContain('runs:cancel');
      expect(acc.denied).toEqual([]); // nothing is missing, so nothing is explained away
      // at the restricting node's sibling nothing changed for anybody
      expect(await cancel('op-both', 'div-2')).toBe(404);
      await clear();
    });

    it('explains the removal as role_restricted, with the restricting node', async () => {
      await clear();
      await put('root-admin', 'org-a', { role: 'operator', permissions: ['runs:approve'] });
      const acc = await access('op-root', 'team-1');
      expect(acc.permissions.map((p) => p.permission)).not.toContain('runs:approve');
      expect(acc.denied).toEqual([
        {
          permission: 'runs:approve',
          reason: 'role_restricted',
          role: 'operator',
          restrictedAt: { tenantId: id['org-a'], tenantSlugPath: 'org-a' },
        },
      ]);
      // the answer for another user goes through the same resolver
      const other = await n.req({
        method: 'GET',
        url: `/v1/tenants/${id['team-1']}/access?userId=${uid['op-d1']}`,
        token: tok['root-admin']!,
      });
      expect(other.statusCode).toBe(200);
      await clear();
    });

    it('never affects a platform admin, and cannot narrow admin', async () => {
      await clear();
      await put('root-admin', 'org-a', { role: 'operator', permissions: ['runs:cancel'] });
      // what the platform user holds at div-1, asked by an administrator who sees them
      const view = await n.req({
        method: 'GET',
        url: `/v1/tenants/${id['div-1']}/access?userId=${uid.platform}`,
        token: tok['root-admin']!,
      });
      expect(view.statusCode).toBe(200);
      expect(view.json().permissions).toHaveLength(27);
      expect(view.json().denied).toEqual([]);
      // inserting an admin restriction behind the API's back changes nothing either (the table
      // refuses it, and the resolver ignores it)
      await expect(
        n.ctx.db.insert(tenantRoleRestrictions).values({
          tenantId: id['org-a']!,
          role: 'admin',
          permission: 'users:write',
        }),
      ).rejects.toThrow();
      expect((await access('root-admin', 'div-1')).permissions).toHaveLength(27);
      await clear();
    });

    it('a restricted pentest role narrows like any other role; the new agent roles work the same', async () => {
      await clear();
      expect(
        (await put('root-admin', 'org-a', { role: 'pentest', permissions: ['audit:read'] }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await put('root-admin', 'org-a', {
            role: 'agent-maintainer',
            permissions: ['agents:publish'],
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await put('root-admin', 'org-a', {
            role: 'agent-developer',
            permissions: ['agents:approve'],
          })
        ).statusCode,
      ).toBe(200);
      await clear();
    });

    it('locate and the access views use the same resolver: a restricted read permission hides the resource', async () => {
      await clear();
      const agentId = randomUUID();
      const versionId = randomUUID();
      await n.ctx.db.insert(agents).values({
        id: agentId,
        tenantId: id['div-1']!,
        name: 'restricted-agent',
        teamId: null,
        draftSource: '# agent',
      });
      await n.ctx.db.insert(agentVersions).values({
        id: versionId,
        agentId,
        version: '1.0.0',
        digest: `sha256:${agentId}`,
        source: '# agent',
        definition: {},
      });
      const locate = (who: string) =>
        n.req({ method: 'GET', url: `/v1/locate/agent/${agentId}`, token: tok[who]! });
      expect((await locate('viewer')).statusCode).toBe(200);
      await put('root-admin', 'org-a', { role: 'viewer', permissions: ['agents:read'] });
      const hidden = await locate('viewer');
      expect(hidden.statusCode).toBe(404);
      // identical to an agent that does not exist
      const missing = await n.req({
        method: 'GET',
        url: `/v1/locate/agent/${randomUUID()}`,
        token: tok.viewer!,
      });
      expect(hidden.json()).toEqual(missing.json());
      await clear();
    });
  });

  describe('team and agent bindings (node-local) are narrowed by the restrictions of their node chain', () => {
    for (const who of ['team-op', 'agent-op']) {
      it(`${who}: a restriction at the organisation removes the permission at the division`, async () => {
        await clear();
        const has = async () =>
          (await access(who, 'div-1')).permissions.map((p) => p.permission).includes('runs:cancel');
        expect(await has()).toBe(true);
        expect(
          (await put('root-admin', 'org-a', { role: 'operator', permissions: ['runs:cancel'] }))
            .statusCode,
        ).toBe(200);
        expect(await has()).toBe(false);
        const acc = await access(who, 'div-1');
        expect(acc.denied).toEqual([
          expect.objectContaining({ permission: 'runs:cancel', reason: 'role_restricted' }),
        ]);
        // a restriction at the division itself narrows it too, a sibling's does not
        await clear();
        await put('root-admin', 'div-2', { role: 'operator', permissions: ['runs:cancel'] });
        expect(await has()).toBe(true);
        await put('root-admin', 'div-1', { role: 'operator', permissions: ['runs:cancel'] });
        expect(await has()).toBe(false);
        await clear();
      });
    }
  });

  describe('platform operators are never narrowed', () => {
    it('an operator with a home operator binding keeps it after a restriction at the home organisation', async () => {
      await clear();
      expect(await cancel('platform-op')).toBe(404); // allowed
      await put('root-admin', 'org-a', { role: 'operator', permissions: ['runs:cancel'] });
      expect(await cancel('platform-op')).toBe(404); // still allowed
      // an ordinary operator of the same shape is narrowed
      expect(await cancel('op-root', 'org-a')).toBe(403);
      // and the access view of the operator is the same resolver
      const view = await n.req({
        method: 'GET',
        url: `/v1/tenants/${id['org-a']}/access?userId=${uid['platform-op']}`,
        token: tok['root-admin']!,
      });
      expect(view.json().denied).toEqual([]);
      await clear();
    });
  });

  describe('who may write', () => {
    it('inheriting tenant admins of the node or an ancestor, and platform operators', async () => {
      await clear();
      const body = { role: 'viewer', permissions: ['costs:read'] };
      expect((await put('root-admin', 'div-1', body)).statusCode).toBe(200); // ancestor
      expect((await put('admin-d1', 'div-1', body)).statusCode).toBe(200); // the node itself
      expect((await put('admin-d1', 'team-1', body)).statusCode).toBe(200); // below
      expect((await put('platform', 'org-b', body)).statusCode).toBe(200); // operator
      await clear();
    });

    it('refuses an administrator whose binding does not inherit, a use-case administrator and every other role', async () => {
      const body = { role: 'viewer', permissions: ['costs:read'] };
      const direct = await put('direct-admin', 'org-a', body);
      expect(direct.statusCode).toBe(403);
      expect(direct.json().error).toBe('inheritance_required');
      for (const who of ['uc-admin', 'op-root', 'viewer', 'auditor'])
        expect((await put(who, 'org-a', body)).statusCode, who).toBe(403);
      // the same for reading the list: needs users:read at the node, a use-case admin has none node-wide
      expect((await get('viewer', 'org-a')).statusCode).toBe(403);
      expect((await get('uc-admin', 'org-a')).statusCode).toBe(403);
      expect((await del('op-root', 'org-a', 'role=viewer')).statusCode).toBe(403);
      expect(await rows('org-a')).toEqual([]);
    });

    it('a restricted user cannot lift or change the restriction that narrows them', async () => {
      await clear();
      await put('root-admin', 'org-a', { role: 'operator', permissions: ['runs:cancel'] });
      expect((await del('op-root', 'org-a', 'role=operator')).statusCode).toBe(403);
      // op-d1 sees div-1 but is no administrator
      expect((await put('op-d1', 'div-1', { role: 'operator', permissions: [] })).statusCode).toBe(
        403,
      );
      expect((await rows('org-a')).length).toBe(1);
      await clear();
    });

    it('an administrator below the node cannot touch it: ancestors, siblings and other organisations are 404, like an unknown id', async () => {
      const body = { role: 'viewer', permissions: ['costs:read'] };
      const unknown = await put('admin-d1', randomUUID(), body);
      expect(unknown.statusCode).toBe(404);
      for (const t of ['org-a', 'div-2', 'org-b', 'x-unit']) {
        const r = await put('admin-d1', t, body);
        expect(r.statusCode, t).toBe(404);
        expect(r.json(), t).toEqual(unknown.json());
        expect((await get('admin-d1', t)).statusCode, t).toBe(404);
        expect((await del('admin-d1', t, 'role=viewer')).statusCode, t).toBe(404);
      }
      const other = await put('admin-b', 'org-a', body);
      expect(other.statusCode).toBe(404);
      expect(other.json()).toEqual(unknown.json());
      expect(await rows('org-a')).toEqual([]);
      expect(await rows('div-2')).toEqual([]);
    });

    it('an API token needs the users:write scope', async () => {
      const principal = await n.services.identity.principalForUser(uid['root-admin']!);
      const scoped = await n.services.identity.createApiToken(
        principal,
        'no-users-write',
        ['agents:read'],
        30,
      );
      const r = await n.req({
        method: 'PUT',
        url: url('org-a'),
        token: scoped.token,
        payload: { role: 'viewer', permissions: ['costs:read'] },
      });
      expect(r.statusCode).toBe(403);
      const ok = await n.services.identity.createApiToken(
        principal,
        'users-write',
        ['users:write'],
        30,
      );
      const r2 = await n.req({
        method: 'PUT',
        url: url('org-a'),
        token: ok.token,
        payload: { role: 'viewer', permissions: ['costs:read'] },
      });
      expect(r2.statusCode).toBe(200);
      await clear();
    });
  });

  describe('validation', () => {
    it('refuses admin with a clear 422, unknown roles and permissions, and permissions the role does not hold', async () => {
      const code = async (body: Record<string, unknown>) => {
        const r = await put('root-admin', 'org-a', body);
        return [r.statusCode, r.json().error] as const;
      };
      expect(await code({ role: 'admin', permissions: ['users:write'] })).toEqual([
        422,
        'restriction_on_admin',
      ]);
      expect(await code({ role: 'admin', permissions: [] })).toEqual([422, 'restriction_on_admin']);
      expect(await code({ role: 'root', permissions: ['runs:read'] })).toEqual([
        422,
        'unknown_role',
      ]);
      expect(await code({ role: 'operator', permissions: ['runs:fly'] })).toEqual([
        422,
        'unknown_permission',
      ]);
      expect(await code({ role: 'viewer', permissions: ['users:write'] })).toEqual([
        422,
        'permission_not_in_role',
      ]);
      expect(await rows('org-a')).toEqual([]);
      // the request shape is validated, too
      expect((await put('root-admin', 'org-a', { permissions: [] })).statusCode).toBe(400);
      expect((await del('root-admin', 'org-a', 'permission=runs:read')).statusCode).toBe(400);
      const bad = await del('root-admin', 'org-a', 'role=admin');
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error).toBe('restriction_on_admin');
    });

    it('caps the restrictions per node', async () => {
      await clear();
      const cfg = n.ctx.config.tenancy as { maxRoleRestrictionsPerNode: number };
      const was = cfg.maxRoleRestrictionsPerNode;
      cfg.maxRoleRestrictionsPerNode = 2;
      try {
        expect(
          (
            await put('root-admin', 'org-a', {
              role: 'operator',
              permissions: ['runs:cancel', 'runs:approve'],
            })
          ).statusCode,
        ).toBe(200);
        const over = await put('root-admin', 'org-a', {
          role: 'viewer',
          permissions: ['costs:read'],
        });
        expect(over.statusCode).toBe(422);
        expect(over.json().error).toBe('restriction_limit_exceeded');
        // replacing within the cap is fine
        expect(
          (await put('root-admin', 'org-a', { role: 'operator', permissions: ['runs:cancel'] }))
            .statusCode,
        ).toBe(200);
        expect(
          (await put('root-admin', 'org-a', { role: 'viewer', permissions: ['costs:read'] }))
            .statusCode,
        ).toBe(200);
        expect((await rows('org-a')).length).toBe(2);
        // the cap is per node
        expect(
          (
            await put('root-admin', 'div-1', {
              role: 'operator',
              permissions: ['runs:cancel', 'runs:approve'],
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        cfg.maxRoleRestrictionsPerNode = was;
        await clear();
      }
    });
  });

  describe('limits and the unenforced guard', () => {
    it('caps the restrictions per organisation', async () => {
      await clear();
      const cfg = n.ctx.config.tenancy as { maxRoleRestrictionsPerOrg: number };
      const was = cfg.maxRoleRestrictionsPerOrg;
      cfg.maxRoleRestrictionsPerOrg = 3;
      try {
        expect(
          (
            await put('root-admin', 'org-a', {
              role: 'operator',
              permissions: ['runs:cancel', 'runs:approve'],
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (await put('root-admin', 'div-1', { role: 'operator', permissions: ['runs:cancel'] }))
            .statusCode,
        ).toBe(200);
        const over = await put('root-admin', 'div-2', {
          role: 'operator',
          permissions: ['runs:cancel'],
        });
        expect(over.statusCode).toBe(422);
        expect(over.json().error).toBe('restriction_limit_exceeded');
        // another organisation is counted separately
        expect(
          (await put('admin-b', 'org-b', { role: 'operator', permissions: ['runs:cancel'] }))
            .statusCode,
        ).toBe(200);
      } finally {
        cfg.maxRoleRestrictionsPerOrg = was;
        await clear();
      }
    });

    it('fails readiness while stored restrictions are not enforced, unless accepted', async () => {
      await clear();
      await put('root-admin', 'org-a', { role: 'operator', permissions: ['runs:cancel'] });
      const ready = () => n.req({ method: 'GET', url: '/readyz', token: null });
      expect((await ready()).statusCode).toBe(200); // enforced: bindings
      const auth = n.ctx.config.auth as unknown as {
        roleBindingsRead: Mode;
        allowUnenforcedRestrictions: boolean;
      };
      setMode('legacy');
      try {
        const r = await ready();
        expect(r.statusCode).toBe(503);
        expect(r.json().checks).toMatchObject({ restrictions: false });
        expect(await n.services.roleRestrictions.countUnenforced()).toBe(1);
        auth.allowUnenforcedRestrictions = true;
        expect((await ready()).statusCode).toBe(200);
      } finally {
        auth.allowUnenforcedRestrictions = false;
        setMode('bindings');
        await clear();
      }
      setMode('legacy');
      try {
        expect((await ready()).statusCode).toBe(200); // nothing stored, nothing to enforce
      } finally {
        setMode('bindings');
      }
    });
  });

  describe('audit, idempotency and reads', () => {
    it('is idempotent: the same call twice changes, audits and bumps nothing the second time', async () => {
      await clear();
      const body = { role: 'operator', permissions: ['runs:approve', 'runs:cancel'] };
      const a0 = (await audit('tenant.role_restricted', 'org-a')).length;
      expect((await put('root-admin', 'org-a', body)).statusCode).toBe(200);
      const e1 = await epoch('org-a');
      const a1 = (await audit('tenant.role_restricted', 'org-a')).length;
      expect(a1).toBe(a0 + 1);
      expect(
        (
          await put('root-admin', 'org-a', {
            ...body,
            permissions: [...body.permissions].reverse(),
          })
        ).statusCode,
      ).toBe(200);
      expect(await epoch('org-a')).toBe(e1);
      expect((await audit('tenant.role_restricted', 'org-a')).length).toBe(a1);
      // removing what is not there is not an error either
      expect((await del('root-admin', 'org-a', 'role=viewer')).statusCode).toBe(204);
      expect(await epoch('org-a')).toBe(e1);
      await clear();
    });

    it('audits restrictions and removals in the partition of the node, names only', async () => {
      await clear();
      const r0 = (await audit('tenant.role_restricted', 'div-1')).length;
      const d0 = (await audit('tenant.role_restriction_removed', 'div-1')).length;
      await put('admin-d1', 'div-1', {
        role: 'operator',
        permissions: ['runs:cancel', 'runs:approve'],
      });
      await put('admin-d1', 'div-1', { role: 'operator', permissions: ['runs:cancel'] });
      await del('admin-d1', 'div-1', 'role=operator&permission=runs:cancel');
      const added = await audit('tenant.role_restricted', 'div-1');
      const removed = await audit('tenant.role_restriction_removed', 'div-1');
      expect(added).toHaveLength(r0 + 1);
      expect(added.at(-1)).toMatchObject({
        actor: uid['admin-d1'],
        payload: { role: 'operator', permissions: ['runs:cancel', 'runs:approve'] },
      });
      expect(removed).toHaveLength(d0 + 2);
      expect(removed.at(-2)?.payload).toMatchObject({
        role: 'operator',
        permissions: ['runs:approve'],
      });
      expect(removed.at(-1)?.payload).toMatchObject({
        role: 'operator',
        permissions: ['runs:cancel'],
      });
      expect(await rows('div-1')).toEqual([]);
    });

    it('lists the restrictions of a node for users:read, grouped by role', async () => {
      await clear();
      await put('root-admin', 'org-a', {
        role: 'operator',
        permissions: ['runs:cancel', 'runs:approve'],
      });
      await put('root-admin', 'org-a', { role: 'viewer', permissions: ['costs:read'] });
      const r = await get('root-admin', 'org-a');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        enforced: true,
        items: [
          {
            role: 'operator',
            permissions: ['runs:cancel', 'runs:approve'],
            updatedBy: uid['root-admin'],
          },
          { role: 'viewer', permissions: ['costs:read'] },
        ],
      });
      // the list is the node's own: a descendant lists none
      expect((await get('root-admin', 'div-1')).json().items).toEqual([]);
      // auditors hold users:read
      expect((await get('auditor', 'org-a')).statusCode).toBe(200);
      await clear();
    });

    it('bumps the authz epoch of the organisation for any change of the table, whatever made it (migration 0033)', async () => {
      await clear();
      const row = { tenantId: id['div-1']!, role: 'viewer', permission: 'costs:read' };
      const e0 = (await epoch('org-a'))!;
      await n.ctx.db.insert(tenantRoleRestrictions).values(row);
      const e1 = (await epoch('org-a'))!;
      expect(e1).toBeGreaterThan(e0);
      await n.ctx.db
        .update(tenantRoleRestrictions)
        .set({ permission: 'runs:read' })
        .where(eq(tenantRoleRestrictions.tenantId, row.tenantId));
      const e2 = (await epoch('org-a'))!;
      expect(e2).toBeGreaterThan(e1);
      await n.ctx.db
        .delete(tenantRoleRestrictions)
        .where(eq(tenantRoleRestrictions.tenantId, row.tenantId));
      expect(await epoch('org-a')).toBeGreaterThan(e2);
      // another organisation is not touched
      const b0 = await epoch('org-b');
      await n.ctx.db.insert(tenantRoleRestrictions).values(row);
      expect(await epoch('org-b')).toBe(b0);
      await clear();
    });

    it('goes with the node when it is deleted (foreign key cascade)', async () => {
      const slug = `tmp-${randomUUID().slice(0, 8)}`;
      const t = await n.services.tenants.createChild(op(), id['org-a']!, { slug, name: slug });
      await n.ctx.db
        .insert(tenantRoleRestrictions)
        .values({ tenantId: t.id, role: 'viewer', permission: 'costs:read' });
      await n.ctx.db.delete(tenants).where(eq(tenants.id, t.id));
      expect(
        await n.ctx.db
          .select()
          .from(tenantRoleRestrictions)
          .where(eq(tenantRoleRestrictions.tenantId, t.id)),
      ).toEqual([]);
    });
  });

  describe('concurrency', () => {
    it('serialises concurrent writes: both succeed, the last one wins, nothing is lost or doubled', async () => {
      await clear();
      const calls = Array.from({ length: 6 }, (_, i) =>
        put('root-admin', 'org-a', {
          role: 'operator',
          permissions: i % 2 === 0 ? ['runs:cancel'] : ['runs:approve', 'runs:cancel'],
        }),
      );
      const res = await Promise.all(calls);
      expect(res.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
      const final = (await rows('org-a')).map((r) => r.permission).sort();
      expect([['runs:cancel'], ['runs:approve', 'runs:cancel']]).toContainEqual(final);
      await clear();
    });

    it('a write racing the removal of the writer own authority ends consistent', async () => {
      await clear();
      await mkUser('temp-admin', 'org-a');
      await bind('temp-admin', 'org-a', 'admin', true);
      const bindingRows = () =>
        n.ctx.db
          .select()
          .from(tenantRoleBindings)
          .where(eq(tenantRoleBindings.userId, uid['temp-admin']!));
      const [b] = await bindingRows();
      const [w, d] = await Promise.all([
        put('temp-admin', 'org-a', { role: 'viewer', permissions: ['costs:read'] }),
        n.req({
          method: 'DELETE',
          url: `/v1/tenants/${id['org-a']}/role-bindings/${b!.id}`,
          token: tok['root-admin']!,
        }),
      ]);
      expect([200, 403]).toContain(w.statusCode);
      expect(d.statusCode).toBe(204);
      // whichever order won, the next write by the removed administrator is refused
      expect(
        (await put('temp-admin', 'org-a', { role: 'viewer', permissions: [] })).statusCode,
      ).toBe(403);
      await clear();
    });
  });

  describe('the legacy read path', () => {
    it('refuses writes with 409 and reports that nothing is enforced', async () => {
      await clear();
      await put('root-admin', 'org-a', { role: 'operator', permissions: ['runs:cancel'] });
      setMode('legacy');
      try {
        const w = await put('root-admin', 'org-a', { role: 'viewer', permissions: ['costs:read'] });
        expect(w.statusCode).toBe(409);
        expect(w.json().error).toBe('role_restrictions_require_bindings_read');
        expect((await del('root-admin', 'org-a', 'role=operator')).statusCode).toBe(409);
        // reading still works and says the rows are not applied
        const r = await n.req({ method: 'GET', url: url('org-a'), token: tok['direct-admin']! });
        expect(r.statusCode).toBe(200);
        expect(r.json().enforced).toBe(false);
        // the legacy sources know no restrictions: the global role is not narrowed there
        expect(await cancel('legacy-op')).toBe(404);
      } finally {
        setMode('bindings');
      }
      // back on the resolver path the stored restriction applies again
      expect(await cancel('legacy-op')).toBe(403);
      expect(await cancel('op-d1')).toBe(403);
      await clear();
    });
  });
});
