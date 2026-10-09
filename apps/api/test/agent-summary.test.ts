import { randomUUID } from 'node:crypto';
import type { Principal } from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costLedger } from '../src/db/schema.js';
import { monthOf } from '../src/services/runs.js';
import { agentSource } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

const PW = 'long-password-123';
const labels = (useCase: string) => `labels:\n  useCase: ${useCase}`;

let n: TestNode;
let alice: string;
let bob: string;
let tenantA: string;
let tenantB: string;
let teamSecA: string;
let teamOpsA: string;
let teamSecB: string;

const as = (token: string) => (opts: Parameters<TestNode['req']>[0]) => n.req({ ...opts, token });
const get = async (token: string, url: string) => {
  const res = await n.req({ method: 'GET', url, token });
  expect(res.statusCode).toBe(200);
  return res.json();
};
/** The parts of an agent response these tests read. */
interface AgentJson {
  id: string;
  name: string;
  teamId: string | null;
  useCase: string | null;
  status: string;
  tenant: { id: string };
  ownerTeam: { name: string } | null;
  lastRun: { id: string; status: string } | null;
  monthSpendUsd: number | null;
  budget: { source: string; limitUsd: number; spentUsd: number; percentUsed: number } | null;
}
const listAgents = async (token: string, query = '') =>
  (await get(token, `/v1/agents${query}`)) as {
    items: AgentJson[];
    nextCursor: string | null;
  };
const names = async (token: string, query = '') =>
  (await listAgents(token, query)).items.map((a) => a.name as string).sort();

