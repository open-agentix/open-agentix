import { CostModel, type Principal, type Role } from '@openagentix/core';
import { createEvent } from '@openagentix/events';
import {
  McpServerConfigSchema,
  ToolGateway,
  demoServerFactories,
  inMemoryServers,
  type Ticket,
} from '@openagentix/mcp';
import { ProviderRegistry, SimulatedProvider } from '@openagentix/providers';
import { InProcessRunner } from '@openagentix/runners';
import { eq, sql } from 'drizzle-orm';
import { agents } from '../db/schema.js';
import type { AppContext } from '../context.js';
import { DEFAULT_TENANT_ID, runs, users as usersTable } from '../db/schema.js';
import type { Services } from '../services/index.js';
import { demoId } from './ids.js';
import {
  CVE_TRIAGE,
  FEATURE_BUILDER,
  HARDENING_REVIEW,
  LOG_SUMMARY,
  RELEASE_WATCH,
  TICKET_UPDATER,
} from './agents.js';

/**
 * Deterministic seed for the public demo (demo.openagentix.si): fixed fake data on example.org,
 * simulated provider only, demo MCP servers in memory, no outbound network, no real secrets.
 */
export const DEMO_PRICE_TABLE = [
  // Demo prices so the cost views show numbers; the simulated provider itself is free.
  {
    provider: 'simulated',
    model: 'sim-1',
    inputPerMTok: 3,
    outputPerMTok: 15,
    perToolCallUsd: 0.0002,
  },
];

/** Tenant tree of the demo (ADR 0013): `root` > `security`, `platform`; `acme-labs` is a separate organisation. */
export type DemoTenantKey = 'root' | 'security' | 'platform' | 'acme-labs';

export const DEMO_TENANTS: {
  key: DemoTenantKey;
  slug: string;
  name: string;
  parent: DemoTenantKey | null;
  budgetUsd?: number;
}[] = [
  { key: 'root', slug: 'default', name: 'Example Org (demo)', parent: null, budgetUsd: 300 },
  { key: 'security', slug: 'security', name: 'Security (demo)', parent: 'root', budgetUsd: 120 },
  { key: 'platform', slug: 'platform', name: 'Platform (demo)', parent: 'root' },
  { key: 'acme-labs', slug: 'acme-labs', name: 'Acme Labs (demo)', parent: null },
];

/** Which tenant each demo agent lives in; the three fixed scenarios run in `security`. */
export const DEMO_AGENT_TENANT: Record<string, DemoTenantKey> = {
  'cve-triage': 'security',
  'ticket-updater': 'security',
  'hardening-review': 'security',
  'feature-builder': 'platform',
  'release-watch': 'root',
  'log-summary': 'acme-labs',
};

/** Teams per tenant (slug, name, monthly budget in USD). */
const DEMO_TEAMS: Record<DemoTenantKey, { slug: string; name: string; budgetUsd: number }[]> = {
  root: [{ slug: 'team-operations', name: 'Operations (demo)', budgetUsd: 10 }],
  security: [{ slug: 'team-security', name: 'Security (demo)', budgetUsd: 50 }],
  platform: [{ slug: 'team-platform', name: 'Platform (demo)', budgetUsd: 20 }],
  'acme-labs': [{ slug: 'team-platform', name: 'Platform (Acme demo)', budgetUsd: 20 }],
};

export interface DemoUser {
  email: string;
  displayName: string;
  globalRoles: Role[];
  /** Tenant of the user; roles apply inside it only (the tree grants nothing across nodes yet). */
  tenant: DemoTenantKey;
  teams?: { slug: string; role: Role }[];
  agents?: { name: string; role: Role }[];
  /**
   * Platform operator, modelled exactly like the seed's bootstrap owner (`users.platform_admin`):
   * lists every tenant and may act in any of them (`X-OAX-Tenant`). The demo stays read-only for
   * this user as well (the read-only hook does not look at the principal).
   */
  platformAdmin?: boolean;
}

