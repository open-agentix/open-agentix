import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Principal } from '@openagentix/core';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costLedger, runs, tenants as tenantsTable } from '../src/db/schema.js';
import { monthOf } from '../src/services/runs.js';
import { agentSource } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * UX slices A2 and A3: acting tenant in /v1/me, X-OAX-Tenant for the visible subtree and
 * GET /v1/tenants/tree. Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 * The negative probes are the point: each one fails when the scoping of the reach is removed.
 */
const PW = 'long-password-123';
const PG_URL = process.env.OAX_TEST_DATABASE_URL;

interface Target {
  name: string;
  enabled: boolean;
  open: () => Promise<{ url: string; close: () => Promise<void> }>;
}

const targets: Target[] = [
  {
    name: 'PGlite',
    enabled: true,
    open: async () => ({ url: 'memory://', close: async () => undefined }),
  },
  {
    name: 'PostgreSQL',
    enabled: !!PG_URL,
    open: async () => {
      const name = `a3_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
      await admin.query(`create database ${name}`);
      const url = new URL(PG_URL!);
      url.pathname = `/${name}`;
      return {
        url: url.toString(),
        close: async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              await admin.query(`drop database ${name}`);
              break;
            } catch (e) {
              if ((e as { code?: string }).code !== '55006' || attempt >= 50) throw e;
              await new Promise((r) => setTimeout(r, 100));
            }
          }
          await admin.end();
        },
      };
    },
  },
];

interface Item {
  id: string;
  parentId: string | null;
  slug: string;
  slugPath: string;
  name: string;
  depth: number;
  hasChildren: boolean;
  visible: boolean;
  status: string;
  myRoles: string[];
  inheritedRoles: string[];
  counts: Record<string, number | string | null> | null;
}

describe.each(targets)('tenant tree API ($name)', (target) => {
  if (!target.enabled) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let db: Awaited<ReturnType<Target['open']>>;
  let n: TestNode;
  const id = {} as Record<string, string>;
  const tok = {} as Record<string, string>;
  const as = (token: string) => (opts: Parameters<TestNode['req']>[0]) => n.req({ ...opts, token });
  const op = (): Principal => ({
    kind: 'user',
    userId: randomUUID(),
    tenantId: id.default!,
    displayName: 'op',
    platformAdmin: true,
    bindings: [],
  });

  /** Agents, runs, one pending approval and ledger lines for one tenant (via the platform admin). */
  async function seed(
    slug: string,
    o: { agents: number; runs?: number; approvals?: number; costMicros?: number },
  ) {
    const H = { 'x-oax-tenant': id[slug]! };
    await n.req({
      method: 'POST',
      url: '/v1/teams',
      headers: H,
      payload: { slug: 'team-security', name: 'S' },
    });
    const agentIds: string[] = [];
    for (let i = 0; i < o.agents; i++) {
      const r = await n.req({
        method: 'POST',
        url: '/v1/agents',
        headers: H,
        payload: { source: agentSource(`${slug}-agent-${i}`) },
      });
      expect(r.statusCode).toBe(201);
      agentIds.push(r.json().id);
    }
    const runIds: string[] = [];
    if (o.runs) {
      const a = agentIds[0]!;
      expect(
        (await n.req({ method: 'POST', url: `/v1/agents/${a}/publish`, headers: H })).statusCode,
      ).toBe(201);
      for (let i = 0; i < o.runs; i++) {
        const r = await n.req({
          method: 'POST',
          url: `/v1/agents/${a}/runs`,
          headers: H,
          payload: { data: { i } },
        });
        expect(r.statusCode).toBe(202);
        runIds.push(r.json().id);
      }
    }
    for (let i = 0; i < (o.approvals ?? 0); i++) {
      const run = runIds[i]!;
      await n.ctx.db.update(runs).set({ status: 'running', lockedBy: 'w' }).where(eq(runs.id, run));
      await n.services.control.requestApproval(run, 'a', { server: 'x', tool: 'y', args: {} }, []);
    }
    if (o.costMicros)
      await n.ctx.db.insert(costLedger).values({
        runId: runIds[0] ?? randomUUID(),
        tenantId: id[slug]!,
        agentId: agentIds[0] ?? randomUUID(),
        costMicros: o.costMicros,
        month: monthOf(n.ctx.now()),
      });
  }

  beforeAll(async () => {
    db = await target.open();
    n = await testNode({ OAX_DATABASE_URL: db.url });
    id.default = (
      await n.ctx.db.select().from(tenantsTable).where(eq(tenantsTable.slug, 'default'))
    )[0]!.id;
    const mkRoot = async (slug: string) => {
      const r = await n.req({
        method: 'POST',
        url: '/v1/tenants',
        payload: {
          slug,
          name: `Org ${slug}`,
          admin: { email: `admin@${slug}.example.org`, displayName: slug, password: PW },
        },
      });
      expect(r.statusCode).toBe(201);
      id[slug] = r.json().id;
    };
    await mkRoot('org-a');
    await mkRoot('org-b');
    const child = async (parent: string, slug: string, name: string) => {
      id[slug] = (await n.services.tenants.createChild(op(), id[parent]!, { slug, name })).id;
    };
    await child('org-a', 'div-1', 'Division One');
    await child('div-1', 'team-1', 'Team One');
    await child('org-a', 'div-2', 'Division Two');
    await child('org-b', 'x-unit', 'Secret Unit');
    // Users: tenant admin of org-a, viewer of org-a, tenant admin of div-1 and of team-1.
    const user = async (slug: string, email: string, roles: ('admin' | 'viewer')[]) => {
      await n.services.identity.createLocalUser(
        { userId: op().userId, tenantId: id[slug]! },
        { email, displayName: email, password: PW, globalRoles: roles },
      );
      return n.login(email, PW);
    };
    tok.adminA = await n.login('admin@org-a.example.org', PW);
    tok.adminB = await n.login('admin@org-b.example.org', PW);
    tok.viewerA = await user('org-a', 'viewer@org-a.example.org', ['viewer']);
    tok.adminDiv1 = await user('div-1', 'admin@div-1.example.org', ['admin']);
    tok.adminTeam1 = await user('team-1', 'admin@team-1.example.org', ['admin']);
    await seed('org-a', { agents: 1, runs: 2, costMicros: 1_000_000 });
    await seed('div-1', { agents: 2, runs: 2, approvals: 1, costMicros: 2_500_000 });
    await seed('team-1', { agents: 1, costMicros: 500_000 });
    await seed('div-2', { agents: 3, costMicros: 4_000_000 });
    await seed('org-b', { agents: 5, runs: 1, approvals: 1, costMicros: 9_000_000 });
    await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${id['div-1']}`,
      payload: { monthlyBudgetUsd: 30 },
    });
    const apiToken = await n.req({
      method: 'POST',
      url: '/v1/tokens',
      token: tok.adminA!,
      payload: { name: 'agents-only', scopes: ['agents:read'], expiresInDays: 1 },
    });
    tok.agentsOnly = apiToken.json().token;
  }, 300_000);
  afterAll(async () => {
    await n.close();
    await db.close();
  });

  const tree = async (token: string, qs = '', headers: Record<string, string> = {}) => {
    const r = await as(token)({ method: 'GET', url: `/v1/tenants/tree${qs}`, headers });
    return r;
  };
  const items = async (token: string, qs = '') => {
    const r = await tree(token, qs);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().items as Item[];
  };
  const slugs = (xs: Item[]) => xs.map((x) => x.slug);

  describe('GET /v1/tenants/tree', () => {
    it('shows a platform admin every organisation, depth first, siblings by slug', async () => {
      const xs = await items(n.admin);
      expect(slugs(xs)).toEqual([
        'default',
        'org-a',
        'div-1',
        'team-1',
        'div-2',
        'org-b',
        'x-unit',
      ]);
      const byslug = Object.fromEntries(xs.map((x) => [x.slug, x]));
      expect(byslug['team-1']).toMatchObject({
        slugPath: 'org-a/div-1/team-1',
        parentId: id['div-1'],
        depth: 2,
        visible: true,
        status: 'active',
        hasChildren: false,
      });
      expect(byslug['org-a']).toMatchObject({ parentId: null, depth: 0, hasChildren: true });
      expect(xs.every((x) => x.counts === null)).toBe(true);
    });

    it('counts own and subtree values with one aggregate per metric', async () => {
      const xs = await items(n.admin, '?include=counts');
      const c = Object.fromEntries(xs.map((x) => [x.slug, x.counts!]));
      expect(c['org-a']).toMatchObject({
        agents: 1,
        agentsSubtree: 7,
        runs30d: 2,
        spendMonthUsd: 1,
        spendMonthSubtreeUsd: 8,
        pendingApprovals: 0,
        capUsd: null,
        capSource: null,
      });
      expect(c['div-1']).toMatchObject({
        agents: 2,
        agentsSubtree: 3,
        runs30d: 2,
        pendingApprovals: 1,
        spendMonthUsd: 2.5,
        spendMonthSubtreeUsd: 3,
        capUsd: 30,
        capSource: 'tenant',
      });
      expect(c['org-b']).toMatchObject({ agents: 5, agentsSubtree: 5, pendingApprovals: 1 });
      expect(c['x-unit']).toMatchObject({ agents: 0, spendMonthUsd: 0 });
    });

    it('shows a tenant admin their node and everything below, nothing else', async () => {
      const r = await tree(tok.adminA!, '?include=counts');
      const xs = r.json().items as Item[];
      expect(slugs(xs)).toEqual(['org-a', 'div-1', 'team-1', 'div-2']);
      expect(xs[0]).toMatchObject({ myRoles: ['admin'], inheritedRoles: [] });
      expect(xs[1]).toMatchObject({ myRoles: [], inheritedRoles: ['admin'] });
      // nothing of the other organisation or the default tenant, not even as a string
      for (const secret of [id['org-b']!, id['x-unit']!, id.default!, 'org-b', 'x-unit', 'Secret'])
        expect(r.body).not.toContain(secret);
      expect(xs[0]!.counts).toMatchObject({ agentsSubtree: 7, spendMonthSubtreeUsd: 8 });
    });

    it('shows a use-case-sized admin only their branch plus the ancestors as name stubs', async () => {
      const r = await tree(tok.adminDiv1!, '?include=counts');
      const xs = r.json().items as Item[];
      expect(slugs(xs)).toEqual(['org-a', 'div-1', 'team-1']);
      expect(xs[0]).toMatchObject({
        visible: false,
        counts: null,
        myRoles: [],
        inheritedRoles: [],
        hasChildren: true,
        name: 'Org org-a',
      });
      expect(xs[1]).toMatchObject({ visible: true, myRoles: ['admin'] });
      // no sibling, no counts of the ancestor, no foreign organisation
      for (const secret of [id['div-2']!, 'div-2', 'Division Two', id['org-b']!, 'org-b'])
        expect(r.body).not.toContain(secret);
      // the stub carries no number of the parent: only the branch's own sums
      expect(xs[1]!.counts).toMatchObject({ agentsSubtree: 3, spendMonthSubtreeUsd: 3 });
    });

    it('shows a viewer only the own node (and the path above), never a child or a subtree sum', async () => {
      const r = await tree(tok.viewerA!, '?include=counts');
      const xs = r.json().items as Item[];
      expect(slugs(xs)).toEqual(['org-a']);
      expect(xs[0]).toMatchObject({
        visible: true,
        myRoles: ['viewer'],
        hasChildren: false,
      });
      // own numbers only: the 6 agents below must not leak into the subtree figure
      expect(xs[0]!.counts).toMatchObject({
        agents: 1,
        agentsSubtree: 1,
        spendMonthUsd: 1,
        spendMonthSubtreeUsd: 1,
      });
      for (const secret of ['div-1', 'div-2', 'team-1', id['div-1']!])
        expect(r.body).not.toContain(secret);
    });

    it('shows a leaf admin the path stubs of all ancestors', async () => {
      const xs = await items(tok.adminTeam1!);
      expect(xs.map((x) => [x.slug, x.visible])).toEqual([
        ['org-a', false],
        ['div-1', false],
        ['team-1', true],
      ]);
      expect(xs[2]).toMatchObject({
        slugPath: 'org-a/div-1/team-1',
        depth: 2,
        parentId: id['div-1'],
      });
    });

    it('only fills the counts a token scope allows', async () => {
      const xs = await items(tok.agentsOnly!, '?include=counts');
      expect(xs[0]!.counts).toMatchObject({
        agents: 1,
        agentsSubtree: 7,
        runs30d: null,
        pendingApprovals: null,
        spendMonthUsd: null,
        spendMonthSubtreeUsd: null,
        capUsd: null,
      });
    });

    it('accepts a root by id or slug path inside the reach and 404s everywhere else', async () => {
      expect(slugs(await items(tok.adminA!, `?root=${id['div-1']}`))).toEqual(['div-1', 'team-1']);
      expect(slugs(await items(tok.adminA!, '?root=org-a/div-1'))).toEqual(['div-1', 'team-1']);
      expect(slugs(await items(n.admin, '?root=org-b&depth=0'))).toEqual(['org-b']);
      const outside = [
        id['org-b']!, // another organisation
        'org-b/x-unit',
        id.default!,
        id['div-2']!, // sibling of the adminDiv1's node, checked below
        randomUUID(), // does not exist
        'nope/nothing',
        '../etc',
        'a//b',
        'ORG-A',
      ];
      const bodies = new Set<string>();
      for (const root of outside.slice(0, 3).concat(outside.slice(4))) {
        const r = await tree(tok.adminA!, `?root=${encodeURIComponent(root)}`);
        expect(r.statusCode, root).toBe(404);
        bodies.add(r.json().message);
      }
      // existing-but-foreign and nonexistent look the same
      expect(bodies.size).toBe(1);
      // sibling and ancestor of div-1's admin
      for (const root of [id['div-2']!, id['org-a']!, 'org-a', 'org-a/div-2'])
        expect(
          (await tree(tok.adminDiv1!, `?root=${encodeURIComponent(root)}`)).statusCode,
          root,
        ).toBe(404);
      // a viewer cannot root the tree at a child
      expect((await tree(tok.viewerA!, `?root=${id['div-1']}`)).statusCode).toBe(404);
    });

    it('limits depth and size and flags truncation, shallowest first', async () => {
      expect(slugs(await items(tok.adminA!, '?depth=1'))).toEqual(['org-a', 'div-1', 'div-2']);
      const xs = await items(tok.adminA!, '?depth=1');
      expect(xs.find((x) => x.slug === 'div-1')!.hasChildren).toBe(true); // cut off by depth
      const r = await tree(tok.adminA!, '?limit=3');
      expect(r.json().truncated).toBe(true);
      expect(slugs(r.json().items)).toEqual(['org-a', 'div-1', 'div-2']); // team-1 is the deepest
      expect((await tree(tok.adminA!, '?limit=4')).json().truncated).toBe(false);
      // truncated responses still carry complete subtree sums
      const c = await items(tok.adminA!, '?limit=1&include=counts');
      expect(c[0]!.counts).toMatchObject({ agentsSubtree: 7 });
      for (const bad of ['?depth=33', '?depth=-1', '?limit=0', '?limit=5001', '?include=secrets'])
        expect((await tree(tok.adminA!, bad)).statusCode, bad).toBe(400);
    });

    it('requires authentication', async () => {
      expect(
        (await n.req({ method: 'GET', url: '/v1/tenants/tree', token: null })).statusCode,
      ).toBe(401);
    });
  });

  describe('GET /v1/me', () => {
    const me = async (token: string, headers: Record<string, string> = {}) => {
      const r = await as(token)({ method: 'GET', url: '/v1/me', headers });
      expect(r.statusCode, r.body).toBe(200);
      return { body: r.json(), headers: r.headers };
    };

    it('reports the acting tenant with its breadcrumb and the home tenant', async () => {
      const { body, headers } = await me(tok.adminDiv1!);
      expect(body.actingTenant).toEqual({
        id: id['div-1'],
        slug: 'div-1',
        slugPath: 'org-a/div-1',
        name: 'Division One',
        path: [
          { id: id['org-a'], slug: 'org-a', name: 'Org org-a' },
          { id: id['div-1'], slug: 'div-1', name: 'Division One' },
        ],
      });
      expect(body.homeTenant).toMatchObject({ id: id['div-1'], slugPath: 'org-a/div-1' });
      expect(body.tenant).toEqual({ id: id['div-1'], slug: 'div-1', name: 'Division One' });
      expect(body.bindings[0]).toEqual({
        role: 'admin',
        teamId: null,
        tenantId: id['div-1'],
        tenantSlugPath: 'org-a/div-1',
        useCase: null,
        expiresAt: null,
      });
      expect(headers['x-oax-acting-tenant']).toBe('org-a/div-1');
      // never a sibling or a foreign name
      expect(JSON.stringify(body)).not.toMatch(/div-2|Division Two|org-b|Secret/);
    });

    it('derives the installation mode from what the caller can act in', async () => {
      expect(
        await me(n.admin).then((r) => [r.body.installationMode, r.body.visibleTenantCount]),
      ).toEqual(['multi', 7]);
      expect((await me(tok.adminA!)).body).toMatchObject({
        installationMode: 'multi',
        visibleTenantCount: 4,
      });
      expect((await me(tok.adminDiv1!)).body).toMatchObject({
        installationMode: 'multi',
        visibleTenantCount: 2,
      });
      // a viewer or a leaf admin has nothing to switch to, whatever else exists in the installation
      expect((await me(tok.viewerA!)).body).toMatchObject({
        installationMode: 'single',
        visibleTenantCount: 1,
      });
      expect((await me(tok.adminTeam1!)).body).toMatchObject({
        installationMode: 'single',
        visibleTenantCount: 1,
      });
    });

    it('follows X-OAX-Tenant: acting tenant changes, home tenant and roles stay', async () => {
      const { body, headers } = await me(tok.adminA!, { 'x-oax-tenant': 'org-a/div-1/team-1' });
      expect(body.actingTenant).toMatchObject({ slugPath: 'org-a/div-1/team-1' });
      expect(body.actingTenant.path.map((p: { slug: string }) => p.slug)).toEqual([
        'org-a',
        'div-1',
        'team-1',
      ]);
      expect(body.homeTenant).toMatchObject({ slug: 'org-a' });
      expect(body.bindings[0]).toMatchObject({ role: 'admin', tenantId: id['org-a'] });
      expect(headers['x-oax-acting-tenant']).toBe('org-a/div-1/team-1');
      expect(body.visibleTenantCount).toBe(4);
    });

    it('lets a platform admin act anywhere', async () => {
      const { body } = await me(n.admin, { 'x-oax-tenant': 'x-unit' });
      expect(body.actingTenant.slugPath).toBe('org-b/x-unit');
      expect(body.homeTenant.slug).toBe('default');
    });
  });

  describe('X-OAX-Tenant', () => {
    const agentsOf = async (token: string, header?: string) => {
      const r = await as(token)({
        method: 'GET',
        url: '/v1/agents',
        headers: header ? { 'x-oax-tenant': header } : {},
      });
      return r;
    };

    it('acts in any node of the visible subtree by id, slug or slug path', async () => {
      for (const ref of [id['team-1']!, 'team-1', 'org-a/div-1/team-1']) {
        const r = await agentsOf(tok.adminA!, ref);
        expect(r.statusCode, ref).toBe(200);
        expect(r.json().items.map((a: { name: string }) => a.name)).toEqual(['team-1-agent-0']);
        expect(r.headers['x-oax-acting-tenant']).toBe('org-a/div-1/team-1');
      }
      const own = await agentsOf(tok.adminA!);
      expect(own.json().items).toHaveLength(1);
      expect(own.headers['x-oax-acting-tenant']).toBe('org-a');
    });

    it('answers 404 identically for sibling, ancestor, other organisation and unknown nodes', async () => {
      const probes: [string, string[]][] = [
        [
          'adminDiv1',
          [
            'div-2',
            id['div-2']!,
            'org-a/div-2',
            'org-a',
            id['org-a']!,
            'org-b',
            'x-unit',
            id.default!,
          ],
        ],
        ['adminA', ['org-b', id['org-b']!, 'org-b/x-unit', 'x-unit', 'default', id.default!]],
        ['viewerA', ['div-1', 'org-a/div-1', id['div-1']!, 'org-b']],
        ['adminTeam1', ['div-1', 'org-a', 'div-2', id['div-1']!]],
        ['adminB', ['org-a', 'div-1', id['div-1']!, 'default']],
        [
          'adminA',
          [randomUUID(), 'nope', 'org-a/nope', 'a//b', '../..', 'ORG-A', ' ', 'x'.repeat(3000)],
        ],
      ];
      const messages = new Set<string>();
      for (const [who, refs] of probes)
        for (const ref of refs) {
          const r = await agentsOf(tok[who]!, ref);
          expect(r.statusCode, `${who} -> ${ref.slice(0, 40)}`).toBe(404);
          expect(r.headers['x-oax-acting-tenant']).toBeUndefined();
          messages.add(r.json().message);
        }
      expect(messages.size).toBe(1);
    });

    it('never widens a non-admin: a viewer may name only the own node', async () => {
      expect((await agentsOf(tok.viewerA!, 'org-a')).statusCode).toBe(200);
      expect((await agentsOf(tok.viewerA!, 'div-1')).statusCode).toBe(404);
    });

    it('keeps the roles of the home tenant: a tenant admin cannot create tenants or leave the subtree', async () => {
      const r = await as(tok.adminA!)({
        method: 'POST',
        url: '/v1/tenants',
        headers: { 'x-oax-tenant': 'div-1' },
        payload: { slug: 'sneaky', name: 'Sneaky' },
      });
      expect(r.statusCode).toBe(403);
      // a resource of the child is not reachable by id from the parent's node without the header
      const a = (await agentsOf(n.admin, id['div-1']!)).json().items[0].id as string;
      expect((await as(tok.adminA!)({ method: 'GET', url: `/v1/agents/${a}` })).statusCode).toBe(
        404,
      );
      expect(
        (
          await as(tok.adminA!)({
            method: 'GET',
            url: `/v1/agents/${a}`,
            headers: { 'x-oax-tenant': 'div-1' },
          })
        ).statusCode,
      ).toBe(200);
    });

    it('sets X-OAX-Acting-Tenant on error responses of authenticated requests too', async () => {
      const r = await as(tok.viewerA!)({
        method: 'POST',
        url: '/v1/agents',
        payload: { source: 'x' },
      });
      expect(r.statusCode).toBe(403);
      expect(r.headers['x-oax-acting-tenant']).toBe('org-a');
      const anon = await n.req({ method: 'GET', url: '/v1/me', token: null });
      expect(anon.headers['x-oax-acting-tenant']).toBeUndefined();
    });
  });

  describe('GET /v1/tenants', () => {
    it('adds parentId, depth and slugPath and follows the same reach', async () => {
      const list = async (t: string) => {
        const r = await as(t)({ method: 'GET', url: '/v1/tenants' });
        expect(r.statusCode).toBe(200);
        return r.json().items as {
          slug: string;
          slugPath: string;
          parentId: string | null;
          depth: number;
        }[];
      };
      const all = await list(n.admin);
      expect(all.find((t) => t.slug === 'x-unit')).toMatchObject({
        slugPath: 'org-b/x-unit',
        parentId: id['org-b'],
        depth: 1,
      });
      expect((await list(tok.adminA!)).map((t) => t.slug)).toEqual([
        'div-1',
        'div-2',
        'org-a',
        'team-1',
      ]);
      expect((await list(tok.adminDiv1!)).map((t) => t.slug)).toEqual(['div-1', 'team-1']);
      expect((await list(tok.viewerA!)).map((t) => t.slug)).toEqual(['org-a']);
    });

    it('404s a node outside the reach on GET /v1/tenants/:id', async () => {
      for (const [who, target] of [
        ['adminA', 'org-b'],
        ['adminDiv1', 'div-2'],
        ['adminDiv1', 'org-a'],
        ['viewerA', 'div-1'],
      ] as const)
        expect(
          (await as(tok[who]!)({ method: 'GET', url: `/v1/tenants/${id[target]}` })).statusCode,
          `${who} ${target}`,
        ).toBe(404);
      expect(
        (await as(tok.adminA!)({ method: 'GET', url: `/v1/tenants/${id['div-1']}` })).json(),
      ).toMatchObject({ slugPath: 'org-a/div-1' });
    });
  });

  describe('GET /v1/tenants/search', () => {
    const search = async (t: string, q: string) => {
      const r = await as(t)({
        method: 'GET',
        url: `/v1/tenants/search?q=${encodeURIComponent(q)}`,
      });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().items as { slug: string; slugPath: string }[];
    };
    it('finds visible nodes by name or slug and nothing else', async () => {
      expect((await search(n.admin, 'div')).map((x) => x.slug)).toEqual(['div-1', 'div-2']);
      expect((await search(tok.adminDiv1!, 'div')).map((x) => x.slug)).toEqual(['div-1']);
      expect(await search(tok.adminDiv1!, 'secret')).toEqual([]);
      expect((await search(tok.adminA!, 'unit one')).map((x) => x.slugPath)).toEqual([]);
      expect((await search(tok.adminA!, 'team one')).map((x) => x.slugPath)).toEqual([
        'org-a/div-1/team-1',
      ]);
      expect(await search(tok.viewerA!, 'division')).toEqual([]);
    });
    it('treats % and _ literally', async () => {
      expect(await search(n.admin, '%')).toEqual([]);
      expect(await search(n.admin, 'div_1')).toEqual([]);
    });
  });

  describe('size and shape', () => {
    it('serves a wide tree of 1000 nodes with counts quickly', async () => {
      const root = randomUUID();
      const pathOf = (...ids: string[]) => `/${ids.join('/')}/`;
      await n.ctx.db.insert(tenantsTable).values({
        id: root,
        slug: 'wide',
        name: 'Wide',
        rootId: root,
        path: pathOf(root),
        depth: 0,
      });
      const kids = Array.from({ length: 1000 }, (_, i) => {
        const kid = randomUUID();
        return {
          id: kid,
          slug: `w-${String(i).padStart(4, '0')}`,
          name: `Wide ${i}`,
          parentId: root,
          rootId: root,
          path: pathOf(root, kid),
          depth: 1,
        };
      });
      for (let i = 0; i < kids.length; i += 250)
        await n.ctx.db.insert(tenantsTable).values(kids.slice(i, i + 250));
      await n.ctx.db.insert(costLedger).values(
        kids.slice(0, 300).map((k) => ({
          runId: randomUUID(),
          tenantId: k.id,
          agentId: randomUUID(),
          costMicros: 1_000_000,
          month: monthOf(n.ctx.now()),
        })),
      );
      const url = `/v1/tenants/tree?root=wide&include=counts&limit=2000`;
      await n.req({ method: 'GET', url }); // warm up
      const t0 = performance.now();
      const r = await n.req({ method: 'GET', url });
      const ms = performance.now() - t0;
      console.info(`[${target.name}] wide tree, 1001 nodes with counts: ${ms.toFixed(0)} ms`);
      expect(r.statusCode).toBe(200);
      const xs = r.json().items as Item[];
      expect(xs).toHaveLength(1001);
      expect(r.json().truncated).toBe(false);
      expect(xs[0]!.counts!.spendMonthSubtreeUsd).toBe(300);
      expect(xs[1]!.slug).toBe('w-0000');
      expect(ms).toBeLessThan(target.name === 'PostgreSQL' ? 1000 : 5000);
      // the default limit caps the response and says so
      const capped = await n.req({ method: 'GET', url: '/v1/tenants/tree?root=wide' });
      expect(capped.json().items).toHaveLength(1000);
      expect(capped.json().truncated).toBe(true);
    });

    it('serves the deepest allowed tree (33 levels) in order, and acts in its leaf by slug path', async () => {
      const ids: string[] = [];
      const rows = Array.from({ length: 33 }, (_, depth) => {
        const nid = randomUUID();
        ids.push(nid);
        return {
          id: nid,
          slug: `d-${depth}`,
          name: `Deep ${depth}`,
          parentId: depth === 0 ? null : ids[depth - 1]!,
          rootId: ids[0]!,
          path: `/${ids.join('/')}/`,
          depth,
        };
      });
      for (const row of rows) await n.ctx.db.insert(tenantsTable).values(row);
      const r = await n.req({ method: 'GET', url: '/v1/tenants/tree?root=d-0&include=counts' });
      const xs = r.json().items as Item[];
      expect(xs.map((x) => x.depth)).toEqual(Array.from({ length: 33 }, (_, i) => i));
      const leafPath = Array.from({ length: 33 }, (_, i) => `d-${i}`).join('/');
      expect(xs.at(-1)!.slugPath).toBe(leafPath);
      const me = await n.req({
        method: 'GET',
        url: '/v1/me',
        headers: { 'x-oax-tenant': leafPath },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().actingTenant.path).toHaveLength(33);
      expect(me.headers['x-oax-acting-tenant']).toBe(leafPath);
    });
  });
});

describe('single-tenant installation', () => {
  it('reports installationMode single and a one-node tree', async () => {
    const n = await testNode();
    try {
      const me = (await n.req({ method: 'GET', url: '/v1/me' })).json();
      expect(me).toMatchObject({ installationMode: 'single', visibleTenantCount: 1 });
      expect(me.actingTenant).toMatchObject({ slug: 'default', slugPath: 'default' });
      expect(me.actingTenant.path).toHaveLength(1);
      const tree = (await n.req({ method: 'GET', url: '/v1/tenants/tree?include=counts' })).json();
      expect(tree.items).toHaveLength(1);
      expect(tree.items[0]).toMatchObject({ slug: 'default', depth: 0, visible: true });
    } finally {
      await n.close();
    }
  });
});
