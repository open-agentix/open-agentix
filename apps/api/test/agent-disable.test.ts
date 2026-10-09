import type { Principal } from '@openagentix/core';
import { signWebhook } from '@openagentix/events';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agents, auditLog, events, runs, users } from '../src/db/schema.js';
import { agentSource } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

const PW = 'long-password-123';
const body = JSON.stringify({ hello: 'world' });
const now = () => Math.floor(Date.now() / 1000);

let n: TestNode;
let alice: string; // admin of tenant A
let bob: string; // admin of tenant B
let teamSecA: string;
let teamOpsA: string;
let aliceId: string;

const as = (token: string) => (opts: Parameters<TestNode['req']>[0]) => n.req({ ...opts, token });
const post = (token: string, url: string, payload?: unknown) =>
  as(token)({
    method: 'POST',
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
const get = async (token: string, url: string) => {
  const res = await as(token)({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  return res.json();
};
const disable = (token: string, id: string, reason?: string) =>
  post(token, `/v1/agents/${id}/disable`, reason === undefined ? {} : { reason });
const enable = (token: string, id: string) => post(token, `/v1/agents/${id}/enable`, {});
const manualRun = (token: string, id: string) =>
  post(token, `/v1/agents/${id}/runs`, { data: { x: 1 } });

async function createAgent(token: string, name: string, owner = 'team-security', publish = true) {
  const res = await post(token, '/v1/agents', { source: agentSource(name, owner) });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  if (publish) expect((await post(token, `/v1/agents/${id}/publish`)).statusCode).toBe(201);
  return id;
}
const auditOf = (action: string, target: string) =>
  n.ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.target, target)))
    .orderBy(auditLog.seq);
const runCount = async (agentId: string) =>
  Number((await n.ctx.db.select({ c: count() }).from(runs).where(eq(runs.agentId, agentId)))[0]!.c);
const eventCount = async (tenantId: string) =>
  Number(
    (await n.ctx.db.select({ c: count() }).from(events).where(eq(events.tenantId, tenantId)))[0]!.c,
  );

async function mkTenant(slug: string) {
  const r = await n.req({
    method: 'POST',
    url: '/v1/tenants',
    payload: {
      slug,
      name: `Org ${slug}`,
      admin: { email: `admin@${slug}.example.org`, displayName: `Admin ${slug}`, password: PW },
    },
  });
  expect(r.statusCode).toBe(201);
}
const members = new Map<string, { userId: string; role: string }[]>();
/** A user with `role` on a team (the API replaces the member list, so we keep the full one). */
async function userWithRole(email: string, team: string, role: string) {
  const u = await post(alice, '/v1/users', { email, displayName: email, password: PW });
  const id = u.json().id as string;
  const all = [...(members.get(team) ?? []), { userId: id, role }];
  members.set(team, all);
  expect(
    (
      await as(alice)({
        method: 'PUT',
        url: `/v1/teams/${team}/members`,
        payload: { members: all },
      })
    ).statusCode,
  ).toBe(204);
  return n.login(email, PW);
}

beforeAll(async () => {
  n = await testNode();
  await mkTenant('org-a');
  await mkTenant('org-b');
  alice = await n.login('admin@org-a.example.org', PW);
  bob = await n.login('admin@org-b.example.org', PW);
  aliceId = (await get(alice, '/v1/me')).user.id;
  const team = async (token: string, slug: string) =>
    (await post(token, '/v1/teams', { slug, name: slug })).json().id as string;
  teamSecA = await team(alice, 'team-security');
  teamOpsA = await team(alice, 'team-ops');
  await team(bob, 'team-security');
});
afterAll(async () => n.close());

describe('disable and enable', () => {
  it('switches the status, keeps versions visible and restores everything on enable', async () => {
    const id = await createAgent(alice, 'toggle-agent');
    expect((await get(alice, `/v1/agents/${id}`)).status).toBe('published');
    const res = await disable(alice, id, '  Pausing for the audit  ');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      status: 'disabled',
      disabledBy: { id: aliceId, displayName: 'Admin org-a' },
      disabledReason: 'Pausing for the audit',
      latestVersion: '1.0.0',
    });
    expect(Date.parse(res.json().disabledAt)).not.toBeNaN();
    // List and detail agree, the status filter finds it, the other filters do not.
    const listed = (await get(alice, '/v1/agents')).items.find((a: { id: string }) => a.id === id);
    const { draftSource: _d, ...detail } = await get(alice, `/v1/agents/${id}`);
    expect(detail).toEqual(listed);
    const names = async (q: string) =>
      (await get(alice, `/v1/agents?status=${q}`)).items.map((a: { name: string }) => a.name);
    expect(await names('disabled')).toEqual(['toggle-agent']);
    expect(await names('published')).not.toContain('toggle-agent');
    // Published versions stay immutable and readable.
    const versions = await get(alice, `/v1/agents/${id}/versions`);
    expect(versions.items).toHaveLength(1);
    expect((await get(alice, `/v1/agents/${id}/versions/1.0.0`)).source).toContain('toggle-agent');

    const back = await enable(alice, id);
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({
      status: 'published',
      disabledAt: null,
      disabledBy: null,
      disabledReason: null,
    });
    expect(await names('disabled')).toEqual([]);
    expect((await manualRun(alice, id)).statusCode).toBe(202);
  });

  it('is idempotent: the first actor, time and reason stay, one audit entry per change', async () => {
    const id = await createAgent(alice, 'idem-agent');
    const first = await disable(alice, id, 'first');
    const second = await disable(alice, id, 'second');
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await auditOf('agent.disabled', id)).toHaveLength(1);
    expect((await enable(alice, id)).statusCode).toBe(200);
    const again = await enable(alice, id);
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('published');
    expect(await auditOf('agent.enabled', id)).toHaveLength(1);
    // Enabling an agent that was never disabled changes nothing either.
    const fresh = await createAgent(alice, 'never-disabled');
    expect((await enable(alice, fresh)).statusCode).toBe(200);
    expect(await auditOf('agent.enabled', fresh)).toHaveLength(0);
  });

  it('audits actor and reason, and validates the reason length', async () => {
    const id = await createAgent(alice, 'audited-agent');
    expect((await disable(alice, id, 'x'.repeat(501))).statusCode).toBe(400);
    expect((await get(alice, `/v1/agents/${id}`)).status).toBe('published');
    expect((await disable(alice, id, 'x'.repeat(500))).statusCode).toBe(200);
    await enable(alice, id);
    expect((await disable(alice, id, '   ')).json().disabledReason).toBeNull();
    const entries = await auditOf('agent.disabled', id);
    expect(entries).toHaveLength(2);
    for (const entry of entries)
      expect(entry).toMatchObject({ actor: aliceId, tenantId: expect.any(String) });
    expect(
      entries.map((e) => (e.payload as { reason: string | null }).reason?.length ?? null),
    ).toEqual([500, null]);
    const [enabled] = await auditOf('agent.enabled', id);
    expect(enabled).toMatchObject({ actor: aliceId });
    // The chain stays valid with the new entries.
    const verify = await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} });
    expect(verify.json().valid).toBe(true);
  });

  it('strips control, invisible and bidi characters from the reason and keeps it on one line', async () => {
    const id = await createAgent(alice, 'reason-clean-agent');
    // NUL would make PostgreSQL reject the row; bidi overrides and zero-width characters would hide
    // or reorder text in the console and the audit export; line breaks would forge extra lines.
    const raw = 'leak\u0000ed \u202Etoken\u202C\u200B rotate\r\nnext\tline\u0007';
    const res = await disable(alice, id, raw);
    expect(res.statusCode).toBe(200);
    expect(res.json().disabledReason).toBe('leaked token rotate next line');
    const [entry] = await auditOf('agent.disabled', id);
    expect((entry!.payload as { reason: string }).reason).toBe('leaked token rotate next line');
    // A reason of invisible characters only is no reason.
    await enable(alice, id);
    expect((await disable(alice, id, '\u200B\u202E\u0000')).json().disabledReason).toBeNull();
    const verify = await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} });
    expect(verify.json().valid).toBe(true);
  });

  it('stays editable and publishable while disabled, without enabling it', async () => {
    const id = await createAgent(alice, 'edit-while-off');
    await disable(alice, id);
    const next = agentSource('edit-while-off', 'team-security', '1.1.0');
    expect(
      (await as(alice)({ method: 'PUT', url: `/v1/agents/${id}/draft`, payload: { source: next } }))
        .statusCode,
    ).toBe(200);
    expect((await post(alice, `/v1/agents/${id}/publish`)).statusCode).toBe(201);
    const a = await get(alice, `/v1/agents/${id}`);
    expect(a).toMatchObject({ status: 'disabled', latestVersion: '1.1.0' });
  });
});