export const DEMO_USERS: DemoUser[] = [
  // Platform operator for visitors: sees all four demo tenants and the tenant switcher.
  {
    email: 'owner@example.org',
    displayName: 'Olga Owner',
    globalRoles: ['admin'],
    tenant: 'root',
    platformAdmin: true,
  },
  {
    email: 'admin@example.org',
    displayName: 'Ada Admin',
    globalRoles: ['admin'],
    tenant: 'security',
  },
  {
    email: 'engineer@example.org',
    displayName: 'Erin Engineer',
    tenant: 'security',
    globalRoles: [],
    teams: [{ slug: 'team-security', role: 'agent-engineer' }],
  },
  {
    email: 'integrator@example.org',
    displayName: 'Ivan Integrator',
    globalRoles: ['integrator'],
    tenant: 'security',
  },
  {
    email: 'operator@example.org',
    displayName: 'Olga Operator',
    tenant: 'security',
    globalRoles: [],
    teams: [{ slug: 'team-security', role: 'operator' }],
  },
  {
    email: 'auditor@example.org',
    displayName: 'Aria Auditor',
    globalRoles: ['auditor'],
    tenant: 'security',
  },
  {
    email: 'viewer@example.org',
    displayName: 'Vic Viewer',
    tenant: 'acme-labs',
    globalRoles: [],
    teams: [{ slug: 'team-platform', role: 'viewer' }],
  },
  // Agent-scoped binding: sees and edits feature-builder only, none of the other agents. Lives in
  // `platform`, where feature-builder runs.
  {
    email: 'contractor@example.org',
    displayName: 'Casey Contractor',
    tenant: 'platform',
    globalRoles: [],
    agents: [{ name: 'feature-builder', role: 'agent-engineer' }],
  },
];

export interface DemoSeedResult {
  seeded: boolean;
  tenants: number;
  users: number;
  agents: number;
  runs: number;
  auditValid: boolean;
}

async function executeRun(
  ctx: AppContext,
  services: Services,
  runId: string,
  tickets: Map<string, Ticket>,
  approve?: () => void,
): Promise<void> {
  await ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'demo-seed',
      startedAt: ctx.now(),
      leaseUntil: new Date(ctx.now().getTime() + 600_000),
    })
    .where(eq(runs.id, runId));
  const control = services.control.forToken(services.control.issueToken(runId, 'demo-seed'));
  const tools = new ToolGateway(
    ['cve-db', 'tickets'].map((name) =>
      McpServerConfigSchema.parse({ name, transport: 'in-memory' }),
    ),
    { secrets: ctx.secrets, inMemory: inMemoryServers(demoServerFactories(tickets)) },
  );
  const pending = approve ? setInterval(approve, 20) : null;
  try {
    await new InProcessRunner().execute(await services.control.prepare(runId), {
      providers: ProviderRegistry.of([new SimulatedProvider({ name: 'simulated' })]),
      tools,
      control,
      costModel: new CostModel(DEMO_PRICE_TABLE),
    });
  } finally {
    if (pending) clearInterval(pending);
    await tools.close();
  }
}

