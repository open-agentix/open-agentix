import {
  hasPermission,
  percentUsed,
  visibleAgents,
  visibleTeams,
  type BudgetScope,
  type Principal,
  type RunStatus,
} from '@openagentix/core';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import {
  agentVersions,
  agents,
  costLedger,
  runs,
  teams,
  useCaseBudgets,
  users,
} from '../db/schema.js';
import type { AgentStatus } from './agent-filters.js';
import type { AgentRow } from './agents.js';
import type { TeamRow, TenantRow } from './identity.js';
import { monthOf } from './runs.js';
import { TenantTree } from './tenant-tree.js';

const MICROS_PER_USD = 1_000_000;
const usd = (micros: number) => micros / MICROS_PER_USD;

export interface AgentTenantInfo {
  id: string;
  slug: string;
  /** Slugs from the organisation root down to the tenant, e.g. `acme/security`. */
  slugPath: string;
  name: string;
}

export interface AgentTeamInfo {
  id: string;
  slug: string;
  name: string;
}

export interface AgentLastRun {
  id: string;
  status: RunStatus;
  createdAt: Date;
}

export interface AgentBudgetInfo {
  limitUsd: number;
  spentUsd: number;
  percentUsed: number;
  source: BudgetScope;
  sourceName: string;
}

/** Read-only context the console shows next to an agent (UX slice A1). */
export interface AgentSummary {
  agent: AgentRow;
  tenant: AgentTenantInfo;
  useCase: string | null;
  ownerTeam: AgentTeamInfo | null;
  status: AgentStatus;
  lastRun: AgentLastRun | null;
  /** Null when the principal may not read costs of the agent. */
  monthSpendUsd: number | null;
  budget: AgentBudgetInfo | null;
  /** Set while the agent is disabled; the user is a member of the principal's tenant. */
  disabled: AgentDisabledInfo | null;
}

/** Who switched an agent off, when and why (UX slice A7). */
export interface AgentDisabledInfo {
  at: Date;
  by: { id: string; displayName: string } | null;
  reason: string | null;
}

interface BudgetCandidate {
  scope: BudgetScope;
  name: string;
  limitMicros: number;
  spentMicros: number;
}

/**
 * Builds {@link AgentSummary} for a page of agents with a fixed number of queries (no query per
 * agent). Everything is read inside the principal's tenant and filtered by the permission that
 * guards the underlying data: `runs:read` for the last run, `costs:read` for spend and budgets.
 * A missing permission yields `null`, never an error, so the list stays usable for every role.
 */
export class AgentSummaryService {
  private readonly tree: TenantTree;

  constructor(private readonly ctx: AppContext) {
    this.tree = new TenantTree(ctx);
  }

  async summarize(principal: Principal, rows: AgentRow[]): Promise<AgentSummary[]> {
    if (rows.length === 0) return [];
    if (rows.some((r) => r.tenantId !== principal.tenantId))
      throw new Error('agent summaries are built for the principal tenant only');
    const ids = rows.map((r) => r.id);
    const costIds = rows
      .filter((r) => hasPermission(principal, 'costs:read', r.teamId, r.id))
      .map((r) => r.id);
    const [tenantRow, teamRows, inSync, lastRuns, spend, disabledBy] = await Promise.all([
      this.tenantNode(principal.tenantId),
      this.teamsOf(principal.tenantId, rows),
      this.draftInSync(principal.tenantId, ids),
      this.lastRuns(principal, ids),
      this.spendByAgent(principal.tenantId, costIds),
      this.disablers(principal.tenantId, rows),
    ]);
    const costVisible = new Set(costIds);
    const budgets = await this.budgets(
      tenantRow,
      rows.filter((r) => costVisible.has(r.id)),
      teamRows,
    );
    const tenant = tenantInfo(tenantRow.node, tenantRow.ancestors);
    return rows.map((agent) => ({
      agent,
      tenant,
      useCase: agent.useCase,
      ownerTeam: teamInfo(agent.teamId ? teamRows.get(agent.teamId) : undefined),
      status: statusOf(agent, inSync.get(agent.id)),
      lastRun: lastRuns.get(agent.id) ?? null,
      monthSpendUsd: costVisible.has(agent.id) ? usd(spend.get(agent.id) ?? 0) : null,
      budget: budgets.get(agent.id) ?? null,
      disabled: agent.disabledAt
        ? {
            at: agent.disabledAt,
            by: agent.disabledBy ? (disabledBy.get(agent.disabledBy) ?? null) : null,
            reason: agent.disabledReason,
          }
        : null,
    }));
  }

