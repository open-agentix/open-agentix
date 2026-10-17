import { randomUUID } from 'node:crypto';
import { StaticSecretResolver, type Principal, type Role } from '@openagentix/core';
import { createEvent } from '@openagentix/events';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_TENANT_ID,
  agents,
  approvals,
  costLedger,
  eventSources,
  events,
  runSteps,
  tenantRoleBindings,
} from '../src/db/schema.js';
import { agentSource } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';
import type { sqlTargets } from './db-targets.js';

/**
 * The world of the use-case tests (ADR 0014 slice S8): one organisation with agents, runs, approvals,
 * costs, events and audit entries in several use cases, a child node that is attached to a use case
 * and one that is not, and a set of users whose only access is through use-case bindings.
 *
 *   org-a ─┬─ unit-1 ─── unit-1-sub     org-b ─── b-unit
 *          └─ unit-2
 *
 * Use cases of the agents of org-a: `sec`, `sec/appsec`, `ops`, `secure` (a different word with the
 * same characters in front), none. Everything runs on the resolver read path.
 */
export const PW = 'long-password-123';
export type Target = Awaited<ReturnType<(typeof sqlTargets)[number][2]>>;

export const USE_CASE_OF: Record<string, string | null> = {
  'a-sec': 'sec',
  'a-appsec': 'sec/appsec',
  'a-ops': 'ops',
  'a-secure': 'secure',
  'a-none': null,
};

export interface World {
  n: TestNode;
  id: Record<string, string>;
  uid: Record<string, string>;
  tok: Record<string, string>;
  agent: Record<string, string>;
  run: Record<string, string>;
  approval: Record<string, string>;
  source: Record<string, string>;
  event: Record<string, string>;
  op: () => Principal;
  req: (
    who: string | null,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    acting?: string,
  ) => ReturnType<TestNode['req']>;
  mkUser: (key: string, home: string, roles?: Role[]) => Promise<void>;
  bind: (
    user: string,
    tenant: string,
    role: Role,
    opts?: { inherit?: boolean; useCase?: string | null; attached?: never },
  ) => Promise<void>;
  relogin: (user: string) => Promise<void>;
  close: () => Promise<void>;
}

