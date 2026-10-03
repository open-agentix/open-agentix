import { visibleTeams, type Principal } from '@openagentix/core';
import { and, desc, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import { costLedger } from '../db/schema.js';

export const COST_GROUPS = ['run', 'agent', 'team', 'month', 'provider', 'model'] as const;
export type CostGroup = (typeof COST_GROUPS)[number];

export interface CostRow {
  key: string | null;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  costUsd: number;
}

const COLUMN: Record<CostGroup, SQL> = {
  run: sql`${costLedger.runId}::text`,
  agent: sql`${costLedger.agentId}::text`,
  team: sql`${costLedger.teamId}::text`,
  month: sql`${costLedger.month}::text`,
  provider: sql`${costLedger.provider}`,
  model: sql`${costLedger.model}`,
};

/** Cost aggregation from the ledger (cached briefly, invalidated when runs finish). */
export class CostsService {
  constructor(private readonly ctx: AppContext) {}

  async summary(
    principal: Principal,
    groupBy: CostGroup,
    from?: string,
    to?: string,
    limit = 100,
  ): Promise<CostRow[]> {
    const scope = visibleTeams(principal, 'costs:read');
    if (Array.isArray(scope) && scope.length === 0) return [];
    const key = `costs:${groupBy}:${from ?? ''}:${to ?? ''}:${limit}:${scope === 'all' ? 'all' : [...scope].sort().join(',')}`;
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
            from ? gte(costLedger.month, from) : undefined,
            to ? lte(costLedger.month, to) : undefined,
            scope === 'all' ? undefined : inArray(costLedger.teamId, scope),
          ),
        )
        .groupBy(col)
        .orderBy(desc(sql`4`))
        .limit(limit);
      return rows.map((r) => ({
        key: r.key,
        tokensIn: Number(r.tokensIn),
        tokensOut: Number(r.tokensOut),
        costMicros: Number(r.costMicros),
        costUsd: Number(r.costMicros) / 1e6,
      }));
    });
  }
}
