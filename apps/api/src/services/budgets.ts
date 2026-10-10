import { randomUUID } from 'node:crypto';
import {
  BUDGET_ALERT_EVENT_TYPE,
  crossedThresholds,
  evaluateBudgets,
  percentUsed,
  type AlertThreshold,
  type BudgetAlertData,
  type BudgetScope,
  type BudgetUsage,
  type BudgetVerdict,
  type Principal,
} from '@openagentix/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import {
  budgetAlerts,
  costLedger,
  events,
  runs,
  teams,
  tenants,
  useCaseBudgets,
} from '../db/schema.js';
import { notFound } from '../errors.js';
import { decodeNameCursor, encodeNameCursor } from '../pagination.js';
import type { AgentsService } from './agents.js';
import type { AuditService } from './audit.js';
import { monthOf } from './runs.js';
import type { ResolvedScope } from './subtree-scope.js';
import { TenantTree } from './tenant-tree.js';

/** What a spend is attributed to; every budget scope that applies to it is checked. */
export interface BudgetTarget {
  tenantId: string;
  teamId: string | null;
  useCase: string | null;
}

/** A usage row plus what the control node needs to address it (alerts, API). */
export interface ScopedUsage extends BudgetUsage {
  /** Stable key for alert de-duplication: team id or use case, empty for the tenant. */
  scopeKey: string;
}

export interface BudgetLine {
  scope: BudgetScope;
  key: string | null;
  limitUsd: number | null;
  spentUsd: number;
  percentUsed: number | null;
  /** Alert thresholds already raised this month. */
  alerts: number[];
}

export interface BudgetOverview {
  month: string;
  tenant: BudgetLine;
  useCases: BudgetLine[];
  teams: BudgetLine[];
}

/** The budgets of one node of a `scope=subtree` overview. */
export interface NodeBudgetOverview extends Omit<BudgetOverview, 'month'> {
  node: { id: string; slugPath: string; name: string };
}

/** Technical limits of the per-node budget overview. */
export const NODE_BUDGETS_DEFAULT_LIMIT = 200;
export const NODE_BUDGETS_MAX_LIMIT = 1000;

type RaisedAlert = { scope: string; scopeKey: string; thresholdPercent: number };

/** One budget line with the alert thresholds already raised for it this month. */
function budgetLine(
  raised: readonly RaisedAlert[],
  scope: BudgetScope,
  key: string | null,
  scopeKey: string,
  limit: number | null,
  spent: number,
): BudgetLine {
  return {
    scope,
    key,
    limitUsd: limit === null ? null : usd(limit),
    spentUsd: usd(spent),
    percentUsed: limit === null ? null : percentUsed({ limitMicros: limit, spentMicros: spent }),
    alerts: raised
      .filter((a) => a.scope === scope && a.scopeKey === scopeKey)
      .map((a) => a.thresholdPercent)
      .sort((a, b) => a - b),
  };
}

const toNumber = (v: unknown) => Number(v ?? 0);
const usd = (micros: number) => micros / 1_000_000;
const spendSum = () => sql<number>`coalesce(sum(${costLedger.costMicros}), 0)::bigint`;

/**
 * Monthly budgets per tenant, use case and team with a hard stop and alerts at 50, 80 and 100 %.
 * The limit of the tenant lives on `tenants`, of a team on `teams`, of a use case in
 * `use_case_budgets`. Spend always comes from the cost ledger of the current UTC month, so every
 * budget starts over on the first of the month.
 */