export async function buildWorld(target: Target, env: Record<string, string> = {}): Promise<World> {
  const n = await testNode(
    {
      OAX_DATABASE_URL: target.url,
      OAX_ROLE_BINDINGS_READ: 'bindings',
      OAX_RATE_LIMIT_LOGIN_MAX: '100000',
      OAX_BINDING_REAPER_INTERVAL_SECONDS: '0',
      ...env,
    },
    { secrets: new StaticSecretResolver({}) },
  );
  const id: Record<string, string> = { default: DEFAULT_TENANT_ID };
  const uid: Record<string, string> = {};
  const tok: Record<string, string> = {};
  const agent: Record<string, string> = {};
  const run: Record<string, string> = {};
  const approval: Record<string, string> = {};
  const source: Record<string, string> = {};
  const event: Record<string, string> = {};
  const op = (): Principal => ({
    kind: 'user',
    userId: randomUUID(),
    tenantId: DEFAULT_TENANT_ID,
    displayName: 'op',
    platformAdmin: true,
    bindings: [{ role: 'admin', teamId: null }],
  });
  const req: World['req'] = (who, method, url, payload, acting) =>
    n.req({
      method,
      url,
      ...(who === null ? {} : { token: tok[who]! }),
      ...(payload === undefined ? {} : { payload: payload as object }),
      ...(acting ? { headers: { 'x-oax-tenant': id[acting] ?? acting } } : {}),
    });
  const mkUser: World['mkUser'] = async (key, home, roles = []) => {
    const email = `${key}@example.org`;
    const u = await n.services.identity.createLocalUser(
      { userId: op().userId, tenantId: id[home]! },
      { email, displayName: key, password: PW, globalRoles: roles },
    );
    uid[key] = u.id;
    tok[key] = await n.login(email, PW);
  };
  const bind: World['bind'] = async (user, tenant, role, opts = {}) => {
    await n.ctx.db.insert(tenantRoleBindings).values({
      id: randomUUID(),
      userId: uid[user]!,
      tenantId: id[tenant]!,
      role,
      inherit: opts.inherit ?? false,
      useCase: opts.useCase ?? null,
      source: 'grant',
    });
  };
  const relogin = async (user: string) => {
    tok[user] = await n.login(`${user}@example.org`, PW);
  };

  for (const slug of ['org-a', 'org-b'])
    id[slug] = (await n.services.tenants.create(op(), { slug, name: `Org ${slug}` })).id;
  // slugs must not overlap in secret names (`unit-1` and `unit-1-sub` would), so keys and slugs differ
  const child = async (parent: string, key: string, slug: string) => {
    id[key] = (await n.services.tenants.createChild(op(), id[parent]!, { slug, name: slug })).id;
  };
  await child('org-a', 'unit-1', 'alpha');
  await child('unit-1', 'unit-1-sub', 'beta');
  await child('org-a', 'unit-2', 'gamma');
  await child('org-b', 'b-unit', 'delta');

  // people: an inheriting tenant administrator, and use-case people created through the API below
  await mkUser('root-admin', 'org-a');
  await bind('root-admin', 'org-a', 'admin', { inherit: true });
  await mkUser('admin-u1', 'unit-1'); // inheriting administrator of unit-1 only
  await bind('admin-u1', 'unit-1', 'admin', { inherit: true });
  await mkUser('viewer', 'org-a', ['viewer']); // a node-wide viewer, for comparison
  await mkUser('b-admin', 'org-b');
  await bind('b-admin', 'org-b', 'admin', { inherit: true });
  for (const k of ['uc-sec', 'uc-ops', 'uc-appsec', 'uc-eng', 'uc-oper', 'uc-none', 'grantee'])
    await mkUser(k, 'org-a');

  const mkAgent = async (key: string, tenant: string, useCase: string | null) => {
    const extra = useCase ? `labels:\n  useCase: ${useCase}` : '';
    const a = await n.services.agents.create(
      { ...op(), tenantId: id[tenant]! },
      agentSource(key, 'nobody', '1.0.0', extra),
    );
    await n.services.agents.publish({ ...op(), tenantId: id[tenant]! }, a.id);
    agent[key] = a.id;
  };
  // The fixture agents are published while approval is off: the world is not about the gate (ADR 0017
  // S3); a test that is switches it on through `env` and keeps it on from here.
  const lifecycle = n.ctx.config.lifecycle as { requireApproval: string };
  const wanted = lifecycle.requireApproval;
  lifecycle.requireApproval = 'off';
  for (const [key, uc] of Object.entries(USE_CASE_OF)) await mkAgent(key, 'org-a', uc);
  await mkAgent('a-u1', 'unit-1', 'anything');
  await mkAgent('a-u1sub', 'unit-1-sub', null);
  await mkAgent('a-u2', 'unit-2', 'sec');
  await mkAgent('a-b', 'b-unit', 'sec');
  lifecycle.requireApproval = wanted;

  for (const key of Object.keys(agent)) {
    const r = await n.services.runs.enqueue({
      agentId: agent[key]!,
      event: createEvent({ source: '/test', type: 'io.openagentix.manual', data: { key } }),
      triggeredBy: 'manual:test',
    });
    run[key] = r.id;
    await n.ctx.db.insert(runSteps).values({
      runId: r.id,
      seq: 1,
      kind: 'output',
      agentId: 'a',
      name: `step of ${key}`,
      status: 'ok',
    });
    const [ag] = await n.ctx.db
      .select({ t: agents.tenantId })
      .from(agents)
      .where(eq(agents.id, agent[key]!));
    const ap = randomUUID();
    approval[key] = ap;
    await n.ctx.db.insert(approvals).values({
      id: ap,
      tenantId: ag!.t,
      runId: r.id,
      teamId: null,
      agentId: 'a',
      tool: 'lookup',
      args: {},
      reasons: [],
      approverRoles: ['operator', 'admin'],
      status: 'pending',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const month = new Date().toISOString().slice(0, 7) + '-01';
    await n.ctx.db.insert(costLedger).values({
      tenantId: ag!.t,
      runId: r.id,
      useCase: USE_CASE_OF[key] ?? (key === 'a-none' ? null : 'anything'),
      agentId: agent[key]!,
      teamId: null,
      month,
      tokensIn: 10,
      tokensOut: 5,
      costMicros: 1_000_000,
    });
    // an event source per agent of org-a, with one event each
    if (key in USE_CASE_OF) {
      const sid = randomUUID();
      source[key] = sid;
      await n.ctx.db.insert(eventSources).values({
        id: sid,
        tenantId: id['org-a']!,
        name: `src-${key}`,
        kind: 'webhook',
        agentId: agent[key]!,
        config: {},
      });
      const eid = randomUUID();
      event[key] = eid;
      await n.ctx.db.insert(events).values({
        id: eid,
        tenantId: id['org-a']!,
        sourceId: sid,
        cloudEventId: eid,
        type: 'io.openagentix.test',
        payload: { from: key },
      });
    }
  }
  // an event without a source and one whose source has no agent: node-level, never a use case
  const free = randomUUID();
  event['free'] = free;
  await n.ctx.db.insert(events).values({
    id: free,
    tenantId: id['org-a']!,
    sourceId: null,
    cloudEventId: free,
    type: 'io.openagentix.budget.alert',
    payload: {},
  });
  const sNone = randomUUID();
  source['none'] = sNone;
  await n.ctx.db.insert(eventSources).values({
    id: sNone,
    tenantId: id['org-a']!,
    name: 'src-no-agent',
    kind: 'webhook',
    agentId: null,
    config: {},
  });
  const eNone = randomUUID();
  event['no-agent'] = eNone;
  await n.ctx.db.insert(events).values({
    id: eNone,
    tenantId: id['org-a']!,
    sourceId: sNone,
    cloudEventId: eNone,
    type: 'io.openagentix.test',
    payload: {},
  });

  return {
    n,
    id,
    uid,
    tok,
    agent,
    run,
    approval,
    source,
    event,
    op,
    req,
    mkUser,
    bind,
    relogin,
    close: async () => {
      await n.close();
      await target.close();
    },
  };
}
