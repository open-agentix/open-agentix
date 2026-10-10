import { randomUUID } from 'node:crypto';
import {
  INHERITED_READ_ONLY,
  PERMISSIONS,
  bindingFingerprint,
  type Principal,
  type Role,
} from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TENANT_ID,
  tenantRoleBindings,
  tenants as tenantsTable,
  teamMembers,
  users as usersTable,
} from '../src/db/schema.js';
import { routeIndex } from '../src/index.js';
import { currentAuthzEpoch } from '../src/services/role-bindings.js';
import { TenantAccess } from '../src/services/tenant-access.js';
import { TenantSnapshots, TreeSnapshot, type SnapNode } from '../src/services/tenant-snapshot.js';
import { TenantTree } from '../src/services/tenant-tree.js';
import { sqlTargets } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0014 slice S2 (#187, #227): the acting node can be any visible node, permissions are
 * evaluated there by the resolver (read-only for inherited bindings), unknown and invisible nodes
 * are indistinguishable, and a cached principal is rejected as soon as the authz epoch of its
 * organisation moved. Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 *
 *   org-a ─┬─ div-1 ─── team-1        org-b ─── x-unit
 *          └─ div-2
 */
const PW = 'long-password-123';

type Mode = 'legacy' | 'bindings';

describe.each(sqlTargets)('acting node and read path (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let target: Awaited<ReturnType<typeof open>>;
  let n: TestNode;
  let clock = Date.now();
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
  const get = (token: string, url: string, ref?: string) =>
    n.req({ method: 'GET', url, token, ...(ref ? { headers: { 'x-oax-tenant': ref } } : {}) });
  const rejected = async () => {
    const out = { stale: 0, invalid: 0 };
    for (const v of (await n.ctx.metrics.authzEpochRejected.get()).values)
      out[v.labels.reason as keyof typeof out] = v.value;
    return out;
  };
  const shadow = async (authoritative: Mode) => {
    const out = { match: 0, mismatch: 0, error: 0, skipped: 0 };
    for (const v of (await n.ctx.metrics.roleBindingsShadow.get()).values)
      if (v.labels.authoritative === authoritative)
        out[v.labels.outcome as keyof typeof out] = v.value;
    return out;
  };
  const bind = (
    user: string,
    tenant: string,
    role: Role,
    over: Partial<typeof tenantRoleBindings.$inferInsert> = {},
  ) =>
    n.ctx.db
      .insert(tenantRoleBindings)
      .values({ id: randomUUID(), userId: user, tenantId: tenant, role, inherit: false, ...over });
  const mkUser = async (key: string, home: string, roles: Role[]) => {
    const email = `${key}@example.org`;
    const u = await n.services.identity.createLocalUser(
      { userId: op().userId, tenantId: id[home]! },
      { email, displayName: key, password: PW, globalRoles: roles },
    );
    uid[key] = u.id;
    tok[key] = await n.login(email, PW);
  };
  const epochOf = async (slug: string) => (await currentAuthzEpoch(n.ctx.db, id[slug]!))!;

  beforeAll(async () => {
    target = await open();
    n = await testNode(
      {
        OAX_DATABASE_URL: target.url,
        OAX_ROLE_BINDINGS_READ: 'bindings',
        OAX_RATE_LIMIT_LOGIN_MAX: '10000',
      },
      {
        now: () => new Date(clock),
      },
    );
    id.default = DEFAULT_TENANT_ID;
    for (const slug of ['org-a', 'org-b']) {
      id[slug] = (await n.services.tenants.create(op(), { slug, name: `Org ${slug}` })).id;
    }
    const child = async (parent: string, slug: string) => {
      id[slug] = (await n.services.tenants.createChild(op(), id[parent]!, { slug, name: slug })).id;
    };
    await child('org-a', 'div-1');
    await child('div-1', 'team-1');
    await child('org-a', 'div-2');
    await child('org-b', 'x-unit');
    // Inheriting bindings sit on an ancestor of the user's home node. (A binding of a legacy role
    // on the home node itself is the mirror's key: until the S4 grant API the reconcile removes
    // every other shape there, see docs/tenancy.md and #226.)
    // admin of org-a without inheritance (the legacy shape: global_roles only)
    await mkUser('plain-admin', 'org-a', ['admin']);
    // inheriting viewer / admin of org-a, living in div-2
    await mkUser('inh-viewer', 'div-2', []);
    await bind(uid['inh-viewer']!, id['org-a']!, 'viewer', { inherit: true });
    await mkUser('inh-admin', 'div-2', []);
    await bind(uid['inh-admin']!, id['org-a']!, 'admin', { inherit: true });
    // inheriting admin of div-1, living in team-1
    await mkUser('inh-admin-div1', 'team-1', []);
    await bind(uid['inh-admin-div1']!, id['div-1']!, 'admin', { inherit: true });
    // home org-a, but a team membership in a team of div-1 only
    await mkUser('team-only', 'org-a', []);
    const team = await n.services.identity.createTeam(
      { userId: op().userId, tenantId: id['div-1']! },
      { slug: 'blue', name: 'Blue' },
    );
    id.team = team.id;
    await n.ctx.db
      .insert(teamMembers)
      .values({ teamId: team.id, userId: uid['team-only']!, role: 'operator' });
    // inheriting admin of org-b, living in x-unit
    await mkUser('inh-admin-b', 'x-unit', []);
    await bind(uid['inh-admin-b']!, id['org-b']!, 'admin', { inherit: true });
    // plain viewer of div-2 (legacy shape)
    await mkUser('viewer-div2', 'div-2', ['viewer']);
  }, 180_000);
  afterAll(async () => {
    await n.close();
    await target.close();
  });

  describe('acting node semantics (read path bindings)', () => {
    it('lets an inheriting binding act in every node below it, read-only', async () => {
      for (const ref of ['org-a/div-1', 'div-1', id['div-1']!, 'org-a/div-1/team-1', 'div-2']) {
        const r = await get(tok['inh-viewer']!, '/v1/agents', ref);
        expect(r.statusCode, ref).toBe(200);
      }
      const me = (await get(tok['inh-viewer']!, '/v1/me', 'org-a/div-1/team-1')).json();
      expect(me.actingTenant.slugPath).toBe('org-a/div-1/team-1');
      expect(me.homeTenant).toMatchObject({ id: id['div-2'], slugPath: 'org-a/div-2' });
      expect(me.visibleTenantCount).toBe(4);
      expect(me.installationMode).toBe('multi');
      expect(me.bindings).toEqual([
        {
          role: 'viewer',
          teamId: null,
          tenantId: id['org-a'],
          tenantSlugPath: 'org-a',
          useCase: null,
          inherit: true,
          expiresAt: null,
          source: 'inherited',
        },
      ]);
      expect(me.permissions.every((p: string) => p.endsWith(':read'))).toBe(true);
      const r = await get(tok['inh-viewer']!, '/v1/agents', 'div-1');
      expect(r.headers['x-oax-acting-tenant']).toBe('org-a/div-1');
    });

    it('is opt-in: a non-inheriting admin of the parent reaches nothing below it', async () => {
      for (const ref of ['div-1', 'org-a/div-1', id['div-1']!, 'org-a/div-1/team-1', 'div-2'])
        expect((await get(tok['plain-admin']!, '/v1/agents', ref)).statusCode, ref).toBe(404);
      expect((await get(tok['plain-admin']!, '/v1/agents', 'org-a')).statusCode).toBe(200);
      const me = (await get(tok['plain-admin']!, '/v1/me')).json();
      expect(me.visibleTenantCount).toBe(1);
      expect(me.bindings[0]).toMatchObject({ inherit: false, source: 'direct' });
    });

    it('never reaches up, sideways or into another organisation', async () => {
      const probes: [string, string[]][] = [
        [
          'inh-admin-div1',
          ['org-a', id['org-a']!, 'div-2', 'org-a/div-2', 'org-b', 'x-unit', 'default'],
        ],
        ['inh-viewer', ['org-b', id['org-b']!, 'org-b/x-unit', 'default', id.default!]],
        ['inh-admin-b', ['org-a', 'div-1', id['div-1']!, 'org-a/div-1/team-1', 'default']],
      ];
      for (const [who, refs] of probes)
        for (const ref of refs)
          expect((await get(tok[who]!, '/v1/agents', ref)).statusCode, `${who} -> ${ref}`).toBe(
            404,
          );
      // the inheriting admin of div-1 does act in div-1 and team-1
      expect((await get(tok['inh-admin-div1']!, '/v1/agents', 'team-1')).statusCode).toBe(200);
      expect((await get(tok['inh-admin-div1']!, '/v1/agents')).statusCode).toBe(200);
    });

    it('lets a team or agent binding act in exactly that node, with exactly those bindings', async () => {
      const r = await get(tok['team-only']!, '/v1/me', 'div-1');
      expect(r.statusCode).toBe(200);
      expect(r.json().bindings).toEqual([
        expect.objectContaining({
          role: 'operator',
          teamId: id.team,
          source: 'team',
          tenantId: id['div-1'],
        }),
      ]);
      expect((await get(tok['team-only']!, '/v1/agents', 'team-1')).statusCode).toBe(404);
      expect((await get(tok['team-only']!, '/v1/agents', 'div-2')).statusCode).toBe(404);
      expect((await get(tok['team-only']!, '/v1/me')).json().visibleTenantCount).toBe(2);
    });

    it('lists only the visible nodes in /v1/tenants and /v1/tenants/tree', async () => {
      const list = (await get(tok['inh-admin-div1']!, '/v1/tenants')).json();
      expect(list.items.map((t: { slugPath: string }) => t.slugPath).sort()).toEqual([
        'org-a/div-1',
        'org-a/div-1/team-1',
      ]);
      const tree = (await get(tok['inh-admin-div1']!, '/v1/tenants/tree')).json().items as {
        slugPath: string;
        visible: boolean;
        myRoles: string[];
        inheritedRoles: string[];
        hasChildren: boolean;
      }[];
      expect(tree.map((t) => `${t.slugPath}:${t.visible}`)).toEqual([
        'org-a:false',
        'org-a/div-1:true',
        'org-a/div-1/team-1:true',
      ]);
      const div1 = tree.find((t) => t.slugPath === 'org-a/div-1')!;
      expect(div1).toMatchObject({ myRoles: ['admin'], inheritedRoles: [], hasChildren: true });
      const team1 = tree.find((t) => t.slugPath === 'org-a/div-1/team-1')!;
      expect(team1).toMatchObject({ myRoles: [], inheritedRoles: ['admin'], hasChildren: false });
      const stub = tree[0]!;
      expect(stub).toMatchObject({ myRoles: [], inheritedRoles: [], hasChildren: true });
      // the sibling and the other organisation are not even named
      expect(JSON.stringify(tree)).not.toContain('div-2');
      expect(JSON.stringify(tree)).not.toContain('org-b');
      expect((await get(tok['inh-admin-div1']!, '/v1/tenants/' + id['org-a'])).statusCode).toBe(
        404,
      );
      expect((await get(tok['inh-admin-div1']!, '/v1/tenants/' + id['div-2'])).statusCode).toBe(
        404,
      );
    });

    it('keeps platform operators as they were: every node, the roles of the home tenant', async () => {
      for (const ref of ['org-a/div-1', 'org-b/x-unit', 'default'])
        expect((await get(n.admin, '/v1/agents', ref)).statusCode, ref).toBe(200);
      const me = (await get(n.admin, '/v1/me', 'org-a/div-1')).json();
      expect(
        me.bindings.map((b: { tenantId: string; source: string }) => `${b.tenantId}|${b.source}`),
      ).toEqual([`${DEFAULT_TENANT_ID}|direct`]);
      expect((await get(n.admin, '/v1/agents', 'nope')).statusCode).toBe(404);
    });
  });

  describe('read-only clamp (INHERITED_READ_ONLY)', () => {
    it('gives an inherited admin read permissions only, on every route', async () => {
      const me = (await get(tok['inh-admin']!, '/v1/me', 'div-1')).json();
      expect(me.permissions.length).toBeGreaterThan(5);
      for (const p of me.permissions) expect(INHERITED_READ_ONLY).toContain(p);
      const routes = routeIndex(n.app).filter((r) =>
        (PERMISSIONS as readonly string[]).includes(String(r.access)),
      );
      expect(routes.length).toBeGreaterThan(40);
      let writes = 0;
      let reads = 0;
      for (const r of routes) {
        const url = r.url.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
        const res = await n.req({
          method: r.method as 'GET',
          url,
          token: tok['inh-admin']!,
          headers: { 'x-oax-tenant': 'org-a/div-1' },
          payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
        });
        if ((INHERITED_READ_ONLY as readonly string[]).includes(String(r.access))) {
          reads++;
          expect(res.statusCode, `${r.method} ${r.url} (read)`).not.toBe(403);
        } else {
          writes++;
          expect(res.statusCode, `${r.method} ${r.url} (write)`).toBe(403);
        }
        expect(res.statusCode).not.toBe(401);
      }
      expect(writes).toBeGreaterThan(15);
      expect(reads).toBeGreaterThan(10);
    });

    it('control: the same admin holding the binding directly may write', async () => {
      const r = await n.req({
        method: 'POST',
        url: '/v1/teams',
        token: tok['plain-admin']!,
        payload: { slug: 'ctl', name: 'Ctl' },
      });
      expect(r.statusCode).toBe(201);
      const refused = await n.req({
        method: 'POST',
        url: '/v1/teams',
        token: tok['inh-admin']!,
        headers: { 'x-oax-tenant': 'div-1' },
        payload: { slug: 'ctl2', name: 'Ctl' },
      });
      expect(refused.statusCode).toBe(403);
    });
  });

  describe('no oracle: unknown and invisible nodes are the same 404', () => {
    const refs = (who: string): string[] =>
      who === 'plain-admin'
        ? [
            'div-1', // child without inheriting binding
            'org-a/div-1/team-1',
            id['div-2']!,
            'org-b', // other organisation
            id['org-b']!,
            'org-b/x-unit',
            'x-unit',
            'default',
            randomUUID(), // unknown
            'nope',
            'org-a/nope',
            'org-a/div-1/nope', // invisible middle segment, unknown leaf
            'org-b/div-1/team-1', // invisible middle segment elsewhere
            'a//b',
            ' ',
            'x'.repeat(3000),
          ]
        : [
            'org-a',
            id['org-a']!,
            'div-2',
            'org-a/div-2',
            'org-b',
            'default',
            randomUUID(),
            'nope',
            'org-a/div-1/nope',
          ];

    it.each(['plain-admin', 'inh-admin-div1'])(
      'answers %s with one status and one body for every probe',
      async (who) => {
        const bodies = new Set<string>();
        for (const ref of refs(who)) {
          const r = await get(tok[who]!, '/v1/agents', ref);
          expect(r.statusCode, `${who} -> ${ref.slice(0, 40)}`).toBe(404);
          expect(r.headers['x-oax-acting-tenant']).toBeUndefined();
          bodies.add(r.body);
        }
        expect(bodies.size).toBe(1);
      },
    );

    it('costs the same number of queries for an unknown and an invisible node, warm or cold', async () => {
      const calls = () => {
        const spies = (
          ['select', 'execute', 'insert', 'update', 'delete', 'transaction'] as const
        ).map((m) =>
          vi.spyOn(n.ctx.db as unknown as Record<string, (...a: unknown[]) => unknown>, m),
        );
        return {
          total: () => spies.reduce((s, sp) => s + sp.mock.calls.length, 0),
          done: () => spies.forEach((sp) => sp.mockRestore()),
        };
      };
      const resolve = vi.spyOn(TenantAccess.prototype, 'resolve');
      const walk = vi.spyOn(TenantTree.prototype, 'resolveSlugPath');
      try {
        for (const cold of [false, true]) {
          // an unknown, an invisible (sibling subtree) and a foreign-organisation reference
          const counts: number[] = [];
          for (const ref of [
            randomUUID(),
            id['div-1']!,
            id['org-b']!,
            'org-a/div-1/nope',
            'org-b/x-unit',
          ]) {
            await get(tok['inh-admin-div1']!, '/v1/agents'); // warm the principal
            if (cold) await n.ctx.cache.delPrefix('tree:');
            const c = calls();
            const r = await get(tok['plain-admin']!, '/v1/agents', ref);
            counts.push(c.total());
            c.done();
            expect(r.statusCode).toBe(404);
          }
          expect(new Set(counts).size, `cold=${cold} ${counts.join(',')}`).toBe(1);
        }
        // never a lookup of another node, never a walk over slug segments
        expect(resolve).not.toHaveBeenCalled();
        expect(walk).not.toHaveBeenCalled();
      } finally {
        resolve.mockRestore();
        walk.mockRestore();
      }
    });
  });

  describe('expiry is evaluated per request, also for a cached principal', () => {
    it('applies a binding one millisecond before its expiry and not at it', async () => {
      await mkUser('expiring', 'div-2', []);
      const expiry = clock + 60_000;
      await bind(uid.expiring!, id['org-a']!, 'viewer', {
        inherit: true,
        expiresAt: new Date(expiry),
      });
      const t = tok.expiring!;
      const before = await rejected();
      clock = expiry - 60_000;
      expect((await get(t, '/v1/agents')).statusCode).toBe(200); // builds and caches the principal
      expect((await get(t, '/v1/agents', 'div-1')).statusCode).toBe(200);
      clock = expiry - 1;
      expect((await get(t, '/v1/agents', 'div-1')).statusCode).toBe(200);
      expect((await get(t, '/v1/agents')).statusCode).toBe(200);
      clock = expiry;
      expect((await get(t, '/v1/agents', 'div-1')).statusCode).toBe(404);
      expect((await get(t, '/v1/agents')).statusCode).toBe(403); // no permission left at home
      clock = expiry + 1;
      expect((await get(t, '/v1/agents', 'div-1')).statusCode).toBe(404);
      // nothing bumped the epoch: the cached entry was used throughout
      expect(await rejected()).toEqual(before);
      clock = Date.now();
    });
  });

  describe('authz epoch (#227)', () => {
    it.each<Mode>(['legacy', 'bindings'])(
      'refuses the next request after a revocation by psql (trigger), mode %s',
      async (mode) => {
        setMode(mode);
        try {
          const key = `psql-${mode}`;
          await mkUser(key, 'org-a', ['admin']);
          expect((await get(tok[key]!, '/v1/users')).statusCode).toBe(200); // cached now
          expect((await get(tok[key]!, '/v1/users')).statusCode).toBe(200);
          const e0 = await epochOf('org-a');
          const stale = (await rejected()).stale;
          // an emergency revocation outside the application: no invalidateUserTokens, no cache delete
          await n.ctx.db
            .update(usersTable)
            .set({ globalRoles: [] })
            .where(eq(usersTable.id, uid[key]!));
          expect(await epochOf('org-a')).toBeGreaterThan(e0);
          expect((await get(tok[key]!, '/v1/users')).statusCode).toBe(403);
          expect((await rejected()).stale).toBe(stale + 1);
        } finally {
          setMode('bindings');
        }
      },
    );

    it.each<Mode>(['legacy', 'bindings'])(
      'refuses the next request after a role change through the API, and keeps the epoch moving, mode %s',
      async (mode) => {
        setMode(mode);
        try {
          const key = `app-${mode}`;
          await mkUser(key, 'org-a', ['admin']);
          expect((await get(tok[key]!, '/v1/users')).statusCode).toBe(200);
          const e0 = await epochOf('org-a');
          const patch = await n.req({
            method: 'PATCH',
            url: `/v1/users/${uid[key]}`,
            headers: { 'x-oax-tenant': id['org-a']! },
            payload: { globalRoles: ['viewer'] },
          });
          expect(patch.statusCode).toBe(200);
          expect(await epochOf('org-a')).toBeGreaterThan(e0);
          expect((await get(tok[key]!, '/v1/users')).statusCode).toBe(403);
          expect((await get(tok[key]!, '/v1/agents')).statusCode).toBe(200);
        } finally {
          setMode('bindings');
        }
      },
    );

    it.each<Mode>(['legacy', 'bindings'])(
      'refuses the next request after the reconcile removed the binding, mode %s',
      async (mode) => {
        setMode(mode);
        // no shadow check: its targeted reconcile would remove the leftover row in the background
        const shadowOn = n.ctx.config.auth.roleBindingsShadow;
        (n.ctx.config.auth as unknown as { roleBindingsShadow: boolean }).roleBindingsShadow =
          false;
        try {
          const key = `rec-${mode}`;
          await mkUser(key, 'org-a', ['admin']);
          expect((await get(tok[key]!, '/v1/users')).statusCode).toBe(200);
          // the role was taken away by a writer that bypassed the trigger (an old version, a restore)
          await n.ctx.db.execute(
            (await import('drizzle-orm'))
              .sql`alter table users disable trigger trb_users_home_move_trg`,
          );
          try {
            await n.ctx.db
              .update(usersTable)
              .set({ globalRoles: [] })
              .where(eq(usersTable.id, uid[key]!));
          } finally {
            await n.ctx.db.execute(
              (await import('drizzle-orm'))
                .sql`alter table users enable trigger trb_users_home_move_trg`,
            );
          }
          // the users trigger bumped the epoch already; take a fresh principal into the cache, then
          // let the reconcile delete the leftover binding: that deletion alone must invalidate it
          const rows = await n.ctx.db
            .select()
            .from(tenantRoleBindings)
            .where(eq(tenantRoleBindings.userId, uid[key]!));
          expect(rows).toHaveLength(1);
          expect((await get(tok[key]!, '/v1/users')).statusCode).toBe(
            mode === 'bindings' ? 200 : 403,
          );
          const e0 = await epochOf('org-a');
          const r = await n.services.identity.reconciler.runUser(uid[key]!, 'cli');
          expect(r?.removed).toBe(1);
          expect(await epochOf('org-a')).toBeGreaterThan(e0);
          expect((await get(tok[key]!, '/v1/users')).statusCode).toBe(403);
        } finally {
          (n.ctx.config.auth as unknown as { roleBindingsShadow: boolean }).roleBindingsShadow =
            shadowOn;
          setMode('bindings');
        }
      },
    );

    it('refuses after a binding row is deleted, narrowed or expired by SQL', async () => {
      await mkUser('sql-del', 'div-2', []);
      await bind(uid['sql-del']!, id['org-a']!, 'viewer', { inherit: true });
      const t = tok['sql-del']!;
      expect((await get(t, '/v1/agents', 'div-1')).statusCode).toBe(200);
      // narrowing: inherit -> false
      await n.ctx.db
        .update(tenantRoleBindings)
        .set({ inherit: false })
        .where(eq(tenantRoleBindings.userId, uid['sql-del']!));
      expect((await get(t, '/v1/agents', 'div-1')).statusCode).toBe(404);
      expect((await get(t, '/v1/agents')).statusCode).toBe(403); // no binding left at its home node
      // widening is seen at once too
      await n.ctx.db
        .update(tenantRoleBindings)
        .set({ inherit: true })
        .where(eq(tenantRoleBindings.userId, uid['sql-del']!));
      expect((await get(t, '/v1/agents', 'div-1')).statusCode).toBe(200);
      // deletion
      await n.ctx.db
        .delete(tenantRoleBindings)
        .where(eq(tenantRoleBindings.userId, uid['sql-del']!));
      expect((await get(t, '/v1/agents', 'div-1')).statusCode).toBe(404);
      expect((await get(t, '/v1/agents')).statusCode).toBe(403);
    });

    it('refuses after a team membership is removed or a user is disabled by SQL', async () => {
      expect((await get(tok['team-only']!, '/v1/agents', 'div-1')).statusCode).toBe(200);
      await n.ctx.db.delete(teamMembers).where(eq(teamMembers.userId, uid['team-only']!));
      expect((await get(tok['team-only']!, '/v1/agents', 'div-1')).statusCode).toBe(404);
      await mkUser('to-disable', 'org-a', ['admin']);
      expect((await get(tok['to-disable']!, '/v1/users')).statusCode).toBe(200);
      await n.ctx.db
        .update(usersTable)
        .set({ disabled: true })
        .where(eq(usersTable.id, uid['to-disable']!));
      expect((await get(tok['to-disable']!, '/v1/users')).statusCode).toBe(401);
    });

    it('sees a node created, renamed or removed after the snapshot was cached', async () => {
      expect((await get(tok['inh-viewer']!, '/v1/agents', 'org-a/div-2/late')).statusCode).toBe(
        404,
      );
      const late = await n.services.tenants.createChild(op(), id['div-2']!, {
        slug: 'late',
        name: 'Late',
      });
      expect((await get(tok['inh-viewer']!, '/v1/agents', 'org-a/div-2/late')).statusCode).toBe(
        200,
      );
      expect((await get(tok['inh-viewer']!, '/v1/agents', late.id)).statusCode).toBe(200);
      await n.ctx.db
        .update(tenantsTable)
        .set({ slug: 'later' })
        .where(eq(tenantsTable.id, late.id));
      expect((await get(tok['inh-viewer']!, '/v1/agents', 'org-a/div-2/late')).statusCode).toBe(
        404,
      );
      expect((await get(tok['inh-viewer']!, '/v1/agents', 'org-a/div-2/later')).statusCode).toBe(
        200,
      );
      await n.ctx.db.delete(tenantsTable).where(eq(tenantsTable.id, late.id));
      expect((await get(tok['inh-viewer']!, '/v1/agents', late.id)).statusCode).toBe(404);
    });

    it('does not mix organisations: a change in org-a leaves org-b principals and snapshots alone', async () => {
      expect((await get(tok['inh-admin-b']!, '/v1/agents', 'x-unit')).statusCode).toBe(200);
      const eb = await epochOf('org-b');
      const stale = (await rejected()).stale;
      await bind(uid['plain-admin']!, id['div-1']!, 'auditor');
      await n.ctx.db
        .delete(tenantRoleBindings)
        .where(eq(tenantRoleBindings.userId, uid['plain-admin']!))
        .returning();
      await bind(uid['plain-admin']!, id['org-a']!, 'admin'); // back to the legacy shape
      expect(await epochOf('org-b')).toBe(eb);
      expect((await get(tok['inh-admin-b']!, '/v1/agents', 'x-unit')).statusCode).toBe(200);
      expect((await rejected()).stale).toBe(stale); // org-b's entry was still valid
      // a snapshot holds the nodes of exactly one organisation
      const snap = await new TenantSnapshots(n.ctx).get(id['org-b']!, eb);
      expect(snap?.nodes.map((x) => x.id).sort()).toEqual([id['org-b']!, id['x-unit']!].sort());
      // and the binding trigger bumps the organisation of the binding's node, not another
      const ea = await epochOf('org-a');
      await bind(uid['inh-admin-b']!, id['x-unit']!, 'viewer');
      expect(await epochOf('org-a')).toBe(ea);
      expect(await epochOf('org-b')).toBeGreaterThan(eb);
    });

    it("rejects a cache entry that does not belong to the token, and one with another user's grants", async () => {
      // find the cache keys of both principals by authenticating once
      await get(tok['plain-admin']!, '/v1/users');
      await get(tok['viewer-div2']!, '/v1/me');
      const keys = (n.ctx.cache as unknown as { lru: { keys(): IterableIterator<string> } }).lru;
      const authKeys = [...keys.keys()].filter((k) => k.startsWith('auth:'));
      const entryOf = async (userId: string) => {
        for (const k of authKeys) {
          const e = await n.ctx.cache.get<{ principal: { userId: string } }>(k);
          if (e?.principal.userId === userId) return { key: k, entry: e };
        }
        throw new Error('no cache entry');
      };
      const admin = await entryOf(uid['plain-admin']!);
      const viewer = await entryOf(uid['viewer-div2']!);
      expect((await get(tok['viewer-div2']!, '/v1/users')).statusCode).toBe(403);
      const before = (await rejected()).invalid;
      // 1. the admin's entry under the viewer's key: a miss, the viewer stays a viewer
      await n.ctx.cache.set(viewer.key, admin.entry, 30_000);
      expect((await get(tok['viewer-div2']!, '/v1/users')).statusCode).toBe(403);
      expect((await rejected()).invalid).toBeGreaterThan(before);
      // 2. the viewer's own entry, but carrying the admin's grants: the owner check fails
      const poisoned = {
        ...(await n.ctx.cache.get<Record<string, unknown>>(viewer.key)),
        grants: (admin.entry as unknown as { grants: unknown }).grants,
      };
      await n.ctx.cache.set(viewer.key, poisoned, 30_000);
      const before2 = (await rejected()).invalid;
      expect((await get(tok['viewer-div2']!, '/v1/users')).statusCode).toBe(403);
      expect((await rejected()).invalid).toBeGreaterThan(before2);
      // 3. an entry for the right user and key but the wrong format is a miss too
      await n.ctx.cache.set(viewer.key, { v: 1, principal: {}, exp: Date.now() + 10_000 }, 30_000);
      expect((await get(tok['viewer-div2']!, '/v1/users')).statusCode).toBe(403);
      expect((await get(tok['plain-admin']!, '/v1/users')).statusCode).toBe(200);
    });

    it('keeps the legacy entry of a token from authorising on the bindings path and back', async () => {
      await get(tok['plain-admin']!, '/v1/users'); // entry built for bindings
      setMode('legacy');
      try {
        expect((await get(tok['plain-admin']!, '/v1/users')).statusCode).toBe(200);
        expect((await get(tok['inh-viewer']!, '/v1/agents', 'div-1')).statusCode).toBe(404);
      } finally {
        setMode('bindings');
      }
      expect((await get(tok['inh-viewer']!, '/v1/agents', 'div-1')).statusCode).toBe(200);
    });
  });

  describe('read path switch', () => {
    it('is the same for every user whose roles the legacy sources can express', async () => {
      const legacyShaped = ['plain-admin', 'viewer-div2', 'team-only'];
      const bootstrap = (
        await n.ctx.db.select().from(usersTable).where(eq(usersTable.email, 'admin@example.com'))
      )[0]!;
      const ids = [bootstrap.id, ...legacyShaped.map((k) => uid[k]!)];
      const prints: Record<Mode, string[][]> = { legacy: [], bindings: [] };
      const statuses: Record<Mode, number[]> = { legacy: [], bindings: [] };
      const routes = routeIndex(n.app).filter(
        (r) =>
          r.method === 'GET' &&
          r.access !== 'public' &&
          !r.url.includes(':') &&
          !r.url.includes('stream'),
      );
      for (const mode of ['legacy', 'bindings'] as Mode[]) {
        setMode(mode);
        try {
          for (const u of ids) {
            const p = await n.services.identity.principalForUser(u);
            prints[mode].push(bindingFingerprint(p.bindings));
          }
          for (const k of legacyShaped)
            for (const r of routes) statuses[mode].push((await get(tok[k]!, r.url)).statusCode);
        } finally {
          setMode('bindings');
        }
      }
      expect(prints.bindings).toEqual(prints.legacy);
      expect(statuses.bindings).toEqual(statuses.legacy);
      expect(statuses.legacy.length).toBeGreaterThan(30);
    });

    it('counts the shadow comparison in the other direction when the resolver decides', async () => {
      await mkUser('drift', 'org-a', ['admin']);
      expect((await get(tok.drift!, '/v1/users')).statusCode).toBe(200);
      const before = await shadow('bindings');
      const legacyBefore = await shadow('legacy');
      // the mirror row goes missing: the resolver (authoritative) grants less than global_roles
      await n.ctx.db.delete(tenantRoleBindings).where(eq(tenantRoleBindings.userId, uid.drift!));
      expect((await get(tok.drift!, '/v1/users')).statusCode).toBe(403); // the resolver decides
      const after = await shadow('bindings');
      expect(after.mismatch).toBe(before.mismatch + 1);
      expect((await shadow('legacy')).mismatch).toBe(legacyBefore.mismatch); // no longer compared
      // repairing the mirror restores the access
      await n.services.identity.reconciler.runUser(uid.drift!, 'cli');
      expect((await get(tok.drift!, '/v1/users')).statusCode).toBe(200);
    });

    it('does not let an inheriting binding act while the legacy path decides', async () => {
      setMode('legacy');
      try {
        expect((await get(tok['inh-admin']!, '/v1/agents', 'div-1')).statusCode).toBe(404);
        expect((await get(tok['inh-admin']!, '/v1/me')).json().permissions).toEqual([]);
        const me = (await get(tok['plain-admin']!, '/v1/me')).json();
        expect(me.bindings[0]).toMatchObject({ inherit: false, source: 'direct', expiresAt: null });
      } finally {
        setMode('bindings');
      }
    });
  });
});

