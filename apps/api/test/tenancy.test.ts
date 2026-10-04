import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costLedger } from '../src/db/schema.js';
import { resolveConnections, type ConnectionRow } from '../src/services/catalog.js';
import { agentSource } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

const PW = 'long-password-123';
let n: TestNode;
let alice: string;
let bob: string;
let tenantA: string;
let tenantB: string;
/** Resources of tenant B, created by bob. */
const b = {} as {
  team: string;
  agent: string;
  run: string;
  source: string;
  connection: string;
  policy: string;
  user: string;
  approval: string;
  token: string;
};

const as = (token: string) => (opts: Parameters<TestNode['req']>[0]) => n.req({ ...opts, token });

beforeAll(async () => {
  n = await testNode();
  const mk = async (slug: string) => {
    const r = await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: {
        slug,
        name: `Tenant ${slug}`,
        admin: { email: `admin@${slug}.example.org`, displayName: slug, password: PW },
      },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  tenantA = await mk('tenant-a');
  tenantB = await mk('tenant-b');
  alice = await n.login('admin@tenant-a.example.org', PW);
  bob = await n.login('admin@tenant-b.example.org', PW);

  const B = as(bob);
  b.team = (
    await B({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-security', name: 'S' } })
  ).json().id;
  b.agent = (
    await B({ method: 'POST', url: '/v1/agents', payload: { source: agentSource('secret-agent') } })
  ).json().id;
  expect((await B({ method: 'POST', url: `/v1/agents/${b.agent}/publish` })).statusCode).toBe(201);
  b.run = (
    await B({ method: 'POST', url: `/v1/agents/${b.agent}/runs`, payload: { data: { x: 1 } } })
  ).json().id;
  b.source = (
    await B({
      method: 'POST',
      url: '/v1/event-sources',
      payload: { name: 'hook', kind: 'webhook', secretRefs: ['trivy-hook'], agentId: b.agent },
    })
  ).json().id;
  b.connection = (
    await B({
      method: 'POST',
      url: '/v1/connections',
      payload: { name: 'jira', config: { transport: 'in-memory' } },
    })
  ).json().id;
  b.policy = (
    await B({
      method: 'POST',
      url: '/v1/policies',
      payload: { name: 'strict', bundle: { forbiddenTools: ['x/*'] } },
    })
  ).json().id;
  b.user = (
    await B({
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'dev@tenant-b.example.org', displayName: 'Dev', password: PW },
    })
  ).json().id;
  b.token = (
    await B({ method: 'POST', url: '/v1/tokens', payload: { name: 'ci', expiresInDays: 1 } })
  ).json().id;
  // A pending approval of tenant B.
  await n.ctx.db
    .update((await import('../src/db/schema.js')).runs)
    .set({ status: 'running', lockedBy: 'w' })
    .where((await import('drizzle-orm')).eq((await import('../src/db/schema.js')).runs.id, b.run));
  b.approval = (await n.services.control.requestApproval(
    b.run,
    'a',
    { server: 'x', tool: 'y', args: {} },
    [],
  )) as string;
  await n.ctx.db.insert(costLedger).values({
    runId: b.run,
    tenantId: tenantB,
    agentId: b.agent,
    costMicros: 1234,
    month: '2026-10-01',
  });
});
afterAll(async () => n.close());

describe('tenant isolation', () => {
  it('hides every tenant B resource from tenant A with 404', async () => {
    const A = as(alice);
    const probes: [string, string, unknown?][] = [
      ['GET', `/v1/agents/${b.agent}`],
      ['PUT', `/v1/agents/${b.agent}/draft`, { source: agentSource('secret-agent') }],
      ['POST', `/v1/agents/${b.agent}/publish`],
      ['GET', `/v1/agents/${b.agent}/versions`],
      ['GET', `/v1/agents/${b.agent}/versions/1.0.0`],
      ['GET', `/v1/agents/${b.agent}/members`],
      ['PUT', `/v1/agents/${b.agent}/members`, { members: [] }],
      ['POST', `/v1/agents/${b.agent}/dry-run`, {}],
      ['POST', `/v1/agents/${b.agent}/runs`, { data: {} }],
      ['GET', `/v1/runs/${b.run}`],
      ['GET', `/v1/runs/${b.run}/steps`],
      ['POST', `/v1/runs/${b.run}/stream-token`],
      ['POST', `/v1/runs/${b.run}/cancel`],
      ['POST', `/v1/approvals/${b.approval}/decision`, { decision: 'approve' }],
      ['GET', `/v1/event-sources/${b.source}`],
      ['PATCH', `/v1/event-sources/${b.source}`, { enabled: false }],
      ['DELETE', `/v1/event-sources/${b.source}`],
      ['GET', `/v1/connections/${b.connection}`],
      ['PUT', `/v1/connections/${b.connection}`, { config: { transport: 'in-memory' } }],
      ['DELETE', `/v1/connections/${b.connection}`],
      ['GET', `/v1/policies/${b.policy}`],
      ['PUT', `/v1/policies/${b.policy}`, { enabled: false }],
      ['GET', `/v1/users/${b.user}`],
      ['PATCH', `/v1/users/${b.user}`, { disabled: true }],
      ['GET', `/v1/teams/${b.team}/members`],
      ['PATCH', `/v1/teams/${b.team}`, { name: 'taken over' }],
      ['PUT', `/v1/teams/${b.team}/members`, { members: [] }],
      ['DELETE', `/v1/teams/${b.team}`],
      ['DELETE', `/v1/tokens/${b.token}`],
      ['GET', `/v1/tenants/${tenantB}`],
    ];
    for (const [method, url, payload] of probes) {
      const r = await A({ method: method as 'GET', url, ...(payload ? { payload } : {}) });
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(404);
    }
  });

  it('keeps tenant B out of every list, summary and export of tenant A', async () => {
    const A = as(alice);
    for (const url of [
      '/v1/agents',
      '/v1/runs',
      '/v1/events',
      '/v1/approvals?status=pending',
      '/v1/event-sources',
      '/v1/connections',
      '/v1/policies',
      '/v1/teams',
    ]) {
      const r = await A({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.json().items, url).toEqual([]);
    }
    expect(
      (await A({ method: 'GET', url: '/v1/users' }))
        .json()
        .items.map((u: { email: string }) => u.email),
    ).toEqual(['admin@tenant-a.example.org']);
    expect((await A({ method: 'GET', url: '/v1/stats/runs' })).json().total).toBe(0);
    expect(
      (await A({ method: 'GET', url: '/v1/costs/summary?groupBy=agent' })).json().items,
    ).toEqual([]);
    expect((await A({ method: 'GET', url: '/v1/costs/export?format=json' })).json().items).toEqual(
      [],
    );
    expect(
      (await A({ method: 'GET', url: '/v1/tenants' }))
        .json()
        .items.map((t: { slug: string }) => t.slug),
    ).toEqual(['tenant-a']);
    // ... while tenant B sees its own data.
    const B = as(bob);
    expect((await B({ method: 'GET', url: '/v1/agents' })).json().items).toHaveLength(1);
    expect((await B({ method: 'GET', url: '/v1/runs' })).json().items).toHaveLength(1);
    expect(
      (await B({ method: 'GET', url: '/v1/costs/summary?groupBy=tenant' })).json().items[0]
        .costMicros,
    ).toBe(1234);
  });

  it('audits denied cross-tenant access in the acting tenant and shows no foreign entries', async () => {
    const A = as(alice);
    const mine = (await A({ method: 'GET', url: '/v1/audit?limit=200' })).json().items as {
      action: string;
      target: string | null;
      payload: unknown;
    }[];
    expect(mine.some((e) => e.action === 'access.denied' && e.target === b.agent)).toBe(true);
    expect(mine.some((e) => e.action === 'agent.created' && e.target === b.agent)).toBe(false);
    expect(JSON.stringify(mine)).not.toContain('secret-agent');
    const exported = (await A({ method: 'GET', url: '/v1/audit/export' })).body;
    expect(exported).not.toContain(b.agent === '' ? 'x' : 'agent.created');
    expect(
      (await as(bob)({ method: 'GET', url: '/v1/audit?action=agent.created' })).json().items,
    ).toHaveLength(1);
  });

  it('lets tenants reuse names and refuses cross-tenant references', async () => {
    const A = as(alice);
    await A({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-security', name: 'S' } });
    const same = await A({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: agentSource('secret-agent') },
    });
    expect(same.statusCode).toBe(201);
    expect(same.json().id).not.toBe(b.agent);
    const bound = await A({
      method: 'POST',
      url: '/v1/event-sources',
      payload: { name: 'steal', kind: 'webhook', secretRefs: ['trivy-hook'], agentId: b.agent },
    });
    expect(bound.statusCode).toBe(404);
    const foreignMember = await A({
      method: 'PUT',
      url: `/v1/teams/${(await A({ method: 'GET', url: '/v1/teams' })).json().items[0].id}/members`,
      payload: { members: [{ userId: b.user, role: 'viewer' }] },
    });
    expect(foreignMember.statusCode).toBe(404);
    const scoped = await A({
      method: 'POST',
      url: '/v1/connections',
      payload: { name: 'x', scope: 'agent', scopeId: b.agent, config: { transport: 'in-memory' } },
    });
    expect(scoped.statusCode).toBe(404);
  });

  it('only resolves tool servers of the run tenant and platform servers', async () => {
    const forB = await n.services.catalog.mcpConfigs({
      tenantId: tenantB,
      teamId: null,
      agentId: b.agent,
    });
    expect(forB.map((c) => c.name)).toEqual(['jira']);
    const forA = await n.services.catalog.mcpConfigs({
      tenantId: tenantA,
      teamId: null,
      agentId: randomUUID(),
    });
    expect(forA).toEqual([]);
  });

  it('restricts tenant management and cross-tenant views to platform operators', async () => {
    const A = as(alice);
    expect(
      (await A({ method: 'POST', url: '/v1/tenants', payload: { slug: 'evil', name: 'x' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await A({ method: 'PATCH', url: `/v1/tenants/${tenantA}`, payload: { name: 'x' } }))
        .statusCode,
    ).toBe(403);
    expect((await A({ method: 'GET', url: '/v1/audit?allTenants=true' })).statusCode).toBe(403);
    expect((await A({ method: 'GET', url: '/v1/costs/summary?allTenants=true' })).statusCode).toBe(
      403,
    );
    expect((await A({ method: 'POST', url: '/v1/audit/checkpoints' })).statusCode).toBe(403);
    expect((await A({ method: 'GET', url: '/v1/audit/checkpoints' })).json().items).toEqual([]);
    expect(
      (
        await A({
          method: 'POST',
          url: '/v1/policies',
          payload: { name: 'g', scope: 'platform', bundle: {} },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await A({
          method: 'POST',
          url: '/v1/guidelines',
          payload: { scope: 'global', name: 'g', version: '1.0.0', rules: {} },
        })
      ).statusCode,
    ).toBe(403);
    // Switching tenants is an operator privilege, indistinguishable from an unknown tenant otherwise.
    expect(
      (await A({ method: 'GET', url: '/v1/agents', headers: { 'x-oax-tenant': 'tenant-b' } }))
        .statusCode,
    ).toBe(404);
    const verify = await A({ method: 'POST', url: '/v1/audit/verify', payload: {} });
    // Tenants see their own latest entry as the head (real seq and hash), not the global head.
    const own = (await A({ method: 'GET', url: '/v1/audit?limit=1' })).json().items[0];
    const globalHead = (
      await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })
    ).json();
    expect(verify.json()).toMatchObject({ valid: true, headSeq: own.seq, headHash: own.hash });
    expect(own.seq).toBeGreaterThan(0);
    expect(verify.json().headSeq).toBeLessThanOrEqual(globalHead.headSeq);
  });

  it('lets a platform operator act inside and across tenants', async () => {
    const asB = await n.req({
      method: 'GET',
      url: '/v1/agents',
      headers: { 'x-oax-tenant': 'tenant-b' },
    });
    expect(asB.json().items.map((a: { id: string }) => a.id)).toEqual([b.agent]);
    const all = await n.req({
      method: 'GET',
      url: '/v1/costs/summary?groupBy=tenant&allTenants=true',
    });
    expect(all.json().items.map((r: { key: string }) => r.key)).toContain(tenantB);
    const audit = await n.req({ method: 'GET', url: '/v1/audit?allTenants=true&limit=200' });
    expect(audit.json().items.some((e: { action: string }) => e.action === 'tenant.created')).toBe(
      true,
    );
    expect(
      (await n.req({ method: 'GET', url: '/v1/agents', headers: { 'x-oax-tenant': 'nope' } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('rejects duplicate tenants and exposes the acting tenant on /v1/me', async () => {
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/tenants',
          payload: { slug: 'tenant-a', name: 'x' },
        })
      ).statusCode,
    ).toBe(409);
    const me = (await as(bob)({ method: 'GET', url: '/v1/me' })).json();
    expect(me).toMatchObject({ tenant: { slug: 'tenant-b' }, platformAdmin: false });
    const upd = await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${tenantB}`,
      payload: { name: 'B2', monthlyBudgetUsd: 5 },
    });
    expect(upd.json()).toMatchObject({ name: 'B2', monthlyBudgetUsd: 5 });
    expect((await as(bob)({ method: 'GET', url: `/v1/tenants/${tenantB}` })).statusCode).toBe(200);
  });
});

describe('connection scope resolution', () => {
  const row = (over: Partial<ConnectionRow>): ConnectionRow =>
    ({
      id: randomUUID(),
      tenantId: 't1',
      scope: 'tenant',
      scopeId: null,
      name: 'm',
      kind: 'model',
      config: {},
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as ConnectionRow;

  it('picks the most specific scope per name and ignores foreign tenants', () => {
    const platform = row({ scope: 'platform', tenantId: 'op' });
    const tenant = row({});
    const team = row({ scope: 'team', scopeId: 'team1' });
    const agent = row({ scope: 'agent', scopeId: 'agent1' });
    const foreign = row({ tenantId: 't2', scope: 'agent', scopeId: 'agent1' });
    const scope = { tenantId: 't1', teamId: 'team1', agentId: 'agent1' };
    expect(resolveConnections([platform, tenant, team, agent, foreign], scope)).toEqual([agent]);
    expect(resolveConnections([platform, tenant, team], scope)).toEqual([team]);
    expect(resolveConnections([platform, tenant], scope)).toEqual([tenant]);
    expect(resolveConnections([platform], { ...scope, tenantId: 'zzz' })).toEqual([platform]);
    expect(resolveConnections([team, agent], { ...scope, teamId: null, agentId: 'other' })).toEqual(
      [],
    );
  });
});
