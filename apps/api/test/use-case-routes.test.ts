import { randomUUID } from 'node:crypto';
import { type Principal } from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, routeIndex } from '../src/http/app.js';
import {
  USE_CASE_POLICY,
  routeAllows,
  routeKey,
  staleDecisions,
  undeclaredRoutes,
} from '../src/http/use-case-policy.js';
import { tenantRoleBindings } from '../src/db/schema.js';
import { sqlTargets } from './db-targets.js';
import { buildWorld, type World } from './use-case-world.js';

/**
 * ADR 0014 slice S8 (#193): the fail-closed route table. Every route that serves a signed-in
 * principal declares what it does with a use-case administrator; a route that is added without that
 * decision fails here (and is refused for use-case administrators at run time). The walk then calls
 * every route that is declared `scoped` as the administrator of another use case, aimed at objects
 * of a use case that is not its own, and looks for any trace of them in the answer.
 */
const userOf = (bindings: Principal['bindings']): Principal => ({
  kind: 'user',
  userId: 'u',
  tenantId: 't',
  platformAdmin: false,
  displayName: 'u',
  bindings,
});
const ucAdmin = userOf([{ role: 'admin', teamId: null, useCase: 'sec' }]);

describe('the use-case policy of a route', () => {
  it('refuses a route that has no decision, for every access class', () => {
    const empty = {};
    for (const access of [
      'agents:read',
      'runs:read',
      'costs:read',
      'audit:read',
      'authenticated',
    ] as const)
      expect(routeAllows(ucAdmin, access, 'GET', '/v1/brand-new-thing', empty), access).toBe(false);
    // a node-wide viewer keeps a route that is simply not listed (nothing changes for them)
    const viewer = userOf([{ role: 'viewer', teamId: null }]);
    expect(routeAllows(viewer, 'runs:read', 'GET', '/v1/brand-new-thing', empty)).toBe(true);
    expect(routeAllows(viewer, 'authenticated', 'GET', '/v1/brand-new-thing', empty)).toBe(true);
  });

  it('opens a scoped route for the permission held through a use case, and only that', () => {
    const scoped = { 'GET /v1/x': 'scoped' as const, 'GET /v1/y': 'denied' as const };
    const ucViewer = userOf([
      {
        role: 'viewer',
        teamId: null,
        useCase: 'sec',
        permissions: ['agents:read', 'runs:read'],
      },
    ]);
    expect(routeAllows(ucViewer, 'runs:read', 'GET', '/v1/x', scoped)).toBe(true);
    expect(routeAllows(ucViewer, 'runs:read', 'GET', '/v1/y', scoped)).toBe(false);
    expect(routeAllows(ucViewer, 'audit:read', 'GET', '/v1/x', scoped)).toBe(false);
    expect(routeAllows(ucViewer, 'connections:read', 'GET', '/v1/x', scoped)).toBe(false);
  });

  it('finds routes without a decision and decisions without a route', () => {
    const routes = [
      { method: 'GET', url: '/v1/agents', access: 'agents:read' },
      { method: 'GET', url: '/v1/new', access: 'runs:read' },
      { method: 'POST', url: '/v1/new-auth', access: 'authenticated' },
      { method: 'GET', url: '/healthz', access: 'public' },
      { method: 'POST', url: '/v1/worker/runs/:id/steps', access: 'run-token' },
    ];
    expect(undeclaredRoutes(routes)).toEqual(['GET /v1/new', 'POST /v1/new-auth']);
    expect(
      staleDecisions(routes, { 'GET /v1/agents': 'scoped', 'GET /v1/gone': 'denied' }),
    ).toEqual(['GET /v1/gone']);
  });
});

