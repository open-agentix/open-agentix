import { randomUUID } from 'node:crypto';
import { type Principal, type Role } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT_ID,
  auditLog,
  tenantRoleBindings,
  tenants as tenantsTable,
} from '../src/db/schema.js';
import { currentAuthzEpoch } from '../src/services/role-bindings.js';
import { sqlTargets } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0014 slice S5 (#190): sub-tenant creation and rename by tenant admins, the access explanation,
 * and the confused-deputy rule (an operation naming another node is decided on that node, never on
 * the acting node). One refusal test per rule. Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a
 * real PostgreSQL.
 *
 *   org-a ─┬─ div-1 ─── team-1        org-b ─── x-unit
 *          └─ div-2
 */
const PW = 'long-password-123';
type Mode = 'legacy' | 'bindings';

describe.each(sqlTargets)('write inheritance and tenant creation (%s)', (_kind, enabled, open) => {
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
  const setTenancy = (over: Partial<{ maxDepth: number; maxNodesPerRoot: number }>) => {
    Object.assign(n.ctx.config.tenancy, over);
  };
  const bind = (user: string, tenant: string, role: Role, inherit: boolean) =>
    n.ctx.db.insert(tenantRoleBindings).values({
      id: randomUUID(),
      userId: uid[user]!,
      tenantId: id[tenant]!,
      role,
      inherit,
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
  const create = (who: string | null, body: Record<string, unknown>, acting?: string) =>
    n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: body,
      ...(who === null ? {} : { token: tok[who]! }),
      ...(acting ? { headers: { 'x-oax-tenant': acting } } : {}),
    });
  const child = (parent: string, slug: string, extra: Record<string, unknown> = {}) => ({
    parentId: id[parent] ?? parent,
    slug,
    name: `Name ${slug}`,
    ...extra,
  });
  const patch = (
    who: string | null,
    tenant: string,
    body: Record<string, unknown>,
    acting?: string,
  ) =>
    n.req({
      method: 'PATCH',
      url: `/v1/tenants/${id[tenant] ?? tenant}`,
      payload: body,
      ...(who === null ? {} : { token: tok[who]! }),
      ...(acting ? { headers: { 'x-oax-tenant': acting } } : {}),
    });
  const get = (who: string, url: string, acting?: string) =>
    n.req({
      method: 'GET',
      url,
      token: tok[who]!,
      ...(acting ? { headers: { 'x-oax-tenant': acting } } : {}),
    });
  const count = async () => (await n.ctx.db.select().from(tenantsTable)).length;
  const audit = async (action: string) =>
    await n.ctx.db.select().from(auditLog).where(eq(auditLog.action, action));
  const epoch = (slug: string) => currentAuthzEpoch(n.ctx.db, id[slug]!);
  const scopedToken = async (user: string, scopes: string[]) => {
    const principal = await n.services.identity.principalForUser(uid[user]!);
    return (await n.services.identity.createApiToken(principal, `s-${user}`, scopes as never, 30))
      .token;
  };

  beforeAll(async () => {
    target = await open();
    n = await testNode({
      OAX_DATABASE_URL: target.url,
      OAX_ROLE_BINDINGS_READ: 'bindings',
      OAX_RATE_LIMIT_LOGIN_MAX: '10000',
    });
    id.default = DEFAULT_TENANT_ID;
    for (const slug of ['org-a', 'org-b'])
      id[slug] = (await n.services.tenants.create(op(), { slug, name: `Org ${slug}` })).id;
    const mk = async (parent: string, slug: string) => {
      id[slug] = (await n.services.tenants.createChild(op(), id[parent]!, { slug, name: slug })).id;
    };
    await mk('org-a', 'div-1');
    await mk('div-1', 'team-1');
    await mk('org-a', 'div-2');
    await mk('org-b', 'x-unit');
    await mkUser('inh-root', 'org-a'); // inheriting admin of org-a
    await bind('inh-root', 'org-a', 'admin', true);
    await mkUser('inh-div1', 'team-1'); // inheriting admin of div-1, lives in team-1
    await bind('inh-div1', 'div-1', 'admin', true);
    await mkUser('direct-a', 'org-a', ['admin']); // admin of org-a without inheritance
    await mkUser('direct-div1', 'div-1', ['admin']); // admin of div-1 without inheritance
    await mkUser('mixed', 'div-1'); // direct admin of org-a, inheriting admin of div-1
    await bind('mixed', 'org-a', 'admin', false);
    await bind('mixed', 'div-1', 'admin', true);
    await mkUser('viewer-inh', 'div-2'); // inheriting viewer of org-a
    await bind('viewer-inh', 'org-a', 'viewer', true);
    await mkUser('nobody', 'org-a'); // no role at all
    await mkUser('admin-b', 'org-b', ['admin']);
    // a tenant of another organisation whose slug overlaps in secret names
    await n.services.tenants.createChild(op(), id['org-b']!, { slug: 'sec.ops', name: 'Sec ops' });
  }, 180_000);
  afterAll(async () => {
    await n.close();
    await target.close();
  });

  describe('POST /v1/tenants { parentId }', () => {
    it('lets an inheriting admin create below a node it administers, audited in the new partition', async () => {
      const before = await epoch('org-a');
      const r = await create('inh-root', child('div-1', 'made-1'));
      expect(r.statusCode).toBe(201);
      const body = r.json();
      expect(body).toMatchObject({
        slug: 'made-1',
        parentId: id['div-1'],
        depth: 2,
        slugPath: 'org-a/div-1/made-1',
      });
      id['made-1'] = body.id;
      const created = (await audit('tenant.created')).find((e) => e.tenantId === body.id);
      expect(created).toBeDefined();
      expect(created!.actor).toBe(uid['inh-root']);
      expect(created!.payload).toMatchObject({
        authority: 'inheriting_admin',
        parentId: id['div-1'],
      });
      // epoch bump: the creator, with a cached principal, acts in the new node at once
      expect(await epoch('org-a')).toBeGreaterThan(before!);
      const team = await n.req({
        method: 'POST',
        url: '/v1/teams',
        token: tok['inh-root']!,
        headers: { 'x-oax-tenant': 'org-a/div-1/made-1' },
        payload: { slug: 'first', name: 'First' },
      });
      expect(team.statusCode).toBe(201);
    });

    it('lets an inheriting admin create directly below the node its binding sits on', async () => {
      const r = await create('inh-div1', child('div-1', 'made-2'));
      expect(r.statusCode).toBe(201);
      id['made-2'] = r.json().id;
    });

    it('refuses a direct admin that does not inherit (inheritance_required) and creates nothing', async () => {
      const total = await count();
      const r = await create('direct-a', child('org-a', 'nope-direct'));
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('inheritance_required');
      expect(await count()).toBe(total);
    });

    it('refuses a role that is not an administrator, even when it inherits', async () => {
      const total = await count();
      const r = await create('viewer-inh', child('div-2', 'nope-viewer'));
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('forbidden');
      expect(await count()).toBe(total);
    });

    it('refuses a user without any role on the parent', async () => {
      const r = await create('nobody', child('org-a', 'nope-nobody'));
      expect(r.statusCode).toBe(403);
    });

    it('refuses an organisation (no parentId), and the operator-only fields', async () => {
      const total = await count();
      expect((await create('inh-root', { slug: 'nope-org', name: 'Org' })).statusCode).toBe(403);
      for (const extra of [
        { monthlyBudgetUsd: 5 },
        { admin: { email: 'a@example.org', displayName: 'A', password: PW } },
      ])
        expect((await create('inh-root', child('div-1', 'nope-field', extra))).statusCode).toBe(
          403,
        );
      expect(await count()).toBe(total);
    });

    it('evaluates on the parent named in the body, never on the acting node (confused deputy)', async () => {
      const total = await count();
      // inh-div1 acts in div-1 (settings:write there) but names org-a, div-2, org-b: all invisible
      const probes = [id['org-a']!, id['div-2']!, id['org-b']!, id['x-unit']!, randomUUID()];
      const bodies = new Set<string>();
      for (const parentId of probes) {
        const r = await create('inh-div1', { parentId, slug: 'nope-cd', name: 'X' }, 'org-a/div-1');
        expect(r.statusCode, parentId).toBe(404);
        bodies.add(r.body);
      }
      expect(bodies.size).toBe(1);
      // mixed is only a direct admin of org-a: the inheriting admin binding on div-1 (the acting
      // node) does not lend its authority to a creation under org-a
      const lent = await create('mixed', child('org-a', 'nope-lent'), 'org-a/div-1');
      expect(lent.statusCode).toBe(403);
      expect(lent.json().error).toBe('inheritance_required');
      // and the other way round: acting at the parent, naming a child it does not cover
      const down = await create('mixed', child('div-1', 'made-3'), 'org-a');
      expect(down.statusCode).toBe(201);
      id['made-3'] = down.json().id;
      expect(await count()).toBe(total + 1);
    });

    it('answers a parent the caller cannot see like one that does not exist', async () => {
      const a = await create('direct-div1', child('div-2', 'nope-1')); // sibling
      const b = await create('direct-div1', child(randomUUID(), 'nope-2')); // unknown
      expect(a.statusCode).toBe(404);
      expect(a.body).toBe(b.body);
    });

    it('refuses a token without the settings:write scope', async () => {
      const weak = await scopedToken('inh-root', ['agents:read']);
      const r = await n.req({
        method: 'POST',
        url: '/v1/tenants',
        token: weak,
        payload: child('div-2', 'nope-scope'),
      });
      expect(r.statusCode).toBe(403);
      const strong = await scopedToken('inh-root', ['settings:write']);
      const ok = await n.req({
        method: 'POST',
        url: '/v1/tenants',
        token: strong,
        payload: child('div-2', 'made-scope'),
      });
      expect(ok.statusCode).toBe(201);
    });

    it('applies the depth limit to everybody', async () => {
      const total = await count();
      setTenancy({ maxDepth: 2 });
      try {
        const r = await create('inh-root', child('made-1', 'too-deep')); // depth 3
        expect(r.statusCode).toBe(422);
        expect(r.json().error).toBe('tenant_depth_exceeded');
      } finally {
        setTenancy({ maxDepth: 8 });
      }
      expect(await count()).toBe(total);
    });

    it('applies the node limit per organisation, also under concurrent requests', async () => {
      const orgNodes = (await n.ctx.db.select().from(tenantsTable)).filter(
        (t) => t.rootId === id['org-a'],
      ).length;
      setTenancy({ maxNodesPerRoot: orgNodes + 2 });
      try {
        const rs = await Promise.all(
          ['race-1', 'race-2', 'race-3', 'race-4', 'race-5'].map((slug) =>
            create('inh-root', child('div-2', slug)),
          ),
        );
        const codes = rs.map((r) => r.statusCode).sort();
        expect(codes).toEqual([201, 201, 422, 422, 422]);
        for (const r of rs.filter((x) => x.statusCode === 422))
          expect(r.json().error).toBe('tenant_node_limit_exceeded');
      } finally {
        setTenancy({ maxNodesPerRoot: 1000 });
      }
    });

    it('enforces the slug rules and does not name other tenants in a conflict', async () => {
      expect((await create('inh-root', child('div-2', 'Bad Slug'))).statusCode).toBe(400);
      const taken = await create('inh-root', child('div-2', 'x-unit')); // exists in org-b
      expect(taken.statusCode).toBe(409);
      const overlap = await create('inh-root', child('div-2', 'sec-ops')); // overlaps sec.ops
      expect(overlap.statusCode).toBe(409);
      expect(overlap.json().message).toBe(taken.json().message);
      expect(overlap.body).not.toContain('sec.ops');
      // an operator is told which slug clashes
      const op1 = await create(null, child('div-2', 'sec-ops'));
      expect(op1.statusCode).toBe(409);
      expect(op1.json().message).toContain('sec.ops');
    });

    it('stays operator-only with the legacy read path, as before', async () => {
      setMode('legacy');
      try {
        const total = await count();
        expect((await create('direct-a', child('org-a', 'legacy-1'))).statusCode).toBe(403);
        const r = await create('inh-root', child('org-a', 'legacy-2'));
        expect(r.statusCode).toBe(403);
        expect(r.json().error).toBe('forbidden');
        expect(await count()).toBe(total);
        // operators create organisations and sub-tenants over HTTP in both modes
        const org = await create(null, { slug: 'org-legacy', name: 'Legacy' });
        expect(org.statusCode).toBe(201);
        const sub = await create(null, child(org.json().id, 'sub-legacy'));
        expect(sub.statusCode).toBe(201);
      } finally {
        setMode('bindings');
      }
    });

    it('refuses the moment the inheriting binding is gone', async () => {
      await mkUser('short-lived', 'div-2');
      await bind('short-lived', 'org-a', 'admin', true);
      const first = await create('short-lived', child('div-2', 'sl-1'));
      expect(first.statusCode).toBe(201);
      await n.ctx.db
        .delete(tenantRoleBindings)
        .where(eq(tenantRoleBindings.userId, uid['short-lived']!));
      const total = await count();
      const second = await create('short-lived', child('div-2', 'sl-2'));
      expect(second.statusCode).toBe(403);
      expect(await count()).toBe(total);
    });

    it('lets the operator create sub-tenants over HTTP', async () => {
      const r = await create(null, child('org-b', 'op-made'));
      expect(r.statusCode).toBe(201);
      expect(
        (await audit('tenant.created')).find((e) => e.tenantId === r.json().id)!.payload,
      ).toMatchObject({
        authority: 'platform',
      });
    });
  });

  describe('PATCH /v1/tenants/{id}', () => {
    it('lets an inherited admin rename a descendant, audited in its partition', async () => {
      const r = await patch('inh-root', 'team-1', { name: 'Renamed team' });
      expect(r.statusCode).toBe(200);
      expect(r.json().name).toBe('Renamed team');
      const entry = (await audit('tenant.updated')).find((e) => e.tenantId === id['team-1']);
      expect(entry?.actor).toBe(uid['inh-root']);
    });

    it('lets an inheriting admin rename the node its binding sits on', async () => {
      expect((await patch('inh-div1', 'div-1', { name: 'Division one' })).statusCode).toBe(200);
    });

    it('refuses a direct admin that does not inherit, so nothing changes without inheritance', async () => {
      const r = await patch('direct-div1', 'div-1', { name: 'direct rename' });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('inheritance_required');
      const row = (
        await n.ctx.db.select().from(tenantsTable).where(eq(tenantsTable.id, id['div-1']!))
      )[0]!;
      expect(row.name).toBe('Division one');
    });

    it('refuses a node the caller cannot see like one that does not exist', async () => {
      const a = await patch('direct-div1', 'div-2', { name: 'x' });
      const b = await patch('direct-div1', randomUUID(), { name: 'x' });
      expect(a.statusCode).toBe(404);
      expect(a.body).toBe(b.body);
    });

    it('refuses roles without settings:write', async () => {
      expect((await patch('viewer-inh', 'div-1', { name: 'x' })).statusCode).toBe(403);
      expect((await patch('nobody', 'org-a', { name: 'x' })).statusCode).toBe(403);
    });

    it('keeps the budget and the secret references operator-only', async () => {
      for (const body of [
        { monthlyBudgetUsd: 10 },
        { secretRefs: ['*'] },
        { name: 'ok', secretRefs: [] },
      ]) {
        const r = await patch('inh-root', 'div-1', body);
        expect(r.statusCode, JSON.stringify(body)).toBe(403);
      }
      const row = (
        await n.ctx.db.select().from(tenantsTable).where(eq(tenantsTable.id, id['div-1']!))
      )[0]!;
      expect(row.monthlyBudgetMicros).toBeNull();
      expect(row.name).toBe('Division one');
      expect((await patch(null, 'div-1', { monthlyBudgetUsd: 10 })).statusCode).toBe(200);
      expect((await patch(null, 'div-1', { monthlyBudgetUsd: null })).statusCode).toBe(200);
    });

    it('evaluates on the node of the path, never on the acting node (confused deputy)', async () => {
      // inh-div1 acts in div-1, where it is admin, and names its ancestor, a sibling, another org
      const bodies = new Set<string>();
      for (const target of ['org-a', 'div-2', 'org-b', 'x-unit']) {
        const r = await patch('inh-div1', target, { name: 'hijacked' }, 'org-a/div-1');
        expect(r.statusCode, target).toBe(404);
        bodies.add(r.body);
      }
      expect(bodies.size).toBe(1);
      // mixed: direct admin of org-a, inheriting admin of div-1. Acting in div-1 does not lend its
      // inheriting binding to org-a; naming div-1 while acting in org-a works.
      const lent = await patch('mixed', 'org-a', { name: 'Org A' }, 'org-a/div-1');
      expect(lent.statusCode).toBe(403);
      expect(lent.json().error).toBe('inheritance_required');
      expect((await patch('mixed', 'div-1', { name: 'Division one' }, 'org-a')).statusCode).toBe(
        200,
      );
      const names = (await n.ctx.db.select().from(tenantsTable))
        .filter((t) => ['org-b', 'x-unit', 'div-2'].includes(t.slug))
        .map((t) => t.name);
      expect(names).not.toContain('hijacked');
    });

    it('stays operator-only with the legacy read path', async () => {
      setMode('legacy');
      try {
        expect((await patch('direct-a', 'org-a', { name: 'legacy' })).statusCode).toBe(403);
        expect((await patch('inh-root', 'div-1', { name: 'legacy' })).statusCode).toBe(403);
      } finally {
        setMode('bindings');
      }
    });

    it('refuses a token without the settings:write scope', async () => {
      const weak = await scopedToken('inh-root', ['agents:read']);
      const r = await n.req({
        method: 'PATCH',
        url: `/v1/tenants/${id['div-2']}`,
        token: weak,
        payload: { name: 'x' },
      });
      expect(r.statusCode).toBe(403);
    });
  });

  describe('access explanation', () => {
    const access = (who: string, tenant?: string, acting?: string) =>
      get(who, `/v1/me/access${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`, acting);

    it('explains inherited permissions with their source and the node they are bound on', async () => {
      const r = await access('inh-root', 'org-a/div-1');
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.tenant).toMatchObject({ slugPath: 'org-a/div-1' });
      expect(body.bindings).toEqual([
        expect.objectContaining({
          role: 'admin',
          source: 'inherited',
          inherit: true,
          tenantSlugPath: 'org-a',
          tenantId: id['org-a'],
        }),
      ]);
      const write = body.permissions.find(
        (p: { permission: string }) => p.permission === 'agents:write',
      );
      expect(write.sources).toEqual(['inherited']);
      const home = (await access('inh-root', 'org-a')).json();
      expect(home.bindings[0].source).toBe('direct');
    });

    it('agrees with GET /v1/me at every node the caller can act in', async () => {
      for (const who of ['inh-root', 'inh-div1', 'direct-div1', 'mixed', 'viewer-inh']) {
        const nodes = (await get(who, '/v1/tenants')).json().items as { slugPath: string }[];
        for (const t of nodes) {
          const me = (await get(who, '/v1/me', t.slugPath)).json();
          const acc = (await access(who, t.slugPath)).json();
          expect(
            acc.permissions.map((p: { permission: string }) => p.permission).sort(),
            `${who} ${t.slugPath}`,
          ).toEqual([...me.permissions].sort());
        }
      }
    });

    it('defaults to the acting node', async () => {
      const r = (await access('inh-root', undefined, 'org-a/div-2')).json();
      expect(r.tenant.slugPath).toBe('org-a/div-2');
    });

    it('answers invisible and unknown tenants alike', async () => {
      const bodies = new Set<string>();
      for (const ref of [
        'org-a',
        'org-a/div-2',
        'org-b',
        randomUUID(),
        'nope',
        'org-a/div-1/nope',
      ]) {
        const r = await access('inh-div1', ref);
        expect(r.statusCode, ref).toBe(404);
        bodies.add(r.body);
      }
      expect(bodies.size).toBe(1);
    });

    it('reports permissions removed by token scopes', async () => {
      const weak = await scopedToken('inh-root', ['agents:read']);
      const r = await n.req({ method: 'GET', url: '/v1/me/access?tenant=div-1', token: weak });
      const body = r.json();
      expect(body.limitedByToken).toBe(true);
      expect(body.permissions.map((p: { permission: string }) => p.permission)).toEqual([
        'agents:read',
      ]);
    });

    it('explains another user at the node in the path, for users:read there only', async () => {
      const url = (tenant: string, user: string) =>
        `/v1/tenants/${id[tenant]}/access?userId=${uid[user]}`;
      const r = await get('inh-root', url('div-1', 'viewer-inh'));
      expect(r.statusCode).toBe(200);
      expect(r.json().user).toMatchObject({ id: uid['viewer-inh'] });
      expect(r.json().bindings[0]).toMatchObject({ role: 'viewer', source: 'inherited' });
      expect(r.json().permissions.map((p: { permission: string }) => p.permission)).not.toContain(
        'agents:write',
      );
      // no users:read at that node
      expect((await get('viewer-inh', url('div-1', 'inh-root'))).statusCode).toBe(403);
      // invisible node, unknown user, user of another organisation: indistinguishable 404s
      const a = await get('direct-a', url('div-1', 'viewer-inh'));
      const b = await get(
        'direct-a',
        `/v1/tenants/${randomUUID()}/access?userId=${uid['viewer-inh']}`,
      );
      expect(a.statusCode).toBe(404);
      expect(a.body).toBe(b.body);
      const missing = await get(
        'inh-root',
        `/v1/tenants/${id['div-1']}/access?userId=${randomUUID()}`,
      );
      const foreign = await get('inh-root', url('div-1', 'admin-b'));
      expect(missing.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);
      // the acting node does not lend users:read to the node in the path
      const lent = await get('inh-div1', url('org-a', 'inh-root'), 'org-a/div-1');
      expect(lent.statusCode).toBe(404);
    });
  });
});