export class BudgetsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
  ) {}

  private async spent(db: Db, where: ReturnType<typeof and>): Promise<number> {
    const [r] = await db
      .select({ total: sql<number>`coalesce(sum(${costLedger.costMicros}), 0)::bigint` })
      .from(costLedger)
      .where(where);
    return toNumber(r?.total);
  }

  /** Budgets that apply to a spend target, each with this month's spend. */
  private async usages(db: Db, target: BudgetTarget, month: string): Promise<ScopedUsage[]> {
    const out: ScopedUsage[] = [];
    const inTenant = eq(costLedger.tenantId, target.tenantId);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, target.tenantId));
    if (tenant && tenant.monthlyBudgetMicros !== null) {
      out.push({
        scope: 'tenant',
        key: tenant.slug,
        scopeKey: '',
        limitMicros: tenant.monthlyBudgetMicros,
        spentMicros: await this.spent(db, and(inTenant, eq(costLedger.month, month))),
      });
    }
    if (target.useCase) {
      const [uc] = await db
        .select()
        .from(useCaseBudgets)
        .where(
          and(
            eq(useCaseBudgets.tenantId, target.tenantId),
            eq(useCaseBudgets.useCase, target.useCase),
          ),
        );
      if (uc) {
        out.push({
          scope: 'use_case',
          key: uc.useCase,
          scopeKey: uc.useCase,
          limitMicros: uc.monthlyBudgetMicros,
          spentMicros: await this.spent(
            db,
            and(inTenant, eq(costLedger.useCase, uc.useCase), eq(costLedger.month, month)),
          ),
        });
      }
    }
    if (target.teamId) {
      const [team] = await db.select().from(teams).where(eq(teams.id, target.teamId));
      if (team && team.monthlyBudgetMicros !== null) {
        out.push({
          scope: 'team',
          key: team.slug,
          scopeKey: team.id,
          limitMicros: team.monthlyBudgetMicros,
          spentMicros: await this.spent(
            db,
            and(eq(costLedger.teamId, team.id), eq(costLedger.month, month)),
          ),
        });
      }
    }
    return out;
  }

  /**
   * Monthly budgets that apply to a spend target with this month's ledger spend, for the model
   * accounting reservations (which add their active reservations on top).
   */
  async scopeUsages(db: Db, target: BudgetTarget): Promise<ScopedUsage[]> {
    return this.usages(db, target, monthOf(this.ctx.now()));
  }

  /** Which use case a run is attributed to (label of the pinned agent version). */
  private async targetOfRun(runId: string): Promise<BudgetTarget> {
    const [run] = await this.ctx.db
      .select({ tenantId: runs.tenantId, teamId: runs.teamId, versionId: runs.agentVersionId })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run) throw notFound('run');
    const { definition } = await this.agents.definitionOf(run.versionId);
    return {
      tenantId: run.tenantId,
      teamId: run.teamId,
      useCase: definition.labels.useCase ?? null,
    };
  }

  /** Verdict for a spend target without side effects. */
  async verdictFor(target: BudgetTarget, db: Db = this.ctx.db): Promise<BudgetVerdict> {
    return evaluateBudgets(await this.usages(db, target, monthOf(this.ctx.now())));
  }

  /**
   * Mid-run hard stop: the verdict for a running run. A breach is written to the audit log; the
   * executor kills the run on the next check, so it appears once per run.
   */
  async verdictForRun(runId: string): Promise<BudgetVerdict> {
    const target = await this.targetOfRun(runId);
    const verdict = await this.verdictFor(target);
    if (verdict.blocked) {
      await this.audit.append({
        actor: 'system',
        tenantId: target.tenantId,
        action: 'budget.blocked',
        target: runId,
        runId,
        payload: { stage: 'run', breaches: verdict.breaches },
      });
    }
    return verdict;
  }

  /**
   * Raises the alerts a new cost line caused (50, 80 and 100 % of any budget it counts against).
   * Runs in the transaction that wrote the ledger row, so the spend already includes it; an
   * alert is stored once per tenant, scope, month and threshold (primary key).
   */
  async raiseAlerts(db: Db, target: BudgetTarget, costMicros: number): Promise<void> {
    if (costMicros <= 0) return;
    const month = monthOf(this.ctx.now());
    for (const u of await this.usages(db, target, month)) {
      for (const threshold of crossedThresholds(
        u.limitMicros,
        u.spentMicros - costMicros,
        u.spentMicros,
      )) {
        await this.raise(db, target.tenantId, u, month, threshold);
      }
    }
  }

  private async raise(
    db: Db,
    tenantId: string,
    u: ScopedUsage,
    month: string,
    threshold: AlertThreshold,
  ): Promise<void> {
    const inserted = await db
      .insert(budgetAlerts)
      .values({
        tenantId,
        scope: u.scope,
        scopeKey: u.scopeKey,
        month,
        thresholdPercent: threshold,
      })
      .onConflictDoNothing()
      .returning({ t: budgetAlerts.thresholdPercent });
    if (inserted.length === 0) return;
    const data: BudgetAlertData = {
      tenantId,
      scope: u.scope,
      key: u.scope === 'tenant' ? null : u.key,
      month,
      thresholdPercent: threshold,
      limitUsd: usd(u.limitMicros),
      spentUsd: usd(u.spentMicros),
    };
    const id = randomUUID();
    await db.insert(events).values({
      id,
      tenantId,
      sourceId: null,
      cloudEventId: id,
      type: BUDGET_ALERT_EVENT_TYPE,
      subject: u.scope === 'tenant' ? 'tenant' : `${u.scope}/${u.key}`,
      payload: {
        specversion: '1.0',
        id,
        source: '/openagentix/budgets',
        type: BUDGET_ALERT_EVENT_TYPE,
        time: this.ctx.now().toISOString(),
        data,
      },
    });
    await this.audit.append(
      {
        actor: 'system',
        tenantId,
        action: 'budget.alert',
        target: u.scope === 'tenant' ? tenantId : u.key,
        payload: data,
      },
      db,
    );
  }

  /** Current budgets with spend and raised alerts for the caller's tenant. */
  async overview(principal: Principal): Promise<BudgetOverview> {
    const month = monthOf(this.ctx.now());
    const tenantId = principal.tenantId;
    const db = this.ctx.db;
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    const raised = await db
      .select()
      .from(budgetAlerts)
      .where(and(eq(budgetAlerts.tenantId, tenantId), eq(budgetAlerts.month, month)));
    const line = (
      scope: BudgetScope,
      key: string | null,
      scopeKey: string,
      limit: number | null,
      spent: number,
    ): BudgetLine => budgetLine(raised, scope, key, scopeKey, limit, spent);
    const inMonth = and(eq(costLedger.tenantId, tenantId), eq(costLedger.month, month));
    const tenantLine = line(
      'tenant',
      tenant?.slug ?? null,
      '',
      tenant?.monthlyBudgetMicros ?? null,
      await this.spent(db, inMonth),
    );
    const useCases: BudgetLine[] = [];
    for (const b of await db
      .select()
      .from(useCaseBudgets)
      .where(eq(useCaseBudgets.tenantId, tenantId))
      .orderBy(useCaseBudgets.useCase)) {
      const spent = await this.spent(db, and(inMonth, eq(costLedger.useCase, b.useCase)));
      useCases.push(line('use_case', b.useCase, b.useCase, b.monthlyBudgetMicros, spent));
    }
    const teamLines: BudgetLine[] = [];
    for (const t of await db
      .select()
      .from(teams)
      .where(eq(teams.tenantId, tenantId))
      .orderBy(teams.slug)) {
      if (t.monthlyBudgetMicros === null) continue;
      const spent = await this.spent(db, and(inMonth, eq(costLedger.teamId, t.id)));
      teamLines.push(line('team', t.slug, t.id, t.monthlyBudgetMicros, spent));
    }
    return { month, tenant: tenantLine, useCases, teams: teamLines };
  }

  /**
   * Budgets of every node of a `scope=subtree` overview: the tenant limit, use case limits and team
   * limits with this month's spend, one entry per node, ordered by slug path and keyset-paged by
   * it. Nodes come from the resolved scope only; the queries cover one page of nodes at a time.
   */
  async overviewNodes(
    subtree: ResolvedScope,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: NodeBudgetOverview[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(page.limit, 1), NODE_BUDGETS_MAX_LIMIT);
    const ids = subtree.nodeIds();
    if (ids.length === 0) return { items: [], nextCursor: null };
    const db = this.ctx.db;
    const rows = await db.select().from(tenants).where(inArray(tenants.id, ids));
    const paths = await new TenantTree(this.ctx).slugPaths(rows);
    const after = decodeNameCursor(page.cursor);
    const ordered = rows
      .map((r) => ({ row: r, slugPath: paths.get(r.id)! }))
      .sort((a, b) => (a.slugPath < b.slugPath ? -1 : a.slugPath > b.slugPath ? 1 : 0))
      .filter((n) => after === null || n.slugPath > after.key);
    const slice = ordered.slice(0, limit);
    const nextCursor = ordered.length > limit ? encodeNameCursor(slice.at(-1)!.slugPath) : null;
    const pageIds = slice.map((n) => n.row.id);
    if (pageIds.length === 0) return { items: [], nextCursor };

    const month = monthOf(this.ctx.now());
    const inMonth = and(inArray(costLedger.tenantId, pageIds), eq(costLedger.month, month));
    const [raised, useCases, teamRows, tenantSpend, useCaseSpend, teamSpend] = await Promise.all([
      db
        .select()
        .from(budgetAlerts)
        .where(and(inArray(budgetAlerts.tenantId, pageIds), eq(budgetAlerts.month, month))),
      db
        .select()
        .from(useCaseBudgets)
        .where(inArray(useCaseBudgets.tenantId, pageIds))
        .orderBy(useCaseBudgets.useCase),
      db.select().from(teams).where(inArray(teams.tenantId, pageIds)).orderBy(teams.slug),
      db
        .select({ k: costLedger.tenantId, total: spendSum() })
        .from(costLedger)
        .where(inMonth)
        .groupBy(costLedger.tenantId),
      db
        .select({ k: costLedger.tenantId, u: costLedger.useCase, total: spendSum() })
        .from(costLedger)
        .where(inMonth)
        .groupBy(costLedger.tenantId, costLedger.useCase),
      db
        .select({ k: costLedger.tenantId, t: costLedger.teamId, total: spendSum() })
        .from(costLedger)
        .where(inMonth)
        .groupBy(costLedger.tenantId, costLedger.teamId),
    ]);
    const items = slice.map(({ row, slugPath }): NodeBudgetOverview => {
      const alerts = raised.filter((a) => a.tenantId === row.id);
      const spent = (k: string) => toNumber(tenantSpend.find((s) => s.k === k)?.total);
      return {
        node: { id: row.id, slugPath, name: row.name },
        tenant: budgetLine(alerts, 'tenant', row.slug, '', row.monthlyBudgetMicros, spent(row.id)),
        useCases: useCases
          .filter((b) => b.tenantId === row.id)
          .map((b) =>
            budgetLine(
              alerts,
              'use_case',
              b.useCase,
              b.useCase,
              b.monthlyBudgetMicros,
              toNumber(useCaseSpend.find((s) => s.k === row.id && s.u === b.useCase)?.total),
            ),
          ),
        teams: teamRows
          .filter((t) => t.tenantId === row.id && t.monthlyBudgetMicros !== null)
          .map((t) =>
            budgetLine(
              alerts,
              'team',
              t.slug,
              t.id,
              t.monthlyBudgetMicros,
              toNumber(teamSpend.find((s) => s.k === row.id && s.t === t.id)?.total),
            ),
          ),
      };
    });
    return { items, nextCursor };
  }

  async setUseCaseBudget(p: Principal, useCase: string, monthlyBudgetUsd: number): Promise<void> {
    const micros = Math.round(monthlyBudgetUsd * 1_000_000);
    await this.ctx.db
      .insert(useCaseBudgets)
      .values({ id: randomUUID(), tenantId: p.tenantId, useCase, monthlyBudgetMicros: micros })
      .onConflictDoUpdate({
        target: [useCaseBudgets.tenantId, useCaseBudgets.useCase],
        set: { monthlyBudgetMicros: micros, updatedAt: this.ctx.now() },
      });
    await this.audit.append({
      actor: p.userId,
      tenantId: p.tenantId,
      action: 'budget.set',
      target: useCase,
      payload: { scope: 'use_case', monthlyBudgetUsd },
    });
  }

  async removeUseCaseBudget(p: Principal, useCase: string): Promise<void> {
    const removed = await this.ctx.db
      .delete(useCaseBudgets)
      .where(and(eq(useCaseBudgets.tenantId, p.tenantId), eq(useCaseBudgets.useCase, useCase)))
      .returning({ id: useCaseBudgets.id });
    if (removed.length === 0) throw notFound('use case budget');
    await this.audit.append({
      actor: p.userId,
      tenantId: p.tenantId,
      action: 'budget.removed',
      target: useCase,
      payload: { scope: 'use_case' },
    });
  }
}
