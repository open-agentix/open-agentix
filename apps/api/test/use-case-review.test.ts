import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agents, teamMembers, users } from '../src/db/schema.js';
import { agentSource } from './fixtures.js';
import { sqlTargets } from './db-targets.js';
import { buildWorld, PW, type World } from './use-case-world.js';

/**
 * Findings of the security review of ADR 0014 S8 (#321): an attached use-case administrator and a
 * team administrator cannot mint accounts, teams or role grants of the node; use-case bindings do
 * not write or run agents of a team; relabelling a team agent needs node-level authority; node
 * limits are hidden from use-case callers; cost labels of agents elsewhere stay hidden. Runs on both
 * read paths (the first describe uses the default of the test run, the second forces `bindings`).
 */
describe.each(sqlTargets)('use-case review findings (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let w: World;
  const userCount = async () => (await w.n.ctx.db.select().from(users)).length;
  const post = (who: string | null, url: string, body: unknown, acting?: string) =>
    w.req(who, 'POST', url, body, acting);

  beforeAll(async () => {
    w = await buildWorld(await open(), { OAX_ROLE_BINDINGS_READ: 'bindings' });
    await w.bind('uc-sec', 'org-a', 'admin', { inherit: true, useCase: 'sec' });
    await w.bind('uc-eng', 'org-a', 'agent-engineer', { useCase: 'sec' });
    await w.bind('uc-oper', 'org-a', 'operator', { useCase: 'sec' });
    for (const k of ['uc-sec', 'uc-eng', 'uc-oper']) await w.relogin(k);
    await w.mkUser('u1-plain', 'unit-1');
    expect(
      (await w.req('root-admin', 'PATCH', `/v1/tenants/${w.id['unit-1']}`, { useCase: 'sec' }))
        .statusCode,
    ).toBe(200);
  }, 240_000);
  afterAll(async () => w?.close());

  describe('an attached use-case administrator mints nothing in the attached node', () => {
    it('is an unrestricted admin there for resources, but not for accounts, teams or grants', async () => {
      expect((await w.req('uc-sec', 'GET', '/v1/agents', undefined, 'unit-1')).statusCode).toBe(
        200,
      );
      const before = await userCount();
      for (const globalRoles of [['admin'], ['viewer'], []]) {
        const r = await post(
          'uc-sec',
          '/v1/users',
          {
            email: `minted-${globalRoles.join('')}@example.org`,
            displayName: 'M',
            password: PW,
            globalRoles,
          },
          'unit-1',
        );
        expect(r.statusCode, JSON.stringify(globalRoles)).toBe(403);
      }
      expect(await userCount()).toBe(before);
    });

    it('cannot change roles of an account, create teams, or grant team and agent roles', async () => {
      const p = await w.req(
        'uc-sec',
        'PATCH',
        `/v1/users/${w.uid['u1-plain']}`,
        { globalRoles: ['admin'] },
        'unit-1',
      );
      expect(p.statusCode).toBe(403);
      expect((await w.n.services.identity.getUser(w.uid['u1-plain']!)).globalRoles).toEqual([]);
      expect(
        (await post('uc-sec', '/v1/teams', { slug: 'sneaky', name: 'S' }, 'unit-1')).statusCode,
      ).toBe(403);
      const t = await post(null, '/v1/teams', { slug: 'plain', name: 'Plain' }, 'unit-1');
      expect(t.statusCode, t.body).toBe(201);
      const members = await w.req(
        'uc-sec',
        'PUT',
        `/v1/teams/${t.json().id}/members`,
        { members: [{ userId: w.uid['u1-plain'], role: 'admin' }] },
        'unit-1',
      );
      expect(members.statusCode).toBe(403);
      const agentMembers = await w.req(
        'uc-sec',
        'PUT',
        `/v1/agents/${w.agent['a-u1']}/members`,
        { members: [{ userId: w.uid['u1-plain'], role: 'admin' }] },
        'unit-1',
      );
      expect(agentMembers.statusCode).toBe(403);
      expect(
        (await w.req('uc-sec', 'DELETE', `/v1/teams/${t.json().id}`, undefined, 'unit-1'))
          .statusCode,
      ).toBe(403);
    });

    it('cannot grant a role there, exactly 403 for a user homed in the node', async () => {
      const r = await post(
        'uc-sec',
        `/v1/tenants/${w.id['unit-1']}/role-bindings`,
        { userId: w.uid['u1-plain'], role: 'viewer', inherit: false, useCase: 'sec' },
        'unit-1',
      );
      expect(r.statusCode).toBe(403);
      const wide = await post(
        'uc-sec',
        `/v1/tenants/${w.id['unit-1']}/role-bindings`,
        { userId: w.uid['u1-plain'], role: 'viewer', inherit: false },
        'unit-1',
      );
      expect(wide.statusCode).toBe(403);
    });

    it('still lets a node-level tenant admin do all of it', async () => {
      const r = await post(
        'root-admin',
        '/v1/users',
        { email: 'legit@example.org', displayName: 'L', password: PW, globalRoles: ['admin'] },
        'unit-1',
      );
      expect(r.statusCode, r.body).toBe(201);
      expect(
        (await post('root-admin', '/v1/teams', { slug: 'legit', name: 'L' }, 'unit-1')).statusCode,
      ).toBe(201);
    });
  });

  describe('a team-scoped administrator cannot mint node-level roles', () => {
    it('is refused account creation and role changes', async () => {
      const team = await post(null, '/v1/teams', { slug: 'blue', name: 'Blue' }, 'org-a');
      expect(team.statusCode, team.body).toBe(201);
      w.id['blue'] = team.json().id;
      await w.mkUser('team-admin', 'org-a');
      const put = await w.req(
        null,
        'PUT',
        `/v1/teams/${w.id['blue']}/members`,
        { members: [{ userId: w.uid['team-admin'], role: 'admin' }] },
        'org-a',
      );
      expect(put.statusCode, put.body).toBe(204);
      await w.relogin('team-admin');
      const before = await userCount();
      const r = await post('team-admin', '/v1/users', {
        email: 'x@example.org',
        displayName: 'X',
        password: PW,
        globalRoles: ['admin'],
      });
      expect(r.statusCode).toBe(403);
      expect(await userCount()).toBe(before);
      const p = await w.req('team-admin', 'PATCH', `/v1/users/${w.uid['grantee']}`, {
        globalRoles: ['admin'],
      });
      expect(p.statusCode).toBe(403);
      expect((await post('team-admin', '/v1/teams', { slug: 'red', name: 'R' })).statusCode).toBe(
        403,
      );
    });
  });

  describe('use-case bindings and agents of a team', () => {
    const teamSource = (name: string, uc: string | null, version = '1.0.0') =>
      agentSource(name, 'blue', version, uc ? `labels:\n  useCase: ${uc}` : '');
    it('read and approve, but neither write, publish, run nor cancel', async () => {
      const admin = { ...w.op(), tenantId: w.id['org-a']! };
      const a = await w.n.services.agents.create(admin, teamSource('t-agent', 'sec'));
      await w.n.services.agents.publish(admin, a.id);
      const run = await w.n.services.runs.enqueue({
        agentId: a.id,
        event: {
          specversion: '1.0',
          id: 'e1',
          source: '/t',
          type: 'io.openagentix.manual',
          data: null,
        } as never,
        triggeredBy: 'manual:test',
      });
      expect((await w.req('uc-eng', 'GET', `/v1/agents/${a.id}`)).statusCode).toBe(200);
      expect((await w.req('uc-eng', 'GET', `/v1/runs/${run.id}`)).statusCode).toBe(200);
      const draft = await w.req('uc-eng', 'PUT', `/v1/agents/${a.id}/draft`, {
        source: teamSource('t-agent', 'sec'),
      });
      expect(draft.statusCode).toBe(403);
      expect((await w.req('uc-eng', 'POST', `/v1/agents/${a.id}/publish`)).statusCode).toBe(403);
      expect((await w.req('uc-eng', 'POST', `/v1/agents/${a.id}/dry-run`, {})).statusCode).toBe(
        403,
      );
      expect(
        (await w.req('uc-oper', 'POST', `/v1/agents/${a.id}/runs`, { data: {} })).statusCode,
      ).toBe(403);
      expect((await w.req('uc-oper', 'POST', `/v1/runs/${run.id}/cancel`, {})).statusCode).toBe(
        404, // the run of a team agent is not visible to a use-case cancel
      );
      w.agent['t-agent'] = a.id;
    });

    it('cannot be relabelled into a use case by a team writer; node-level authority can', async () => {
      await w.mkUser('team-eng', 'org-a');
      await w.n.ctx.db
        .insert(teamMembers)
        .values({ teamId: w.id['blue']!, userId: w.uid['team-eng']!, role: 'agent-engineer' });
      await w.relogin('team-eng');
      const a = w.agent['t-agent']!;
      const stay = await w.req('team-eng', 'PUT', `/v1/agents/${a}/draft`, {
        source: teamSource('t-agent', 'sec'),
      });
      expect(stay.statusCode, stay.body).toBe(200);
      const moved = await w.req('team-eng', 'PUT', `/v1/agents/${a}/draft`, {
        source: teamSource('t-agent', 'ops'),
      });
      expect(moved.statusCode).toBe(403);
      expect(moved.json().message).toContain('node-level');
      const draft = await w.req(
        null,
        'PUT',
        `/v1/agents/${a}/draft`,
        { source: teamSource('t-agent', 'ops', '1.1.0') },
        'org-a',
      );
      expect(draft.statusCode, draft.body).toBe(200);
      const ok = await w.req(null, 'POST', `/v1/agents/${a}/publish`, undefined, 'org-a');
      expect(ok.statusCode, ok.body).toBe(201);
      expect((await w.n.ctx.db.select().from(agents).where(eq(agents.id, a)))[0]!.useCase).toBe(
        'ops',
      );
    });
  });

  describe('node limits and cost labels', () => {
    it('hides the budget and secret references of the node from a use-case caller', async () => {
      await w.req(null, 'PATCH', `/v1/tenants/${w.id['org-a']}`, {
        monthlyBudgetUsd: 100,
        secretRefs: ['org-a.*'],
      });
      const own = (await w.req('root-admin', 'GET', `/v1/tenants/${w.id['org-a']}`)).json();
      expect(own.monthlyBudgetUsd).toBe(100);
      const r = (await w.req('uc-sec', 'GET', `/v1/tenants/${w.id['org-a']}`)).json();
      expect(r.monthlyBudgetUsd).toBeNull();
      expect(r.secretRefs).toEqual([]);
      const list = (await w.req('uc-sec', 'GET', '/v1/tenants')).json().items as {
        id: string;
        monthlyBudgetUsd: number | null;
      }[];
      expect(list.find((t) => t.id === w.id['org-a'])!.monthlyBudgetUsd).toBeNull();
    });

    it('hides the name of an agent that moved to another use case from the cost summary', async () => {
      const a = w.agent['a-sec']!;
      let n = 0;
      const names = async () =>
        (
          (await w.req('uc-sec', 'GET', `/v1/costs/summary?groupBy=agent&limit=${50 + n++}`)).json()
            .items as {
            key: string;
            label: string | null;
          }[]
        )
          .filter((x) => x.key === a)
          .map((x) => x.label);
      expect(await names()).toEqual(['a-sec']);
      await w.n.ctx.db.update(agents).set({ useCase: 'ops' }).where(eq(agents.id, a));
      expect((await names()).every((l) => l === null)).toBe(true);
      await w.n.ctx.db.update(agents).set({ useCase: 'sec' }).where(eq(agents.id, a));
    });
  });
});