  /**
   * Display names of the users who disabled the given agents, looked up inside the principal's
   * tenant only (a user of another tenant, or a deleted one, yields no name). Names are shown to
   * every `agents:read` holder, like the members of a team or an agent.
   */
  private async disablers(tenantId: string, rows: AgentRow[]) {
    const ids = [
      ...new Set(rows.flatMap((r) => (r.disabledAt && r.disabledBy ? [r.disabledBy] : []))),
    ];
    const out = new Map<string, { id: string; displayName: string }>();
    if (ids.length === 0) return out;
    const found = await this.ctx.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, ids)));
    for (const u of found) out.set(u.id, u);
    return out;
  }

  /** The tenant and its ancestors (the principal's own chain only). */
  private async tenantNode(tenantId: string) {
    const node = await this.tree.node(tenantId);
    if (!node) throw new Error('tenant of principal not found');
    return { node, ancestors: await this.tree.ancestors(node) };
  }

  private async teamsOf(tenantId: string, rows: AgentRow[]) {
    const teamIds = [...new Set(rows.flatMap((r) => (r.teamId ? [r.teamId] : [])))];
    if (teamIds.length === 0) return new Map<string, TeamRow>();
    const found = await this.ctx.db
      .select()
      .from(teams)
      .where(and(eq(teams.tenantId, tenantId), inArray(teams.id, teamIds)));
    return new Map(found.map((t) => [t.id, t]));
  }

  /** Per agent: is the draft identical to the latest published version (absent: never published). */
  private async draftInSync(tenantId: string, ids: string[]) {
    const found = await this.ctx.db
      .select({
        id: agents.id,
        same: sql<boolean>`${agentVersions.source} = ${agents.draftSource}`,
      })
      .from(agents)
      .innerJoin(
        agentVersions,
        and(eq(agentVersions.id, agents.latestVersionId), eq(agentVersions.agentId, agents.id)),
      )
      .where(and(eq(agents.tenantId, tenantId), inArray(agents.id, ids)));
    return new Map(found.map((r) => [r.id, r.same]));
  }

  /**
   * Latest run per agent in one statement (lateral join on `runs_agent_created_idx`), restricted
   * to the runs the principal may read, exactly like the runs list.
   */
  private async lastRuns(principal: Principal, ids: string[]) {
    const out = new Map<string, AgentLastRun>();
    const scope = runScope(principal);
    if (scope === 'none') return out;
    const res = (await this.ctx.db.execute(sql`
      select ag.id as agent_id, r.id, r.status, r.created_at
      from ${agents} ag
      cross join lateral (
        select ${runs.id} as id, ${runs.status} as status, ${runs.createdAt} as created_at
        from ${runs}
        where ${runs.agentId} = ag.id
          and ${runs.tenantId} = ${principal.tenantId}
          ${scope === 'all' ? sql`` : sql`and ${scope}`}
        order by ${runs.createdAt} desc, ${runs.id} desc
        limit 1
      ) r
      where ag.id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}) and ag.tenant_id = ${principal.tenantId}
    `)) as unknown as {
      rows: { agent_id: string; id: string; status: string; created_at: Date | string }[];
    };
    for (const r of res.rows)
      out.set(r.agent_id, {
        id: r.id,
        status: r.status as RunStatus,
        createdAt: new Date(r.created_at),
      });
    return out;
  }

  private async spendByAgent(tenantId: string, ids: string[]) {
    const totals = new Map<string, number>();
    if (ids.length === 0) return totals;
    const rows = await this.ctx.db
      .select({ key: costLedger.agentId, total: micros() })
      .from(costLedger)
      .where(
        and(
          eq(costLedger.tenantId, tenantId),
          eq(costLedger.month, monthOf(this.ctx.now())),
          inArray(costLedger.agentId, ids),
        ),
      )
      .groupBy(costLedger.agentId);
    for (const r of rows) totals.set(r.key, Number(r.total));
    return totals;
  }

  /**
   * The monthly budget closest to its limit among the scopes that apply to each agent (tenant,
   * use case, team: the same scopes the hard stop enforces). Agents without any limit get none.
   */
  private async budgets(
    tenantRow: { node: TenantRow },
    rows: AgentRow[],
    teamRows: Map<string, TeamRow>,
  ) {
    const out = new Map<string, AgentBudgetInfo>();
    if (rows.length === 0) return out;
    const tenant = tenantRow.node;
    const tenantId = tenant.id;
    const month = monthOf(this.ctx.now());
    const inMonth = and(eq(costLedger.tenantId, tenantId), eq(costLedger.month, month));
    const useCases = [...new Set(rows.flatMap((r) => (r.useCase ? [r.useCase] : [])))];
    const teamIds = [...new Set(rows.flatMap((r) => (r.teamId ? [r.teamId] : [])))];
    const [useCaseLimits, tenantSpent, teamSpent, useCaseSpent] = await Promise.all([
      useCases.length
        ? this.ctx.db
            .select()
            .from(useCaseBudgets)
            .where(
              and(eq(useCaseBudgets.tenantId, tenantId), inArray(useCaseBudgets.useCase, useCases)),
            )
        : [],
      this.ctx.db.select({ total: micros() }).from(costLedger).where(inMonth),
      this.spendBy(costLedger.teamId, teamIds, inMonth),
      this.spendBy(costLedger.useCase, useCases, inMonth),
    ]);
    const limits = new Map(useCaseLimits.map((u) => [u.useCase, u.monthlyBudgetMicros]));
    for (const agent of rows) {
      const candidates: BudgetCandidate[] = [];
      if (tenant.monthlyBudgetMicros !== null)
        candidates.push({
          scope: 'tenant',
          name: tenant.name,
          limitMicros: tenant.monthlyBudgetMicros,
          spentMicros: Number(tenantSpent[0]?.total ?? 0),
        });
      const useCaseLimit = agent.useCase ? limits.get(agent.useCase) : undefined;
      if (agent.useCase && useCaseLimit !== undefined)
        candidates.push({
          scope: 'use_case',
          name: agent.useCase,
          limitMicros: useCaseLimit,
          spentMicros: useCaseSpent.get(agent.useCase) ?? 0,
        });
      const team = agent.teamId ? teamRows.get(agent.teamId) : undefined;
      if (team && team.monthlyBudgetMicros !== null)
        candidates.push({
          scope: 'team',
          name: team.name,
          limitMicros: team.monthlyBudgetMicros,
          spentMicros: teamSpent.get(team.id) ?? 0,
        });
      const tightest = tightestOf(candidates);
      if (tightest) out.set(agent.id, tightest);
    }
    return out;
  }

  private async spendBy(
    column: typeof costLedger.teamId | typeof costLedger.useCase,
    keys: string[],
    inMonth: SQL | undefined,
  ) {
    const totals = new Map<string, number>();
    if (keys.length === 0) return totals;
    const rows = await this.ctx.db
      .select({ key: column, total: micros() })
      .from(costLedger)
      .where(and(inMonth, inArray(column, keys)))
      .groupBy(column);
    for (const r of rows) if (r.key) totals.set(r.key, Number(r.total));
    return totals;
  }
}

