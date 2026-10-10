import { randomUUID } from 'node:crypto';
import { type Principal, type Role } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TENANT_ID,
  auditLog,
  tenantRoleBindings,
  tenants as tenantsTable,
  agentRoleBindings,
  agents as agentsTable,
  teamMembers,
  users as usersTable,
} from '../src/db/schema.js';
import { sqlTargets } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0014 S5 hardening (review of #302): user lifecycle across the hierarchy (a subordinate
 * administrator cannot disable, demote or revoke a superior), budgets below capped nodes, reserved
 * slugs, check ordering, platform-admin targets and the legacy read path of the access endpoint, and
 * a walk over the `authenticated` tenant routes with realistic bodies.
 *
 *   org-a ─┬─ div-1 ─── team-1        org-c, org-d (last-admin scenarios)
 *          └─ div-2
 */
const PW = 'long-password-123';
type Mode = 'legacy' | 'bindings';

describe.each(sqlTargets)('hierarchy hardening (%s)', (_kind, enabled, open) => {
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
    over: Partial<typeof tenantRoleBindings.$inferInsert> = {},
  ) =>
    n.ctx.db.insert(tenantRoleBindings).values({
      id: randomUUID(),
      userId: uid[user]!,
      tenantId: id[tenant]!,
      role,
      inherit,
      source: 'grant',
      ...over,
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
  const call = (
    who: string | null,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
    acting?: string,
  ) =>
    n.req({
      method,
      url,
      ...(payload ? { payload } : {}),
      ...(who === null ? {} : { token: tok[who]! }),
      ...(acting ? { headers: { 'x-oax-tenant': acting } } : {}),
    });
  const alive = async (who: string) => (await call(who, 'GET', '/v1/me')).statusCode === 200;
  const count = async () => (await n.ctx.db.select().from(tenantsTable)).length;

  beforeAll(async () => {
    target = await open();
    n = await testNode({
      OAX_DATABASE_URL: target.url,
      OAX_ROLE_BINDINGS_READ: 'bindings',
      OAX_RATE_LIMIT_LOGIN_MAX: '10000',
    });
    id.default = DEFAULT_TENANT_ID;
    for (const slug of ['org-a', 'org-b', 'org-c', 'org-d'])
      id[slug] = (await n.services.tenants.create(op(), { slug, name: slug })).id;
    const mk = async (parent: string, slug: string) => {
      id[slug] = (await n.services.tenants.createChild(op(), id[parent]!, { slug, name: slug })).id;
    };
    await mk('org-a', 'div-1');
    await mk('div-1', 'team-1');
    await mk('org-a', 'div-2');
    // the PoC: the only inheriting admin of org-a lives in team-1, below a division admin
    await mkUser('root-admin', 'team-1');
    await bind('root-admin', 'org-a', 'admin', true);
    await mkUser('div-admin', 'div-1');
    await bind('div-admin', 'div-1', 'admin', true);
    await mkUser('victim', 'team-1', ['viewer']); // only local roles
    await mkUser('victim-up', 'team-1', ['viewer']); // also admin of the sibling division
    await bind('victim-up', 'div-2', 'admin', false);
    await mkUser('victim-inh', 'team-1'); // inheriting viewer on team-1 itself
    await bind('victim-inh', 'team-1', 'viewer', true);
    await mkUser('plat', 'team-1'); // a platform operator homed in team-1
    await n.ctx.db
      .update(usersTable)
      .set({ platformAdmin: true })
      .where(eq(usersTable.id, uid['plat']!));
    await mkUser('team-direct', 'team-1', ['admin']); // direct admin of team-1, not inheriting
    await mkUser('viewer-inh', 'div-2');
    await bind('viewer-inh', 'org-a', 'viewer', true);
    await mkUser('nobody', 'org-a');
    await mkUser('inh-root', 'org-a');
    await bind('inh-root', 'org-a', 'admin', true);
    await mkUser('direct-div1', 'div-1', ['admin']);
    await mkUser('outsider', 'org-b', ['admin']);
    // org-c: a permanent inheriting admin and an expiring one
    await mkUser('c-last', 'org-c');
    await bind('c-last', 'org-c', 'admin', true);
    await mkUser('c-temp', 'org-c');
    await bind('c-temp', 'org-c', 'admin', true, { expiresAt: new Date(Date.now() + 3_600_000) });
    // org-d: the only inheriting admin is a mirror row
    await mkUser('d-mirror', 'org-d', ['admin']);
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ inherit: true })
      .where(eq(tenantRoleBindings.userId, uid['d-mirror']!));
    for (const slug of ['org-e'])
      id[slug] = (await n.services.tenants.create(op(), { slug, name: slug })).id;
    // org-e: one user holds the admin role twice (mirror row made inheriting, and a grant)
    await mkUser('e-both', 'org-e', ['admin']);
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ inherit: true })
      .where(eq(tenantRoleBindings.userId, uid['e-both']!));
    await bind('e-both', 'org-e', 'admin', true);
    await mkUser('e-temp', 'org-e');
    await bind('e-temp', 'org-e', 'admin', true, { expiresAt: new Date(Date.now() + 3_600_000) });
    // a user homed in team-1 who is a member of a team owned by the organisation root
    await mkUser('root-team-member', 'team-1');
    const rootTeam = await n.services.identity.createTeam(
      { userId: op().userId, tenantId: id['org-a']! },
      { slug: 'ops', name: 'Ops' },
    );
    await n.ctx.db
      .insert(teamMembers)
      .values({ teamId: rootTeam.id, userId: uid['root-team-member']!, role: 'viewer' });
    // ... and one bound to an agent owned by the organisation root
    await mkUser('root-agent-member', 'team-1');
    const rootAgent = randomUUID();
    await n.ctx.db
      .insert(agentsTable)
      .values({ id: rootAgent, name: 'root-agent', draftSource: '', tenantId: id['org-a']! });
    await n.ctx.db
      .insert(agentRoleBindings)
      .values({ agentId: rootAgent, userId: uid['root-agent-member']!, role: 'viewer' });
    await mkUser('d-temp', 'org-d');
    await bind('d-temp', 'org-d', 'admin', true, { expiresAt: new Date(Date.now() + 3_600_000) });
  }, 180_000);
  afterAll(async () => {
    await n.close();
    await target.close();
  });

  describe('user lifecycle across the hierarchy (the PoC and its rules)', () => {
    it('a division admin cannot disable the superior admin living below it', async () => {
      const r = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['root-admin']}`,
        { disabled: true },
        'org-a/div-1/team-1',
      );
      expect(r.statusCode).toBe(403);
      expect(await alive('root-admin')).toBe(true);
      const row = (
        await n.ctx.db.select().from(usersTable).where(eq(usersTable.id, uid['root-admin']!))
      )[0]!;
      expect(row.disabled).toBe(false);
    });

    it('nor change their global roles', async () => {
      const r = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['root-admin']}`,
        { globalRoles: [] },
        'team-1',
      );
      expect(r.statusCode).toBe(403);
    });

    it('nor revoke or list their API tokens', async () => {
      const principal = await n.services.identity.principalForUser(uid['root-admin']!);
      const t = await n.services.identity.createApiToken(
        principal,
        'ci',
        ['agents:read'] as never,
        30,
      );
      const revoke = await call('div-admin', 'DELETE', `/v1/tokens/${t.id}`, undefined, 'team-1');
      expect(revoke.statusCode).toBe(403);
      expect((await n.req({ method: 'GET', url: '/v1/agents', token: t.token })).statusCode).toBe(
        200,
      );
      const list = await call('div-admin', 'GET', '/v1/tokens?all=true', undefined, 'team-1');
      expect(list.statusCode).toBe(200);
      expect(list.json().items.map((x: { id: string }) => x.id)).not.toContain(t.id);
      // the owner may revoke their own, and so may an operator
      expect((await call('root-admin', 'DELETE', `/v1/tokens/${t.id}`)).statusCode).toBe(204);
    });

    it('control: the same admin manages a user whose roles are all within its reach', async () => {
      const r = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['victim']}`,
        { displayName: 'Victim', globalRoles: ['operator'] },
        'team-1',
      );
      expect(r.statusCode).toBe(200);
      const off = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['victim']}`,
        { disabled: true },
        'team-1',
      );
      expect(off.statusCode).toBe(200);
    });

    it('refuses a user who also holds a role on a node the actor cannot manage', async () => {
      const r = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['victim-up']}`,
        { disabled: true },
        'team-1',
      );
      expect(r.statusCode).toBe(403);
      expect(await alive('victim-up')).toBe(true);
    });

    it('refuses an inheriting role the actor does not cover (rule 2 for the target)', async () => {
      // team-direct is admin of team-1 but does not inherit: it cannot manage an inheriting binding there
      const r = await call('team-direct', 'PATCH', `/v1/users/${uid['victim-inh']}`, {
        disabled: true,
      });
      expect(r.statusCode).toBe(403);
      // div-admin inherits from div-1 and covers team-1
      const ok = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['victim-inh']}`,
        { displayName: 'ok' },
        'team-1',
      );
      expect(ok.statusCode).toBe(200);
    });

    it('refuses a platform operator account, which only operators manage', async () => {
      const r = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['plat']}`,
        { disabled: true },
        'team-1',
      );
      expect(r.statusCode).toBe(403);
      expect(await alive('plat')).toBe(true);
    });

    it('any change of another account is managing it: re-enabling and renaming a superior is refused (PoC)', async () => {
      await mkUser('ra2', 'team-1');
      await bind('ra2', 'org-a', 'admin', true);
      expect(
        (await call(null, 'PATCH', `/v1/users/${uid['ra2']}`, { disabled: true }, 'team-1'))
          .statusCode,
      ).toBe(200);
      const on = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['ra2']}`,
        { disabled: false },
        'team-1',
      );
      expect(on.statusCode).toBe(403);
      const name = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['ra2']}`,
        { displayName: 'renamed' },
        'team-1',
      );
      expect(name.statusCode).toBe(403);
      const row = (
        await n.ctx.db.select().from(usersTable).where(eq(usersTable.id, uid['ra2']!))
      )[0]!;
      expect(row.disabled).toBe(true);
      expect(row.displayName).toBe('ra2');
      expect(
        (await call(null, 'PATCH', `/v1/users/${uid['ra2']}`, { disabled: false }, 'team-1'))
          .statusCode,
      ).toBe(200);
    });

    it("team memberships count: a member of a team owned above the manager is not the manager's to change", async () => {
      const r = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['root-team-member']}`,
        { disabled: true },
        'team-1',
      );
      expect(r.statusCode).toBe(403);
      expect(await alive('root-team-member')).toBe(true);
    });

    it('agent bindings count too: a user bound to an agent above the manager is refused', async () => {
      const r = await call(
        'div-admin',
        'PATCH',
        `/v1/users/${uid['root-agent-member']}`,
        { displayName: 'x' },
        'team-1',
      );
      expect(r.statusCode).toBe(403);
      expect(await alive('root-agent-member')).toBe(true);
    });

    it("last admin counts the user once: two admin rows of one user are not each other's co-admin", async () => {
      const dis = await call('e-temp', 'PATCH', `/v1/users/${uid['e-both']}`, { disabled: true });
      expect(dis.statusCode).toBe(409);
      expect(await alive('e-both')).toBe(true);
      // deleting the grant row leaves the mirror row, so the user stays an admin: allowed
      const grant = (
        await n.ctx.db
          .select()
          .from(tenantRoleBindings)
          .where(eq(tenantRoleBindings.userId, uid['e-both']!))
      ).find((b) => b.source === 'grant')!;
      const del = await call(
        'e-temp',
        'DELETE',
        `/v1/tenants/${id['org-e']}/role-bindings/${grant.id}`,
      );
      expect(del.statusCode).toBe(204);
      // now the mirror row is the only one: removing it through the roles, or disabling, is refused
      const roles = await call('e-temp', 'PATCH', `/v1/users/${uid['e-both']}`, {
        globalRoles: [],
      });
      expect(roles.statusCode).toBe(409);
      expect(
        (await call('e-temp', 'PATCH', `/v1/users/${uid['e-both']}`, { disabled: true }))
          .statusCode,
      ).toBe(409);
    });

    it('operators are exempt', async () => {
      await mkUser('tmp-admin', 'team-1');
      await bind('tmp-admin', 'org-a', 'admin', true);
      const r = await call(
        null,
        'PATCH',
        `/v1/users/${uid['tmp-admin']}`,
        { disabled: true },
        'team-1',
      );
      expect(r.statusCode).toBe(200);
    });

    it('last admin: disabling the only permanent inheriting admin of a root is 409, also for oneself', async () => {
      const r = await call('c-temp', 'PATCH', `/v1/users/${uid['c-last']}`, { disabled: true });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('last_admin');
      expect(await alive('c-last')).toBe(true);
      const self = await call('c-last', 'PATCH', `/v1/users/${uid['c-last']}`, { disabled: true });
      expect(self.statusCode).toBe(409);
    });

    it('last admin: removing the admin global role of the only inheriting mirror admin is 409', async () => {
      const r = await call('d-temp', 'PATCH', `/v1/users/${uid['d-mirror']}`, { globalRoles: [] });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('last_admin');
      const keep = await call('d-temp', 'PATCH', `/v1/users/${uid['d-mirror']}`, {
        globalRoles: ['admin', 'viewer'],
      });
      expect(keep.statusCode).toBe(200);
    });

    it('does nothing different on the legacy read path (the guard is for bindings)', async () => {
      setMode('legacy');
      try {
        await mkUser('leg-a', 'org-b', ['admin']);
        await mkUser('leg-b', 'org-b', ['viewer']);
        const r = await call('leg-a', 'PATCH', `/v1/users/${uid['leg-b']}`, { disabled: true });
        expect(r.statusCode).toBe(200);
      } finally {
        setMode('bindings');
      }
    });
  });

  describe('budgets below capped nodes', () => {
    it('refuses a tenant admin below a node with a cap on it or on an ancestor, and an operator may', async () => {
      expect(
        (await call(null, 'PATCH', `/v1/tenants/${id['org-a']}`, { monthlyBudgetUsd: 5 }))
          .statusCode,
      ).toBe(200);
      try {
        const total = await count();
        for (const parent of ['org-a', 'div-1', 'team-1']) {
          const r = await call('inh-root', 'POST', '/v1/tenants', {
            parentId: id[parent],
            slug: `cap-${parent}`,
            name: 'x',
          });
          expect(r.statusCode, parent).toBe(403);
          expect(r.json().error).toBe('budget_capped');
        }
        expect(await count()).toBe(total);
        expect(
          (
            await call(null, 'POST', '/v1/tenants', {
              parentId: id['div-1'],
              slug: 'cap-op',
              name: 'x',
              monthlyBudgetUsd: 1,
            })
          ).statusCode,
        ).toBe(201);
      } finally {
        await call(null, 'PATCH', `/v1/tenants/${id['org-a']}`, { monthlyBudgetUsd: null });
      }
      const ok = await call('inh-root', 'POST', '/v1/tenants', {
        parentId: id['div-1'],
        slug: 'cap-free',
        name: 'x',
      });
      expect(ok.statusCode).toBe(201);
    });
  });

  describe('slugs and secrets', () => {
    it('refuses slugs that an operator reserved or whose secret prefix already holds secrets', async () => {
      (n.ctx.config.tenancy as { reservedSlugs: string[] }).reservedSlugs = ['vault'];
      try {
        const reserved = await call('inh-root', 'POST', '/v1/tenants', {
          parentId: id['div-2'],
          slug: 'vault-eu',
          name: 'x',
        });
        const staged = await call('inh-root', 'POST', '/v1/tenants', {
          parentId: id['div-2'],
          slug: 'trivy',
          name: 'x',
        });
        const taken = await call('inh-root', 'POST', '/v1/tenants', {
          parentId: id['div-2'],
          slug: 'div-1',
          name: 'x',
        });
        for (const r of [reserved, staged, taken]) expect(r.statusCode).toBe(409);
        expect(reserved.body).toBe(taken.body);
        expect(staged.body).toBe(taken.body);
        // operators are not bound by it
        expect(
          (
            await call(null, 'POST', '/v1/tenants', {
              parentId: id['div-2'],
              slug: 'trivy',
              name: 'x',
            })
          ).statusCode,
        ).toBe(201);
      } finally {
        (n.ctx.config.tenancy as { reservedSlugs: string[] }).reservedSlugs = [];
      }
    });
  });

  describe('check ordering', () => {
    it('an unauthorised caller gets 403 whatever the slug, and never opens a transaction', async () => {
      const spy = vi.spyOn(n.ctx.db as unknown as { transaction: () => unknown }, 'transaction');
      const fresh = await call('team-direct', 'POST', '/v1/tenants', {
        parentId: id['team-1'],
        slug: 'zz-free',
        name: 'x',
      });
      const taken = await call('team-direct', 'POST', '/v1/tenants', {
        parentId: id['team-1'],
        slug: 'org-b',
        name: 'x',
      });
      const used = spy.mock.calls.length;
      spy.mockRestore();
      expect(fresh.statusCode).toBe(403);
      expect(taken.statusCode).toBe(403);
      expect(taken.body).toBe(fresh.body);
      expect(used).toBe(0);
    });

    it('the node and depth limits answer before the slug does, so a taken slug is not revealed', async () => {
      const total = (await n.ctx.db.select().from(tenantsTable)).filter(
        (t) => t.rootId === id['org-a'],
      ).length;
      (n.ctx.config.tenancy as { maxNodesPerRoot: number }).maxNodesPerRoot = total;
      try {
        const a = await call('inh-root', 'POST', '/v1/tenants', {
          parentId: id['div-2'],
          slug: 'org-b',
          name: 'x',
        }); // exists elsewhere
        const b = await call('inh-root', 'POST', '/v1/tenants', {
          parentId: id['div-2'],
          slug: 'zz-limit',
          name: 'x',
        });
        expect(a.statusCode).toBe(422);
        expect(a.body).toBe(b.body);
      } finally {
        (n.ctx.config.tenancy as { maxNodesPerRoot: number }).maxNodesPerRoot = 1000;
      }
      (n.ctx.config.tenancy as { maxDepth: number }).maxDepth = 2;
      try {
        const a = await call('inh-root', 'POST', '/v1/tenants', {
          parentId: id['team-1'],
          slug: 'org-b',
          name: 'x',
        });
        const b = await call('inh-root', 'POST', '/v1/tenants', {
          parentId: id['team-1'],
          slug: 'zz-deep',
          name: 'x',
        });
        expect(a.statusCode).toBe(422);
        expect(a.body).toBe(b.body);
      } finally {
        (n.ctx.config.tenancy as { maxDepth: number }).maxDepth = 32;
      }
    });

    it('rename audits who authorised it', async () => {
      const r = await call('inh-root', 'PATCH', `/v1/tenants/${id['div-2']}`, {
        name: 'Division two',
      });
      expect(r.statusCode).toBe(200);
      const e = (
        await n.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'tenant.updated'))
      ).find((x) => x.tenantId === id['div-2']);
      expect(e?.payload).toMatchObject({ name: 'Division two', authority: 'inheriting_admin' });
    });
  });

  describe('access endpoint', () => {
    it('shows a platform operator as admin at the node in the path, without naming their home node', async () => {
      const r = await call(null, 'GET', `/v1/tenants/${id['div-1']}/access?userId=${uid['plat']}`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.bindings).toEqual([
        expect.objectContaining({ role: 'admin', source: 'platform', tenantId: id['div-1'] }),
      ]);
      expect(r.body).not.toContain(id['team-1']);
    });

    it('lists only bindings on the chain of the node', async () => {
      const r = await call(
        null,
        'GET',
        `/v1/tenants/${id['div-1']}/access?userId=${uid['victim-up']}`,
      );
      expect(r.json().bindings).toEqual([]); // its only roles are viewer (team-1) and admin (div-2)
    });

    it('follows the legacy read path: global roles and users:read from the global roles', async () => {
      setMode('legacy');
      try {
        await mkUser('lg-admin', 'org-b', ['admin']);
        await mkUser('lg-viewer', 'org-b', ['viewer']);
        const ok = await call(
          'lg-admin',
          'GET',
          `/v1/tenants/${id['org-b']}/access?userId=${uid['lg-viewer']}`,
        );
        expect(ok.statusCode).toBe(200);
        expect(ok.json().bindings).toEqual([
          expect.objectContaining({ role: 'viewer', source: 'direct' }),
        ]);
        const no = await call(
          'lg-viewer',
          'GET',
          `/v1/tenants/${id['org-b']}/access?userId=${uid['lg-admin']}`,
        );
        expect(no.statusCode).toBe(403);
        // The tables diverge from the global roles (an unreconciled grant): legacy ignores them.
        await mkUser('lg-bound', 'org-b');
        await bind('lg-bound', 'org-b', 'admin', false);
        await bind('lg-viewer', 'org-b', 'admin', false);
        const ghost = await call(
          'lg-admin',
          'GET',
          `/v1/tenants/${id['org-b']}/access?userId=${uid['lg-bound']}`,
        );
        expect(ghost.statusCode).toBe(200);
        expect(ghost.json().bindings).toEqual([]);
        // users:read comes from the global roles (viewer), not from the extra admin grant
        const still = await call(
          'lg-viewer',
          'GET',
          `/v1/tenants/${id['org-b']}/access?userId=${uid['lg-admin']}`,
        );
        expect(still.statusCode).toBe(403);
      } finally {
        setMode('bindings');
      }
    });
  });

  describe('walk over the authenticated tenant routes', () => {
    type Row = [
      string,
      'GET' | 'POST' | 'PATCH',
      (u: string) => string,
      (u: string) => Record<string, unknown> | undefined,
      Record<string, number>,
    ];
    // expected status per caller; callers act in their home node, the node in the path is div-1
    const rows: Row[] = [
      [
        'create below div-1',
        'POST',
        () => '/v1/tenants',
        (u) => ({ parentId: id['div-1'], slug: `walk-${u}`, name: 'W' }),
        { 'inh-root': 201, 'direct-div1': 403, 'viewer-inh': 403, nobody: 404, outsider: 404 },
      ],
      [
        'rename div-1',
        'PATCH',
        () => `/v1/tenants/${id['div-1']}`,
        () => ({ name: 'Division 1' }),
        { 'inh-root': 200, 'direct-div1': 403, 'viewer-inh': 403, nobody: 404, outsider: 404 },
      ],
      [
        'list bindings',
        'GET',
        () => `/v1/tenants/${id['div-1']}/role-bindings`,
        () => undefined,
        { 'inh-root': 200, 'direct-div1': 200, 'viewer-inh': 403, nobody: 404, outsider: 404 },
      ],
      [
        'bind a viewer',
        'POST',
        () => `/v1/tenants/${id['div-1']}/role-bindings`,
        () => ({ userId: uid['direct-div1'], role: 'auditor', inherit: false }),
        { 'inh-root': 201, 'direct-div1': 403, 'viewer-inh': 403, nobody: 404, outsider: 404 },
      ],
      [
        'own access',
        'GET',
        () => `/v1/me/access?tenant=${id['div-1']}`,
        () => undefined,
        { 'inh-root': 200, 'direct-div1': 200, 'viewer-inh': 200, nobody: 404, outsider: 404 },
      ],
      [
        'access of self',
        'GET',
        (u) => `/v1/tenants/${id['div-1']}/access?userId=${uid[u]}`,
        () => undefined,
        { 'inh-root': 200, 'direct-div1': 200, 'viewer-inh': 403, nobody: 404, outsider: 404 },
      ],
    ];
    it.each(rows)('%s', async (_name, method, url, body, expected) => {
      for (const [who, status] of Object.entries(expected)) {
        const r = await call(who, method, url(who), body(who));
        expect(r.statusCode, `${who}: ${r.body}`).toBe(status);
      }
    });
  });
});