describe('TreeSnapshot lookups (pure)', () => {
  const root = 'aaaaaaaa-0000-4000-8000-000000000001';
  const a = 'aaaaaaaa-0000-4000-8000-0000000000a1';
  const b = 'aaaaaaaa-0000-4000-8000-0000000000b1';
  const x = 'bbbbbbbb-0000-4000-8000-000000000001';
  const node = (id: string, parentId: string | null, path: string, slug: string): SnapNode => ({
    id,
    rootId: path.split('/')[1]!,
    path,
    parentId,
    depth: path.split('/').length - 3,
    slug,
  });
  const snap = new TreeSnapshot(root, [
    node(root, null, `/${root}/`, 'acme'),
    node(a, root, `/${root}/${a}/`, 'security'),
    node(b, a, `/${root}/${a}/${b}/`, 'blue'),
    // a node whose ancestor is missing from the snapshot has no slug path
    node(
      x,
      'cccccccc-0000-4000-8000-000000000009',
      `/${root}/cccccccc-0000-4000-8000-000000000009/${x}/`,
      'orphan',
    ),
  ]);

  it('finds a node by id, bare slug and slug path, and nothing else', () => {
    expect(snap.find(b)?.id).toBe(b);
    expect(snap.find(b.toUpperCase())?.id).toBe(b);
    expect(snap.find('blue')?.id).toBe(b);
    expect(snap.find('acme/security/blue')?.id).toBe(b);
    for (const ref of [
      '',
      'nope',
      'acme/blue',
      'security/blue',
      'acme/security/blue/',
      '/acme',
      'orphan/x',
      'ACME',
    ])
      expect(snap.find(ref), ref).toBeUndefined();
    expect(snap.slugPath(x)).toBeUndefined();
    expect(snap.find('orphan')?.id).toBe(x);
  });
});
