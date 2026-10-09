import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_ALLOWED_MUTATIONS, routeIndex } from '../src/index.js';
import { DEMO_TENANTS, DEMO_USERS } from '../src/demo/seed.js';
import { users as usersTable } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';

const PW = 'demo-password-2026';
let n: TestNode;
let owner: string;

beforeAll(async () => {
  n = await testNode({ OAX_DEMO_MODE: 'true' });
  owner = await n.login('owner@example.org', PW);
}, 300_000);
afterAll(async () => n.close());

describe('demo users', () => {
  it('seeds exactly one visitor account that is a platform admin', async () => {
    const rows = await n.ctx.db.select().from(usersTable);
    const byEmail = Object.fromEntries(rows.map((u) => [u.email, u]));
    for (const u of DEMO_USERS) expect(byEmail[u.email], u.email).toBeDefined();
    expect(DEMO_USERS.filter((u) => u.platformAdmin).map((u) => u.email)).toEqual([
      'owner@example.org',
    ]);
    expect(byEmail['owner@example.org']).toMatchObject({
      displayName: 'Olga Owner',
      platformAdmin: true,
    });
    // The existing accounts are unchanged: nobody else (besides the seed's own owner) is one.
    expect(
      rows
        .filter((u) => u.platformAdmin && u.email.endsWith('@example.org'))
        .map((u) => u.email)
        .sort(),
    ).toEqual(['demo-owner@example.org', 'owner@example.org']);
    expect(byEmail['admin@example.org']).toMatchObject({ platformAdmin: false });
    expect(DEMO_USERS.length).toBe(8);
  });

  it('lets the owner see and act in all four demo tenants', async () => {
    const me = (await n.req({ method: 'GET', url: '/v1/me', token: owner })).json();
    expect(me.platformAdmin).toBe(true);
    const list = (await n.req({ method: 'GET', url: '/v1/tenants', token: owner })).json()
      .items as { slug: string; name: string }[];
    expect(list.map((t) => t.slug).sort()).toEqual(DEMO_TENANTS.map((t) => t.slug).sort());
    expect(list.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'Example Org (demo)',
        'Security (demo)',
        'Platform (demo)',
        'Acme Labs (demo)',
      ]),
    );
    const counts: Record<string, number> = {};
    for (const t of list) {
      const agents = await n.req({
        method: 'GET',
        url: '/v1/agents',
        token: owner,
        headers: { 'x-oax-tenant': t.slug },
      });
      expect(agents.statusCode).toBe(200);
      counts[t.slug] = agents.json().items.length;
    }
    expect(counts).toEqual({ default: 1, security: 3, platform: 1, 'acme-labs': 1 });
  });

  it('opens the listed accounts with the shared password and the unlisted seed helpers not at all', async () => {
    const attempt = (username: string, i: number) =>
      n.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { username, password: PW },
        // One address per attempt: the sign-in rate limit is per client address.
        remoteAddress: `192.0.2.${10 + i}`,
      });
    const listed = DEMO_USERS.map((u) => u.email);
    for (const [i, email] of listed.entries())
      expect((await attempt(email, i)).statusCode, email).toBe(200);
    // demo-owner@ (platform admin) and the Acme admin get a random password per seed.
    for (const [i, hidden] of ['demo-owner@example.org', 'admin@acme.example.org'].entries())
      expect((await attempt(hidden, 50 + i)).statusCode, hidden).toBe(401);
  });

  it('keeps the other visitor accounts in one tenant (no switcher for them)', async () => {
    const admin = await n.login('admin@example.org', PW);
    expect((await n.req({ method: 'GET', url: '/v1/me', token: admin })).json().platformAdmin).toBe(
      false,
    );
    const list = (await n.req({ method: 'GET', url: '/v1/tenants', token: admin })).json().items;
    expect(list).toHaveLength(1);
    const other = await n.req({
      method: 'GET',
      url: '/v1/agents',
      token: admin,
      headers: { 'x-oax-tenant': 'acme-labs' },
    });
    expect(other.statusCode).toBe(404);
  });
});

describe('a platform admin in the public demo', () => {
  const sample = (url: string) =>
    url.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

  it('cannot use any mutating endpoint outside the fixed allowlist', async () => {
    const mutating = routeIndex(n.app).filter(
      (r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method),
    );
    expect(mutating.length).toBeGreaterThan(40);
    const refused: string[] = [];
    for (const r of mutating) {
      if (DEMO_ALLOWED_MUTATIONS.has(`${r.method} ${r.url}`)) continue;
      const res = await n.req({
        method: r.method as 'POST',
        url: sample(r.url),
        token: owner,
        headers: { 'x-oax-tenant': 'security' },
        payload: {},
      });
      if (r.access === 'run-token' || r.access === 'model-token') {
        // Worker and model-proxy endpoints take machine tokens only: a user session (platform admin or not) is
        // refused at authentication, before any handler runs.
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      } else {
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
        expect(res.json().error, `${r.method} ${r.url}`).toBe('demo_read_only');
      }
      refused.push(`${r.method} ${r.url}`);
    }
    // The allowlist only names routes that exist, and contains nothing destructive or admin.
    const known = new Set(mutating.map((r) => `${r.method} ${r.url}`));
    for (const a of DEMO_ALLOWED_MUTATIONS) expect(known.has(a), a).toBe(true);
    expect(refused.length + DEMO_ALLOWED_MUTATIONS.size).toBe(mutating.length);
    for (const a of DEMO_ALLOWED_MUTATIONS)
      expect(a).not.toMatch(/tenants|tokens|users|policies$|deploy|publish|delete|connections/);
  }, 120_000);

  it('is refused on the named admin operations and nothing changes', async () => {
    const before = (await n.req({ method: 'GET', url: '/v1/tenants', token: owner })).json().items
      .length;
    const attempts = [
      { method: 'POST', url: '/v1/tenants', payload: { slug: 'evil', name: 'Evil' } },
      { method: 'POST', url: '/v1/tokens', payload: { name: 'x', scopes: ['agents:read'] } },
      {
        method: 'POST',
        url: '/v1/users',
        payload: { email: 'x@example.org', displayName: 'X', password: 'pppppppppppp' },
      },
      { method: 'POST', url: '/v1/policies', payload: { name: 'p', bundle: {} } },
      { method: 'POST', url: '/v1/agents', payload: { source: 'x' } },
      { method: 'PATCH', url: '/v1/tenants/default', payload: { name: 'Hacked' } },
      { method: 'DELETE', url: '/v1/tenants/security' },
    ] as const;
    for (const a of attempts) {
      const res = await n.req({
        method: a.method,
        url: a.url,
        token: owner,
        headers: { 'x-oax-tenant': 'default' },
        ...('payload' in a ? { payload: a.payload } : {}),
      });
      expect(res.statusCode, `${a.method} ${a.url}`).toBe(403);
      expect(res.json().error).toBe('demo_read_only');
    }
    const after = (await n.req({ method: 'GET', url: '/v1/tenants', token: owner })).json().items;
    expect(after).toHaveLength(before);
    expect(after.find((t: { slug: string }) => t.slug === 'default').name).toBe(
      'Example Org (demo)',
    );
  });

  it('may still sign in and use the side-effect-free checks', async () => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/policies/evaluate',
      token: owner,
      payload: {},
    });
    expect(res.json().error).not.toBe('demo_read_only');
  });
});