/** Seeds the demo data set once (no-op when agents exist unless `force`). */
export async function seedDemo(
  ctx: AppContext,
  services: Services,
  opts: { password: string; force?: boolean },
): Promise<DemoSeedResult> {
  const [{ n } = { n: 0 }] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(agents);
  if (Number(n) > 0 && !opts.force) {
    return {
      seeded: false,
      tenants: 0,
      users: 0,
      agents: Number(n),
      runs: 0,
      auditValid: (await services.audit.verify()).valid,
    };
  }
  const admin = await services.identity.createLocalUser(
    { userId: 'demo-seed', tenantId: DEFAULT_TENANT_ID },
    {
      email: 'demo-owner@example.org',
      displayName: 'Demo Owner',
      password: opts.password,
      globalRoles: ['admin'],
    },
  );
  await ctx.db.update(usersTable).set({ platformAdmin: true }).where(eq(usersTable.id, admin.id));
  const ownerPrincipal = await services.identity.principalForUser(admin.id);

  // Tenant tree: the migrated default tenant becomes the root of "Example Org (demo)", the two
  // sub-tenants are created through the service layer (no HTTP route for children exists yet) and
  // the separate organisation keeps proving isolation. Ids are fixed (see ids.ts).
  const tenantIds = {} as Record<DemoTenantKey, string>;
  for (const t of DEMO_TENANTS) {
    if (t.key === 'root') {
      await services.tenants.update(ownerPrincipal, DEFAULT_TENANT_ID, {
        name: t.name,
        monthlyBudgetUsd: t.budgetUsd ?? null,
      });
      tenantIds.root = DEFAULT_TENANT_ID;
      continue;
    }
    const input = {
      id: demoId('tenant', t.slug),
      slug: t.slug,
      name: t.name,
      ...(t.budgetUsd === undefined ? {} : { monthlyBudgetUsd: t.budgetUsd }),
    };
    const row = t.parent
      ? await services.tenants.createChild(ownerPrincipal, tenantIds[t.parent], input)
      : await services.tenants.create(ownerPrincipal, {
          ...input,
          admin: {
            email: 'admin@acme.example.org',
            displayName: 'Acme Admin',
            password: opts.password,
          },
        });
    tenantIds[t.key] = row.id;
  }
  const actors = {} as Record<DemoTenantKey, Principal>;
  for (const t of DEMO_TENANTS)
    actors[t.key] = await services.identity.actingIn(ownerPrincipal, tenantIds[t.key]);
  const actor = actors.root;

  const teamIds: Record<string, string> = {};
  for (const [key, list] of Object.entries(DEMO_TEAMS) as [
    DemoTenantKey,
    (typeof DEMO_TEAMS)[DemoTenantKey],
  ][])
    for (const t of list) {
      const team = await services.identity.createTeam(actors[key], {
        slug: t.slug,
        name: t.name,
        monthlyBudgetUsd: t.budgetUsd,
      });
      teamIds[`${key}/${t.slug}`] = team.id;
    }

  // Every tenant that runs agents needs its own connections and baseline policy.
  for (const key of ['root', 'security', 'platform'] as const) {
    for (const name of ['cve-db', 'tickets'])
      await services.catalog.createConnection(actors[key], {
        name,
        kind: 'mcp',
        config: { transport: 'in-memory' },
      });
    await services.catalog.createPolicy(actors[key], {
      name: 'baseline',
      description: 'Demo baseline: no destructive tools, approvals for merges and deploys.',
      bundle: {
        forbiddenTools: ['*/delete_*', 'shell/*'],
        requireApprovalTools: ['*/merge_*', '*/deploy_*'],
        forbiddenArgPatterns: [{ pattern: 'rm\\s+-rf', reason: 'destructive shell command' }],
      },
      enabled: true,
    });
  }
  await services.guidelines.create(actor, {
    scope: 'global',
    name: 'company',
    version: '1.0.0',
    content:
      '# Company guidelines (demo)\n\nConventional Commits, tests for every change, 80 % coverage.',
    rules: {
      conventionalCommits: true,
      requireTests: true,
      minCoverage: 80,
      requireApprovalTools: ['*/merge_*'],
    },
  });
  await services.guidelines.create(actor, {
    scope: 'agent',
    name: 'secure-coding',
    version: '1.0.0',
    content: '# Secure coding (demo)',
    rules: { forbiddenDependencies: ['event-stream', 'left-pad'] },
  });

  const agentIds = new Map<string, string>();
  for (const source of [
    CVE_TRIAGE,
    TICKET_UPDATER,
    FEATURE_BUILDER,
    HARDENING_REVIEW,
    RELEASE_WATCH,
    LOG_SUMMARY,
  ]) {
    const name = /^name: (\S+)$/m.exec(source)![1]!;
    const owner = actors[DEMO_AGENT_TENANT[name]!];
    const a = await services.agents.create(owner, source, { id: demoId('agent', name) });
    await services.agents.publish(owner, a.id);
    agentIds.set(a.name, a.id);
  }

  const users: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    const created = await services.identity.createLocalUser(actors[u.tenant], {
      email: u.email,
      displayName: u.displayName,
      password: opts.password,
      globalRoles: u.globalRoles,
    });
    users[u.email] = created.id;
    if (u.platformAdmin)
      await ctx.db
        .update(usersTable)
        .set({ platformAdmin: true })
        .where(eq(usersTable.id, created.id));
  }
  for (const [key, teamId] of Object.entries(teamIds)) {
    const [tenant, slug] = key.split('/') as [DemoTenantKey, string];
    const members = DEMO_USERS.filter((u) => u.tenant === tenant).flatMap((u) =>
      (u.teams ?? [])
        .filter((t) => t.slug === slug)
        .map((t) => ({ userId: users[u.email]!, role: t.role })),
    );
    await services.identity.setTeamMembers(actors[tenant], teamId, members);
  }
  for (const u of DEMO_USERS) {
    for (const b of u.agents ?? [])
      await services.identity.setAgentMembers(
        actors[DEMO_AGENT_TENANT[b.name]!],
        agentIds.get(b.name)!,
        [{ userId: users[u.email]!, role: b.role }],
      );
  }

  // Event sources: a signed webhook (fake secret reference) and a change-gated schedule.
  await services.ingest.createSource(actors.security, {
    name: 'trivy',
    kind: 'webhook',
    secretRefs: ['demo-hook'],
    agentId: agentIds.get('cve-triage')!,
  });
  const watch = await services.ingest.createSource(actors.root, {
    name: 'release-feed',
    kind: 'cron',
    agentId: agentIds.get('release-watch')!,
    enabled: false,
    config: {
      schedule: '*/30 * * * *',
      changeCheck: {
        probe: {
          type: 'http',
          url: 'https://releases.example.org/feed.json',
          jsonPointer: '/latest',
        },
      },
    },
  });
  const feed = ['{"latest":"1.4.2"}', '{"latest":"1.4.2"}', '{"latest":"1.5.0"}'];
  services.ingest.probeDeps = {
    fetch: async () => new Response(feed.shift() ?? '{"latest":"1.5.0"}'),
  };

  // Runs with steps, tool calls, policy decisions, approvals and costs.
  const tickets = new Map<string, Ticket>();
  const runIds: string[] = [];
  const enqueue = async (name: string, key: string, data: unknown, triggeredBy = 'demo') => {
    const run = await services.runs.enqueue({
      id: demoId('run', key),
      agentId: agentIds.get(name)!,
      event: createEvent({ source: '/demo', type: 'io.openagentix.demo', data }),
      triggeredBy,
    });
    runIds.push(run.id);
    return run.id;
  };
  for (const [image, cve, ticket] of [
    ['ghcr.io/example/api:1.4.2', 'CVE-2024-3094', 'SEC-42'],
    ['ghcr.io/example/web:2.0.1', 'CVE-2023-44487', 'SEC-43'],
    ['ghcr.io/example/worker:0.9.0', 'CVE-2021-44228', 'SEC-44'],
  ] as const) {
    await executeRun(
      ctx,
      services,
      await enqueue(
        'cve-triage',
        `cve-triage:${cve}`,
        { image, finding: { cveId: cve, package: 'demo-package', installed: '1.0' }, ticket },
        'webhook:trivy',
      ),
      tickets,
    );
  }
  const approver = await services.identity.principalForUser(users['operator@example.org']!);
  const approveAll = () => {
    void services.runs.listApprovals(actors.security, 'pending', 10).then(async (page) => {
      for (const a of page.items)
        await services.runs
          .decide(approver, a.id, 'approve', 'Looks good (demo)')
          .catch(() => undefined);
    });
  };
  await executeRun(
    ctx,
    services,
    await enqueue('ticket-updater', 'ticket-updater:SEC-42', {
      issue: { key: 'SEC-42', severity: 'critical' },
    }),
    tickets,
    approveAll,
  );
  await executeRun(
    ctx,
    services,
    await enqueue('feature-builder', 'feature-builder:DEV-7', {
      ticket: 'DEV-7',
      slug: 'export-costs-csv',
      title: 'Export costs as CSV',
    }),
    tickets,
  );
  await executeRun(
    ctx,
    services,
    await enqueue('hardening-review', 'hardening-review:export-costs-csv', {
      pullRequest: 'feat/export-costs-csv',
    }),
    tickets,
  );
  await executeRun(
    ctx,
    services,
    await enqueue('log-summary', 'log-summary:6h', { window: '6h' }, 'cron:0 */6 * * *'),
    tickets,
  );
  // Change gate: first probe = change (run), second = unchanged (no run), third = change (run).
  for (const minute of [0, 30, 60]) {
    const gate = await services.ingest.changeGate(watch);
    if (gate?.changed) {
      const r = await services.ingest.ingestEvent(
        watch,
        createEvent({
          source: '/sources/cron/release-feed',
          type: 'io.openagentix.cron.tick',
          data: { minute, change: gate },
        }),
        'cron:release-feed',
        { runId: demoId('run', `release-watch:tick-${minute}`) },
      );
      if (r.runId) {
        runIds.push(r.runId);
        await executeRun(ctx, services, r.runId, tickets);
      }
    }
  }
  // One approval left pending for the approval inbox.
  const pendingRun = await enqueue('ticket-updater', 'ticket-updater:SEC-43', {
    issue: { key: 'SEC-43', severity: 'high' },
  });
  await ctx.db
    .update(runs)
    .set({ status: 'running', lockedBy: 'demo-seed', startedAt: ctx.now() })
    .where(eq(runs.id, pendingRun));
  await services.control.requestApproval(
    pendingRun,
    'updater',
    { server: 'tickets', tool: 'update_ticket', args: { key: 'SEC-43', status: 'triaged' } },
    [
      {
        code: 'approval_required',
        message: 'tool "tickets/update_ticket" requires human approval',
      },
    ],
  );

  await services.audit.checkpoint();
  return {
    seeded: true,
    tenants: DEMO_TENANTS.length,
    users: DEMO_USERS.length + 1,
    agents: agentIds.size,
    runs: runIds.length + 1,
    auditValid: (await services.audit.verify()).valid,
  };
}
