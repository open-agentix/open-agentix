import { randomUUID } from 'node:crypto';
import type { Principal, Role } from '@openagentix/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT_ID,
  agents as agentsTable,
  costLedger,
  events as eventsTable,
  runs,
  teamMembers,
  tenantRoleBindings,
  tenants as tenantsTable,
} from '../src/db/schema.js';
import { monthOf } from '../src/services/runs.js';
import { agentSource } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';
import { sqlTargets } from './db-targets.js';

/**
 * ADR 0014 slice S3 (#188): `?scope=subtree` on the list routes. The server builds the node list
 * from the resolver; ancestors, siblings and other organisations never take part; unknown and
 * invisible `tenantId` values are the same 404; the single-node behaviour is unchanged.
 *
 *   org-a ─┬─ div-1 ─── team-1        org-b ─── x-unit
 *          └─ div-2
 */
const PW = 'long-password-123';
const SLUGS = ['org-a', 'div-1', 'team-1', 'div-2', 'org-b', 'x-unit'] as const;

interface Page {
  items: Record<string, unknown>[];
  nextCursor?: string | null;
}

describe.each(sqlTargets)('scope=subtree on the list routes (%s)', (_kind, enabled, open) => {
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
  const get = (user: string, url: string, ref?: string) =>
    n.req({
      method: 'GET',
      url,
      token: tok[user]!,
      ...(ref ? { headers: { 'x-oax-tenant': ref } } : {}),
    });
  const ok = async (user: string, url: string, ref?: string) => {
    const r = await get(user, url, ref);
    expect(r.statusCode, `${url} as ${user}: ${r.body}`).toBe(200);
    return r.json() as Page;
  };
  /** Follows `nextCursor` with a page size of one: the union must equal the unpaged list. */
  const allPages = async (user: string, url: string, ref?: string) => {
    const out: Record<string, unknown>[] = [];
    let cursor: string | null | undefined;
    for (let i = 0; i < 50; i++) {
      const sep = url.includes('?') ? '&' : '?';
      const page = await ok(
        user,
        `${url}${sep}limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ref,
      );
      out.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) return out;
    }
    throw new Error('did not terminate');
  };
  const bind = (user: string, tenant: string, role: Role, inherit = true) =>
    n.ctx.db.insert(tenantRoleBindings).values({
      id: randomUUID(),
      userId: uid[user]!,
      tenantId: id[tenant]!,
      role,
      inherit,
    });
  const mkUser = async (key: string, home: string, roles: Role[], homeId = id[home]!) => {
    const email = `${key}@example.org`;
    uid[key] = (
      await n.services.identity.createLocalUser(
        { userId: op().userId, tenantId: homeId },
        { email, displayName: key, password: PW, globalRoles: roles },
      )
    ).id;
    tok[key] = await n.login(email, PW);
  };
  const names = (xs: Record<string, unknown>[]) => xs.map((x) => x.name as string).sort();
  const tenantSlugs = (xs: Record<string, unknown>[]) =>
    [...new Set(xs.map((x) => (x.tenant as { slug: string }).slug))].sort();
  const asAdmin = (slug: string) => ({ 'x-oax-tenant': id[slug]! });

  async function seed(slug: string) {
    const H = asAdmin(slug);
    await n.req({
      method: 'POST',
      url: '/v1/teams',
      headers: H,
      payload: { slug: 'team-security', name: 'S' },
    });
    const a = await n.req({
      method: 'POST',
      url: '/v1/agents',
      headers: H,
      payload: { source: agentSource(`${slug}-agent`) },
    });
    expect(a.statusCode).toBe(201);
    expect(
      (await n.req({ method: 'POST', url: `/v1/agents/${a.json().id}/publish`, headers: H }))
        .statusCode,
    ).toBe(201);
    const run = await n.req({
      method: 'POST',
      url: `/v1/agents/${a.json().id}/runs`,
      headers: H,
      payload: { data: { slug } },
    });
    expect(run.statusCode).toBe(202);
    await n.ctx.db.insert(eventsTable).values({
      id: randomUUID(),
      tenantId: id[slug]!,
      cloudEventId: `ce-${slug}`,
      type: 'test.event',
      payload: { slug },
    });
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/event-sources',
          headers: H,
          payload: { name: `src-${slug}`, kind: 'webhook' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/connections',
          headers: H,
          payload: { name: `conn-${slug}`, config: { transport: 'in-memory' } },
        })
      ).statusCode,
    ).toBe(201);
    await n.ctx.db.insert(costLedger).values({
      runId: run.json().id,
      tenantId: id[slug]!,
      agentId: a.json().id,
      costMicros: 1_000_000,
      month: monthOf(n.ctx.now()),
    });
    return { agentId: a.json().id as string, runId: run.json().id as string };
  }

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
    for (const [parent, slug] of [
      ['org-a', 'div-1'],
      ['div-1', 'team-1'],
      ['org-a', 'div-2'],
      ['org-b', 'x-unit'],
    ] as const)
      id[slug] = (await n.services.tenants.createChild(op(), id[parent]!, { slug, name: slug })).id;

    // inheriting viewer / auditor of org-a, both living in div-2
    await mkUser('inh-viewer', 'div-2', []);
    await bind('inh-viewer', 'org-a', 'viewer');
    await mkUser('inh-auditor', 'div-2', []);
    await bind('inh-auditor', 'org-a', 'auditor');
    // admin of org-a without inheritance (legacy shape), plain viewer of org-a
    await mkUser('plain-admin', 'org-a', ['admin']);
    await mkUser('plain-viewer', 'org-a', ['viewer']);
    // inheriting viewer of org-b
    await mkUser('inh-b', 'x-unit', []);
    await bind('inh-b', 'org-b', 'viewer');
    // team scoped: member of one team of div-1, home org-a
    await mkUser('team-only', 'org-a', []);

    for (const slug of SLUGS) await seed(slug);
    // a second agent in div-1, owned by a team the team-only user is a member of
    const blue = await n.services.identity.createTeam(
      { userId: op().userId, tenantId: id['div-1']! },
      { slug: 'blue', name: 'Blue' },
    );
    await n.ctx.db
      .insert(teamMembers)
      .values({ teamId: blue.id, userId: uid['team-only']!, role: 'operator' });
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/agents',
          headers: asAdmin('div-1'),
          payload: { source: agentSource('div-1-blue', 'blue') },
        })
      ).statusCode,
    ).toBe(201);
    // a pending approval in div-1 and in org-b
    for (const slug of ['div-1', 'org-b']) {
      const [run] = await n.ctx.db.select().from(runs).where(eq(runs.tenantId, id[slug]!));
      await n.ctx.db
        .update(runs)
        .set({ status: 'running', lockedBy: 'w' })
        .where(eq(runs.id, run!.id));
      await n.services.control.requestApproval(
        run!.id,
        'a',
        { server: 'x', tool: 'y', args: {} },
        [],
      );
    }
    await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${id['div-1']}`,
      payload: { monthlyBudgetUsd: 30 },
    });
  }, 240_000);
  afterAll(async () => {
    await n.close();
    await target.close();
  });

  describe('default behaviour is unchanged', () => {
    it('lists the acting node only, without a tenant on the rows', async () => {
      for (const url of ['/v1/runs', '/v1/runs?scope=node', '/v1/events', '/v1/approvals']) {
        const page = await ok('inh-auditor', url, 'org-a');
        for (const row of page.items) expect(row).not.toHaveProperty('tenant');
      }
      const runsOfOrgA = await ok('inh-viewer', '/v1/runs', 'org-a');
      expect(runsOfOrgA.items).toHaveLength(1);
      const agents = await ok('inh-viewer', '/v1/agents', 'org-a');
      expect(names(agents.items)).toEqual(['org-a-agent']);
      expect(names((await ok('inh-viewer', '/v1/agents?scope=node', 'org-a')).items)).toEqual([
        'org-a-agent',
      ]);
      const sources = await ok('inh-auditor', '/v1/event-sources', 'org-a');
      expect(names(sources.items)).toEqual(['src-org-a']);
      expect(sources).not.toHaveProperty('nextCursor');
    });

    it('refuses tenantId, limit and cursor without scope=subtree', async () => {
      for (const url of [
        `/v1/agents?tenantId=${id['div-1']}`,
        `/v1/runs?tenantId=div-1`,
        '/v1/event-sources?limit=5',
        '/v1/connections?cursor=abc',
        '/v1/budgets?limit=5',
      ]) {
        const r = await get('inh-auditor', url, 'org-a');
        expect(r.statusCode, url).toBe(400);
      }
    });
  });

  describe('agents', () => {
    it('spans the acting node and its descendants, with the tenant on every row', async () => {
      const page = await ok('inh-viewer', '/v1/agents?scope=subtree', 'org-a');
      expect(names(page.items)).toEqual([
        'div-1-agent',
        'div-1-blue',
        'div-2-agent',
        'org-a-agent',
        'team-1-agent',
      ]);
      expect(tenantSlugs(page.items)).toEqual(['div-1', 'div-2', 'org-a', 'team-1']);
      const t1 = page.items.find((x) => x.name === 'team-1-agent')!;
      expect(t1.tenant).toMatchObject({ id: id['team-1'], slugPath: 'org-a/div-1/team-1' });
      // the summary (spend, last run) is computed per row's own tenant
      expect(t1.monthSpendUsd).toBe(1);
      expect(t1.lastRun).not.toBeNull();
    });

    it('never includes ancestors, siblings or other organisations', async () => {
      const fromDiv1 = await ok('inh-viewer', '/v1/agents?scope=subtree', 'div-1');
      expect(tenantSlugs(fromDiv1.items)).toEqual(['div-1', 'team-1']);
      const fromHome = await ok('inh-viewer', '/v1/agents?scope=subtree');
      expect(tenantSlugs(fromHome.items)).toEqual(['div-2']);
      const orgB = await ok('inh-b', '/v1/agents?scope=subtree', 'org-b');
      expect(tenantSlugs(orgB.items)).toEqual(['org-b', 'x-unit']);
    });

    it('is opt-in: a non-inheriting admin gets its own node only', async () => {
      const page = await ok('plain-admin', '/v1/agents?scope=subtree', 'org-a');
      expect(tenantSlugs(page.items)).toEqual(['org-a']);
      expect((await get('plain-admin', '/v1/agents?scope=subtree', 'div-1')).statusCode).toBe(404);
    });

    it('applies team scoped roles per node', async () => {
      const page = await ok('team-only', '/v1/agents?scope=subtree', 'div-1');
      expect(names(page.items)).toEqual(['div-1-blue']);
      const node = await ok('team-only', '/v1/agents', 'div-1');
      expect(names(node.items)).toEqual(['div-1-blue']);
    });

    it('combines with filters and cursors without leaving the visible subtree', async () => {
      const unpaged = await ok('inh-viewer', '/v1/agents?scope=subtree', 'org-a');
      const paged = await allPages('inh-viewer', '/v1/agents?scope=subtree', 'org-a');
      expect(names(paged)).toEqual(names(unpaged.items));
      const filtered = await allPages('inh-viewer', '/v1/agents?scope=subtree&q=agent', 'org-a');
      expect(tenantSlugs(filtered)).not.toContain('org-b');
      const status = await allPages(
        'inh-viewer',
        '/v1/agents?scope=subtree&status=published',
        'org-a',
      );
      expect(names(status)).toEqual(
        ['div-1-agent', 'div-2-agent', 'org-a-agent', 'team-1-agent'].sort(),
      );
      // a cursor taken in another scope cannot widen this one
      const other = await ok('inh-b', '/v1/agents?scope=subtree&limit=1', 'org-b');
      const cross = await ok(
        'inh-viewer',
        `/v1/agents?scope=subtree&cursor=${encodeURIComponent(other.nextCursor!)}`,
        'org-a',
      );
      expect(tenantSlugs(cross.items)).not.toContain('org-b');
    });
  });

  describe('tenantId narrows, never widens', () => {
    it('accepts an id, a slug path and a bare slug of a node in the subtree', async () => {
      for (const ref of [id['div-1']!, 'org-a/div-1', 'div-1']) {
        const page = await ok(
          'inh-viewer',
          `/v1/agents?scope=subtree&tenantId=${encodeURIComponent(ref)}`,
          'org-a',
        );
        expect(tenantSlugs(page.items), ref).toEqual(['div-1']);
      }
    });

    it('answers unknown, invisible, foreign and out-of-subtree nodes with the same 404', async () => {
      const refs = [
        randomUUID(),
        'org-a/nope',
        'nope',
        id['org-b']!,
        'x-unit',
        'org-b/x-unit',
        id.default!,
        // visible to the caller, but not in the subtree of the acting node
        id['div-2']!,
        'org-a', // the ancestor of the acting node
      ];
      const bodies = new Set<string>();
      for (const ref of refs) {
        const r = await get(
          'inh-viewer',
          `/v1/agents?scope=subtree&tenantId=${encodeURIComponent(ref)}`,
          'div-1',
        );
        expect(r.statusCode, ref).toBe(404);
        bodies.add(r.body);
      }
      expect(bodies.size).toBe(1);
    });
  });

  describe('runs, approvals and events', () => {
    it('lists runs of the subtree page by page', async () => {
      const url = '/v1/runs?scope=subtree';
      const unpaged = (await ok('inh-viewer', url, 'org-a')).items;
      expect(tenantSlugs(unpaged)).toEqual(['div-1', 'div-2', 'org-a', 'team-1']);
      const paged = await allPages('inh-viewer', url, 'org-a');
      expect(paged.map((r) => r.id).sort()).toEqual(unpaged.map((r) => r.id).sort());
      const narrowed = await allPages('inh-viewer', `${url}&tenantId=team-1`, 'org-a');
      expect(tenantSlugs(narrowed)).toEqual(['team-1']);
    });

    it('applies team scoped roles to runs', async () => {
      const page = await ok('team-only', '/v1/runs?scope=subtree', 'div-1');
      expect(page.items).toHaveLength(0);
    });

    it('lists the approvals of the subtree', async () => {
      const fromOrgA = await ok('inh-viewer', '/v1/approvals?scope=subtree', 'org-a');
      expect(tenantSlugs(fromOrgA.items)).toEqual(['div-1']);
      const fromOrgB = await ok('inh-b', '/v1/approvals?scope=subtree', 'org-b');
      expect(tenantSlugs(fromOrgB.items)).toEqual(['org-b']);
      expect((await ok('inh-viewer', '/v1/approvals', 'org-a')).items).toHaveLength(0);
    });

    it('lists events of the subtree', async () => {
      const page = await allPages('inh-auditor', '/v1/events?scope=subtree', 'org-a');
      expect(tenantSlugs(page)).toEqual(['div-1', 'div-2', 'org-a', 'team-1']);
      expect(page.every((e) => e.tenant)).toBe(true);
    });
  });

  describe('sources and connections (paged only with scope=subtree)', () => {
    it('lists the sources and connections owned by the subtree', async () => {
      const sources = await allPages('inh-auditor', '/v1/event-sources?scope=subtree', 'org-a');
      expect(names(sources)).toEqual(['src-div-1', 'src-div-2', 'src-org-a', 'src-team-1']);
      expect(sources.every((s) => s.tenant)).toBe(true);
      const conns = await allPages('inh-auditor', '/v1/connections?scope=subtree', 'org-a');
      expect(names(conns)).toEqual(['conn-div-1', 'conn-div-2', 'conn-org-a', 'conn-team-1']);
      const page = await ok('inh-auditor', '/v1/connections?scope=subtree&limit=2', 'org-a');
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeTruthy();
    });

    it('does not name nodes outside the scope on platform connections', async () => {
      await n.ctx.db.execute(
        sql`update connections set scope = 'platform' where name = 'conn-org-b'`,
      );
      const conns = await allPages('inh-auditor', '/v1/connections?scope=subtree', 'org-a');
      expect(names(conns)).not.toContain('conn-org-b');
      // the single-node list keeps showing platform connections, as before
      const node = await ok('inh-auditor', '/v1/connections', 'org-a');
      expect(names(node.items)).toContain('conn-org-b');
    });
  });

  describe('costs and budgets', () => {
    it('aggregates the ledger of the subtree per tenant', async () => {
      const r = await ok('inh-viewer', '/v1/costs/summary?scope=subtree&groupBy=tenant', 'org-a');
      const items = r.items as unknown as { key: string; label: string; costUsd: number }[];
      expect(items.map((i) => i.label).sort()).toEqual([
        'org-a',
        'org-a/div-1',
        'org-a/div-1/team-1',
        'org-a/div-2',
      ]);
      expect(items.every((i) => i.costUsd === 1)).toBe(true);
      const total = await ok(
        'inh-viewer',
        '/v1/costs/summary?scope=subtree&groupBy=month',
        'org-a',
      );
      expect((total.items[0] as { costUsd: number }).costUsd).toBe(4);
      // single node: the acting tenant only, label unchanged
      const node = await ok('inh-viewer', '/v1/costs/summary?groupBy=tenant', 'org-a');
      expect(node.items).toHaveLength(1);
      expect((node.items[0] as { label: unknown }).label).toBeNull();
    });

    it('does not mix the cache entries of different scopes', async () => {
      const a = await ok('inh-viewer', '/v1/costs/summary?scope=subtree&groupBy=month', 'org-a');
      const b = await ok('inh-viewer', '/v1/costs/summary?scope=subtree&groupBy=month', 'div-1');
      const c = await ok('inh-b', '/v1/costs/summary?scope=subtree&groupBy=month', 'org-b');
      expect((a.items[0] as { costUsd: number }).costUsd).toBe(4);
      expect((b.items[0] as { costUsd: number }).costUsd).toBe(2);
      expect((c.items[0] as { costUsd: number }).costUsd).toBe(2);
    });

    it('lists the budgets of the nodes of the subtree', async () => {
      const r = (await ok('inh-viewer', '/v1/budgets?scope=subtree', 'org-a')) as unknown as {
        tenant: { key: string };
        nodes: {
          node: { slugPath: string };
          tenant: { limitUsd: number | null; spentUsd: number };
        }[];
      };
      expect(r.tenant.key).toBe('org-a');
      expect(r.nodes.map((x) => x.node.slugPath)).toEqual([
        'org-a',
        'org-a/div-1',
        'org-a/div-1/team-1',
        'org-a/div-2',
      ]);
      const div1 = r.nodes.find((x) => x.node.slugPath === 'org-a/div-1')!;
      expect(div1.tenant).toMatchObject({ limitUsd: 30, spentUsd: 1 });
      const paged = await ok('inh-viewer', '/v1/budgets?scope=subtree&limit=2', 'org-a');
      expect((paged as unknown as { nodes: unknown[] }).nodes).toHaveLength(2);
      expect(paged.nextCursor).toBeTruthy();
      const plain = (await ok('inh-viewer', '/v1/budgets', 'org-a')) as unknown as object;
      expect(plain).not.toHaveProperty('nodes');
    });

    it('pages the budgets through long slug paths (the cursor carries the slug path)', async () => {
      const long = (c: string) => `${c}${'x'.repeat(62)}`;
      const chain = [(await n.services.tenants.create(op(), { slug: long('l'), name: 'L' })).id];
      for (const c of ['m', 'n', 'o'])
        chain.push(
          (await n.services.tenants.createChild(op(), chain.at(-1)!, { slug: long(c), name: c }))
            .id,
        );
      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let i = 0; i < 10; i++) {
        const r = await n.req({
          method: 'GET',
          url: `/v1/budgets?scope=subtree&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          headers: { 'x-oax-tenant': chain[0]! },
        });
        expect(r.statusCode, r.body).toBe(200);
        seen.push(...r.json().nodes.map((x: { node: { id: string } }) => x.node.id));
        cursor = r.json().nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(chain);
    });
  });

  describe('audit', () => {
    it('is never readable with a viewer role, subtree or not', async () => {
      for (const user of ['inh-viewer', 'plain-viewer']) {
        for (const url of ['/v1/audit', '/v1/audit?scope=subtree']) {
          const ref = user === 'inh-viewer' ? 'org-a' : undefined;
          expect((await get(user, url, ref)).statusCode, `${user} ${url}`).toBe(403);
        }
      }
    });

    it('lists the entries of the nodes where audit:read is held', async () => {
      const unpaged = (await ok('inh-auditor', '/v1/audit?scope=subtree&limit=200', 'org-a')).items;
      expect(unpaged.length).toBeGreaterThan(0);
      for (const e of unpaged) {
        const t = e.tenant as { slug: string } | undefined;
        expect(t, JSON.stringify(e)).toBeDefined();
        expect(['org-a', 'div-1', 'team-1', 'div-2']).toContain(t!.slug);
      }
      const paged = await allPages('inh-auditor', '/v1/audit?scope=subtree', 'org-a');
      expect(paged.map((e) => e.seq)).toEqual(unpaged.map((e) => e.seq));
      const narrowed = await ok('inh-auditor', '/v1/audit?scope=subtree&tenantId=div-2', 'org-a');
      expect(tenantSlugs(narrowed.items)).toEqual(['div-2']);
      // the single-node list has no tenant on its rows
      const node = await ok('inh-auditor', '/v1/audit', 'org-a');
      for (const e of node.items) expect(e).not.toHaveProperty('tenant');
    });

    it('does not combine with allTenants', async () => {
      const r = await n.req({
        method: 'GET',
        url: '/v1/audit?scope=subtree&allTenants=true',
      });
      expect(r.statusCode).toBe(400);
    });
  });

  describe('platform operators and the read path', () => {
    it('gives an operator the subtree of the acting node, never another organisation', async () => {
      const r = await n.req({
        method: 'GET',
        url: '/v1/agents?scope=subtree',
        headers: asAdmin('org-a'),
      });
      expect(r.statusCode).toBe(200);
      expect(tenantSlugs(r.json().items)).toEqual(['div-1', 'div-2', 'org-a', 'team-1']);
      const narrowed = await n.req({
        method: 'GET',
        url: `/v1/agents?scope=subtree&tenantId=${id['x-unit']}`,
        headers: asAdmin('org-a'),
      });
      expect(narrowed.statusCode).toBe(404);
    });

    it('refuses a subtree larger than the node limit of an organisation', async () => {
      const cfg = n.ctx.config.tenancy as { maxNodesPerRoot: number };
      const before = cfg.maxNodesPerRoot;
      cfg.maxNodesPerRoot = 2;
      try {
        const r = await get('inh-viewer', '/v1/agents?scope=subtree', 'org-a');
        expect(r.statusCode).toBe(422);
        expect(r.json().error).toBe('subtree_too_large');
        const narrowed = await get(
          'inh-viewer',
          '/v1/agents?scope=subtree&tenantId=div-1',
          'org-a',
        );
        expect(narrowed.statusCode).toBe(200);
      } finally {
        cfg.maxNodesPerRoot = before;
      }
    });

    it('falls back to the acting node on the legacy read path', async () => {
      const auth = n.ctx.config.auth as unknown as { roleBindingsRead: string };
      auth.roleBindingsRead = 'legacy';
      try {
        const token = await n.login('plain-admin@example.org', PW);
        const r = await n.req({ method: 'GET', url: '/v1/agents?scope=subtree', token });
        expect(r.statusCode).toBe(200);
        expect(tenantSlugs(r.json().items)).toEqual(['org-a']);
      } finally {
        auth.roleBindingsRead = 'bindings';
      }
    });
  });

  describe('against a naive recursive reference', () => {
    // mulberry32: a seeded generator so a failure replays
    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    let compared = 0;
    let nonEmpty = 0;

    it.each([1, 2, 3, 4, 5, 6])(
      'returns exactly the readable agents (seed %i)',
      async (seed) => {
        const rand = rng(seed);
        const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
        const root = (await n.services.tenants.create(op(), { slug: `p${seed}`, name: 'P' })).id;
        const nodes: { id: string; parent: string | null; depth: number }[] = [
          { id: root, parent: null, depth: 0 },
        ];
        const count = 6 + Math.floor(rand() * 8);
        for (let i = 0; i < count; i++) {
          const parent = pick(nodes.filter((x) => x.depth < 4));
          const child = await n.services.tenants.createChild(op(), parent.id, {
            slug: `s${seed}n${i}`,
            name: `n${i}`,
          });
          nodes.push({ id: child.id, parent: parent.id, depth: parent.depth + 1 });
        }
        const teamOf = new Map<string, string>();
        const agentNode = new Map<string, { node: string; team: string }>();
        for (const [i, node] of nodes.entries()) {
          const team = await n.services.identity.createTeam(
            { userId: op().userId, tenantId: node.id },
            { slug: 'tm', name: 'tm' },
          );
          teamOf.set(node.id, team.id);
          for (const k of [0, 1]) {
            const created = await n.req({
              method: 'POST',
              url: '/v1/agents',
              headers: { 'x-oax-tenant': node.id },
              payload: {
                source: agentSource(`p${seed}-a${i}-${k}`, k === 0 ? 'tm' : 'team-security'),
              },
            });
            // owner "team-security" does not exist in this node: the agent has no team
            expect(created.statusCode).toBe(201);
            agentNode.set(created.json().id, { node: node.id, team: k === 0 ? team.id : '' });
          }
        }
        const parentOf = async (nodeId: string) =>
          (
            await n.ctx.db
              .select({ p: tenantsTable.parentId })
              .from(tenantsTable)
              .where(eq(tenantsTable.id, nodeId))
          )[0]!.p;
        /** The chain from the node up to the root, one lookup per step (the naive walk). */
        const chain = async (nodeId: string) => {
          const out = [nodeId];
          for (let p = await parentOf(nodeId); p; p = await parentOf(p)) out.push(p);
          return out;
        };

        interface Grant {
          node: string;
          inherit: boolean;
          expired: boolean;
        }
        for (let u = 0; u < 3; u++) {
          const key = `prop-${seed}-${u}`;
          const home = pick(nodes);
          await mkUser(key, '', [], home.id);
          const grants: Grant[] = [];
          const bindingNodes = nodes.filter((x) => x.id !== home.id);
          for (let b = 0; b < Math.floor(rand() * 4); b++) {
            const node = pick(bindingNodes);
            if (grants.some((g) => g.node === node.id)) continue;
            const g: Grant = { node: node.id, inherit: rand() < 0.6, expired: rand() < 0.2 };
            grants.push(g);
            await n.ctx.db.insert(tenantRoleBindings).values({
              id: randomUUID(),
              userId: uid[key]!,
              tenantId: node.id,
              role: 'viewer',
              inherit: g.inherit,
              expiresAt: new Date(Date.now() + (g.expired ? -60_000 : 3_600_000)),
            });
          }
          const member = rand() < 0.5 ? pick(nodes) : undefined;
          if (member)
            await n.ctx.db
              .insert(teamMembers)
              .values({ teamId: teamOf.get(member.id)!, userId: uid[key]!, role: 'operator' });
          // log in again: the principal is rebuilt from the new grants
          tok[key] = await n.login(`${key}@example.org`, PW);
          const principal = await n.services.identity.authenticate(tok[key]!);

          for (const acting of nodes) {
            let p: Principal;
            try {
              p = await n.services.identity.actingIn(principal, acting.id);
            } catch {
              continue; // not visible: the same 404 as an unknown node
            }
            const scope = await n.services.subtree.resolve(p, 'agents:read', { scope: 'subtree' });
            const got = (
              await n.ctx.db
                .select({ id: agentsTable.id })
                .from(agentsTable)
                .where(
                  scope!.isEmpty
                    ? sql`false`
                    : scope!.predicate({
                        tenantId: agentsTable.tenantId,
                        teamId: agentsTable.teamId,
                        agent: agentsTable.id,
                      }),
                )
            )
              .map((r) => r.id)
              .sort();
            const expected: string[] = [];
            for (const [agentId, a] of agentNode) {
              const up = await chain(a.node);
              if (!up.includes(acting.id)) continue; // not below the acting node
              const whole = grants.some(
                (g) => !g.expired && (g.node === a.node || (g.inherit && up.includes(g.node))),
              );
              const viaTeam =
                member?.id === a.node && a.team !== '' && a.team === teamOf.get(a.node);
              // a home node alone grants nothing
              if (whole || viaTeam) expected.push(agentId);
            }
            expect(got, `seed ${seed} user ${u} acting ${acting.id}`).toEqual(expected.sort());
            compared++;
            if (expected.length > 0) nonEmpty++;
          }
        }
      },
      240_000,
    );

    it('compared non-trivial cases', () => {
      expect(compared).toBeGreaterThan(20);
      expect(nonEmpty).toBeGreaterThan(5);
    });
  });
});