async function createAgent(
  token: string,
  name: string,
  owner: string,
  extra = '',
  version = '1.0.0',
) {
  const res = await as(token)({
    method: 'POST',
    url: '/v1/agents',
    payload: { source: agentSource(name, owner, version, extra) },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}
const publish = async (token: string, id: string) =>
  expect((await as(token)({ method: 'POST', url: `/v1/agents/${id}/publish` })).statusCode).toBe(
    201,
  );

/** Inserts a finished run row directly (a run needs no executor to be listed as "last run"). */
async function insertRun(
  agentId: string,
  tenantId: string,
  teamId: string,
  at: string,
  status: string,
) {
  const { runs, agents } = await import('../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [a] = await n.ctx.db.select().from(agents).where(eq(agents.id, agentId));
  const id = randomUUID();
  await n.ctx.db.insert(runs).values({
    id,
    tenantId,
    agentId,
    agentVersionId: a!.latestVersionId!,
    teamId,
    status,
    triggeredBy: 'test',
    createdAt: new Date(at),
  });
  return id;
}

const spend = (
  agentId: string,
  tenantId: string,
  teamId: string | null,
  useCase: string | null,
  micros: number,
) =>
  n.ctx.db.insert(costLedger).values({
    runId: randomUUID(),
    tenantId,
    agentId,
    teamId,
    useCase,
    costMicros: micros,
    month: monthOf(n.ctx.now()),
  });

beforeAll(async () => {
  n = await testNode();
  const mk = async (slug: string) => {
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
    return r.json().id as string;
  };
  tenantA = await mk('org-a');
  tenantB = await mk('org-b');
  alice = await n.login('admin@org-a.example.org', PW);
  bob = await n.login('admin@org-b.example.org', PW);
  const team = async (token: string, slug: string, name: string) =>
    (await as(token)({ method: 'POST', url: '/v1/teams', payload: { slug, name } })).json()
      .id as string;
  teamSecA = await team(alice, 'team-security', 'Security');
  teamOpsA = await team(alice, 'team-ops', 'Operations');
  teamSecB = await team(bob, 'team-security', 'Secret Team B');
});
afterAll(async () => n.close());

describe('agent summary fields', () => {
  it('returns tenant, use case, owner team, status and null context for a fresh draft', async () => {
    const draft = await createAgent(alice, 'draft-only', 'team-security', labels('intake'));
    expect(draft).toMatchObject({
      tenant: { id: tenantA, slug: 'org-a', slugPath: 'org-a', name: 'Org org-a' },
      useCase: 'intake',
      ownerTeam: { id: teamSecA, slug: 'team-security', name: 'Security' },
      status: 'draft',
      lastRun: null,
      monthSpendUsd: 0,
      budget: null,
    });
    const listed = (await listAgents(alice)).items.find((a) => a.id === draft.id)!;
    const { draftSource: _omit, ...detailWithoutDraft } = await get(
      alice,
      `/v1/agents/${draft.id}`,
    );
    expect(detailWithoutDraft).toEqual(listed);
  });

  it('derives status draft, published and changed from the draft and the latest version', async () => {
    const a = await createAgent(alice, 'status-agent', 'team-security');
    expect((await get(alice, `/v1/agents/${a.id}`)).status).toBe('draft');
    await publish(alice, a.id);
    expect((await get(alice, `/v1/agents/${a.id}`)).status).toBe('published');
    const edited = agentSource('status-agent', 'team-security', '1.1.0');
    await as(alice)({
      method: 'PUT',
      url: `/v1/agents/${a.id}/draft`,
      payload: { source: edited },
    });
    expect((await get(alice, `/v1/agents/${a.id}`)).status).toBe('changed');
    await publish(alice, a.id);
    expect((await get(alice, `/v1/agents/${a.id}`)).status).toBe('published');
    // Reverting the draft to the published text is "published" again.
    await as(alice)({
      method: 'PUT',
      url: `/v1/agents/${a.id}/draft`,
      payload: { source: agentSource('status-agent', 'team-security', '1.2.0') },
    });
    expect((await get(alice, `/v1/agents/${a.id}`)).status).toBe('changed');
    await as(alice)({
      method: 'PUT',
      url: `/v1/agents/${a.id}/draft`,
      payload: { source: edited },
    });
    expect((await get(alice, `/v1/agents/${a.id}`)).status).toBe('published');
    const byStatus = async (s: string) => names(alice, `?status=${s}`);
    expect(await byStatus('draft')).toContain('draft-only');
    expect(await byStatus('draft')).not.toContain('status-agent');
    expect(await byStatus('published')).toContain('status-agent');
    expect(await byStatus('changed')).not.toContain('status-agent');
    await as(alice)({
      method: 'PUT',
      url: `/v1/agents/${a.id}/draft`,
      payload: { source: agentSource('status-agent', 'team-security', '1.3.0') },
    });
    expect(await byStatus('changed')).toEqual(['status-agent']);
  });

  it('takes the use case from the latest published version, the draft only before publishing', async () => {
    const a = await createAgent(alice, 'uc-agent', 'team-security', labels('invoicing'));
    expect((await get(alice, `/v1/agents/${a.id}`)).useCase).toBe('invoicing');
    await as(alice)({
      method: 'PUT',
      url: `/v1/agents/${a.id}/draft`,
      payload: { source: agentSource('uc-agent', 'team-security', '1.0.0', labels('invoicing-2')) },
    });
    expect((await get(alice, `/v1/agents/${a.id}`)).useCase).toBe('invoicing-2');
    await publish(alice, a.id);
    await as(alice)({
      method: 'PUT',
      url: `/v1/agents/${a.id}/draft`,
      payload: { source: agentSource('uc-agent', 'team-security', '1.1.0', labels('other')) },
    });
    // The published version keeps defining the use case (it is what costs are attributed to).
    expect((await get(alice, `/v1/agents/${a.id}`)).useCase).toBe('invoicing-2');
    expect(await names(alice, '?useCase=other')).toEqual([]);
    expect(await names(alice, '?useCase=invoicing-2')).toEqual(['uc-agent']);
  });

  it('shows the latest run the caller may read, the newest first', async () => {
    const a = await createAgent(alice, 'run-agent', 'team-security');
    await publish(alice, a.id);
    await insertRun(a.id, tenantA, teamSecA, '2026-10-01T10:00:00Z', 'succeeded');
    const latest = await insertRun(a.id, tenantA, teamSecA, '2026-10-02T10:00:00Z', 'failed');
    expect((await get(alice, `/v1/agents/${a.id}`)).lastRun).toEqual({
      id: latest,
      status: 'failed',
      createdAt: '2026-10-02T10:00:00.000Z',
    });
    const listed = (await listAgents(alice)).items.find((x) => x.id === a.id)!;
    expect(listed.lastRun?.id).toBe(latest);
  });

  it('adds spend and the budget closest to its limit (tenant, use case, team)', async () => {
    const uc = 'budgeted';
    const a = await createAgent(alice, 'money-agent', 'team-ops', labels(uc));
    await publish(alice, a.id);
    await spend(a.id, tenantA, teamOpsA, uc, 2_000_000);
    const other = await createAgent(alice, 'money-neighbour', 'team-ops', labels(uc));
    await publish(alice, other.id);
    await spend(other.id, tenantA, teamOpsA, uc, 1_000_000);
    const money = async () => (await get(alice, `/v1/agents/${a.id}`)) as AgentJson;
    expect(await money()).toMatchObject({ monthSpendUsd: 2, budget: null });
    const patch = (url: string, method: string, payload: object) =>
      as(alice)({ method: method as 'PUT', url, payload });
    await patch(`/v1/teams/${teamOpsA}`, 'PATCH', { monthlyBudgetUsd: 30 });
    expect((await money()).budget).toEqual({
      limitUsd: 30,
      spentUsd: 3,
      percentUsed: 10,
      source: 'team',
      sourceName: 'Operations',
    });
    await patch(`/v1/budgets/use-cases/${uc}`, 'PUT', { monthlyBudgetUsd: 6 });
    expect((await money()).budget).toMatchObject({
      source: 'use_case',
      sourceName: uc,
      limitUsd: 6,
      spentUsd: 3,
      percentUsed: 50,
    });
    // Tenant budgets are set by platform operators.
    await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${tenantA}`,
      payload: { monthlyBudgetUsd: 4 },
    });
    const tenantBudget = (await money()).budget;
    expect(tenantBudget?.source).toBe('tenant');
    expect(tenantBudget?.limitUsd).toBe(4);
    expect(tenantBudget?.percentUsed).toBeGreaterThan(50);
  });

  it('exposes tenant ancestry as a slug path for a sub-tenant', async () => {
    const op: Principal = {
      kind: 'user',
      userId: randomUUID(),
      tenantId: tenantA,
      displayName: 'op',
      platformAdmin: true,
      bindings: [],
    };
    const child = await n.services.tenants.createChild(op, tenantA, {
      slug: 'security-div',
      name: 'Security Division',
    });
    const inChild = { 'x-oax-tenant': 'security-div' };
    const t = await n.req({
      method: 'POST',
      url: '/v1/teams',
      headers: inChild,
      payload: { slug: 'blue', name: 'Blue' },
    });
    expect(t.statusCode).toBe(201);
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      headers: inChild,
      payload: { source: agentSource('child-agent', 'blue') },
    });
    expect(created.json().tenant).toEqual({
      id: child.id,
      slug: 'security-div',
      slugPath: 'org-a/security-div',
      name: 'Security Division',
    });
    // The parent organisation does not list agents of its sub-tenant (no subtree scope yet).
    expect(await names(alice)).not.toContain('child-agent');
  });
});

describe('agent list filters and paging', () => {
  beforeAll(async () => {
    for (const [name, owner, uc] of [
      ['f-support', 'team-security', 'support'],
      ['f-billing', 'team-security', 'support/billing'],
      ['f-refunds', 'team-ops', 'support/billing/refunds'],
      ['f-supported', 'team-ops', 'supported'],
    ] as const)
      await createAgent(alice, name, owner, labels(uc));
  });

  it('filters by owner team, narrowing only within the tenant', async () => {
    const byTeam = await names(alice, `?teamId=${teamOpsA}&q=f-`);
    expect(byTeam).toEqual(['f-refunds', 'f-supported']);
    expect(await names(alice, `?teamId=${teamSecA}&q=f-`)).toEqual(['f-billing', 'f-support']);
  });

  it('matches a use case and its sub-use cases per path segment', async () => {
    expect(await names(alice, '?useCase=support')).toEqual(['f-billing', 'f-refunds', 'f-support']);
    expect(await names(alice, '?useCase=support/billing')).toEqual(['f-billing', 'f-refunds']);
    expect(await names(alice, '?useCase=support%2Fbilling%2F')).toEqual(['f-billing', 'f-refunds']);
    expect(await names(alice, '?useCase=supp')).toEqual([]);
    expect(await names(alice, '?useCase=%25')).toEqual([]);
  });

  it('searches name, description and use case literally, case-insensitively', async () => {
    expect(await names(alice, '?q=F-REFUND')).toEqual(['f-refunds']);
    expect(await names(alice, '?q=billing')).toEqual(['f-billing', 'f-refunds']);
    expect(await names(alice, '?q=%25')).toEqual([]);
    expect(await names(alice, '?q=_')).toEqual([]);
  });

  it('combines filters with AND and rejects invalid values', async () => {
    expect(await names(alice, `?useCase=support&teamId=${teamOpsA}`)).toEqual(['f-refunds']);
    expect(await names(alice, '?useCase=support&status=published')).toEqual([]);
    expect(
      (await n.req({ method: 'GET', url: '/v1/agents?status=archived', token: alice })).statusCode,
    ).toBe(400);
    expect(
      (await n.req({ method: 'GET', url: '/v1/agents?teamId=nope', token: alice })).statusCode,
    ).toBe(400);
  });

  it('pages a filtered list without gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `?useCase=support&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await listAgents(alice, q);
      seen.push(...page.items.map((a) => a.name));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(2);
    expect([...seen].sort()).toEqual(['f-billing', 'f-refunds', 'f-support']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('keeps the page order stable when other filters change between pages', async () => {
    const all = (await listAgents(alice, '?limit=200')).items.map((a) => a.id);
    const first = await listAgents(alice, '?limit=3');
    const second = await listAgents(alice, `?limit=3&cursor=${first.nextCursor}`);
    expect([...first.items, ...second.items].map((a) => a.id)).toEqual(all.slice(0, 6));
  });
});

describe('visibility and permissions', () => {
  it('hides last run, spend and budget from tokens without runs:read and costs:read', async () => {
    const a = (await listAgents(alice)).items.find((x) => x.name === 'money-agent')!;
    expect(a.monthSpendUsd).toBe(2);
    const t = await n.req({
      method: 'POST',
      url: '/v1/tokens',
      token: alice,
      payload: { name: 'read-agents-only', scopes: ['agents:read'] },
    });
    expect(t.statusCode).toBe(201);
    const limited = t.json().token as string;
    const seen = (await listAgents(limited)).items.find((x) => x.name === 'money-agent')!;
    expect(seen).toMatchObject({ lastRun: null, monthSpendUsd: null, budget: null });
    const run = (await listAgents(limited)).items.find((x) => x.name === 'run-agent')!;
    expect(run.lastRun).toBeNull();
    // The fields that need agents:read only stay available.
    expect(seen.ownerTeam).toMatchObject({ name: 'Operations' });
    expect(seen.tenant.id).toBe(tenantA);
  });

  it('lets a viewer read team names, and an agent-scoped user only the bound agent', async () => {
    const mk = async (email: string) =>
      (
        await as(alice)({
          method: 'POST',
          url: '/v1/users',
          payload: { email, displayName: email, password: PW },
        })
      ).json().id as string;
    const viewer = await mk('viewer@org-a.example.org');
    await as(alice)({
      method: 'PUT',
      url: `/v1/teams/${teamSecA}/members`,
      payload: { members: [{ userId: viewer, role: 'viewer' }] },
    });
    const viewerToken = await n.login('viewer@org-a.example.org', PW);
    const teamViewer = await listAgents(viewerToken);
    expect(teamViewer.items.every((a) => a.teamId === teamSecA)).toBe(true);
    expect(teamViewer.items.every((a) => a.ownerTeam?.name === 'Security')).toBe(true);
    // A team filter for a team the viewer cannot see narrows to nothing, never widens.
    expect(await names(viewerToken, `?teamId=${teamOpsA}`)).toEqual([]);

    const solo = await mk('solo@org-a.example.org');
    const bound = (await listAgents(alice)).items.find((a) => a.name === 'run-agent')!;
    await as(alice)({
      method: 'PUT',
      url: `/v1/agents/${bound.id}/members`,
      payload: { members: [{ userId: solo, role: 'viewer' }] },
    });
    const soloToken = await n.login('solo@org-a.example.org', PW);
    const soloList = await listAgents(soloToken);
    expect(soloList.items.map((a) => a.name)).toEqual(['run-agent']);
    expect(soloList.items[0]!.lastRun).not.toBeNull();
    expect(await names(soloToken, '?q=money')).toEqual([]);
  });

  it('refuses users without any role instead of listing anything', async () => {
    await as(alice)({
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'lonely@org-a.example.org', displayName: 'l', password: PW },
    });
    const token = await n.login('lonely@org-a.example.org', PW);
    const res = await n.req({ method: 'GET', url: `/v1/agents?teamId=${teamSecA}`, token });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('Security');
  });
});

describe('tenant isolation of the summary fields', () => {
  let secretAgent: string;
  const SHARED_UC = 'shared-use-case';
  let sharedA: string;

  beforeAll(async () => {
    const s = await createAgent(bob, 'b-secret-agent', 'team-security', labels(SHARED_UC));
    secretAgent = s.id;
    await publish(bob, secretAgent);
    await insertRun(secretAgent, tenantB, teamSecB, '2026-10-05T10:00:00Z', 'failed');
    // Tenant B has a use case budget and heavy spend under the same use case label as A.
    await as(bob)({
      method: 'PUT',
      url: `/v1/budgets/use-cases/${SHARED_UC}`,
      payload: { monthlyBudgetUsd: 1 },
    });
    await as(bob)({
      method: 'PATCH',
      url: `/v1/teams/${teamSecB}`,
      payload: { monthlyBudgetUsd: 2 },
    });
    await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${tenantB}`,
      payload: { monthlyBudgetUsd: 3 },
    });
    await spend(secretAgent, tenantB, teamSecB, SHARED_UC, 900_000_000);
    const a = await createAgent(alice, 'a-shared-uc', 'team-security', labels(SHARED_UC));
    sharedA = a.id;
    await publish(alice, sharedA);
  });

  it('never lists tenant B agents through any filter, search or count', async () => {
    for (const q of [
      '?q=b-secret',
      `?useCase=${SHARED_UC}&q=secret`,
      `?teamId=${teamSecB}`,
      '?q=Secret%20Team',
    ]) {
      expect(await listAgents(alice, q)).toEqual({ items: [], nextCursor: null });
    }
    expect(await names(alice, `?useCase=${SHARED_UC}`)).toEqual(['a-shared-uc']);
    expect(await names(bob, `?useCase=${SHARED_UC}`)).toEqual(['b-secret-agent']);
    const allA = JSON.stringify(await listAgents(alice, '?limit=200'));
    for (const leak of ['b-secret-agent', 'Secret Team B', 'org-b', tenantB, secretAgent, teamSecB])
      expect(allA).not.toContain(leak);
  });

  it('answers a team of another tenant exactly like an unknown team', async () => {
    const foreign = await n.req({
      method: 'GET',
      url: `/v1/agents?teamId=${teamSecB}`,
      token: alice,
    });
    const unknown = await n.req({
      method: 'GET',
      url: `/v1/agents?teamId=${randomUUID()}`,
      token: alice,
    });
    expect(foreign.statusCode).toBe(unknown.statusCode);
    expect(foreign.body).toBe(unknown.body);
  });

  it('keeps spend, budgets and last runs of tenant B out of the summary of tenant A', async () => {
    const mine = (await listAgents(alice)).items.find((a) => a.id === sharedA)!;
    expect(mine.monthSpendUsd).toBe(0);
    expect(mine.lastRun).toBeNull();
    // Tenant B limits (1 / 2 / 3 USD) and its 900 USD spend must not appear as A's budget.
    expect(JSON.stringify(mine.budget)).not.toMatch(/Org org-b|Secret Team B/);
    expect(mine.budget === null || mine.budget.spentUsd < 100).toBe(true);
    const theirs = (await listAgents(bob)).items.find((a) => a.id === secretAgent)!;
    expect(theirs.monthSpendUsd).toBe(900);
    expect(theirs.budget).toMatchObject({ source: 'use_case', limitUsd: 1, spentUsd: 900 });
    expect(theirs.lastRun).toMatchObject({ status: 'failed' });
  });

  it('refuses to summarise rows of another tenant at the service level', async () => {
    const { agents } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await n.ctx.db.select().from(agents).where(eq(agents.id, secretAgent));
    const alicePrincipal = {
      kind: 'user',
      userId: randomUUID(),
      tenantId: tenantA,
      displayName: 'alice',
      platformAdmin: false,
      bindings: [{ role: 'admin', teamId: null }],
    } as const;
    await expect(
      n.services.agentSummaries.summarize(alicePrincipal as never, [row!]),
    ).rejects.toThrow(/principal tenant only/);
  });

  it('still returns 404 for the detail of a foreign agent', async () => {
    expect(
      (await n.req({ method: 'GET', url: `/v1/agents/${secretAgent}`, token: alice })).statusCode,
    ).toBe(404);
  });
});