describe('admission refuses a disabled agent', () => {
  it('rejects manual runs with 409 agent_disabled, audits it and creates no run', async () => {
    const id = await createAgent(alice, 'manual-agent');
    await disable(alice, id);
    const before = await runCount(id);
    const res = await manualRun(alice, id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'agent_disabled' });
    expect(await runCount(id)).toBe(before);
    const [refused] = await auditOf('run.refused', id);
    expect(refused).toMatchObject({ actor: `manual:${aliceId}` });
    expect(refused!.payload).toMatchObject({ reason: 'agent_disabled' });
    await enable(alice, id);
    expect((await manualRun(alice, id)).statusCode).toBe(202);
  });

  it('rejects a manual run of a pinned older version as well', async () => {
    const id = await createAgent(alice, 'pinned-agent');
    await disable(alice, id);
    const res = await post(alice, `/v1/agents/${id}/runs`, { data: {}, version: '1.0.0' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('agent_disabled');
  });

  it('stores webhook events of a bound disabled agent with reason agent_disabled', async () => {
    const id = await createAgent(alice, 'hook-agent');
    const src = await post(alice, '/v1/event-sources', {
      name: 'hook',
      kind: 'webhook',
      secretRefs: ['trivy-hook'],
      agentId: id,
    });
    expect(src.statusCode).toBe(201);
    const sourceId = src.json().id as string;
    const send = (delivery: string) =>
      n.req({
        method: 'POST',
        url: `/v1/ingest/webhook/${sourceId}`,
        token: null,
        payload: body,
        headers: {
          'content-type': 'application/json',
          ...signWebhook('hook-secret-1', body, now(), delivery),
        },
      });
    await disable(alice, id);
    const tenant = (await get(alice, '/v1/me')).tenant.id as string;
    const eventsBefore = await eventCount(tenant);
    const runsBefore = await runCount(id);
    const res = await send('d-1');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ runId: null, reason: 'agent_disabled' });
    expect(await eventCount(tenant)).toBe(eventsBefore + 1);
    expect(await runCount(id)).toBe(runsBefore);
    expect(await auditOf('run.refused', id)).toHaveLength(1);
    // The source stays bound and enabled; enabling the agent restores the path.
    expect((await get(alice, '/v1/event-sources')).items[0].agentId).toBe(id);
    await enable(alice, id);
    const ok = await send('d-2');
    expect(ok.json()).toMatchObject({ reason: null });
    expect(ok.json().runId).toBeTruthy();
  });
});

