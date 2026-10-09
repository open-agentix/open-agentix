import { randomUUID } from 'node:crypto';
import {
  PERMISSIONS,
  bindingFingerprint,
  effectiveAt,
  hasPermission,
  sameBindings,
  visibleAgents,
  visibleTeams,
  type Principal,
  type Role,
} from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapGroupsToBindings } from '../src/config.js';
import {
  DEFAULT_TENANT_ID,
  tenantRoleBindings,
  tenants as tenantsTable,
  users as usersTable,
} from '../src/db/schema.js';
import { IdentityService } from '../src/services/identity.js';
import { loadRawGrants } from '../src/services/role-bindings.js';
import { sqlState, sqlTargets } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0014 slice S1: the bindings table is a write-through mirror of `users.global_roles`, and the
 * pure resolver runs in shadow mode behind the legacy permission code. Nothing about authorisation
 * may change; the tests pin that down. Runs on PGlite and, with OAX_TEST_DATABASE_URL, PostgreSQL.
 */
const PW = 'long-password-123';

describe.each(sqlTargets)(
  'role bindings write-through and shadow mode (%s)',
  (_kind, enabled, open) => {
    if (!enabled()) {
      it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
      return;
    }
    let target: Awaited<ReturnType<typeof open>>;
    let n: TestNode;
    const id = {} as Record<string, string>;
    const op = (): Principal => ({
      kind: 'user',
      userId: randomUUID(),
      tenantId: DEFAULT_TENANT_ID,
      displayName: 'op',
      platformAdmin: true,
      bindings: [],
    });

    const rows = (userId: string) =>
      n.ctx.db.select().from(tenantRoleBindings).where(eq(tenantRoleBindings.userId, userId));
    const mirror = async (userId: string) => {
      const bs = await rows(userId);
      return bs
        .filter((b) => !b.inherit && b.useCase === null && b.expiresAt === null)
        .map((b) => `${b.tenantId}|${b.role}`)
        .sort();
    };
    const legacyRoles = async (userId: string) =>
      (await n.ctx.db.select().from(usersTable).where(eq(usersTable.id, userId)))[0]!.globalRoles;
    const expectMirrorEqualsGlobalRoles = async (userId: string) => {
      const [u] = await n.ctx.db.select().from(usersTable).where(eq(usersTable.id, userId));
      expect(await mirror(userId)).toEqual(
        [...new Set(u!.globalRoles)].map((r) => `${u!.tenantId}|${r}`).sort(),
      );
    };
    const shadow = async () => {
      const out = { match: 0, mismatch: 0, error: 0, skipped: 0 };
      for (const v of (await n.ctx.metrics.roleBindingsShadow.get()).values)
        out[v.labels.outcome as keyof typeof out] = v.value;
      return out;
    };
    const createUser = async (
      email: string,
      globalRoles: Role[],
      headers?: Record<string, string>,
    ) => {
      const r = await n.req({
        method: 'POST',
        url: '/v1/users',
        ...(headers ? { headers } : {}),
        payload: { email, displayName: email, password: PW, globalRoles },
      });
      expect(r.statusCode).toBe(201);
      return r.json().id as string;
    };

    beforeAll(async () => {
      target = await open();
      n = await testNode({ OAX_DATABASE_URL: target.url });
      const child = await n.services.tenants.createChild(op(), DEFAULT_TENANT_ID, {
        slug: 'sub',
        name: 'Sub',
      });
      id.sub = child.id;
    }, 120_000);
    afterAll(async () => {
      await n.close();
      await target.close();
    });

    it('writes a binding for the bootstrap admin', async () => {
      const [admin] = await n.ctx.db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, 'admin@example.com'));
      expect(await mirror(admin!.id)).toEqual([`${DEFAULT_TENANT_ID}|admin`]);
    });

    describe('every write path of global_roles writes the bindings too', () => {
      it('POST /v1/users, also in a child tenant and with duplicates', async () => {
        const a = await createUser('a@example.org', ['admin', 'viewer']);
        expect(await mirror(a)).toEqual(
          [`${DEFAULT_TENANT_ID}|admin`, `${DEFAULT_TENANT_ID}|viewer`].sort(),
        );
        const b = await createUser('b@example.org', ['auditor'], { 'x-oax-tenant': id.sub! });
        expect(await mirror(b)).toEqual([`${id.sub}|auditor`]);
        const none = await createUser('none@example.org', []);
        expect(await rows(none)).toEqual([]);
        for (const u of [a, b, none]) await expectMirrorEqualsGlobalRoles(u);
        const bs = await rows(a);
        for (const r of bs) {
          expect(r).toMatchObject({ inherit: false, useCase: null, expiresAt: null });
          expect(r.grantedBy).not.toBeNull(); // the admin who created the user
        }
      });

      it('PATCH /v1/users/:id replaces, narrows and clears the roles', async () => {
        const u = await createUser('patch@example.org', ['admin', 'viewer']);
        for (const roles of [['viewer'], ['operator', 'auditor'], [], ['integrator']] as Role[][]) {
          const r = await n.req({
            method: 'PATCH',
            url: `/v1/users/${u}`,
            payload: { globalRoles: roles },
          });
          expect(r.statusCode).toBe(200);
          expect(await legacyRoles(u)).toEqual(roles);
          await expectMirrorEqualsGlobalRoles(u);
        }
        // patching something else leaves the roles and the bindings alone
        await n.req({ method: 'PATCH', url: `/v1/users/${u}`, payload: { displayName: 'New' } });
        await expectMirrorEqualsGlobalRoles(u);
        expect(await mirror(u)).toEqual([`${DEFAULT_TENANT_ID}|integrator`]);
      });

      it('does not touch bindings the mirror does not manage', async () => {
        const u = await createUser('keep@example.org', ['viewer']);
        await n.ctx.db.insert(tenantRoleBindings).values([
          { id: randomUUID(), userId: u, tenantId: id.sub!, role: 'auditor', inherit: true },
          {
            id: randomUUID(),
            userId: u,
            tenantId: DEFAULT_TENANT_ID,
            role: 'pentest',
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        ]);
        await n.req({ method: 'PATCH', url: `/v1/users/${u}`, payload: { globalRoles: [] } });
        const left = (await rows(u)).map((b) => `${b.tenantId}|${b.role}|${b.inherit}`).sort();
        expect(left).toEqual(
          [`${DEFAULT_TENANT_ID}|pentest|false`, `${id.sub}|auditor|true`].sort(),
        );
        // the stray rows are not part of the legacy model; later tests compare every user
        await n.ctx.db.delete(tenantRoleBindings).where(eq(tenantRoleBindings.userId, u));
      });

      it('LDAP/OIDC group mapping (login) mirrors the mapped global roles', async () => {
        const ident = n.services.identity;
        const first = await ident.upsertExternalUser('ldap', 'cn=e', 'ext@example.org', 'Ext', [
          { role: 'viewer', teamSlug: null },
          { role: 'auditor', teamSlug: null },
          { role: 'operator', teamSlug: 'team-x' },
        ]);
        expect(await mirror(first.id)).toEqual(
          [`${DEFAULT_TENANT_ID}|viewer`, `${DEFAULT_TENANT_ID}|auditor`].sort(),
        );
        await expectMirrorEqualsGlobalRoles(first.id);
        const second = await ident.upsertExternalUser('ldap', 'cn=e', 'ext@example.org', 'Ext', [
          { role: 'admin', teamSlug: null },
        ]);
        expect(second.id).toBe(first.id);
        expect(await mirror(first.id)).toEqual([`${DEFAULT_TENANT_ID}|admin`]);
        await expectMirrorEqualsGlobalRoles(first.id);
        const third = await ident.upsertExternalUser('ldap', 'cn=e', 'ext@example.org', 'Ext', []);
        expect(await rows(third.id)).toEqual([]);
        expect(await legacyRoles(third.id)).toEqual([]);
      });

      it('tenant creation with a first admin binds that admin on the new tenant', async () => {
        const r = await n.req({
          method: 'POST',
          url: '/v1/tenants',
          payload: {
            slug: 'org-z',
            name: 'Org Z',
            admin: { email: 'admin@org-z.example.org', displayName: 'Z', password: PW },
          },
        });
        expect(r.statusCode).toBe(201);
        const [z] = await n.ctx.db
          .select()
          .from(usersTable)
          .where(eq(usersTable.email, 'admin@org-z.example.org'));
        expect(await mirror(z!.id)).toEqual([`${r.json().id}|admin`]);
      });

      it('a failed write leaves global_roles and the bindings unchanged together', async () => {
        const u = await createUser('atomic@example.org', ['viewer']);
        // pentest is refused by the mirror even when it reaches the service directly
        await expect(
          n.services.identity.updateUser({ userId: op().userId, tenantId: DEFAULT_TENANT_ID }, u, {
            globalRoles: ['pentest'],
          }),
        ).rejects.toThrow(/cannot be granted globally/);
        expect(await legacyRoles(u)).toEqual(['viewer']);
        await expectMirrorEqualsGlobalRoles(u);
      });
    });

    describe('pentest is not grantable yet', () => {
      it('is refused by user create/patch and by team and agent members', async () => {
        const bad = await n.req({
          method: 'POST',
          url: '/v1/users',
          payload: {
            email: 'p@example.org',
            displayName: 'P',
            password: PW,
            globalRoles: ['pentest'],
          },
        });
        expect(bad.statusCode).toBe(400);
        const u = await createUser('p2@example.org', ['viewer']);
        const patch = await n.req({
          method: 'PATCH',
          url: `/v1/users/${u}`,
          payload: { globalRoles: ['pentest'] },
        });
        expect(patch.statusCode).toBe(400);
        const team = await n.req({
          method: 'POST',
          url: '/v1/teams',
          payload: { slug: 'tp', name: 'TP' },
        });
        const members = await n.req({
          method: 'PUT',
          url: `/v1/teams/${team.json().id}/members`,
          payload: { members: [{ userId: u, role: 'pentest' }] },
        });
        expect(members.statusCode).toBe(400);
        expect(await legacyRoles(u)).toEqual(['viewer']);
      });

      it('is ignored in group mappings and in the legacy sources if it got there anyway', async () => {
        expect(mapGroupsToBindings(['g'], { g: ['pentest', 'viewer', 'pentest@team'] })).toEqual([
          { role: 'viewer', teamSlug: null },
        ]);
        const u = await createUser('legacy@example.org', ['viewer']);
        await n.ctx.db
          .update(usersTable)
          .set({ globalRoles: ['pentest', 'viewer'] })
          .where(eq(usersTable.id, u));
        const p = await n.services.identity.principalForUser(u);
        expect(p.bindings.map((b) => b.role)).toEqual(['viewer']);
      });
    });

    describe('shadow mode', () => {
      it('agrees with the legacy bindings of every user, team and agent binding of the fixtures', async () => {
        // users in two tenants with global, team and agent-scoped roles
        const team = (
          await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'shadow', name: 'S' } })
        ).json().id as string;
        const agentSource = `name: shadow-agent\nversion: 1.0.0\ndescription: d\ninstructions: i\n`;
        const agentRes = await n.req({
          method: 'POST',
          url: '/v1/agents',
          payload: { source: agentSource },
        });
        const agentId = agentRes.json().id as string | undefined;
        const a = await createUser('s-a@example.org', ['admin']);
        const b = await createUser('s-b@example.org', []);
        const c = await createUser('s-c@example.org', ['integrator', 'viewer'], {
          'x-oax-tenant': id.sub!,
        });
        await n.services.identity.setTeamMembers(
          { userId: op().userId, tenantId: DEFAULT_TENANT_ID },
          team,
          [{ userId: b, role: 'operator' }],
        );
        if (agentId)
          await n.services.identity.setAgentMembers(
            { userId: op().userId, tenantId: DEFAULT_TENANT_ID },
            agentId,
            [{ userId: b, role: 'agent-engineer' }],
          );
        const before = await shadow();
        const all = await n.ctx.db.select().from(usersTable);
        expect(all.length).toBeGreaterThan(5);
        for (const user of all) {
          const p = await n.services.identity.principalForUser(user.id);
          const loaded = (await loadRawGrants(n.ctx.db, user))!;
          const fresh = effectiveAt(loaded.raw, loaded.home, {
            now: n.ctx.now(),
            implicitPlatformAdmin: false,
          });
          expect(sameBindings(p.bindings, fresh), user.email).toBe(true);
          expect(bindingFingerprint(p.bindings), user.email).toEqual(bindingFingerprint(fresh));
          // the services see no difference whichever list they get
          const viaResolver: Principal = { ...p, bindings: fresh };
          for (const perm of PERMISSIONS) {
            for (const t of [undefined, null, team, 'other-team']) {
              for (const g of [undefined, agentId ?? 'x', 'other-agent']) {
                expect(hasPermission(viaResolver, perm, t, g)).toBe(hasPermission(p, perm, t, g));
              }
            }
            expect(visibleTeams(viaResolver, perm)).toEqual(visibleTeams(p, perm));
            expect(visibleAgents(viaResolver, perm)).toEqual(visibleAgents(p, perm));
          }
        }
        const after = await shadow();
        expect(after.mismatch).toBe(before.mismatch);
        expect(after.error).toBe(before.error);
        expect(after.match).toBeGreaterThanOrEqual(before.match + all.length);
        expect([a, c]).toHaveLength(2);
      });

      it('keeps the legacy result authoritative: a stray inheriting admin binding changes nothing', async () => {
        const u = await createUser('stray@example.org', ['viewer'], { 'x-oax-tenant': id.sub! });
        const token = await n.login('stray@example.org', PW);
        const before = await n.services.identity.principalForUser(u);
        const counts = await shadow();
        await n.ctx.db.insert(tenantRoleBindings).values({
          id: randomUUID(),
          userId: u,
          tenantId: DEFAULT_TENANT_ID, // the root above the user's home node
          role: 'admin',
          inherit: true,
        });
        const after = await n.services.identity.principalForUser(u);
        expect(after.bindings).toEqual(before.bindings);
        expect((await shadow()).mismatch).toBeGreaterThan(counts.mismatch);
        // and over HTTP: still a viewer, no admin routes, no reach into the parent tenant
        expect((await n.req({ method: 'GET', url: '/v1/agents', token })).statusCode).toBe(200);
        expect((await n.req({ method: 'GET', url: '/v1/users', token })).statusCode).toBe(403);
        const me = (await n.req({ method: 'GET', url: '/v1/me', token })).json();
        expect(me.permissions).not.toContain('users:write');
        expect(
          (
            await n.req({
              method: 'GET',
              url: '/v1/agents',
              token,
              headers: { 'x-oax-tenant': DEFAULT_TENANT_ID },
            })
          ).statusCode,
        ).toBe(404);
      });

      it('detects drift of the mirror, but the legacy bindings still decide', async () => {
        const u = await createUser('drift@example.org', ['admin']);
        const counts = await shadow();
        await n.ctx.db.delete(tenantRoleBindings).where(eq(tenantRoleBindings.userId, u));
        const p = await n.services.identity.principalForUser(u);
        expect(p.bindings.map((b) => b.role)).toEqual(['admin']);
        expect((await shadow()).mismatch).toBe(counts.mismatch + 1);
      });

      it('never breaks authentication when the check itself fails', async () => {
        const u = await createUser('fail@example.org', ['viewer']);
        const token = await n.login('fail@example.org', PW);
        const counts = await shadow();
        await n.ctx.db.execute(
          // PGlite and PostgreSQL both accept this; the shadow read then fails
          (await import('drizzle-orm')).sql`alter table tenant_role_bindings rename to trb_hidden`,
        );
        try {
          const p = await n.services.identity.principalForUser(u);
          expect(p.bindings.map((b) => b.role)).toEqual(['viewer']);
          expect((await n.req({ method: 'GET', url: '/v1/me', token })).statusCode).toBe(200);
          expect((await shadow()).error).toBeGreaterThan(counts.error);
        } finally {
          await n.ctx.db.execute(
            (await import('drizzle-orm'))
              .sql`alter table trb_hidden rename to tenant_role_bindings`,
          );
        }
      });

      it('is skipped under load instead of adding database reads, and still changes nothing', async () => {
        const u = await createUser('busy@example.org', ['viewer']);
        await n.ctx.db.delete(tenantRoleBindings).where(eq(tenantRoleBindings.userId, u)); // drift
        const identity = n.services.identity as unknown as { shadowInFlight: number };
        const counts = await shadow();
        identity.shadowInFlight = IdentityService.SHADOW_MAX_IN_FLIGHT;
        try {
          const p = await n.services.identity.principalForUser(u);
          expect(p.bindings.map((b) => b.role)).toEqual(['viewer']);
          const after = await shadow();
          expect(after.skipped).toBe(counts.skipped + 1);
          expect(after.mismatch).toBe(counts.mismatch);
          expect(after.match).toBe(counts.match);
        } finally {
          identity.shadowInFlight = 0;
        }
        // Below the cap the check runs again (and sees the drift), and the slot is released.
        await n.services.identity.principalForUser(u);
        expect((await shadow()).mismatch).toBe(counts.mismatch + 1);
        expect(identity.shadowInFlight).toBe(0);
        // Concurrent principal builds never leave a slot behind, whatever was skipped.
        await Promise.all(
          Array.from({ length: 8 }, () => n.services.identity.principalForUser(u)),
        );
        expect(identity.shadowInFlight).toBe(0);
      });

      it('refuses a binding outside the home organisation at the database', async () => {
        const u = await createUser('org@example.org', ['viewer']);
        const other = await n.req({
          method: 'POST',
          url: '/v1/tenants',
          payload: { slug: 'org-y', name: 'Org Y' },
        });
        const code = await sqlState(
          n.ctx.db.insert(tenantRoleBindings).values({
            id: randomUUID(),
            userId: u,
            tenantId: other.json().id,
            role: 'viewer',
            inherit: true,
          }),
        );
        expect(code).toBe('23514');
        const [t] = await n.ctx.db
          .select()
          .from(tenantsTable)
          .where(eq(tenantsTable.slug, 'org-y'));
        expect(t).toBeDefined();
      });
    });
  },
);

describe('shadow mode switch', () => {
  it('can be turned off: no comparison, no queries, no counter', async () => {
    const n = await testNode({ OAX_ROLE_BINDINGS_SHADOW: 'false' });
    try {
      const token = await n.login('admin@example.com', 'admin-password-123');
      expect((await n.req({ method: 'GET', url: '/v1/me', token })).statusCode).toBe(200);
      const values = (await n.ctx.metrics.roleBindingsShadow.get()).values;
      expect(values.reduce((s, v) => s + v.value, 0)).toBe(0);
    } finally {
      await n.close();
    }
  });
});
