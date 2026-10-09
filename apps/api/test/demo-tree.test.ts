import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoId, uuidV5 } from '../src/demo/ids.js';
import { DEMO_AGENT_TENANT, DEMO_TENANTS, DEMO_USERS } from '../src/demo/seed.js';
import { tenants as tenantsTable } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';

const PW = 'demo-password-2026';
let a: TestNode;
let b: TestNode;

beforeAll(async () => {
  // Two independent databases, seeded the way the nightly reset does it.
  a = await testNode({ OAX_DEMO_MODE: 'true' });
  b = await testNode({ OAX_DEMO_MODE: 'true' });
}, 300_000);
afterAll(async () => {
  await a.close();
  await b.close();
});

interface TenantItem {
  id: string;
  slug: string;
  name: string;
}
const tenantsOf = async (n: TestNode) =>
  (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items as TenantItem[];
/** Read the tree columns straight from the table (the API shows parentId, depth and slugPath). */
const treeOf = (n: TestNode) => n.ctx.db.select().from(tenantsTable);

describe('uuidV5', () => {
  it('matches the RFC 4122 test vector and differs per name', () => {
    // python3: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
    expect(uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
    expect(demoId('run', 'x')).not.toBe(demoId('agent', 'x'));
    expect(demoId('run', 'x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('demo tenant tree', () => {
  it('seeds the expected tree, agents and counts', async () => {
    const tenants = await treeOf(a);
    expect(tenants.map((t) => t.slug).sort()).toEqual(
      ['acme-labs', 'default', 'platform', 'security'].sort(),
    );
    const bySlug = Object.fromEntries(tenants.map((t) => [t.slug, t]));
    const root = bySlug.default!;
    expect(root).toMatchObject({ name: 'Example Org (demo)', parentId: null, depth: 0 });
    for (const child of ['security', 'platform'] as const)
      expect(bySlug[child]).toMatchObject({
        parentId: root.id,
        rootId: root.id,
        depth: 1,
        path: `${root.path}${bySlug[child]!.id}/`,
      });
    expect(bySlug['acme-labs']).toMatchObject({ parentId: null, depth: 0 });
    expect(tenants).toHaveLength(DEMO_TENANTS.length);

    for (const [agent, key] of Object.entries(DEMO_AGENT_TENANT)) {
      const slug = DEMO_TENANTS.find((t) => t.key === key)!.slug;
      const list = (
        await a.req({ method: 'GET', url: '/v1/agents', headers: { 'x-oax-tenant': slug } })
      ).json().items as { name: string; id: string }[];
      expect(list.find((x) => x.name === agent)?.id).toBe(demoId('agent', agent));
    }
    // The three fixed scenarios target agents of the `security` sub-tenant.
    expect(DEMO_AGENT_TENANT['cve-triage']).toBe('security');
    const runs = (
      await a.req({ method: 'GET', url: '/v1/stats/runs', headers: { 'x-oax-tenant': 'security' } })
    ).json();
    expect(runs.byStatus.awaiting_approval).toBe(1);
  });

  it('gives every demo user a home tenant and keeps the demo read-only', async () => {
    expect(DEMO_USERS.every((u) => DEMO_TENANTS.some((t) => t.key === u.tenant))).toBe(true);
    const admin = await a.login('admin@example.org', PW);
    const write = await a.req({
      method: 'POST',
      url: '/v1/teams',
      token: admin,
      payload: { slug: 'x', name: 'X' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe('demo_read_only');
  });

  it('uses the same ids after a second, independent seed (nightly reset)', async () => {
    const ids = async (n: TestNode) => {
      const t = await tenantsOf(n);
      const out: Record<string, string> = {};
      for (const x of t.filter((x) => x.slug !== 'default')) out[`tenant:${x.slug}`] = x.id;
      for (const slug of t.map((x) => x.slug)) {
        const agents = (
          await n.req({ method: 'GET', url: '/v1/agents', headers: { 'x-oax-tenant': slug } })
        ).json().items as { name: string; id: string }[];
        for (const g of agents) out[`agent:${g.name}`] = g.id;
        const runs = (
          await n.req({
            method: 'GET',
            url: '/v1/runs?limit=100',
            headers: { 'x-oax-tenant': slug },
          })
        ).json().items as { id: string; agentId: string }[];
        for (const r of runs) out[`run:${r.id}`] = r.agentId;
      }
      return out;
    };
    const first = await ids(a);
    const second = await ids(b);
    expect(second).toEqual(first);
    expect(Object.keys(first).filter((k) => k.startsWith('agent:'))).toHaveLength(6);
    // 3 CVE runs, ticket-updater (2), feature-builder, hardening-review, log-summary, and the
    // change-gated release-watch runs (probes 1 and 3 changed, probe 2 did not).
    expect(Object.keys(first).filter((k) => k.startsWith('run:')).length).toBe(10);
    expect(Object.keys(first)).toContain(`run:${demoId('run', 'cve-triage:CVE-2024-3094')}`);
    expect(Object.keys(first)).toContain(`run:${demoId('run', 'release-watch:tick-0')}`);
    expect(Object.keys(first)).toContain(`run:${demoId('run', 'release-watch:tick-60')}`);
    expect(Object.keys(first)).not.toContain(`run:${demoId('run', 'release-watch:tick-30')}`);
  });

  it('contains only fictional data (example.org, no real personal data)', () => {
    for (const u of DEMO_USERS) expect(u.email).toMatch(/@example\.org$/);
    for (const t of DEMO_TENANTS) expect(`${t.slug} ${t.name}`).not.toMatch(/@|\d{5}/);
    for (const file of ['seed.ts', 'agents.ts', 'scenarios.ts']) {
      const text = readFileSync(
        fileURLToPath(new URL(`../src/demo/${file}`, import.meta.url)),
        'utf8',
      );
      const mails = text.match(/[\w.+-]+@[\w-]+(\.[a-z]{2,})+/gi) ?? [];
      for (const m of mails) expect(m).toMatch(/@([\w-]+\.)?example\.org$/);
    }
  });
});