const micros = () => sql<number>`coalesce(sum(${costLedger.costMicros}), 0)::bigint`;

const tenantInfo = (node: TenantRow, ancestors: TenantRow[]): AgentTenantInfo => ({
  id: node.id,
  slug: node.slug,
  slugPath: [...ancestors.map((a) => a.slug), node.slug].join('/'),
  name: node.name,
});

const teamInfo = (t: TeamRow | undefined): AgentTeamInfo | null =>
  t ? { id: t.id, slug: t.slug, name: t.name } : null;

function statusOf(agent: AgentRow, inSync: boolean | undefined): AgentStatus {
  if (agent.disabledAt) return 'disabled';
  if (!agent.latestVersionId) return 'draft';
  return inSync === false ? 'changed' : 'published';
}

/** Highest share of the limit used wins; on a tie the smaller limit (the tighter cap) wins. */
function tightestOf(candidates: BudgetCandidate[]): AgentBudgetInfo | null {
  const best = candidates.reduce<BudgetCandidate | null>((a, b) => {
    if (!a) return b;
    const [pa, pb] = [percentUsed(a), percentUsed(b)];
    return pb > pa || (pb === pa && b.limitMicros < a.limitMicros) ? b : a;
  }, null);
  if (!best) return null;
  return {
    limitUsd: usd(best.limitMicros),
    spentUsd: usd(best.spentMicros),
    percentUsed: percentUsed(best),
    source: best.scope,
    sourceName: best.name,
  };
}

/** SQL restriction of runs to what the principal may read; `none` when nothing is readable. */
function runScope(principal: Principal): SQL | 'all' | 'none' {
  const teamsIn = visibleTeams(principal, 'runs:read');
  if (teamsIn === 'all') return 'all';
  const agentsIn = visibleAgents(principal, 'runs:read');
  if (teamsIn.length === 0 && agentsIn.length === 0) return 'none';
  return or(
    teamsIn.length ? inArray(runs.teamId, teamsIn) : undefined,
    agentsIn.length ? inArray(runs.agentId, agentsIn) : undefined,
  )!;
}
