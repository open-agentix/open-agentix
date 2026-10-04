import { CostModel, type Role } from '@openagentix/core';
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
import { eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { agents, costLedger, runs, teams, tenants } from '../db/schema.js';
import type { Services } from '../services/index.js';
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
export const DEMO_TENANT_ID = '00000000-0000-4000-8000-0000000000a2';
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

export interface DemoUser {
  email: string;
  displayName: string;
  globalRoles: Role[];
  teams?: { slug: string; role: Role }[];
  agents?: { name: string; role: Role }[];
}

export const DEMO_USERS: DemoUser[] = [
  { email: 'admin@example.org', displayName: 'Ada Admin', globalRoles: ['admin'] },
  {
    email: 'engineer@example.org',
    displayName: 'Erin Engineer',
    globalRoles: [],
    teams: [{ slug: 'team-security', role: 'agent-engineer' }],
  },
  { email: 'integrator@example.org', displayName: 'Ivan Integrator', globalRoles: ['integrator'] },
  {
    email: 'operator@example.org',
    displayName: 'Olga Operator',
    globalRoles: [],
    teams: [{ slug: 'team-security', role: 'operator' }],
  },
  { email: 'auditor@example.org', displayName: 'Aria Auditor', globalRoles: ['auditor'] },
  {
    email: 'viewer@example.org',
    displayName: 'Vic Viewer',
    globalRoles: [],
    teams: [{ slug: 'team-platform', role: 'viewer' }],
  },
  // Agent-scoped binding: sees and edits feature-builder only, none of the other agents.
  {
    email: 'contractor@example.org',
    displayName: 'Casey Contractor',
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
  const admin = await services.identity.createLocalUser('demo-seed', {
    email: 'demo-owner@example.org',
    displayName: 'Demo Owner',
    password: opts.password,
    globalRoles: ['admin'],
  });
  const actor = admin.id;
  await ctx.db
    .insert(tenants)
    .values({ id: DEMO_TENANT_ID, slug: 'acme-labs', name: 'Acme Labs (demo)' })
    .onConflictDoNothing();
  const sec = await services.identity.createTeam(actor, {
    slug: 'team-security',
    name: 'Security (demo)',
    monthlyBudgetUsd: 50,
  });
  const platform = await services.identity.createTeam(actor, {
    slug: 'team-platform',
    name: 'Platform (demo)',
    monthlyBudgetUsd: 20,
  });
  await ctx.db.update(teams).set({ tenantId: DEMO_TENANT_ID }).where(eq(teams.id, platform.id));

  for (const name of ['cve-db', 'tickets'])
    await services.catalog.createConnection(actor, {
      name,
      kind: 'mcp',
      config: { transport: 'in-memory' },
    });
  await services.catalog.createPolicy(actor, {
    name: 'baseline',
    description: 'Demo baseline: no destructive tools, approvals for merges and deploys.',
    bundle: {
      forbiddenTools: ['*/delete_*', 'shell/*'],
      requireApprovalTools: ['*/merge_*', '*/deploy_*'],
      forbiddenArgPatterns: [{ pattern: 'rm\\s+-rf', reason: 'destructive shell command' }],
    },
    enabled: true,
  });
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

  const ownerPrincipal = await services.identity.principalForUser(admin.id);
  const agentIds = new Map<string, string>();
  for (const source of [
    CVE_TRIAGE,
    TICKET_UPDATER,
    FEATURE_BUILDER,
    HARDENING_REVIEW,
    RELEASE_WATCH,
    LOG_SUMMARY,
  ]) {
    const a = await services.agents.create(ownerPrincipal, source);
    await services.agents.publish(ownerPrincipal, a.id);
    agentIds.set(a.name, a.id);
  }
  await ctx.db
    .update(agents)
    .set({ tenantId: DEMO_TENANT_ID })
    .where(eq(agents.id, agentIds.get('log-summary')!));

  const teamIds: Record<string, string> = { 'team-security': sec.id, 'team-platform': platform.id };
  const users: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    const created = await services.identity.createLocalUser(actor, {
      email: u.email,
      displayName: u.displayName,
      password: opts.password,
      globalRoles: u.globalRoles,
    });
    users[u.email] = created.id;
  }
  for (const slug of ['team-security', 'team-platform']) {
    const members = DEMO_USERS.flatMap((u) =>
      (u.teams ?? [])
        .filter((t) => t.slug === slug)
        .map((t) => ({ userId: users[u.email]!, role: t.role })),
    );
    await services.identity.setTeamMembers(actor, teamIds[slug]!, members);
  }
  for (const u of DEMO_USERS) {
    for (const b of u.agents ?? [])
      await services.identity.setAgentMembers(actor, agentIds.get(b.name)!, [
        { userId: users[u.email]!, role: b.role },
      ]);
  }

  // Event sources: a signed webhook (fake secret reference) and a change-gated schedule.
  await services.ingest.createSource(actor, {
    name: 'trivy',
    kind: 'webhook',
    secretRefs: ['demo-hook'],
    agentId: agentIds.get('cve-triage')!,
  });
  const watch = await services.ingest.createSource(actor, {
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
  const enqueue = async (name: string, data: unknown, triggeredBy = 'demo') => {
    const run = await services.runs.enqueue({
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
        { image, finding: { cveId: cve, package: 'demo-package', installed: '1.0' }, ticket },
        'webhook:trivy',
      ),
      tickets,
    );
  }
  const approver = await services.identity.principalForUser(users['operator@example.org']!);
  const approveAll = () => {
    void services.runs.listApprovals(ownerPrincipal, 'pending', 10).then(async (page) => {
      for (const a of page.items)
        await services.runs
          .decide(approver, a.id, 'approve', 'Looks good (demo)')
          .catch(() => undefined);
    });
  };
  await executeRun(
    ctx,
    services,
    await enqueue('ticket-updater', { issue: { key: 'SEC-42', severity: 'critical' } }),
    tickets,
    approveAll,
  );
  await executeRun(
    ctx,
    services,
    await enqueue('feature-builder', {
      ticket: 'DEV-7',
      slug: 'export-costs-csv',
      title: 'Export costs as CSV',
    }),
    tickets,
  );
  await executeRun(
    ctx,
    services,
    await enqueue('hardening-review', { pullRequest: 'feat/export-costs-csv' }),
    tickets,
  );
  await executeRun(
    ctx,
    services,
    await enqueue('log-summary', { window: '6h' }, 'cron:0 */6 * * *'),
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
      );
      if (r.runId) {
        runIds.push(r.runId);
        await executeRun(ctx, services, r.runId, tickets);
      }
    }
  }
  // One approval left pending for the approval inbox.
  const pendingRun = await enqueue('ticket-updater', {
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

  // Second tenant's rows.
  const logRuns = await ctx.db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.agentId, agentIds.get('log-summary')!));
  const ids = logRuns.map((r) => r.id);
  if (ids.length) {
    await ctx.db.update(runs).set({ tenantId: DEMO_TENANT_ID }).where(inArray(runs.id, ids));
    await ctx.db
      .update(costLedger)
      .set({ tenantId: DEMO_TENANT_ID })
      .where(inArray(costLedger.runId, ids));
  }
  await services.audit.checkpoint();
  return {
    seeded: true,
    tenants: 2,
    users: DEMO_USERS.length + 1,
    agents: agentIds.size,
    runs: runIds.length + 1,
    auditValid: (await services.audit.verify()).valid,
  };
}
