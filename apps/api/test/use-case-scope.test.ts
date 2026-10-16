import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agents, approvals, runs } from '../src/db/schema.js';
import { sqlTargets } from './db-targets.js';
import { buildWorld, type World } from './use-case-world.js';

/**
 * ADR 0014 slice S8 (#193): the service walk. A use-case administrator reads, changes and exports
 * only what carries its use case (or a sub-use case): agents, their versions and members, runs and
 * their steps and streams, approvals, events, costs (summary and export), budgets and audit
 * entries, in the node of the binding and with `scope=subtree`. Everything outside is a plain 404
 * (the same body as an id that does not exist) or absent from the list; aggregates and their
 * caches never mix scopes.
 */
describe.each(sqlTargets)('use-case scope in the services (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let w: World;
  const get = (who: string, url: string, acting?: string) =>
    w.req(who, 'GET', url, undefined, acting);
  const names = (r: { json: () => unknown }) =>
    ((r.json() as { items: { name: string }[] }).items ?? []).map((a) => a.name).sort();
  /** A hidden object answers exactly like one that does not exist. */
  const hidden = async (
    who: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
  ) => {
    const real = await w.req(who, method, url, body);
    const fake = await w.req(
      who,
      method,
      url.replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
        '00000000-0000-4000-8000-0000000000ff',
      ),
      body,
    );
    expect([real.statusCode, real.json().error, real.json().message], url).toEqual([
      fake.statusCode,
      fake.json().error,
      fake.json().message,
    ]);
    return real.statusCode;
  };

  beforeAll(async () => {
    w = await buildWorld(await open());
    await w.bind('uc-sec', 'org-a', 'admin', { inherit: true, useCase: 'sec' });
    await w.bind('uc-ops', 'org-a', 'admin', { useCase: 'ops' });
    await w.bind('uc-appsec', 'org-a', 'viewer', { useCase: 'sec/appsec' });
    await w.bind('uc-eng', 'org-a', 'agent-maintainer', { useCase: 'sec' });
    await w.bind('uc-oper', 'org-a', 'operator', { useCase: 'sec' });
    for (const k of ['uc-sec', 'uc-ops', 'uc-appsec', 'uc-eng', 'uc-oper']) await w.relogin(k);
  }, 240_000);
  afterAll(async () => w?.close());

  describe('agents', () => {
    it('lists only the agents of the use case and its sub-use cases', async () => {
      expect(names(await get('uc-sec', '/v1/agents'))).toEqual(['a-appsec', 'a-sec']);
      expect(names(await get('uc-appsec', '/v1/agents'))).toEqual(['a-appsec']);
      expect(names(await get('uc-ops', '/v1/agents'))).toEqual(['a-ops']);
      // the same words with other characters are another use case
      expect(names(await get('viewer', '/v1/agents'))).toEqual([
        'a-appsec',
        'a-none',
        'a-ops',
        'a-sec',
        'a-secure',
      ]);
    });

    it('only narrows with filters, never widens', async () => {
      for (const q of [
        'useCase=ops',
        'useCase=secure',
        'q=ops',
        'status=draft',
        'teamId=00000000-0000-4000-8000-000000000001',
      ])
        expect(names(await get('uc-sec', `/v1/agents?${q}`)), q).toEqual([]);
      expect(names(await get('uc-sec', '/v1/agents?useCase=sec/appsec'))).toEqual(['a-appsec']);
      expect(names(await get('uc-sec', '/v1/agents?q=a-'))).toEqual(['a-appsec', 'a-sec']);
    });

    it('answers a hidden agent like a missing one, on every route of the agent', async () => {
      for (const key of ['a-ops', 'a-secure', 'a-none', 'a-u2', 'a-b', 'a-u1']) {
        const a = w.agent[key]!;
        for (const [m, url] of [
          ['GET', `/v1/agents/${a}`],
          ['GET', `/v1/agents/${a}/versions`],
          ['GET', `/v1/agents/${a}/versions/1.0.0`],
          ['GET', `/v1/agents/${a}/members`],
        ] as const)
          expect(await hidden('uc-sec', m, url), `${key} ${url}`).toBe(404);
        expect(await hidden('uc-sec', 'POST', `/v1/agents/${a}/runs`, { data: {} }), key).toBe(404);
        for (const [m, url] of [
          ['POST', `/v1/agents/${a}/disable`],
          ['POST', `/v1/agents/${a}/enable`],
          ['POST', `/v1/agents/${a}/publish`],
          ['POST', `/v1/agents/${a}/dry-run`],
        ] as const)
          expect(await hidden('uc-sec', m, url, {}), `${key} ${url}`).toBe(404);
        expect(await hidden('uc-sec', 'PUT', `/v1/agents/${a}/draft`, { source: 'x' }), key).toBe(
          404,
        );
      }
      for (const key of ['a-sec', 'a-appsec'])
        expect((await get('uc-sec', `/v1/agents/${w.agent[key]}`)).statusCode).toBe(200);
      // the sub-use-case viewer does not see the parent use case's agent
      expect((await get('uc-appsec', `/v1/agents/${w.agent['a-sec']}`)).statusCode).toBe(404);
    });

    it('carries the use case, not a wide budget, into the summary', async () => {
      const r = await get('uc-sec', `/v1/agents/${w.agent['a-sec']}`);
      expect(r.json().useCase).toBe('sec');
      // spend is visible through costs:read of the use case (admin role carries it)
      expect(r.json().monthSpendUsd).toBe(1);
    });
  });

  describe('runs and approvals', () => {
    const ids = (r: { json: () => unknown }) =>
      ((r.json() as { items: { id: string }[] }).items ?? []).map((x) => x.id).sort();
    const idsOf = (keys: string[], from: Record<string, string>) =>
      keys.map((k) => from[k]!).sort();

    it('lists the runs and approvals of the use case only', async () => {
      expect(ids(await get('uc-sec', '/v1/runs'))).toEqual(idsOf(['a-sec', 'a-appsec'], w.run));
      expect(ids(await get('uc-appsec', '/v1/runs'))).toEqual(idsOf(['a-appsec'], w.run));
      expect(ids(await get('uc-ops', '/v1/runs'))).toEqual(idsOf(['a-ops'], w.run));
      expect(ids(await get('uc-sec', '/v1/approvals'))).toEqual(
        idsOf(['a-sec', 'a-appsec'], w.approval),
      );
      expect(ids(await get('uc-ops', '/v1/approvals'))).toEqual(idsOf(['a-ops'], w.approval));
      expect(ids(await get('viewer', '/v1/runs'))).toHaveLength(5);
      // filters narrow
      expect(ids(await get('uc-sec', `/v1/runs?agentId=${w.agent['a-ops']}`))).toEqual([]);
      expect(ids(await get('uc-sec', `/v1/approvals?runId=${w.run['a-ops']}`))).toEqual([]);
    });

    it('counts only the runs of the use case in the stats', async () => {
      expect((await get('uc-sec', '/v1/stats/runs')).json().total).toBe(2);
      expect((await get('uc-ops', '/v1/stats/runs')).json().total).toBe(1);
      expect((await get('viewer', '/v1/stats/runs')).json().total).toBe(5);
      expect((await get('uc-sec', `/v1/stats/runs?agentId=${w.agent['a-ops']}`)).json().total).toBe(
        0,
      );
    });

    it('answers a hidden run like a missing one: detail, steps, stream and stream token', async () => {
      for (const key of ['a-ops', 'a-secure', 'a-none', 'a-u2']) {
        const r = w.run[key]!;
        for (const [m, url] of [
          ['GET', `/v1/runs/${r}`],
          ['GET', `/v1/runs/${r}/steps`],
          ['GET', `/v1/runs/${r}/stream`],
          ['POST', `/v1/runs/${r}/stream-token`],
        ] as const)
          expect(await hidden('uc-sec', m, url, {}), `${key} ${url}`).toBe(404);
        expect(await hidden('uc-oper', 'POST', `/v1/runs/${r}/cancel`, {}), key).toBe(404);
      }
      const mine = w.run['a-sec']!;
      expect((await get('uc-sec', `/v1/runs/${mine}`)).statusCode).toBe(200);
      const steps = await get('uc-sec', `/v1/runs/${mine}/steps`);
      expect(steps.statusCode, steps.body).toBe(200);
      expect(steps.json().items).toHaveLength(1);
      const tok = await w.req('uc-sec', 'POST', `/v1/runs/${mine}/stream-token`, {});
      expect(tok.statusCode).toBe(201);
      // the stream token carries the user: it cannot open a run outside the use case
      const other = await w.n.req({
        method: 'GET',
        url: `/v1/runs/${w.run['a-ops']}/stream?access_token=${tok.json().token}`,
        token: null,
      });
      expect(other.statusCode).toBeGreaterThanOrEqual(401);
    });

    it('decides only approvals of the use case, with a role the approval accepts', async () => {
      // not in the use case
      expect(
        await hidden('uc-oper', 'POST', `/v1/approvals/${w.approval['a-ops']}/decision`, {
          decision: 'approve',
        }),
      ).toBe(404);
      // a role without runs:approve cannot even reach the route
      for (const who of ['uc-appsec', 'uc-eng'])
        expect(
          (
            await w.req(who, 'POST', `/v1/approvals/${w.approval['a-sec']}/decision`, {
              decision: 'approve',
            })
          ).statusCode,
          who,
        ).toBe(403);
      // an approval that only an admin may decide
      await w.n.ctx.db
        .update(approvals)
        .set({ approverRoles: ['admin'] })
        .where(eq(approvals.id, w.approval['a-appsec']!));
      const operator = await w.req(
        'uc-oper',
        'POST',
        `/v1/approvals/${w.approval['a-appsec']}/decision`,
        {
          decision: 'approve',
        },
      );
      expect(operator.statusCode).toBe(403);
      const admin = await w.req(
        'uc-sec',
        'POST',
        `/v1/approvals/${w.approval['a-appsec']}/decision`,
        {
          decision: 'approve',
        },
      );
      expect(admin.statusCode, admin.body).toBe(200);
      // the admin of another use case has the role but not the use case
      expect(
        (
          await w.req('uc-ops', 'POST', `/v1/approvals/${w.approval['a-sec']}/decision`, {
            decision: 'reject',
          })
        ).statusCode,
      ).toBe(404);
      const own = await w.req('uc-oper', 'POST', `/v1/approvals/${w.approval['a-sec']}/decision`, {
        decision: 'approve',
      });
      expect(own.statusCode, own.body).toBe(200);
      const [row] = await w.n.ctx.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, w.approval['a-ops']!));
      expect(row!.status).toBe('pending');
    });

    it('triggers runs only for agents of the use case', async () => {
      const ok = await w.req('uc-oper', 'POST', `/v1/agents/${w.agent['a-sec']}/runs`, {
        data: {},
      });
      expect(ok.statusCode, ok.body).toBe(202);
      const rows = await w.n.ctx.db.select().from(runs).where(eq(runs.agentId, w.agent['a-ops']!));
      const before = rows.length;
      expect(
        (await w.req('uc-oper', 'POST', `/v1/agents/${w.agent['a-ops']}/runs`, { data: {} }))
          .statusCode,
      ).toBe(404);
      expect(
        (await w.n.ctx.db.select().from(runs).where(eq(runs.agentId, w.agent['a-ops']!))).length,
      ).toBe(before);
    });
    it('streams a finished run of the use case and nothing outside it', async () => {
      const cancel = await w.req('uc-oper', 'POST', `/v1/runs/${w.run['a-sec']}/cancel`, {});
      expect(cancel.statusCode, cancel.body).toBe(200);
      const s = await get('uc-sec', `/v1/runs/${w.run['a-sec']}/stream`);
      expect(s.statusCode).toBe(200);
      expect(s.body).toContain('event: end');
      expect(s.body).toContain('step of a-sec');
      expect((await get('uc-sec', `/v1/runs/${w.run['a-ops']}/stream`)).statusCode).toBe(404);
    });
  });

  describe('costs and budgets', () => {
    const keys = (r: { json: () => unknown }) =>
      ((r.json() as { items: { key: string | null }[] }).items ?? []).map((x) => x.key).sort();
    const total = (r: { json: () => unknown }) =>
      ((r.json() as { items: { costUsd: number }[] }).items ?? []).reduce(
        (s, x) => s + x.costUsd,
        0,
      );

    it('aggregates only the use case, in every grouping, whatever was cached before', async () => {
      // the wide aggregate first: its cache entry must not serve a narrower caller
      const wide = await get('viewer', '/v1/costs/summary?groupBy=use_case');
      expect(keys(wide)).toEqual([null, 'ops', 'sec', 'sec/appsec', 'secure'].sort());
      const mine = await get('uc-sec', '/v1/costs/summary?groupBy=use_case');
      expect(keys(mine)).toEqual(['sec', 'sec/appsec']);
      expect(keys(await get('uc-appsec', '/v1/costs/summary?groupBy=use_case'))).toEqual([
        'sec/appsec',
      ]);
      expect(keys(await get('uc-ops', '/v1/costs/summary?groupBy=use_case'))).toEqual(['ops']);
      for (const g of ['agent', 'run', 'month', 'provider', 'model', 'team', 'tenant']) {
        const r = await get('uc-sec', `/v1/costs/summary?groupBy=${g}`);
        expect(r.statusCode, g).toBe(200);
        expect(total(r), g).toBe(2);
      }
      const agentsOf = (await get('uc-sec', '/v1/costs/summary?groupBy=agent')).json().items as {
        key: string;
      }[];
      expect(agentsOf.map((x) => x.key).sort()).toEqual(
        [w.agent['a-sec']!, w.agent['a-appsec']!].sort(),
      );
      // and the other way round, after the narrow one was cached
      expect(keys(await get('viewer', '/v1/costs/summary?groupBy=use_case'))).toEqual(keys(wide));
    });

    it('exports only the use case (CSV and JSON)', async () => {
      const json = await get('uc-sec', '/v1/costs/export?format=json');
      const lines = (json.json() as { items: { useCase: string | null; agentId: string }[] }).items;
      expect(lines.map((l) => l.useCase).sort()).toEqual(['sec', 'sec/appsec']);
      const csv = await get('uc-sec', '/v1/costs/export?format=csv');
      expect(csv.statusCode).toBe(200);
      expect(csv.body).not.toContain(w.agent['a-ops']!);
      expect(csv.body).not.toContain('a-ops');
      expect(csv.body).toContain(w.agent['a-sec']!);
      expect((await get('uc-ops', '/v1/costs/export?format=csv')).body).not.toContain('a-sec');
    });

    it('shows the limits and spend of the use case and nothing of the node', async () => {
      for (const [uc, usd] of [
        ['sec', 10],
        ['ops', 20],
        ['sec/appsec', 5],
        ['secure', 7],
      ] as const) {
        const r = await w.req(
          null,
          'PUT',
          `/v1/budgets/use-cases/${encodeURIComponent(uc)}`,
          { monthlyBudgetUsd: usd },
          'org-a',
        );
        expect(r.statusCode, r.body).toBe(204);
      }
      const wide = (await get('viewer', '/v1/budgets')).json();
      expect(wide.useCases.map((b: { key: string }) => b.key).sort()).toEqual([
        'ops',
        'sec',
        'sec/appsec',
        'secure',
      ]);
      const mine = (await get('uc-sec', '/v1/budgets')).json();
      expect(mine.useCases.map((b: { key: string }) => b.key)).toEqual(['sec', 'sec/appsec']);
      expect(mine.teams).toEqual([]);
      expect(mine.tenant).toMatchObject({ limitUsd: null, spentUsd: 2, alerts: [] });
      // a budget of the wider use case covers spend this caller cannot see
      const sub = (await get('uc-appsec', '/v1/budgets')).json();
      expect(sub.useCases.map((b: { key: string }) => b.key)).toEqual(['sec/appsec']);
      expect(sub.tenant.spentUsd).toBe(1);
      const ops = (await get('uc-ops', '/v1/budgets')).json();
      expect(ops.useCases.map((b: { key: string }) => b.key)).toEqual(['ops']);
    });
  });

  describe('events', () => {
    const ev = (r: { json: () => unknown }) =>
      ((r.json() as { items: { id: string }[] }).items ?? []).map((x) => x.id).sort();

    it('lists the events of the sources of the use case and nothing without an agent', async () => {
      expect(ev(await get('uc-sec', '/v1/events'))).toEqual(
        [w.event['a-sec']!, w.event['a-appsec']!].sort(),
      );
      expect(ev(await get('uc-ops', '/v1/events'))).toEqual([w.event['a-ops']!]);
      // node-wide readers: the events of every source, the sourceless and the agentless ones
      expect((ev(await get('viewer', '/v1/events')) as string[]).length).toBeGreaterThanOrEqual(7);
      expect(ev(await get('uc-sec', `/v1/events?sourceId=${w.source['a-ops']}`))).toEqual([]);
      expect(ev(await get('uc-sec', `/v1/events?sourceId=${w.source['none']}`))).toEqual([]);
    });

    it('answers a hidden event like a missing one', async () => {
      for (const key of ['a-ops', 'a-secure', 'a-none', 'free', 'no-agent'])
        expect(await hidden('uc-sec', 'GET', `/v1/events/${w.event[key]}`), key).toBe(404);
      expect((await get('uc-sec', `/v1/events/${w.event['a-sec']}`)).statusCode).toBe(200);
    });
  });

  describe('audit', () => {
    it('shows and exports only entries about the agents and runs of the use case', async () => {
      const allAgents = await w.n.ctx.db.select().from(agents);
      const mineAgents = new Set(
        allAgents
          .filter((a) => a.useCase === 'sec' || a.useCase?.startsWith('sec/'))
          .map((a) => a.id),
      );
      const nameOf = new Map(allAgents.map((a) => [a.id, `${a.name}/${a.useCase}`]));
      const allRuns = await w.n.ctx.db.select().from(runs);
      const mineRuns = new Set(allRuns.filter((r) => mineAgents.has(r.agentId)).map((r) => r.id));
      const list = await get('uc-sec', '/v1/audit?limit=200');
      expect(list.statusCode, list.body).toBe(200);
      const items = list.json().items as {
        target: string | null;
        runId: string | null;
        action: string;
      }[];
      expect(items.length).toBeGreaterThan(0);
      for (const e of items)
        expect(
          (e.target !== null && mineAgents.has(e.target)) ||
            (e.runId !== null && mineRuns.has(e.runId)),
          JSON.stringify(e) +
            ` run of ${nameOf.get(allRuns.find((r) => r.id === e.runId)?.agentId ?? '')}`,
        ).toBe(true);
      const all = (await get('root-admin', '/v1/audit?limit=200')).json().items as unknown[];
      expect(all.length).toBeGreaterThan(items.length);
      const exp = await get('uc-sec', '/v1/audit/export');
      expect(exp.statusCode).toBe(200);
      const lines = exp.body
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { target: string | null; runId: string | null });
      expect(lines.length).toBeGreaterThan(0);
      for (const e of lines)
        expect(
          (e.target !== null && mineAgents.has(e.target)) ||
            (e.runId !== null && mineRuns.has(e.runId)),
        ).toBe(true);
      // a filter cannot reach the others
      expect((await get('uc-sec', `/v1/audit?runId=${w.run['a-ops']}`)).json().items).toEqual([]);
      expect((await get('uc-sec', `/v1/audit/export?runId=${w.run['a-ops']}`)).body).toBe('');
    });

    it('refuses the whole chain, the checkpoints and other tenants', async () => {
      expect((await w.req('uc-sec', 'POST', '/v1/audit/verify', {})).statusCode).toBe(403);
      expect((await get('uc-sec', '/v1/audit/checkpoints')).statusCode).toBe(403);
      expect((await get('uc-sec', '/v1/audit?allTenants=true')).statusCode).toBe(403);
      expect((await get('uc-sec', '/v1/audit/export?allTenants=true')).statusCode).toBe(403);
      // a viewer-like role of the use case has no audit permission at all
      expect((await get('uc-appsec', '/v1/audit')).statusCode).toBe(403);
    });

    it('records the denials of a use-case caller in its partition without leaking the owner', async () => {
      await get('uc-sec', `/v1/runs/${w.run['a-ops']}`);
      const mine = (await get('uc-sec', '/v1/audit?limit=200')).json().items as {
        action: string;
        target: string | null;
      }[];
      // the denial names the run the caller asked for; the run belongs to the other use case, and its
      // administrator sees the denial (they own the object that was probed)
      const theirs = (await get('uc-ops', '/v1/audit?limit=200')).json().items as {
        action: string;
        target: string | null;
      }[];
      expect(theirs.some((e) => e.action === 'access.denied' && e.target === w.run['a-ops'])).toBe(
        true,
      );
      expect(mine.some((e) => e.action === 'access.denied' && e.target === w.run['a-ops'])).toBe(
        false,
      );
    });
  });

  describe('locate', () => {
    it('answers for the resources of the use case and 404s for all others alike', async () => {
      expect((await get('uc-sec', `/v1/locate/agent/${w.agent['a-sec']}`)).statusCode).toBe(200);
      expect((await get('uc-sec', `/v1/locate/run/${w.run['a-appsec']}`)).statusCode).toBe(200);
      expect((await get('uc-sec', `/v1/locate/approval/${w.approval['a-sec']}`)).statusCode).toBe(
        200,
      );
      const miss = await get('uc-sec', '/v1/locate/agent/00000000-0000-4000-8000-0000000000ff');
      for (const [kind, id] of [
        ['agent', w.agent['a-ops']],
        ['run', w.run['a-ops']],
        ['approval', w.approval['a-ops']],
        ['agent', w.agent['a-u2']],
        ['event-source', w.source['a-sec']],
      ] as const) {
        const r = await get('uc-sec', `/v1/locate/${kind}/${id}`);
        expect([r.statusCode, r.json()], `${kind}`).toEqual([miss.statusCode, miss.json()]);
      }
    });
  });

  describe('writes stay inside the use case', () => {
    const source = (name: string, uc: string | null, owner = 'nobody') =>
      `---\napiVersion: openagentix.io/v1alpha1\nkind: Agent\nname: ${name}\nversion: 1.0.0\nowner: ${owner}\n${
        uc ? `labels:\n  useCase: ${uc}\n` : ''
      }agents:\n  - id: a\n    provider: simulated\n    model: sim-1\n    instructions: Summarise the event.\n---\n`;

    it('creates agents of the use case that belong to no team, nothing else', async () => {
      const ok = await w.req('uc-eng', 'POST', '/v1/agents', {
        source: source('n-sec', 'sec/new'),
      });
      expect(ok.statusCode, ok.body).toBe(201);
      for (const uc of ['ops', 'secure', null, 'se']) {
        const r = await w.req('uc-eng', 'POST', '/v1/agents', {
          source: source(`n-${uc ?? 'none'}`, uc),
        });
        expect(r.statusCode, String(uc)).toBe(403);
      }
      // a team brings its connections with it: not part of a use case
      const team = await w.req(null, 'POST', '/v1/teams', { slug: 'blue', name: 'Blue' }, 'org-a');
      expect(team.statusCode, team.body).toBe(201);
      const withTeam = await w.req('uc-eng', 'POST', '/v1/agents', {
        source: source('n-team', 'sec', 'blue'),
      });
      expect(withTeam.statusCode).toBe(403);
      // an operator holds no agents:write
      expect(
        (await w.req('uc-oper', 'POST', '/v1/agents', { source: source('n-op', 'sec') }))
          .statusCode,
      ).toBe(403);
    });

    it('does not let a draft or a version leave the use case', async () => {
      const a = w.agent['a-sec']!;
      const stay = await w.req('uc-eng', 'PUT', `/v1/agents/${a}/draft`, {
        source: source('a-sec', 'sec/moved'),
      });
      expect(stay.statusCode, stay.body).toBe(200);
      for (const uc of ['ops', 'secure', null]) {
        const r = await w.req('uc-eng', 'PUT', `/v1/agents/${a}/draft`, {
          source: source('a-sec', uc),
        });
        expect(r.statusCode, String(uc)).toBe(403);
      }
      // a draft that was labelled elsewhere by someone with more authority is not published by them
      await w.n.services.agents.updateDraft(
        { ...w.op(), tenantId: w.id['org-a']! },
        a,
        source('a-sec', 'ops'),
      );
      const pub = await w.req('uc-eng', 'POST', `/v1/agents/${a}/publish`);
      expect(pub.statusCode).toBe(403);
      expect(pub.json().message).toContain('outside your scope');
      await w.n.services.agents.updateDraft(
        { ...w.op(), tenantId: w.id['org-a']! },
        a,
        source('a-sec', 'sec'),
      );
      expect((await w.req('uc-eng', 'POST', `/v1/agents/${a}/publish`)).statusCode).toBe(200);
      expect(names(await get('uc-sec', '/v1/agents'))).toContain('a-sec');
    });

    it('disables and enables within the use case', async () => {
      const a = w.agent['a-appsec']!;
      expect((await w.req('uc-eng', 'POST', `/v1/agents/${a}/disable`, {})).statusCode).toBe(200);
      expect((await w.req('uc-eng', 'POST', `/v1/agents/${a}/enable`, {})).statusCode).toBe(200);
      // roles without agents:publish
      expect((await w.req('uc-oper', 'POST', `/v1/agents/${a}/disable`, {})).statusCode).toBe(403);
    });
  });

  describe('scope=subtree', () => {
    it('keeps a use-case binding on its node: the same use case elsewhere is not covered', async () => {
      const r = await get('uc-sec', '/v1/agents?scope=subtree');
      expect(r.statusCode, r.body).toBe(200);
      expect(names(r)).toEqual(['a-appsec', 'a-sec', 'n-sec']);
      expect(names(await get('uc-sec', '/v1/agents?scope=subtree&tenantId=unit-2'))).toEqual([]);
    });

    it('applies the filter to runs, approvals, costs, budgets, events and audit too', async () => {
      const runsOf = async (who: string) =>
        ((await get(who, '/v1/runs?scope=subtree&limit=200')).json().items as { id: string }[]).map(
          (x) => x.id,
        );
      const mine = await runsOf('uc-sec');
      expect(mine).toContain(w.run['a-sec']);
      expect(mine).not.toContain(w.run['a-ops']);
      expect(mine).not.toContain(w.run['a-u2']);
      const ap = (await get('uc-sec', '/v1/approvals?scope=subtree&status=approved')).json()
        .items as { runId: string }[];
      expect(ap.every((a) => [w.run['a-sec'], w.run['a-appsec']].includes(a.runId))).toBe(true);
      const costs = await get('uc-sec', '/v1/costs/summary?scope=subtree&groupBy=use_case');
      expect((costs.json().items as { key: string }[]).map((x) => x.key).sort()).toEqual([
        'sec',
        'sec/appsec',
      ]);
      const tenantCosts = await get('uc-sec', '/v1/costs/summary?scope=subtree&groupBy=tenant');
      expect((tenantCosts.json().items as { key: string }[]).map((x) => x.key)).toEqual([
        w.id['org-a'],
      ]);
      const budgets = (await get('uc-sec', '/v1/budgets?scope=subtree')).json();
      const nodes = budgets.nodes as {
        node: { id: string };
        tenant: { limitUsd: number | null };
        teams: unknown[];
        useCases: { key: string }[];
      }[];
      expect(nodes.map((x) => x.node.id)).toEqual([w.id['org-a']]);
      expect(nodes[0]!.tenant.limitUsd).toBeNull();
      expect(nodes[0]!.teams).toEqual([]);
      expect(nodes[0]!.useCases.map((b) => b.key)).toEqual(['sec', 'sec/appsec']);
      const ev = (await get('uc-sec', '/v1/events?scope=subtree')).json().items as { id: string }[];
      expect(ev.map((e) => e.id).sort()).toEqual([w.event['a-sec']!, w.event['a-appsec']!].sort());
      const audit = (await get('uc-sec', '/v1/audit?scope=subtree&limit=200')).json().items as {
        target: string | null;
        runId: string | null;
      }[];
      for (const e of audit)
        expect(e.target === w.agent['a-ops'] || e.runId === w.run['a-ops']).toBe(false);
      expect(audit.length).toBeGreaterThan(0);
    });

    it('adds an attached node and its subtree, unrestricted, and removes it again', async () => {
      expect(
        (
          await w.req('root-admin', 'PATCH', `/v1/tenants/${w.id['unit-2']}`, {
            useCase: 'sec/appsec',
          })
        ).statusCode,
      ).toBe(200);
      const attached = names(await get('uc-sec', '/v1/agents?scope=subtree'));
      expect(attached).toContain('a-u2');
      expect(attached).not.toContain('a-ops');
      const tenantCosts = (
        await get('uc-sec', '/v1/costs/summary?scope=subtree&groupBy=tenant')
      ).json().items as { key: string }[];
      expect(tenantCosts.map((x) => x.key).sort()).toEqual(
        [w.id['org-a']!, w.id['unit-2']!].sort(),
      );
      expect(
        (await w.req('root-admin', 'PATCH', `/v1/tenants/${w.id['unit-2']}`, { useCase: null }))
          .statusCode,
      ).toBe(200);
      expect(names(await get('uc-sec', '/v1/agents?scope=subtree'))).not.toContain('a-u2');
    });
  });

  describe('people without a use case, tokens and the legacy read path', () => {
    it('keeps a user with no binding out of everything', async () => {
      for (const url of [
        '/v1/agents',
        '/v1/runs',
        '/v1/approvals',
        '/v1/events',
        '/v1/costs/summary',
        '/v1/budgets',
        '/v1/audit',
      ])
        expect((await get('uc-none', url)).statusCode, url).toBe(403);
    });

    it('applies the scopes of a token to the use cases', async () => {
      const p = await w.n.services.identity.authenticate(w.tok['uc-sec']!);
      const t = await w.n.services.identity.createApiToken(p, 'runs only', ['runs:read'], 30);
      const asToken = (url: string) => w.n.req({ method: 'GET', url, token: t.token });
      expect((await asToken('/v1/runs')).statusCode).toBe(200);
      expect(((await asToken('/v1/runs')).json().items as unknown[]).length).toBe(
        ((await get('uc-sec', '/v1/runs')).json().items as unknown[]).length,
      );
      for (const url of ['/v1/agents', '/v1/costs/summary', '/v1/events', '/v1/audit'])
        expect((await asToken(url)).statusCode, url).toBe(403);
    });

    it('keeps the node-wide viewer exactly as before', async () => {
      expect(names(await get('viewer', '/v1/agents'))).toContain('a-ops');
      expect((await get('viewer', `/v1/agents/${w.agent['a-ops']}`)).statusCode).toBe(200);
      expect((await get('viewer', '/v1/budgets')).statusCode).toBe(200);
    });
  });
});

/** The legacy read path decides from the global roles: a use-case binding does nothing there. */
describe.each(sqlTargets)(
  'use-case bindings on the legacy read path (%s)',
  (_kind, enabled, open) => {
    if (!enabled()) {
      it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
      return;
    }
    let w: World;
    beforeAll(async () => {
      w = await buildWorld(await open(), { OAX_ROLE_BINDINGS_READ: 'legacy' });
      await w.bind('uc-sec', 'org-a', 'admin', { inherit: true, useCase: 'sec' });
      await w.relogin('uc-sec');
    }, 240_000);
    afterAll(async () => w?.close());

    it('gives a use-case binding no effect, and refuses to create one', async () => {
      for (const url of ['/v1/agents', '/v1/runs', '/v1/costs/summary'])
        expect((await w.req('uc-sec', 'GET', url)).statusCode, url).toBe(403);
      const r = await w.req(null, 'POST', `/v1/tenants/${w.id['org-a']}/role-bindings`, {
        userId: w.uid['grantee'],
        role: 'viewer',
        inherit: false,
        useCase: 'sec',
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('use_case_requires_bindings_read');
    });
  },
);
