import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, tenantRoleBindings, tenants } from '../src/db/schema.js';
import { sqlTargets } from './db-targets.js';
import { buildWorld, type World } from './use-case-world.js';

/**
 * ADR 0014 slice S8 (#193): attaching a node to a use case and the use-case-scoped bindings of the
 * role-binding API. Who may attach, who may grant what for which use case, the 404 parity of
 * bindings outside a use-case administrator's use case, and the acting-node effect of an
 * attachment (only inheriting use-case bindings reach an attached node, immediately).
 */
describe.each(sqlTargets)('use-case bindings and attachment (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let w: World;
  const rb = (t: string) => `/v1/tenants/${w.id[t] ?? t}/role-bindings`;
  const attach = (who: string | null, tenant: string, useCase: string | null, acting?: string) =>
    w.req(who, 'PATCH', `/v1/tenants/${w.id[tenant]}`, { useCase }, acting);
  const grant = (
    who: string | null,
    tenant: string,
    user: string,
    body: Record<string, unknown>,
    acting?: string,
  ) =>
    w.req(
      who,
      'POST',
      rb(tenant),
      { userId: w.uid[user] ?? user, role: 'viewer', inherit: false, ...body },
      acting,
    );
  const rows = async (user: string) =>
    w.n.ctx.db.select().from(tenantRoleBindings).where(eq(tenantRoleBindings.userId, w.uid[user]!));
  const audits = async (action: string, tenant: string) =>
    (
      await w.n.ctx.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, action), eq(auditLog.tenantId, w.id[tenant]!)))
        .orderBy(auditLog.seq)
    ).map((e) => e.payload as Record<string, unknown>);
  const useCaseOf = async (tenant: string) =>
    (await w.n.ctx.db.select().from(tenants).where(eq(tenants.id, w.id[tenant]!)))[0]!.useCase;

  beforeAll(async () => {
    w = await buildWorld(await open());
  }, 240_000);
  afterAll(async () => w?.close());

  describe('grants of use-case bindings', () => {
    it('lets a tenant admin bind a role limited to a use case', async () => {
      const r = await grant('root-admin', 'org-a', 'uc-sec', {
        role: 'admin',
        inherit: true,
        useCase: 'sec',
      });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ role: 'admin', useCase: 'sec', inherit: true });
      expect((await audits('tenant.role_bound', 'org-a')).some((p) => p.useCase === 'sec')).toBe(
        true,
      );
      expect(
        (
          await grant('root-admin', 'org-a', 'uc-ops', {
            role: 'admin',
            inherit: false,
            useCase: 'ops',
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await grant('root-admin', 'org-a', 'uc-appsec', {
            role: 'viewer',
            inherit: false,
            useCase: 'sec/appsec',
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (await grant('root-admin', 'org-a', 'uc-eng', { role: 'agent-maintainer', useCase: 'sec' }))
          .statusCode,
      ).toBe(201);
      expect(
        (await grant('root-admin', 'org-a', 'uc-oper', { role: 'operator', useCase: 'sec' }))
          .statusCode,
      ).toBe(201);
    });

    it('refuses a duplicate, a malformed use case and pentest for a use case', async () => {
      expect(
        (
          await grant('root-admin', 'org-a', 'uc-sec', {
            role: 'admin',
            inherit: true,
            useCase: 'sec',
          })
        ).statusCode,
      ).toBe(409);
      for (const bad of ['a b', 'x/', '/x', 'a//b', 'sec%', 'sec*', '..', 'ö'])
        expect(
          (await grant('root-admin', 'org-a', 'grantee', { useCase: bad })).statusCode,
          bad,
        ).toBe(422);
      const pentest = await grant('root-admin', 'org-a', 'grantee', {
        role: 'pentest',
        useCase: 'sec',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      expect(pentest.statusCode).toBe(422);
      expect((await rows('grantee')).filter((b) => b.useCase !== null)).toHaveLength(0);
    });

    it('keeps the node-level rules for a tenant admin (no role above its own, self grant)', async () => {
      const self = await grant('root-admin', 'org-a', 'root-admin', { useCase: 'sec' });
      expect(self.statusCode).toBe(403);
      expect(self.json().error).toBe('self_grant');
    });

    describe('a use-case administrator (rule 3)', () => {
      it('grants for the own use case and its sub-use cases, on its own node', async () => {
        const sub = await grant('uc-sec', 'org-a', 'grantee', {
          role: 'viewer',
          useCase: 'sec/appsec',
        });
        expect(sub.statusCode, sub.body).toBe(201);
        const same = await grant('uc-sec', 'org-a', 'grantee', {
          role: 'operator',
          useCase: 'sec',
        });
        expect(same.statusCode).toBe(201);
        // an inheriting grant needs an inheriting binding of its own: uc-sec has one
        const inh = await grant('uc-sec', 'org-a', 'grantee', {
          role: 'agent-maintainer',
          useCase: 'sec',
          inherit: true,
        });
        expect(inh.statusCode, inh.body).toBe(201);
      });

      it('never grants for another use case, for the whole node, or pentest', async () => {
        for (const useCase of ['ops', 'secure', 'sec2', 'se', 'sec-x', 'other/sec'])
          expect((await grant('uc-sec', 'org-a', 'uc-none', { useCase })).statusCode, useCase).toBe(
            403,
          );
        const wide = await grant('uc-sec', 'org-a', 'uc-none', { role: 'viewer' });
        expect(wide.statusCode).toBe(403);
        expect(wide.json().error).toBe('grant_exceeds_own');
        const wideInherit = await grant('uc-sec', 'org-a', 'uc-none', {
          role: 'viewer',
          inherit: true,
        });
        expect(wideInherit.statusCode).toBe(403);
        const pt = await grant('uc-sec', 'org-a', 'uc-none', {
          role: 'pentest',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        expect(pt.statusCode).toBe(403);
        const ptUc = await grant('uc-sec', 'org-a', 'uc-none', {
          role: 'pentest',
          useCase: 'sec',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        expect(ptUc.statusCode).toBe(422);
        expect(await rows('uc-none')).toHaveLength(0);
      });

      it('does not inherit through an own binding that does not inherit', async () => {
        const nonInh = await grant('uc-ops', 'org-a', 'uc-none', {
          useCase: 'ops',
          inherit: false,
        });
        expect(nonInh.statusCode, nonInh.body).toBe(201);
        const inh = await grant('uc-ops', 'org-a', 'uc-none', {
          useCase: 'ops',
          role: 'operator',
          inherit: true,
        });
        expect(inh.statusCode).toBe(403);
        expect(inh.json().error).toBe('inheritance_required');
      });

      it('cannot grant to itself, to a stranger, or from a role without users:write', async () => {
        const self = await grant('uc-sec', 'org-a', 'uc-sec', { useCase: 'sec' });
        expect(self.json().error).toBe('self_grant');
        // a user of another organisation, and an unknown id: the same 404
        const foreign = await grant('uc-sec', 'org-a', 'b-admin', { useCase: 'sec' });
        const unknown = await grant('uc-sec', 'org-a', '00000000-0000-4000-8000-0000000000aa', {
          useCase: 'sec',
        });
        expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
        expect(foreign.json()).toEqual(unknown.json());
        // an engineer or operator of the use case holds no users:write
        for (const who of ['uc-eng', 'uc-oper', 'uc-appsec'])
          expect((await grant(who, 'org-a', 'uc-none', { useCase: 'sec' })).statusCode, who).toBe(
            403,
          );
      });

      it('cannot grant on a node where it holds no use-case binding of its own', async () => {
        for (const t of ['unit-1', 'unit-2', 'org-b'])
          expect(
            (await grant('uc-sec', t, 'uc-none', { useCase: 'sec' })).statusCode,
            t,
          ).toBeGreaterThanOrEqual(403);
      });

      it('lists, changes and revokes only the bindings of its own use cases', async () => {
        const list = await w.req('uc-sec', 'GET', rb('org-a'));
        expect(list.statusCode, list.body).toBe(200);
        const items = list.json().items as { useCase: string | null; user: { id: string } }[];
        expect(items.length).toBeGreaterThan(0);
        for (const b of items)
          expect(['sec', 'sec/appsec'], JSON.stringify(b)).toContain(b.useCase);
        // the other use case, the node-wide mirror rows and the tenant admin stay out of sight
        expect(items.some((b) => b.user.id === w.uid['uc-ops'])).toBe(false);
        expect(items.some((b) => b.user.id === w.uid['root-admin'])).toBe(false);
        const opsList = (await w.req('uc-ops', 'GET', rb('org-a'))).json().items as {
          useCase: string;
        }[];
        for (const b of opsList) expect(b.useCase).toBe('ops');
        // a role that gives no users:read
        expect((await w.req('uc-eng', 'GET', rb('org-a'))).statusCode).toBe(403);

        const ops = (await rows('uc-ops')).find((b) => b.useCase === 'ops')!;
        const rootRow = (await rows('root-admin'))[0]!;
        const unknown = '00000000-0000-4000-8000-0000000000bb';
        const probe = async (method: 'PATCH' | 'DELETE', bindingId: string) =>
          w.req(
            'uc-sec',
            method,
            `${rb('org-a')}/${bindingId}`,
            method === 'PATCH' ? { inherit: true } : undefined,
          );
        const outcomes = [];
        for (const id of [ops.id, rootRow.id, unknown])
          for (const m of ['PATCH', 'DELETE'] as const) {
            const r = await probe(m, id);
            outcomes.push([m, r.statusCode, r.json().error]);
          }
        // outside its use cases every binding answers like one that does not exist
        expect(new Set(outcomes.map((o) => `${o[1]}|${o[2]}`))).toEqual(new Set(['404|not_found']));
        expect((await rows('uc-ops')).some((b) => b.id === ops.id)).toBe(true);
        expect((await rows('root-admin')).some((b) => b.id === rootRow.id)).toBe(true);

        // inside its use case it may change and revoke
        const mine = (await rows('grantee')).find((b) => b.useCase === 'sec/appsec')!;
        const patched = await w.req('uc-sec', 'PATCH', `${rb('org-a')}/${mine.id}`, {
          role: 'operator',
        });
        expect(patched.statusCode, patched.body).toBe(200);
        // not above its own role, and a role change must stay within the use case
        const over = await w.req('uc-sec', 'PATCH', `${rb('org-a')}/${mine.id}`, {
          role: 'pentest',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        expect(over.statusCode).toBeGreaterThanOrEqual(400);
        const del = await w.req('uc-sec', 'DELETE', `${rb('org-a')}/${mine.id}`);
        expect(del.statusCode, del.body).toBe(204);
        expect(
          (await audits('tenant.role_unbound', 'org-a')).some((p) => p.useCase === 'sec/appsec'),
        ).toBe(true);
      });

      it('may leave a use case, and its own binding cannot be widened by itself', async () => {
        const own = (await rows('uc-sec')).find((b) => b.useCase === 'sec')!;
        const widen = await w.req('uc-sec', 'PATCH', `${rb('org-a')}/${own.id}`, {
          inherit: false,
        });
        expect(widen.statusCode).toBe(403);
        expect(widen.json().error).toBe('self_grant');
      });
    });

    it('does not touch the last-admin rule: use-case admins neither count nor block', async () => {
      // root-admin is the only inheriting tenant admin of org-a: leaving is refused, use-case
      // administrators do not count as co-admins
      const own = (await rows('root-admin'))[0]!;
      const leave = await w.req('root-admin', 'DELETE', `${rb('org-a')}/${own.id}`);
      expect(leave.statusCode).toBe(409);
      expect(leave.json().error).toBe('last_admin');
      // revoking a use-case admin is not a last-admin matter at all
      const ucRow = (await rows('uc-ops')).find((b) => b.useCase === 'ops')!;
      const revoke = await w.req('root-admin', 'DELETE', `${rb('org-a')}/${ucRow.id}`);
      expect(revoke.statusCode, revoke.body).toBe(204);
      expect(
        (
          await grant('root-admin', 'org-a', 'uc-ops', {
            role: 'admin',
            inherit: false,
            useCase: 'ops',
          })
        ).statusCode,
      ).toBe(201);
    });

    it('respects the token scopes of a use-case administrator', async () => {
      const p = await w.n.services.identity.authenticate(w.tok['uc-sec']!);
      const limited = await w.n.services.identity.createApiToken(p, 'limited', ['runs:read'], 30);
      const r = await w.n.req({
        method: 'POST',
        url: rb('org-a'),
        token: limited.token,
        payload: { userId: w.uid['uc-none'], role: 'viewer', inherit: false, useCase: 'sec' },
      });
      expect(r.statusCode).toBe(403);
      const list = await w.n.req({ method: 'GET', url: rb('org-a'), token: limited.token });
      expect(list.statusCode).toBe(403);
    });

    it('bypasses nothing through the mirror: global roles stay node-wide', async () => {
      // a use-case binding is not a global role; granting one never writes users.global_roles
      const u = await w.n.services.identity.getUser(w.uid['uc-sec']!);
      expect(u.globalRoles).toEqual([]);
    });
  });

  describe('attaching a node to a use case (PATCH /v1/tenants/{id} { useCase })', () => {
    it('is done by an inheriting tenant admin of the parent and audited at both ends', async () => {
      const r = await attach('root-admin', 'unit-1', 'sec');
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().useCase).toBe('sec');
      expect(await useCaseOf('unit-1')).toBe('sec');
      for (const t of ['unit-1', 'org-a']) {
        const a = await audits('tenant.attached', t);
        expect(a.at(-1), t).toMatchObject({
          nodeId: w.id['unit-1'],
          parentId: w.id['org-a'],
          useCase: 'sec',
          authority: 'inheriting_admin',
        });
      }
      // the same value again changes nothing and writes nothing
      const before = (await audits('tenant.attached', 'unit-1')).length;
      expect((await attach('root-admin', 'unit-1', 'sec')).statusCode).toBe(200);
      expect((await audits('tenant.attached', 'unit-1')).length).toBe(before);
    });

    it('re-attaching is a detach and an attach, detaching clears it', async () => {
      const detachedBefore = (await audits('tenant.detached', 'org-a')).length;
      expect((await attach(null, 'unit-1', 'ops')).statusCode).toBe(200);
      expect(await useCaseOf('unit-1')).toBe('ops');
      expect((await audits('tenant.detached', 'org-a')).length).toBe(detachedBefore + 1);
      expect((await audits('tenant.detached', 'unit-1')).at(-1)).toMatchObject({ useCase: 'sec' });
      expect((await audits('tenant.attached', 'unit-1')).at(-1)).toMatchObject({
        useCase: 'ops',
        authority: 'platform',
      });
      expect((await attach('root-admin', 'unit-1', null)).statusCode).toBe(200);
      expect(await useCaseOf('unit-1')).toBeNull();
      expect((await audits('tenant.detached', 'unit-1')).at(-1)).toMatchObject({ useCase: 'ops' });
    });

    it('is never done by a use-case admin, a viewer or an admin bound on the node alone', async () => {
      for (const who of ['uc-sec', 'uc-ops', 'uc-eng'])
        expect((await attach(who, 'unit-1', 'sec')).statusCode, who).toBe(403);
      // a node-wide viewer of the organisation cannot even see the child
      expect((await attach('viewer', 'unit-1', 'sec')).statusCode).toBe(404);
      // admin-u1 is an inheriting admin of unit-1 only: not of its parent
      const own = await attach('admin-u1', 'unit-1', 'sec');
      expect(own.statusCode).toBe(403);
      expect(await useCaseOf('unit-1')).toBeNull();
      // ... but of unit-1-sub, whose parent is unit-1
      const sub = await attach('admin-u1', 'unit-1-sub', 'sec');
      expect(sub.statusCode, sub.body).toBe(200);
      expect((await attach('admin-u1', 'unit-1-sub', null)).statusCode).toBe(200);
      // a node of another organisation or one the caller cannot see: the usual 404
      expect((await attach('b-admin', 'unit-1', 'sec')).statusCode).toBe(404);
      expect((await attach('admin-u1', 'unit-2', 'sec')).statusCode).toBe(404);
    });

    it('refuses a use-case admin even from inside an attached node', async () => {
      expect((await attach('root-admin', 'unit-1', 'sec')).statusCode).toBe(200);
      // uc-sec is now an unrestricted admin in unit-1 (inheriting binding): it still cannot attach
      // unit-1-sub, nor change the tree, nor grant there
      const sub = await attach('uc-sec', 'unit-1-sub', 'sec', 'unit-1');
      expect(sub.statusCode).toBe(403);
      const detach = await attach('uc-sec', 'unit-1', null, 'unit-1');
      expect(detach.statusCode).toBe(403);
      const create = await w.req(
        'uc-sec',
        'POST',
        '/v1/tenants',
        { parentId: w.id['unit-1'], slug: 'sneaky', name: 'Sneaky' },
        'unit-1',
      );
      expect(create.statusCode).toBe(403);
      const grantThere = await grant('uc-sec', 'unit-1', 'uc-none', { useCase: 'sec' }, 'unit-1');
      expect(grantThere.statusCode).toBeGreaterThanOrEqual(403);
      expect(await useCaseOf('unit-1')).toBe('sec');
      expect((await attach('root-admin', 'unit-1', null)).statusCode).toBe(200);
    });

    it('validates the value and refuses an organisation', async () => {
      for (const bad of ['a b', 'x/', '/x', 'a//b', 'sec%', 'sec_%', 'ö'])
        expect((await attach('root-admin', 'unit-1', bad)).statusCode, bad).toBe(422);
      expect((await attach('root-admin', 'unit-1', 'x'.repeat(201))).statusCode).toBe(400);
      expect((await attach('root-admin', 'unit-1', '')).statusCode).toBe(400);
      const root = await attach(null, 'org-a', 'sec');
      expect(root.statusCode).toBe(422);
      expect(root.json().error).toBe('use_case_on_root');
      expect(await useCaseOf('org-a')).toBeNull();
      expect(await useCaseOf('unit-1')).toBeNull();
    });

    it('needs the settings:write scope of a token and the bindings read path', async () => {
      const p = await w.n.services.identity.authenticate(w.tok['root-admin']!);
      const narrow = await w.n.services.identity.createApiToken(p, 'narrow', ['users:write'], 30);
      const r = await w.n.req({
        method: 'PATCH',
        url: `/v1/tenants/${w.id['unit-1']}`,
        token: narrow.token,
        payload: { useCase: 'sec' },
      });
      expect(r.statusCode).toBe(403);
      expect(await useCaseOf('unit-1')).toBeNull();
      const wide = await w.n.services.identity.createApiToken(p, 'wide', ['settings:write'], 30);
      const ok = await w.n.req({
        method: 'PATCH',
        url: `/v1/tenants/${w.id['unit-1']}`,
        token: wide.token,
        payload: { useCase: 'sec' },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await attach('root-admin', 'unit-1', null)).statusCode).toBe(200);
    });
  });

  describe('what an attachment changes at the acting node', () => {
    const acting = (who: string, tenant: string, url = '/v1/me') =>
      w.req(who, 'GET', url, undefined, tenant);
    const agentsIn = async (who: string, tenant: string): Promise<string[]> => {
      const r = await acting(who, tenant, '/v1/agents');
      if (r.statusCode !== 200) return [`status ${r.statusCode}`];
      return (r.json().items as { name: string }[]).map((a) => a.name).sort();
    };

    it('gives an inheriting use-case admin the whole attached node and its subtree, nothing else', async () => {
      expect(await agentsIn('uc-sec', 'unit-1')).toEqual(['status 404']);
      expect((await attach('root-admin', 'unit-1', 'sec')).statusCode).toBe(200);
      // the very next request: the epoch moved, no stale principal
      expect(await agentsIn('uc-sec', 'unit-1')).toEqual(['a-u1']);
      expect(await agentsIn('uc-sec', 'unit-1-sub')).toEqual(['a-u1sub']);
      const me = (await acting('uc-sec', 'unit-1')).json();
      expect(me.bindings).toEqual([
        expect.objectContaining({ role: 'admin', source: 'attached', useCase: null }),
      ]);
      // siblings, the other organisation and the parent stay what they were
      expect(await agentsIn('uc-sec', 'unit-2')).toEqual(['status 404']);
      expect(await agentsIn('uc-sec', 'b-unit')).toEqual(['status 404']);
      expect(await agentsIn('uc-sec', 'org-a')).toEqual(['a-appsec', 'a-sec']);
    });

    it('does not reach the attached node with a binding that does not inherit (owner decision 6)', async () => {
      for (const who of ['uc-ops', 'uc-appsec', 'uc-eng', 'uc-oper'])
        expect(await agentsIn(who, 'unit-1'), who).toEqual(['status 404']);
      expect((await attach('root-admin', 'unit-1', 'sec/appsec')).statusCode).toBe(200);
      // a sub-use case of the attached one: the parent use case still covers it
      expect(await agentsIn('uc-sec', 'unit-1')).toEqual(['a-u1']);
      expect(await agentsIn('uc-appsec', 'unit-1')).toEqual(['status 404']);
    });

    it('follows a re-attachment and a detachment at once', async () => {
      expect((await attach('root-admin', 'unit-1', 'ops')).statusCode).toBe(200);
      expect(await agentsIn('uc-sec', 'unit-1')).toEqual(['status 404']);
      expect((await attach('root-admin', 'unit-1', 'sec')).statusCode).toBe(200);
      expect(await agentsIn('uc-sec', 'unit-1')).toEqual(['a-u1']);
      expect((await attach('root-admin', 'unit-1', null)).statusCode).toBe(200);
      expect(await agentsIn('uc-sec', 'unit-1')).toEqual(['status 404']);
    });

    it('applies the sub-use-case rule per segment', async () => {
      expect((await attach('root-admin', 'unit-1', 'secure')).statusCode).toBe(200);
      expect(await agentsIn('uc-sec', 'unit-1')).toEqual(['status 404']);
      expect((await attach('root-admin', 'unit-1', 'sec-x')).statusCode).toBe(200);
      expect(await agentsIn('uc-sec', 'unit-1')).toEqual(['status 404']);
      expect((await attach('root-admin', 'unit-1', null)).statusCode).toBe(200);
    });

    it('lets the tenant tree show use-case people no node-wide role', async () => {
      const tree = await w.req('uc-sec', 'GET', '/v1/tenants/tree?include=counts');
      expect(tree.statusCode, tree.body).toBe(200);
      const org = (
        tree.json().items as { slug: string; myRoles: string[]; counts: unknown }[]
      ).find((e) => e.slug === 'org-a')!;
      expect(org.myRoles).toEqual([]);
      expect(
        org.counts === null || Object.values(org.counts as object).every((v) => v === null),
      ).toBe(true);
    });
  });
});