describe('permissions and tenant isolation', () => {
  it('returns 404 for an agent of another tenant and leaves it untouched', async () => {
    const id = await createAgent(alice, 'secret-agent');
    for (const act of [disable, enable]) {
      const res = await act(bob, id);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('secret-agent');
    }
    const [row] = await n.ctx.db.select().from(agents).where(eq(agents.id, id));
    expect(row!.disabledAt).toBeNull();
    // The attempt is audited in the caller's tenant, like any denied access.
    const denied = await auditOf('access.denied', id);
    expect(denied.length).toBeGreaterThan(0);
    // The other direction: a disabled agent of A cannot be enabled by B either.
    await disable(alice, id);
    expect((await enable(bob, id)).statusCode).toBe(404);
    const [still] = await n.ctx.db.select().from(agents).where(eq(agents.id, id));
    expect(still!.disabledAt).not.toBeNull();
    expect((await disable(alice, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('refuses viewers and operators (no agents:publish) with 403, and unknown callers', async () => {
    const id = await createAgent(alice, 'rbac-agent');
    const viewer = await userWithRole('viewer@org-a.example.org', teamSecA, 'viewer');
    const operator = await userWithRole('operator@org-a.example.org', teamSecA, 'operator');
    for (const token of [viewer, operator]) {
      expect((await disable(token, id)).statusCode).toBe(403);
      expect((await enable(token, id)).statusCode).toBe(403);
    }
    expect((await get(alice, `/v1/agents/${id}`)).status).toBe('published');
    // Without a token: 401.
    expect(
      (await n.req({ method: 'POST', url: `/v1/agents/${id}/disable`, token: null })).statusCode,
    ).toBe(401);
    // The viewer can see the state.
    await disable(alice, id, 'maintenance');
    expect(await get(viewer, `/v1/agents/${id}`)).toMatchObject({
      status: 'disabled',
      disabledReason: 'maintenance',
    });
    expect((await enable(viewer, id)).statusCode).toBe(403);
  });

  it('honours the team of the agent for agent engineers, and hides foreign teams (404)', async () => {
    const mine = await createAgent(alice, 'eng-own', 'team-security');
    const other = await createAgent(alice, 'eng-other', 'team-ops');
    const eng = await userWithRole('eng@org-a.example.org', teamSecA, 'agent-engineer');
    expect((await disable(eng, mine)).statusCode).toBe(200);
    // team-ops is not visible to this engineer: existence is not revealed.
    expect((await disable(eng, other)).statusCode).toBe(404);
    expect((await enable(eng, other)).statusCode).toBe(404);
    expect((await get(alice, `/v1/agents/${other}`)).status).toBe('published');
    expect(teamOpsA).toBeTruthy();
  });

  it('honours API token scopes', async () => {
    const id = await createAgent(alice, 'scope-agent');
    const mkToken = async (scopes: string[]) =>
      (await post(alice, '/v1/tokens', { name: `t-${scopes.join('-')}`, scopes })).json()
        .token as string;
    const readOnly = await mkToken(['agents:read']);
    const writeOnly = await mkToken(['agents:read', 'agents:write']);
    const publisher = await mkToken(['agents:read', 'agents:publish']);
    expect((await disable(readOnly, id)).statusCode).toBe(403);
    expect((await disable(writeOnly, id)).statusCode).toBe(403);
    expect((await get(alice, `/v1/agents/${id}`)).status).toBe('published');
    expect((await disable(publisher, id)).statusCode).toBe(200);
    expect((await enable(readOnly, id)).statusCode).toBe(403);
    expect((await enable(publisher, id)).statusCode).toBe(200);
  });

  it('names the disabling user only from the same tenant', async () => {
    const id = await createAgent(alice, 'who-agent');
    await disable(alice, id);
    // A foreign user id in disabledBy (data corruption) is never resolved to a name.
    const [foreign] = await n.ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'admin@org-b.example.org'));
    await n.ctx.db.update(agents).set({ disabledBy: foreign!.id }).where(eq(agents.id, id));
    const a = await get(alice, `/v1/agents/${id}`);
    expect(a.status).toBe('disabled');
    expect(a.disabledBy).toBeNull();
    expect(JSON.stringify(a)).not.toContain('Admin org-b');
  });
});

describe('race between enqueue and disable', () => {
  it('never admits a run that starts after disable returned', async () => {
    const id = await createAgent(alice, 'race-agent');
    const tenantId = (await get(alice, '/v1/me')).tenant.id as string;
    const principal = adminOf(tenantId);
    for (let round = 0; round < 15; round++) {
      await enable(alice, id);
      const results: { startedAfterDisable: boolean; ok: boolean }[] = [];
      let disabledAt = Infinity;
      const attempt = async (delay: number) => {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const started = performance.now();
        try {
          await n.services.runs.enqueue({
            agentId: id,
            event: {
              specversion: '1.0',
              id: crypto.randomUUID(),
              source: '/test',
              type: 'io.openagentix.test',
              time: new Date().toISOString(),
              data: null,
            } as never,
            triggeredBy: 'test:race',
          });
          results.push({ startedAfterDisable: started >= disabledAt, ok: true });
        } catch (e) {
          expect((e as { code?: string }).code).toBe('agent_disabled');
          results.push({ startedAfterDisable: started >= disabledAt, ok: false });
        }
      };
      const disabling = n.services.agents.disable(principal, id, 'race').then(() => {
        disabledAt = performance.now();
      });
      await Promise.all([disabling, ...Array.from({ length: 6 }, (_, i) => attempt(i % 3))]);
      // Everything that began after disable had returned must have been refused.
      for (const r of results.filter((x) => x.startedAfterDisable)) expect(r.ok).toBe(false);
      // And a late attempt is certainly refused.
      await attempt(0);
      expect(results.at(-1)!.ok).toBe(false);
    }
    // The state is consistent: disabled, and the queued runs that slipped in before are intact.
    const a = await get(alice, `/v1/agents/${id}`);
    expect(a.status).toBe('disabled');
  });
});

/** The admin principal of tenant A as the service layer expects it. */
function adminOf(tenantId: string): Principal {
  return {
    kind: 'user',
    userId: aliceId,
    tenantId,
    displayName: 'Admin org-a',
    platformAdmin: false,
    bindings: [{ role: 'admin', teamId: null }],
  };
}
