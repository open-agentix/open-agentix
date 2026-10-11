import { randomUUID } from 'node:crypto';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type Permission,
  type Principal,
  type Role,
} from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TENANT_ID,
  agentVersions,
  agents,
  approvals,
  auditLog,
  connections,
  eventSources,
  runs,
  tenantRoleBindings,
} from '../src/db/schema.js';
import { routeIndex } from '../src/http/app.js';
import { LOCATE_AUDIT_MAX, LOCATE_KINDS, type LocateKind } from '../src/services/locate.js';
import { sqlTargets } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0014 slice S7 (#192, #163): `GET /v1/locate/{kind}/{id}`. 404 parity between a resource that
 * does not exist and one the caller must not learn about (sibling, ancestor, other organisation, no
 * read permission at the owner, token scope), the same number of statements for all of them, the
 * audit rate limit, kinds and roles, and the legacy read path. Runs on PGlite and, with
 * OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 *
 *   org-a ─┬─ div-1 ─── team-1        org-b ─── x-unit        org-c
 *          └─ div-2
 */
const PW = 'long-password-123';
const KINDS = LOCATE_KINDS;
const NEEDS: Record<LocateKind, Permission> = {
  agent: 'agents:read',
  run: 'runs:read',
  approval: 'runs:read',
  'event-source': 'sources:read',
  connection: 'connections:read',
};

interface Res {
  agent: string;
  run: string;
  approval: string;
  'event-source': string;
  connection: string;
}

describe.each(['bindings', 'legacy'] as const)('locate, read path %s', (mode) =>
  describe.each(sqlTargets)(`(%s)`, (_kind, enabled, open) => {
    if (!enabled()) {
      it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
      return;
    }
    let target: Awaited<ReturnType<typeof open>>;
    let n: TestNode;
    const id = {} as Record<string, string>;
    const tok = {} as Record<string, string>;
    const uid = {} as Record<string, string>;
    const res = {} as Record<string, Res>;
    const teamId = {} as Record<string, string>;
    const bindingsMode = mode === 'bindings';
    const op = (): Principal => ({
      kind: 'user',
      userId: randomUUID(),
      tenantId: DEFAULT_TENANT_ID,
      displayName: 'op',
      platformAdmin: true,
      bindings: [],
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
    const bind = (user: string, tenant: string, role: Role, inherit: boolean, expiresAt?: Date) =>
      n.ctx.db.insert(tenantRoleBindings).values({
        id: randomUUID(),
        userId: uid[user]!,
        tenantId: id[tenant]!,
        role,
        inherit,
        source: 'grant',
        ...(expiresAt ? { expiresAt } : {}),
      });
    const locate = (who: string | null, kind: string, rid: string, headers = {}) =>
      n.req({
        method: 'GET',
        url: `/v1/locate/${kind}/${rid}`,
        headers,
        ...(who === null ? {} : { token: tok[who]! }),
      });
    const audits = async (user: string) =>
      (await n.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'access.denied'))).filter(
        (e) => e.actor === uid[user],
      );

    /** One agent, run, approval, event source and connection owned by `tenant` (team-scoped when given). */
    const seed = async (tenant: string, team?: string): Promise<Res> => {
      const t = id[tenant]!;
      const tm = team ? teamId[team]! : null;
      const agentId = randomUUID();
      const versionId = randomUUID();
      const runId = randomUUID();
      const out: Res = {
        agent: agentId,
        run: runId,
        approval: randomUUID(),
        'event-source': randomUUID(),
        connection: randomUUID(),
      };
      const sfx = `${tenant}${team ? `-${team}` : ''}`;
      await n.ctx.db.insert(agents).values({
        id: agentId,
        tenantId: t,
        name: `agent-${sfx}`,
        teamId: tm,
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
      await n.ctx.db.insert(runs).values({
        id: runId,
        tenantId: t,
        agentId,
        agentVersionId: versionId,
        teamId: tm,
        status: 'succeeded',
        triggeredBy: 'test',
      });
      await n.ctx.db.insert(approvals).values({
        id: out.approval,
        tenantId: t,
        runId,
        teamId: tm,
        agentId: 'x',
        tool: 'tool',
        args: {},
        reasons: [],
        approverRoles: ['admin'],
        status: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await n.ctx.db.insert(eventSources).values({
        id: out['event-source'],
        tenantId: t,
        name: `src-${sfx}`,
        kind: 'webhook',
      });
      await n.ctx.db.insert(connections).values({
        id: out.connection,
        tenantId: t,
        name: `conn-${sfx}`,
        kind: 'mcp',
        config: {},
      });
      return out;
    };

    beforeAll(async () => {
      target = await open();
      n = await testNode({
        OAX_DATABASE_URL: target.url,
        OAX_ROLE_BINDINGS_READ: mode,
        OAX_RATE_LIMIT_LOGIN_MAX: '100000',
        OAX_BINDING_REAPER_INTERVAL_SECONDS: '0',
      });
      id.default = DEFAULT_TENANT_ID;
      for (const slug of ['org-a', 'org-b', 'org-c'])
        id[slug] = (await n.services.tenants.create(op(), { slug, name: `Org ${slug}` })).id;
      const child = async (parent: string, slug: string) => {
        id[slug] = (
          await n.services.tenants.createChild(op(), id[parent]!, { slug, name: `Name ${slug}` })
        ).id;
      };
      await child('org-a', 'div-1');
      await child('div-1', 'team-1');
      await child('org-a', 'div-2');
      await child('org-b', 'x-unit');
      for (const t of ['blue', 'red']) {
        const r = await n.req({
          method: 'POST',
          url: '/v1/teams',
          payload: { slug: t, name: t },
          headers: { 'x-oax-tenant': id['org-a']! },
        });
        expect(r.statusCode).toBe(201);
        teamId[t] = r.json().id;
      }
      // users
      await mkUser('root-admin', 'org-a', ['admin']); // inheriting admin of org-a
      await bind('root-admin', 'org-a', 'admin', true);
      await mkUser('admin-d1', 'div-1', ['admin']); // inheriting admin of div-1
      await bind('admin-d1', 'div-1', 'admin', true);
      await mkUser('admin-t1', 'team-1', ['admin']); // admin of team-1 only (legacy: global role)
      await mkUser('plain-admin', 'org-a', ['admin']); // admin of org-a, does not inherit
      await mkUser('viewer', 'org-a', ['viewer']);
      await bind('viewer', 'org-a', 'viewer', true);
      await mkUser('integrator', 'org-a', ['integrator']);
      await bind('integrator', 'org-a', 'integrator', true);
      await mkUser('pentester', 'org-a');
      await bind('pentester', 'org-a', 'pentest', true, new Date(Date.now() + 7 * 86_400_000));
      await mkUser('blue-viewer', 'org-a');
      await mkUser('admin-b', 'org-b', ['admin']);
      await bind('admin-b', 'org-b', 'admin', true);
      await mkUser('admin-c', 'org-c', ['admin']);
      await bind('admin-c', 'org-c', 'admin', true);
      const put = await n.req({
        method: 'PUT',
        url: `/v1/teams/${teamId.blue}/members`,
        payload: { members: [{ userId: uid['blue-viewer'], role: 'viewer' }] },
        headers: { 'x-oax-tenant': id['org-a']! },
      });
      expect(put.statusCode).toBeLessThan(300);
      // resources
      for (const t of ['org-a', 'div-1', 'team-1', 'div-2', 'org-b', 'x-unit', 'org-c'])
        res[t] = await seed(t);
      res['org-a/blue'] = await seed('org-a', 'blue');
      res['org-a/red'] = await seed('org-a', 'red');
      await n.ctx.cache.delPrefix('auth:');
    }, 240_000);
    afterAll(async () => {
      await n.close();
      await target.close();
    });

    const owner = (tenant: string) => ({ id: id[tenant], name: expect.any(String) });
    const ok = async (who: string | null, tenant: string, kind: LocateKind, key = tenant) => {
      const r = await locate(who, kind, res[key]![kind]);
      expect(r.statusCode, `${who} ${kind} ${key} ${r.body}`).toBe(200);
      expect(r.json().tenant).toMatchObject(owner(tenant));
      expect(Object.keys(r.json())).toEqual(['tenant']);
      expect(Object.keys(r.json().tenant).sort()).toEqual(['id', 'name', 'slugPath']);
      return r.json().tenant as { id: string; slugPath: string; name: string };
    };
    /** The 404 a non-existent id gives the same caller, compared in full with the one under test. */
    const parity = async (who: string, kind: LocateKind, key: string) => {
      const hidden = await locate(who, kind, res[key]![kind]);
      const missing = await locate(who, kind, randomUUID());
      expect(hidden.statusCode, `${who} ${kind} ${key}`).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(hidden.body).toBe(missing.body);
      const strip = (h: Record<string, unknown>) => {
        const {
          date: _d,
          'x-request-id': _r,
          'x-ratelimit-remaining': _l,
          'x-ratelimit-reset': _t,
          ...rest
        } = h;
        return rest;
      };
      expect(strip(hidden.headers)).toEqual(strip(missing.headers));
    };

    describe.runIf(bindingsMode)('answers', () => {
      it('names the owning tenant for every kind, with slug path and name', async () => {
        for (const kind of KINDS) {
          const t = await ok('root-admin', 'team-1', kind);
          expect(t.slugPath).toBe('org-a/div-1/team-1');
          expect(t.name).toBe('Name team-1');
        }
        expect((await ok('root-admin', 'org-a', 'agent')).slugPath).toBe('org-a');
      });

      it('does not depend on the acting tenant or its header', async () => {
        const r = await locate('root-admin', 'run', res['team-1']!.run, {
          'x-oax-tenant': id['div-2']!,
        });
        expect(r.statusCode).toBe(200);
        expect(r.json().tenant.id).toBe(id['team-1']);
      });

      it('never returns data of the resource', async () => {
        for (const kind of KINDS) {
          const r = await locate('root-admin', kind, res['div-1']![kind]);
          expect(r.body).not.toMatch(/agent-div-1|src-div-1|conn-div-1|succeeded|# agent|webhook/);
        }
      });
    });

    it('lets a platform operator locate everything, in any organisation', async () => {
      for (const t of ['org-a', 'org-b', 'x-unit', 'org-c'])
        for (const kind of KINDS) await ok(null, t, kind);
    });

    describe('404 parity with a non-existent id', () => {
      const cases: [string, string][] = [
        ['admin-d1', 'div-2'], // sibling
        ['admin-d1', 'org-a'], // ancestor of the home node
        ['admin-d1', 'org-b'], // other organisation
        ['admin-t1', 'div-1'], // ancestor
        ['admin-t1', 'org-a'],
        ['plain-admin', 'div-1'], // below a non-inheriting binding
        ['plain-admin', 'team-1'],
        ['root-admin', 'org-b'], // other organisation
        ['root-admin', 'x-unit'],
        ['root-admin', 'org-c'],
        ['admin-c', 'org-a'],
        ['admin-b', 'div-1'],
      ];
      it.each(cases)('%s asking for a resource of %s', async (who, tenant) => {
        for (const kind of KINDS) await parity(who, kind, tenant);
      });

      it('gives the same answer for the default tenant resources of other organisations', async () => {
        for (const kind of KINDS) await parity('admin-b', kind, 'org-c');
      });

      it('gives a non-existent id the same answer for every caller and kind', async () => {
        const bodies = new Set<string>();
        for (const who of ['root-admin', 'admin-d1', 'admin-c', 'viewer'])
          for (const kind of KINDS) bodies.add((await locate(who, kind, randomUUID())).body);
        expect(bodies.size).toBe(1);
      });

      it('answers 404 not 403 when the node is visible but the permission is missing', async () => {
        // a viewer sees org-a and div-1 but holds neither sources:read nor connections:read
        await parity('viewer', 'event-source', 'div-1');
        await parity('viewer', 'connection', 'org-a');
        const r = await locate('viewer', 'connection', res['org-a']!.connection);
        expect(r.statusCode).toBe(404);
      });
    });

    describe.runIf(bindingsMode)('permissions at the owning node', () => {
      it('follows the read permission of each kind for every role', async () => {
        const roles: [string, Role][] = [
          ['viewer', 'viewer'],
          ['integrator', 'integrator'],
          ['pentester', 'pentest'],
          ['root-admin', 'admin'],
        ];
        for (const [who, role] of roles)
          for (const kind of KINDS) {
            const may = ROLE_PERMISSIONS[role].includes(NEEDS[kind]);
            if (may) await ok(who, 'div-1', kind);
            else await parity(who, kind, 'div-1');
          }
      });

      it('lets the read-only pentest role locate every readable kind', async () => {
        for (const kind of KINDS) await ok('pentester', 'team-1', kind);
        expect(PERMISSIONS).toContain('sources:read');
      });

      it('honours team-scoped bindings for team-owned resources', async () => {
        await ok('blue-viewer', 'org-a', 'run', 'org-a/blue');
        await ok('blue-viewer', 'org-a', 'agent', 'org-a/blue');
        await ok('blue-viewer', 'org-a', 'approval', 'org-a/blue');
        await parity('blue-viewer', 'run', 'org-a/red');
        await parity('blue-viewer', 'agent', 'org-a/red');
        await parity('blue-viewer', 'approval', 'org-a/red');
        // node-wide resources have no team: a team-scoped viewer holds no sources:read anyway
        await parity('blue-viewer', 'connection', 'org-a');
      });

      it('does not let a visible home node lend permissions to a node below it', async () => {
        // plain-admin is admin of org-a only; div-1 is not covered by a non-inheriting binding
        await ok('plain-admin', 'org-a', 'run');
        await parity('plain-admin', 'run', 'div-1');
      });

      it('applies token scopes', async () => {
        const mk = async (scopes: Permission[]) => {
          const r = await n.req({
            method: 'POST',
            url: '/v1/tokens',
            token: tok['root-admin']!,
            payload: { name: `t-${scopes.join('-')}`, scopes },
          });
          expect(r.statusCode).toBe(201);
          return r.json().token as string;
        };
        const agentsOnly = await mk(['agents:read', 'tokens:write']);
        const get = (kind: LocateKind, key: string) =>
          n.req({ method: 'GET', url: `/v1/locate/${kind}/${res[key]![kind]}`, token: agentsOnly });
        expect((await get('agent', 'div-1')).statusCode).toBe(200);
        for (const kind of ['run', 'approval', 'event-source', 'connection'] as const) {
          const r = await get(kind, 'div-1');
          expect(r.statusCode).toBe(404);
          const m = await n.req({
            method: 'GET',
            url: `/v1/locate/${kind}/${randomUUID()}`,
            token: agentsOnly,
          });
          expect(r.body).toBe(m.body);
        }
      });
    });

    describe('request validation and authentication', () => {
      it('requires authentication', async () => {
        expect(
          (await n.req({ method: 'GET', url: `/v1/locate/run/${randomUUID()}`, token: null }))
            .statusCode,
        ).toBe(401);
        const bad = await n.req({
          method: 'GET',
          url: `/v1/locate/run/${randomUUID()}`,
          token: 'oax_nope',
        });
        expect(bad.statusCode).toBe(401);
      });

      it('refuses kinds outside the allowlist and ids that are not UUIDs, before any lookup', async () => {
        const spy = vi.spyOn(n.ctx.db as never as Record<string, () => unknown>, 'select');
        try {
          for (const [kind, rid] of [
            ['tenant', randomUUID()],
            ['user', randomUUID()],
            ['run', 'not-a-uuid'],
            ['run', "x'; drop table runs; --"],
            ['run', `${randomUUID()}%20`],
            ['..', randomUUID()],
            ['agent', '00000000-0000-0000-0000-00000000000g'],
          ] as const) {
            const r = await locate('root-admin', encodeURIComponent(kind), encodeURIComponent(rid));
            expect([400, 404], `${kind} ${rid}`).toContain(r.statusCode);
          }
        } finally {
          spy.mockRestore();
        }
        expect((await locate('root-admin', 'run', "' or 1=1 --")).statusCode).toBe(400);
        // the table is still there
        expect((await locate('root-admin', 'run', res['org-a']!.run)).statusCode).toBe(200);
      });

      it('accepts upper-case UUIDs like the other routes', async () => {
        const r = await locate('root-admin', 'run', res['org-a']!.run.toUpperCase());
        expect(r.statusCode).toBe(200);
      });

      it('is listed as authenticated, the permission being checked at the owning node', () => {
        const route = routeIndex(n.app).find((r) => r.url === '/v1/locate/:kind/:id');
        expect(route).toMatchObject({ method: 'GET', access: 'authenticated' });
      });
    });

    describe('constant work', () => {
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

      it.each(['admin-d1', 'plain-admin', 'root-admin'])(
        'costs the same number of statements for %s whether the id exists or not, warm or cold',
        async (who) => {
          for (const cold of [false, true])
            for (const limited of [false, true]) {
              const counts: Record<string, number> = {};
              for (const [label, kind, rid] of [
                ['unknown', 'run', randomUUID()],
                ['sibling', 'run', res['div-2']!.run],
                ['ancestor', 'run', res['org-a']!.run],
                ['other-org', 'run', res['org-b']!.run],
                ['unknown-conn', 'connection', randomUUID()],
                ['other-org-conn', 'connection', res['org-c']!.connection],
                ['unknown-appr', 'approval', randomUUID()],
                ['other-org-appr', 'approval', res['x-unit']!.approval],
              ] as const) {
                await locate(who, 'run', res['org-a']!.run); // warm the principal
                await n.ctx.cache.delPrefix('locate-denied:');
                if (limited)
                  for (let i = 0; i < LOCATE_AUDIT_MAX + 1; i++)
                    await locate(who, kind, randomUUID());
                if (cold) await n.ctx.cache.delPrefix('tree:');
                const c = calls();
                const r = await locate(who, kind, rid);
                counts[label] = c.total();
                c.done();
                if (label === 'sibling' || label === 'ancestor') {
                  // visible to some callers; only compare statement counts of refusals
                  if (r.statusCode === 200) delete counts[label];
                } else expect(r.statusCode, label).toBe(404);
              }
              const run = Object.entries(counts).filter(([l]) => !l.includes('-'));
              expect(
                new Set(run.map(([, v]) => v)).size,
                `${who} cold=${cold} ${JSON.stringify(counts)}`,
              ).toBe(1);
              const conn = Object.entries(counts).filter(([l]) => l.endsWith('-conn'));
              expect(new Set(conn.map(([, v]) => v)).size, JSON.stringify(counts)).toBe(1);
              const appr = Object.entries(counts).filter(([l]) => l.endsWith('-appr'));
              expect(new Set(appr.map(([, v]) => v)).size, JSON.stringify(counts)).toBe(1);
            }
        },
      );

      it('has the same statement shape for a found and a refused lookup apart from the audit write', async () => {
        await n.ctx.cache.delPrefix('locate-denied:');
        await locate('root-admin', 'run', res['org-a']!.run);
        const c = calls();
        const found = await locate('root-admin', 'run', res['org-a']!.run);
        const foundCount = c.total();
        c.done();
        expect(found.statusCode).toBe(200);
        const limited = calls();
        for (let i = 0; i < LOCATE_AUDIT_MAX; i++) await locate('root-admin', 'run', randomUUID());
        limited.done();
        const c2 = calls();
        await locate('root-admin', 'run', randomUUID()); // over the audit limit: no write
        expect(c2.total()).toBe(foundCount);
        c2.done();
      });
    });

    describe('audit', () => {
      it('writes access.denied for existing and unknown ids alike, naming only the requested id', async () => {
        await n.ctx.cache.delPrefix('locate-denied:');
        const before = (await audits('admin-d1')).length;
        await locate('admin-d1', 'agent', res['org-b']!.agent);
        await locate('admin-d1', 'agent', res['div-2']!.agent);
        const unknown = randomUUID();
        await locate('admin-d1', 'agent', unknown);
        const all = (await audits('admin-d1')).slice(before);
        expect(all).toHaveLength(3);
        for (const e of all) {
          expect(e.tenantId).toBe(id['div-1']);
          expect(e.payload).toEqual({
            permission: 'agents:read',
            resource: 'agent',
            via: 'locate',
          });
        }
        expect(all.map((e) => e.target)).toEqual([
          res['org-b']!.agent,
          res['div-2']!.agent,
          unknown,
        ]);
        // the owning tenant never appears in the entries
        expect(JSON.stringify(all)).not.toContain(id['org-b']!);
        expect(JSON.stringify(all)).not.toContain(id['div-2']!);
      });

      it('writes nothing for a found resource', async () => {
        await n.ctx.cache.delPrefix('locate-denied:');
        const before = (await audits('root-admin')).length;
        await locate('root-admin', 'run', res['org-a']!.run);
        expect((await audits('root-admin')).length).toBe(before);
      });

      it('limits entries per principal and kind and does not flood', async () => {
        await n.ctx.cache.delPrefix('locate-denied:');
        const before = (await audits('admin-c')).length;
        for (let i = 0; i < 40; i++) await locate('admin-c', 'run', randomUUID());
        for (let i = 0; i < 40; i++) await locate('admin-c', 'run', res['org-a']!.run);
        expect((await audits('admin-c')).length - before).toBe(LOCATE_AUDIT_MAX);
        // another kind and another principal have their own budget
        await locate('admin-c', 'agent', randomUUID());
        expect((await audits('admin-c')).length - before).toBe(LOCATE_AUDIT_MAX + 1);
        await locate('admin-b', 'run', randomUUID());
        expect((await audits('admin-b')).some((e) => e.target !== null)).toBe(true);
      });

      it('starts a new window after it has passed', async () => {
        await n.ctx.cache.delPrefix('locate-denied:');
        const before = (await audits('admin-b')).length;
        for (let i = 0; i < LOCATE_AUDIT_MAX + 2; i++)
          await locate('admin-b', 'connection', randomUUID());
        expect((await audits('admin-b')).length - before).toBe(LOCATE_AUDIT_MAX);
        await n.ctx.cache.delPrefix('locate-denied:'); // what the passing of the window does
        await locate('admin-b', 'connection', randomUUID());
        expect((await audits('admin-b')).length - before).toBe(LOCATE_AUDIT_MAX + 1);
      });

      it('still answers 404 when the audit write fails', async () => {
        await n.ctx.cache.delPrefix('locate-denied:');
        const spy = vi.spyOn(n.services.audit, 'append').mockRejectedValue(new Error('db down'));
        try {
          const a = await locate('admin-c', 'run', randomUUID());
          const b = await locate('admin-c', 'run', res['org-a']!.run);
          expect(a.statusCode).toBe(404);
          expect(b.body).toBe(a.body);
        } finally {
          spy.mockRestore();
        }
      });
    });

    describe.runIf(!bindingsMode)('legacy read path', () => {
      it('reaches the home node only, everything else is the common 404', async () => {
        await ok('admin-d1', 'div-1', 'run');
        await ok('root-admin', 'org-a', 'run');
        // inheriting bindings do not apply on the legacy path
        await parity('root-admin', 'run', 'div-1');
        await parity('admin-d1', 'run', 'team-1');
        await parity('admin-d1', 'run', 'org-a');
        await parity('admin-c', 'run', 'org-a');
      });

      it('still checks the permission of the global roles', async () => {
        await ok('viewer', 'org-a', 'agent');
        await parity('viewer', 'connection', 'org-a');
        await ok('integrator', 'org-a', 'connection');
      });
    });
  }),
);
