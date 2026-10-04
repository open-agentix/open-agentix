import { visibleAgents, visibleTeams, type Principal } from '@openagentix/core';
import { and, desc, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import { agents, costLedger, teams } from '../db/schema.js';
import { forbidden } from '../errors.js';

export const COST_GROUPS = [
  'run',
  'agent',
  'team',
  'tenant',
  'use_case',
  'month',
  'provider',
  'model',
] as const;
export type CostGroup = (typeof COST_GROUPS)[number];

export interface CostLine {
  id: number;
  createdAt: string;
  month: string;
  tenantId: string;
  teamId: string | null;
  agentId: string;
  agentName: string | null;
  useCase: string | null;
  runId: string;
  stepSeq: number | null;
  provider: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  costUsd: number;
}

const CSV_COLUMNS: (keyof CostLine)[] = [
  'id',
  'createdAt',
  'month',
  'tenantId',
  'teamId',
  'agentId',
  'agentName',
  'useCase',
  'runId',
  'stepSeq',
  'provider',
  'model',
  'tokensIn',
  'tokensOut',
  'costMicros',
  'costUsd',
];

/** RFC 4180 CSV with a header row; formula-like cells are prefixed to prevent CSV injection. */
export function costLinesToCsv(lines: readonly CostLine[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@]/.test(s) && typeof v === 'string') s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [CSV_COLUMNS.join(','), ...lines.map((l) => CSV_COLUMNS.map((c) => cell(l[c])).join(','))].join(
      '\r\n',
    ) + '\r\n'
  );
}

export interface CostRow {
  key: string | null;
  label: string | null;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  costUsd: number;
}

const COLUMN: Record<CostGroup, SQL> = {
  run: sql`${costLedger.runId}::text`,
  agent: sql`${costLedger.agentId}::text`,
  team: sql`${costLedger.teamId}::text`,
  tenant: sql`${costLedger.tenantId}::text`,
  use_case: sql`${costLedger.useCase}`,
  month: sql`${costLedger.month}::text`,
  provider: sql`${costLedger.provider}`,
  model: sql`${costLedger.model}`,
};

/** Cost aggregation from the ledger (cached briefly, invalidated when runs finish). */
export class CostsService {
  constructor(private readonly ctx: AppContext) {}

  private async labels(groupBy: CostGroup, keys: string[]): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map();
    if (groupBy === 'agent') {
      const rows = await this.ctx.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, keys));
      return new Map(rows.map((r) => [r.id, r.name]));
    }
    if (groupBy === 'team') {
      const rows = await this.ctx.db
        .select({ id: teams.id, slug: teams.slug })
        .from(teams)
        .where(inArray(teams.id, keys));
      return new Map(rows.map((r) => [r.id, r.slug]));
    }
    return new Map();
  }

  /** Platform operators may aggregate across tenants; everybody else stays inside their own. */
  private tenantFilter(principal: Principal, allTenants: boolean): SQL | undefined {
    if (allTenants) {
      if (!principal.platformAdmin) throw forbidden('allTenants needs platform operator access');
      return undefined;
    }
    return eq(costLedger.tenantId, principal.tenantId);
  }

  /** Cost lines for export (CSV/JSON), oldest first, same scoping as the summary. */
  async lines(
    principal: Principal,
    from?: string,
    to?: string,
    limit = 100_000,
    allTenants = false,
  ): Promise<CostLine[]> {
    const tenantFilter = this.tenantFilter(principal, allTenants);
    const scope = visibleTeams(principal, 'costs:read');
    const scopedAgents = visibleAgents(principal, 'costs:read');
    if (Array.isArray(scope) && scope.length === 0 && scopedAgents.length === 0) return [];
    const rows = await this.ctx.db
      .select({
        id: costLedger.id,
        createdAt: costLedger.createdAt,
        month: costLedger.month,
        tenantId: costLedger.tenantId,
        teamId: costLedger.teamId,
        agentId: costLedger.agentId,
        agentName: agents.name,
        useCase: costLedger.useCase,
        runId: costLedger.runId,
        stepSeq: costLedger.stepSeq,
        provider: costLedger.provider,
        model: costLedger.model,
        tokensIn: costLedger.tokensIn,
        tokensOut: costLedger.tokensOut,
        costMicros: costLedger.costMicros,
      })
      .from(costLedger)
      .leftJoin(agents, sql`${agents.id} = ${costLedger.agentId}`)
      .where(
        and(
          tenantFilter,
          from ? gte(costLedger.month, from) : undefined,
          to ? lte(costLedger.month, to) : undefined,
          scope === 'all'
            ? undefined
            : or(
                scope.length ? inArray(costLedger.teamId, scope) : undefined,
                scopedAgents.length ? inArray(costLedger.agentId, scopedAgents) : undefined,
              ),
        ),
      )
      .orderBy(costLedger.id)
      .limit(limit);
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      costMicros: Number(r.costMicros),
      costUsd: Number(r.costMicros) / 1e6,
    }));
  }

  async summary(
    principal: Principal,
    groupBy: CostGroup,
    from?: string,
    to?: string,
    limit = 100,
    allTenants = false,
  ): Promise<CostRow[]> {
    const tenantFilter = this.tenantFilter(principal, allTenants);
    const scope = visibleTeams(principal, 'costs:read');
    const scopedAgents = visibleAgents(principal, 'costs:read');
    if (Array.isArray(scope) && scope.length === 0 && scopedAgents.length === 0) return [];
    const key = `costs:${allTenants ? 'all' : principal.tenantId}:${groupBy}:${from ?? ''}:${to ?? ''}:${limit}:${scope === 'all' ? 'all' : [...scope, ...scopedAgents.map((a) => `agent:${a}`)].sort().join(',')}`;
    return cached(this.ctx.cache, key, 30_000, async () => {
      const col = COLUMN[groupBy];
      const rows = await this.ctx.db
        .select({
          key: sql<string | null>`${col}`,
          tokensIn: sql<number>`coalesce(sum(${costLedger.tokensIn}), 0)::bigint`,
          tokensOut: sql<number>`coalesce(sum(${costLedger.tokensOut}), 0)::bigint`,
          costMicros: sql<number>`coalesce(sum(${costLedger.costMicros}), 0)::bigint`,
        })
        .from(costLedger)
        .where(
          and(
            tenantFilter,
            from ? gte(costLedger.month, from) : undefined,
            to ? lte(costLedger.month, to) : undefined,
            scope === 'all'
              ? undefined
              : or(
                  scope.length ? inArray(costLedger.teamId, scope) : undefined,
                  scopedAgents.length ? inArray(costLedger.agentId, scopedAgents) : undefined,
                ),
          ),
        )
        .groupBy(col)
        .orderBy(desc(sql`4`))
        .limit(limit);
      const labels = await this.labels(
        groupBy,
        rows.map((r) => r.key).filter((k): k is string => !!k),
      );
      return rows.map((r) => ({
        key: r.key,
        label: (r.key && labels.get(r.key)) ?? null,
        tokensIn: Number(r.tokensIn),
        tokensOut: Number(r.tokensOut),
        costMicros: Number(r.costMicros),
        costUsd: Number(r.costMicros) / 1e6,
      }));
    });
  }
}