describe.each(sqlTargets)('use-case decision of every route (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let w: World;
  let routes: { method: string; url: string; access: unknown }[];
  const binding: Record<string, string> = {};

  beforeAll(async () => {
    w = await buildWorld(await open());
    await w.bind('uc-ops', 'org-a', 'admin', { inherit: true, useCase: 'ops' });
    await w.bind('uc-sec', 'org-a', 'admin', { inherit: true, useCase: 'sec' });
    await w.relogin('uc-ops');
    await w.relogin('uc-sec');
    routes = routeIndex(w.n.app);
    const [b] = await w.n.ctx.db.select().from(tenantRoleBindings);
    binding.any = b!.id;
  }, 240_000);
  afterAll(async () => w?.close());

  it('has a decision for every route that serves a principal, and none for a route that is gone', () => {
    expect(undeclaredRoutes(routes)).toEqual([]);
    expect(staleDecisions(routes)).toEqual([]);
  });

  it('only knows the three decisions, and lists no public or token route', () => {
    for (const [key, policy] of Object.entries(USE_CASE_POLICY)) {
      expect(['scoped', 'denied', 'self'], key).toContain(policy);
      const route = routes.find((r) => routeKey(r.method, r.url) === key)!;
      expect(['public', 'run-token', 'model-token', 'webhook'], key).not.toContain(route.access);
      // a permission route is `scoped` only for a permission a use-case binding can carry
      if (policy === 'self') expect(route.access, key).toBe('authenticated');
    }
  });

  /** A concrete URL for a route, aimed at an object of the use case `sec` (not the caller's). */
  const concrete = (url: string, mine: boolean): string => {
    const key = mine ? 'a-ops' : 'a-sec';
    const kindOf = (path: string) =>
      path.startsWith('/v1/agents')
        ? w.agent[key]!
        : path.startsWith('/v1/runs')
          ? w.run[key]!
          : path.startsWith('/v1/approvals')
            ? w.approval[key]!
            : path.startsWith('/v1/events')
              ? w.event[key]!
              : path.startsWith('/v1/tenants')
                ? w.id['org-a']!
                : randomUUID();
    return url
      .replace('/:kind/:id', `/agent/${w.agent[key]}`)
      .replace(':bindingId', binding.any!)
      .replace(':version', '1.0.0')
      .replace(':id', kindOf(url));
  };

  /** Everything that belongs to the use case `sec` and its neighbours: it must not show up for `ops`. */
  const needles = (): string[] => {
    const out: string[] = [];
    for (const key of ['a-sec', 'a-appsec', 'a-secure', 'a-none', 'a-u1', 'a-u2', 'a-b']) {
      out.push(w.agent[key]!, w.run[key]!, w.approval[key]!, `"${key}"`);
      if (w.event[key]) out.push(w.event[key]!, w.source[key]!);
    }
    out.push(w.event['free']!, w.event['no-agent']!, 'uc-sec@example.org', 'sec/appsec');
    return out;
  };

  it('walks every scoped route as the administrator of another use case', async () => {
    const hits: string[] = [];
    const seen: string[] = [];
    for (const r of routes) {
      const key = routeKey(r.method, r.url);
      if (USE_CASE_POLICY[key] !== 'scoped') continue;
      seen.push(key);
      const url = concrete(r.url, false);
      const isRead = r.method === 'GET';
      const res = await w.req(
        'uc-ops',
        r.method as 'GET',
        url,
        isRead || r.method === 'DELETE' ? undefined : {},
      );
      // streams of a hidden object end at once; nothing is left open
      expect(res.statusCode, `${key} -> ${res.statusCode}`).toBeLessThan(500);
      if (!isRead) expect(res.statusCode, `${key} must refuse`).toBeGreaterThanOrEqual(400);
      const body = res.body;
      for (const needle of needles())
        if (body.includes(needle)) hits.push(`${key} shows ${needle}`);
    }
    expect(hits).toEqual([]);
    // the walk touched every decision it is supposed to
    expect(seen.length).toBe(Object.values(USE_CASE_POLICY).filter((p) => p === 'scoped').length);
    expect(seen.length).toBeGreaterThan(30);
  });

  it('refuses every denied route to a use-case administrator, before the handler runs', async () => {
    const wrong: string[] = [];
    for (const r of routes) {
      const key = routeKey(r.method, r.url);
      if (USE_CASE_POLICY[key] !== 'denied') continue;
      const res = await w.req(
        'uc-sec',
        r.method as 'GET',
        concrete(r.url, true).replace(':useCase', 'sec').replace(':scenario', 'x'),
        r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
      );
      if (res.statusCode !== 403) wrong.push(`${key} -> ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('answers the self routes without any trace of a use case that is not the callers', async () => {
    const hits: string[] = [];
    for (const r of routes) {
      const key = routeKey(r.method, r.url);
      if (USE_CASE_POLICY[key] !== 'self') continue;
      if (key === 'POST /v1/auth/logout') continue; // would end the session the other tests use
      const res = await w.req(
        'uc-ops',
        r.method as 'GET',
        concrete(r.url, true),
        r.method === 'POST' ? {} : undefined,
      );
      expect(res.statusCode, `${key} -> ${res.statusCode}`).toBeLessThan(500);
      for (const needle of needles())
        if (res.body.includes(needle)) hits.push(`${key} shows ${needle}`);
    }
    expect(hits).toEqual([]);
  });

  it('refuses a use-case administrator on every route that has no decision (the live hook)', async () => {
    // The same control node, with a registry that lost its entries: nothing is "scoped" any more,
    // so nothing may be open to a caller whose bindings are all limited to a use case, while a
    // node-wide viewer is not affected at all.
    const bare = await buildApp({ ctx: w.n.ctx, services: w.n.services, useCasePolicy: {} });
    try {
      const call = (who: string, url: string) =>
        bare.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${w.tok[who]}` },
        });
      for (const url of [
        '/v1/agents',
        '/v1/runs',
        '/v1/approvals',
        '/v1/events',
        '/v1/costs/summary',
        '/v1/budgets',
        '/v1/audit',
        '/v1/me',
        '/v1/tenants',
        '/v1/teams',
      ]) {
        const r = await call('uc-ops', url);
        expect(r.statusCode, `${url} ${r.body}`).toBe(403);
      }
      expect((await call('viewer', '/v1/agents')).statusCode).toBe(200);
      expect((await call('viewer', '/v1/me')).statusCode).toBe(200);
      // one entry brought back opens exactly that route
      const one = await buildApp({
        ctx: w.n.ctx,
        services: w.n.services,
        useCasePolicy: { 'GET /v1/agents': 'scoped' },
      });
      try {
        const agents = await one.inject({
          method: 'GET',
          url: '/v1/agents',
          headers: { authorization: `Bearer ${w.tok['uc-ops']}` },
        });
        expect(agents.statusCode).toBe(200);
        const runs = await one.inject({
          method: 'GET',
          url: '/v1/runs',
          headers: { authorization: `Bearer ${w.tok['uc-ops']}` },
        });
        expect(runs.statusCode).toBe(403);
      } finally {
        await one.close();
      }
    } finally {
      await bare.close();
    }
  });
});
