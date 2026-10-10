import type { StepInput } from '@openagentix/runners';
import { eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { costLedger, runSteps, runs } from '../db/schema.js';
import { notFound } from '../errors.js';
import type { AgentsService } from './agents.js';
import type { BudgetsService } from './budgets.js';
import { monthOf } from './runs.js';

/** What the ledger records about where a line's numbers came from (migration 0010). */
export interface LedgerExtras {
  usageSource: 'provider' | 'estimated' | 'floor' | 'reservation';
  /** Breakdown of `tokensIn`; cache tokens are part of the input total. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reservationId: string | null;
  via: 'in-process' | 'proxy' | 'harness-report';
}

export const DEFAULT_LEDGER_EXTRAS: LedgerExtras = {
  usageSource: 'provider',
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reservationId: null,
  via: 'in-process',
};

/**
 * What the caller records after the transaction commits (cost and token counters, ADR 0015 S5).
 * `provider` is the provider **instance** name as stored on the step: for a tenant connection that
 * is tenant-chosen text. It is resolved to a family label by the consumers
 * (`recordStepMetric`) and is never a label itself.
 */
export interface StepMetric {
  /** Provider instance name of the step; `null` for a cost line without a model provider (tools). */
  provider: string | null;
  costMicros: number;
  /** Tenant, team and agent of the run: the scope that resolves the provider instance. */
  scope: { tenantId: string; teamId: string | null; agentId: string };
  /** Present for steps that carry model tokens (`input` excludes cache tokens). */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  via: LedgerExtras['via'];
  model: string | null;
  /** Reported duration of the step, when there is one (seconds). */
  seconds: number | null;
  failed: boolean;
}

export interface StepWriteResult {
  /** Cost and tokens of the step; the caller records the metrics after commit. */
  metric: StepMetric | null;
}

/**
 * Writes one step inside the caller's transaction: run counters, `run_steps` row, `cost_ledger`
 * line (when the step has cost or tokens) and the budget alerts it causes. Shared by the trusted
 * `recordStep` path and by model call settlement so both produce identical rows.
 */
export async function writeStepRows(
  deps: { ctx: AppContext; agents: AgentsService; budgets: BudgetsService },
  tx: Db,
  runId: string,
  step: StepInput,
  opts: { reportedBy?: string | null; ledger?: Partial<LedgerExtras> } = {},
): Promise<StepWriteResult> {
  const { ctx } = deps;
  const [run] = await tx
    .update(runs)
    .set({
      lastSeq: sql`${runs.lastSeq} + 1`,
      tokensIn: sql`${runs.tokensIn} + ${step.tokensIn ?? 0}`,
      tokensOut: sql`${runs.tokensOut} + ${step.tokensOut ?? 0}`,
      costMicros: sql`${runs.costMicros} + ${step.costMicros ?? 0}`,
      toolCalls: sql`${runs.toolCalls} + ${step.kind === 'tool_call' ? 1 : 0}`,
    })
    .where(eq(runs.id, runId))
    .returning({
      seq: runs.lastSeq,
      agentId: runs.agentId,
      teamId: runs.teamId,
      tenantId: runs.tenantId,
      versionId: runs.agentVersionId,
    });
  if (!run) throw notFound('run');
  await tx.insert(runSteps).values({
    runId,
    seq: run.seq,
    kind: step.kind,
    agentId: step.agentId,
    name: step.name,
    status: step.status,
    input: (step.input ?? null) as object,
    output: (step.output ?? null) as object,
    tokensIn: step.tokensIn ?? 0,
    tokensOut: step.tokensOut ?? 0,
    costMicros: step.costMicros ?? 0,
    durationMs: step.durationMs ?? null,
    provider: step.provider ?? null,
    model: step.model ?? null,
    reportedBy: opts.reportedBy ?? null,
    createdAt: ctx.now(),
  });
  if ((step.costMicros ?? 0) <= 0 && (step.tokensIn ?? 0) <= 0 && (step.tokensOut ?? 0) <= 0) {
    return { metric: null };
  }
  const { definition } = await deps.agents.definitionOf(run.versionId);
  const extras = { ...DEFAULT_LEDGER_EXTRAS, ...opts.ledger };
  await tx.insert(costLedger).values({
    runId,
    stepSeq: run.seq,
    tenantId: run.tenantId,
    useCase: definition.labels.useCase ?? null,
    agentId: run.agentId,
    teamId: run.teamId,
    provider: step.provider ?? null,
    model: step.model ?? null,
    month: monthOf(ctx.now()),
    tokensIn: step.tokensIn ?? 0,
    tokensOut: step.tokensOut ?? 0,
    costMicros: step.costMicros ?? 0,
    ...extras,
  });
  // Alerts at 50/80/100 % of every budget this cost line counts against.
  await deps.budgets.raiseAlerts(
    tx,
    { tenantId: run.tenantId, teamId: run.teamId, useCase: definition.labels.useCase ?? null },
    step.costMicros ?? 0,
  );
  const cacheRead = extras.cacheReadTokens;
  const cacheWrite = extras.cacheWriteTokens;
  const hasTokens =
    step.provider !== undefined && ((step.tokensIn ?? 0) > 0 || (step.tokensOut ?? 0) > 0);
  return {
    metric: {
      provider: step.provider ?? null,
      costMicros: step.costMicros ?? 0,
      scope: { tenantId: run.tenantId, teamId: run.teamId, agentId: run.agentId },
      tokens: hasTokens
        ? {
            input: Math.max(0, (step.tokensIn ?? 0) - cacheRead - cacheWrite),
            output: step.tokensOut ?? 0,
            cacheRead,
            cacheWrite,
          }
        : null,
      via: extras.via,
      model: step.model ?? null,
      seconds: step.durationMs !== undefined ? step.durationMs / 1000 : null,
      failed: step.status !== 'ok',
    },
  };
}
