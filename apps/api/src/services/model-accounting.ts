import { randomUUID } from 'node:crypto';
import {
  effectiveBudget,
  estimateOutputTokensFromBytes,
  outputFloorFromBytes,
  type Budget,
  type PriceEntry,
} from '@openagentix/core';
import type { StepInput } from '@openagentix/runners';
import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { modelReservations, runSteps, runs } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { AgentsService } from './agents.js';
import type { AuditService } from './audit.js';
import type { BudgetsService } from './budgets.js';
import { writeStepRows, type LedgerExtras } from './step-writer.js';

/**
 * Model call accounting (ADR 0009 section 4): a reservation of the worst-case cost before every
 * model call, settlement from measured usage afterwards, expiry of reservations nobody settled.
 *
 * All money is integer micro-USD. Prices are USD per million tokens, so `tokens * price` is
 * micro-USD; the arithmetic runs on BigInt and rounds up exactly once per call, so there is no
 * floating point drift and a reservation can never be smaller than the settled amount for the
 * same token counts.
 */

/** Advisory lock namespace (first key) of the per-tenant accounting lock. */
export const ACCOUNTING_LOCK_NS = 734_203;
/** Largest token count a ledger column holds; larger provider numbers are clamped. */
const MAX_TOKENS = 2_000_000_000;
/** Settled reservations are bookkeeping; the ledger keeps the money (ADR 0009 4.5). */
export const SETTLED_RETENTION_DAYS = 35;
const ACTIVE_RUN_STATUSES = ['running', 'awaiting_approval'];
const UNLIMITED = Number.POSITIVE_INFINITY;
const MICRO = 1_000_000n;

export interface ModelAccountingOptions {
  /** Active reservations per run node session (`OAX_MODEL_PROXY_MAX_CONCURRENT_PER_SESSION`). */
  maxConcurrentPerSession: number;
  /** Active reservations per tenant (`OAX_MODEL_PROXY_MAX_CONCURRENT_PER_TENANT`). */
  maxConcurrentPerTenant: number;
  /** Time a reservation outlives its call deadline before the reaper settles it. */
  graceMs: number;
  /** Call deadline when the caller names none (`OAX_MODEL_PROXY_MAX_CALL_SECONDS`). */
  defaultDeadlineMs: number;
  /**
   * Price of a model for the run's scope: the platform table plus the price overrides of the run's
   * connections (BYOK) and the catalog provider of the connection. Without it the platform table
   * (`ctx.costModel`) is used as is.
   */
  priceFor?: (
    scope: { tenantId: string; teamId: string | null; agentId: string },
    provider: string,
    model: string,
  ) => Promise<PriceEntry | undefined>;
}

/** Defaults; the control node binds them from the `OAX_MODEL_PROXY_*` config block (services/index.ts). */
export const DEFAULT_ACCOUNTING_OPTIONS: ModelAccountingOptions = {
  maxConcurrentPerSession: 2,
  maxConcurrentPerTenant: 16,
  graceMs: 60_000,
  defaultDeadlineMs: 600_000,
};

/** The tenant a caller acts for. Everything here is scoped to it; other tenants' rows do not exist. */
export interface AccountingScope {
  tenantId: string;
}

export interface ReserveRequest {
  runId: string;
  /** Id of the step agent inside the published definition. Provider and model come from it. */
  agentId: string;
  /** Run node session of a proxied call; omit for in-process calls. */
  sessionId?: string | null;
  /** Upper bound of the input tokens (ADR 0009 4.3). */
  inputTokens: number;
  /** Largest output the call may produce (the value forced as the provider's max-tokens). */
  maxOutputTokens: number;
  /**
   * Shrink `maxOutputTokens` to what the tightest budget can pay instead of refusing, as long as
   * at least this many tokens remain (`OAX_MODEL_PROXY_MIN_OUTPUT_TOKENS`). Decided inside the
   * lock, so concurrent calls cannot both claim the same headroom.
   */
  minOutputTokens?: number;
  /** `cache_control` blocks present: the input is priced at the cache-write rate if higher. */
  cacheWrite?: boolean;
  deadlineMs?: number;
}

export interface Remaining {
  costMicros?: number;
  tokens?: number;
  modelCalls?: number;
}

export interface Reservation {
  reservationId: string;
  provider: string;
  model: string;
  reservedMicros: number;
  reservedInputTokens: number;
  /** The granted output bound (possibly lower than requested when `minOutputTokens` was set). */
  reservedOutputTokens: number;
  priced: boolean;
  /** Call deadline the reservation was sized for (the expiry adds the grace on top). */
  deadlineMs: number;
  expiresAt: Date;
  /** Tightest remaining headroom after this reservation. */
  remaining: Remaining;
}

export interface UsageReport {
  /** Input tokens that were NOT served from or written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface SettleRequest {
  /** Provider-reported usage; absent or invalid falls back to the estimate. */
  usage?: UsageReport | null | undefined;
  /** Measured output, for the estimator fallback and the lower bound. */
  output?: { textBytes: number; toolArgBytes?: number };
  status?: 'ok' | 'error';
  via?: LedgerExtras['via'];
  /** Stored on the step record (scrubbed of broker secrets by `settle` before its transaction). */
  detail?: { input?: unknown; output?: unknown; durationMs?: number };
  /** Reason of an aborted call, written to `model.aborted` by the proxy (not by this service). */
  note?: string;
  /**
   * Metadata merged into the `step.model_call` audit payload (latency, stop reason, node id, request
   * digest: names and numbers only, never content). Cannot override the accounting fields.
   */
  auditExtra?: Record<string, string | number | boolean | null>;
}

export interface Settlement {
  reservationId: string;
  status: 'settled' | 'expired';
  costMicros: number;
  tokensIn: number;
  tokensOut: number;
  usageSource: LedgerExtras['usageSource'];
  /** True when the reservation was already closed: nothing was written this time. */
  alreadyClosed: boolean;
}

export type ReservationRow = typeof modelReservations.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Integer money arithmetic. The price entries are those of `CostModel` (including the optional
// cache prices of W1-3b-1).

interface PriceLike {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

/** Prices in nano-USD per token (USD per million tokens times 1e6), as exact integers. */
export interface Rates {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
}

const scaled = (usdPerMTok: number): bigint => BigInt(Math.max(0, Math.round(usdPerMTok * 1e6)));

/** Without explicit prices cache reads cost as input and cache writes 1.25 x input. */
export function ratesOf(p: PriceLike): Rates {
  const input = scaled(p.inputPerMTok);
  return {
    input,
    output: scaled(p.outputPerMTok),
    cacheRead: p.cacheReadPerMTok === undefined ? input : scaled(p.cacheReadPerMTok),
    cacheWrite:
      p.cacheWritePerMTok === undefined ? (input * 5n + 3n) / 4n : scaled(p.cacheWritePerMTok),
  };
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

function toSafeNumber(v: bigint): number {
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
}

/** Micro-USD of a call, rounded up once: `ceil(sum(tokens * rate) / 1e6)`. */
export function priceMicros(rates: Rates, t: Tokens): number {
  const sum =
    BigInt(t.input) * rates.input +
    BigInt(t.output) * rates.output +
    BigInt(t.cacheRead ?? 0) * rates.cacheRead +
    BigInt(t.cacheWrite ?? 0) * rates.cacheWrite;
  return toSafeNumber(ceilDiv(sum, MICRO));
}

/** Worst-case input rate: the cache-write rate when it is higher and the request caches. */
const inputRate = (r: Rates, cacheWrite: boolean) =>
  cacheWrite && r.cacheWrite > r.input ? r.cacheWrite : r.input;

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_TOKENS;

function validUsage(u: UsageReport | null | undefined): u is UsageReport {
  return (
    !!u &&
    isCount(u.inputTokens) &&
    isCount(u.outputTokens) &&
    (u.cacheReadTokens === undefined || isCount(u.cacheReadTokens)) &&
    (u.cacheWriteTokens === undefined || isCount(u.cacheWriteTokens))
  );
}

const clampTokens = (n: number) => Math.min(Math.max(0, n), MAX_TOKENS);

// ---------------------------------------------------------------------------------------------

type Code =
  | 'control_budget_tokens'
  | 'control_budget_cost'
  | 'control_budget_steps'
  | 'control_budget_tenant'
  | 'control_budget_use_case'
  | 'control_budget_team';

interface Limit {
  code: Code;
  kind: 'cost' | 'tokens' | 'calls';
  /** What the limit applies to, for the refusal message. */
  label: string;
  /** Spent plus active reservations. */
  used: number;
  limit: number;
  /** Monthly scopes block as soon as the spend reaches the limit (existing hard-stop rule). */
  blockAtLimit: boolean;
}

const sumBy = <T>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);

/**
 * Reservation, settlement and expiry of model call cost. One instance per control node; all state
 * is in the database, so any number of control node replicas share the guarantees.
 */
export class ModelAccountingService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
    private readonly budgets: BudgetsService,
    /** Scrubs broker secrets from step payloads (RunNodesService.scrub). */
    private readonly scrub: <T>(runId: string, value: T) => Promise<T> = async (_r, v) => v,
    private readonly options: ModelAccountingOptions = DEFAULT_ACCOUNTING_OPTIONS,
  ) {}

  private lockTenant(tx: Db, tenantId: string) {
    return tx.execute(
      sql`select pg_advisory_xact_lock(${ACCOUNTING_LOCK_NS}::int, hashtext(${tenantId}))`,
    );
  }

  /**
   * Reserves the worst-case cost of one model call against every limit that applies, or refuses.
   * One transaction under a per-tenant advisory lock: concurrent reservations of a tenant queue up
   * behind each other, so the sum of settled and reserved cost of any scope never exceeds its limit.
   */
  async reserve(scope: AccountingScope, req: ReserveRequest): Promise<Reservation> {
    if (!isCount(req.inputTokens) || !isCount(req.maxOutputTokens) || req.maxOutputTokens < 1) {
      throw new HttpError(400, 'model_request_invalid', 'token bounds must be positive integers');
    }
    if (
      req.minOutputTokens !== undefined &&
      !(isCount(req.minOutputTokens) && req.minOutputTokens >= 1)
    ) {
      throw new HttpError(
        400,
        'model_request_invalid',
        'minOutputTokens must be a positive integer',
      );
    }
    // The price is resolved before the transaction opens (it reads connections; never a second
    // query path while the tenant lock is held).
    const price = await this.priceForRun(scope, req.runId, req.agentId);
    const result = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await this.lockTenant(tx, scope.tenantId);
      return this.reserveLocked(tx, scope, req, price);
    });
    return result;
  }

  /** Price of the step's model for the run's scope, or `undefined` (unpriced / run unknown). */
  private async priceForRun(
    scope: AccountingScope,
    runId: string,
    agentId: string,
  ): Promise<PriceEntry | undefined> {
    const hook = this.options.priceFor;
    if (!hook) return undefined;
    try {
      const [run] = await this.ctx.db
        .select({
          teamId: runs.teamId,
          versionId: runs.agentVersionId,
          agentId: runs.agentId,
        })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.tenantId, scope.tenantId)));
      if (!run) return undefined;
      const { definition } = await this.agents.definitionOf(run.versionId);
      const agent = definition.agents.find((a) => a.id === agentId);
      if (!agent) return undefined;
      return await hook(
        { tenantId: scope.tenantId, teamId: run.teamId, agentId: run.agentId },
        agent.provider,
        agent.model,
      );
    } catch (err) {
      // The transaction reports the real problem (unknown run, agent not published, ...); the
      // warning makes a broken price lookup visible (names only, no secrets).
      this.ctx.logger.warn(
        { err: err instanceof Error ? err.message : String(err), runId, agentId },
        'could not resolve the model price for a run',
      );
      return undefined;
    }
  }

  private async reserveLocked(
    tx: Db,
    scope: AccountingScope,
    req: ReserveRequest,
    resolvedPrice?: PriceEntry,
  ): Promise<Reservation> {
    const [run] = await tx
      .select({
        tenantId: runs.tenantId,
        teamId: runs.teamId,
        versionId: runs.agentVersionId,
        status: runs.status,
        costMicros: runs.costMicros,
        tokensIn: runs.tokensIn,
        tokensOut: runs.tokensOut,
      })
      .from(runs)
      .where(and(eq(runs.id, req.runId), eq(runs.tenantId, scope.tenantId)));
    // Another tenant's run looks exactly like a missing one.
    if (!run) throw notFound('run');
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
      throw new HttpError(409, 'invalid_state', 'run is not active');
    }
    const { definition } = await this.agents.definitionOf(run.versionId);
    const agent = definition.agents.find((a) => a.id === req.agentId);
    if (!agent) {
      throw new HttpError(
        403,
        'model_not_allowed',
        'agent is not part of the published definition',
      );
    }
    const useCase = definition.labels.useCase ?? null;
    const price = resolvedPrice ?? this.ctx.costModel.find(agent.provider, agent.model);
    const rates = price ? ratesOf(price) : null;
    const runBudget = definition.budget as Budget;
    const stepBudget = effectiveBudget(runBudget, agent.budget);

    const active = await tx
      .select()
      .from(modelReservations)
      .where(
        and(eq(modelReservations.tenantId, scope.tenantId), eq(modelReservations.status, 'active')),
      );
    const [agentSpend] = await tx
      .select({
        cost: sql<number>`coalesce(sum(${runSteps.costMicros}), 0)::bigint`,
        tokens: sql<number>`coalesce(sum(${runSteps.tokensIn} + ${runSteps.tokensOut}), 0)::bigint`,
        calls: sql<number>`count(*) filter (where ${runSteps.kind} = 'model_call')::int`,
      })
      .from(runSteps)
      .where(and(eq(runSteps.runId, req.runId), eq(runSteps.agentId, req.agentId)));

    const ofRun = active.filter((r) => r.runId === req.runId);
    const ofAgent = ofRun.filter((r) => r.agentId === req.agentId);
    const reservedCost = (rows: ReservationRow[]) => sumBy(rows, (r) => Number(r.reservedMicros));
    const reservedTokens = (rows: ReservationRow[]) =>
      sumBy(rows, (r) => r.reservedInputTokens + r.reservedOutputTokens);

    const limits: Limit[] = [];
    const costLimit = (usd: number) => Math.round(usd * 1_000_000);
    if (runBudget.maxCostUsd !== undefined) {
      limits.push({
        code: 'control_budget_cost',
        kind: 'cost',
        label: 'run cost budget',
        used: Number(run.costMicros) + reservedCost(ofRun),
        limit: costLimit(runBudget.maxCostUsd),
        blockAtLimit: false,
      });
    }
    if (runBudget.maxTokens !== undefined) {
      limits.push({
        code: 'control_budget_tokens',
        kind: 'tokens',
        label: 'run token budget',
        used: run.tokensIn + run.tokensOut + reservedTokens(ofRun),
        limit: runBudget.maxTokens,
        blockAtLimit: false,
      });
    }
    if (stepBudget.maxCostUsd !== undefined) {
      limits.push({
        code: 'control_budget_cost',
        kind: 'cost',
        label: 'step cost budget',
        used: Number(agentSpend?.cost ?? 0) + reservedCost(ofAgent),
        limit: costLimit(stepBudget.maxCostUsd),
        blockAtLimit: false,
      });
    }
    if (stepBudget.maxTokens !== undefined) {
      limits.push({
        code: 'control_budget_tokens',
        kind: 'tokens',
        label: 'step token budget',
        used: Number(agentSpend?.tokens ?? 0) + reservedTokens(ofAgent),
        limit: stepBudget.maxTokens,
        blockAtLimit: false,
      });
    }
    if (stepBudget.maxSteps !== undefined) {
      limits.push({
        code: 'control_budget_steps',
        kind: 'calls',
        label: 'step model call budget',
        used: Number(agentSpend?.calls ?? 0) + ofAgent.length,
        limit: stepBudget.maxSteps,
        blockAtLimit: true,
      });
    }
    const monthly = await this.budgets.scopeUsages(tx, {
      tenantId: scope.tenantId,
      teamId: run.teamId,
      useCase,
    });
    for (const u of monthly) {
      const rows =
        u.scope === 'tenant'
          ? active
          : u.scope === 'use_case'
            ? active.filter((r) => r.useCase === u.scopeKey)
            : active.filter((r) => r.teamId === u.scopeKey);
      limits.push({
        code:
          u.scope === 'tenant'
            ? 'control_budget_tenant'
            : u.scope === 'use_case'
              ? 'control_budget_use_case'
              : 'control_budget_team',
        kind: 'cost',
        label: `${u.scope.replace('_', ' ')} "${u.key}" monthly budget`,
        used: u.spentMicros + reservedCost(rows),
        limit: u.limitMicros,
        blockAtLimit: true,
      });
    }

    // A model without a price cannot be held to a cost limit: refuse instead of counting it as 0.
    if (!rates && limits.some((l) => l.kind === 'cost')) {
      throw new HttpError(
        422,
        'model_unpriced',
        `model ${agent.provider}/${agent.model} has no price and a cost limit applies`,
      );
    }

    const inRate = rates ? inputRate(rates, req.cacheWrite === true) : 0n;
    const outRate = rates?.output ?? 0n;
    const inputNano = BigInt(req.inputTokens) * inRate;
    // Largest output (in tokens) each limit still allows for this call; -1 refuses.
    const allowedBy = (l: Limit): number => {
      if (l.kind === 'calls') return l.used >= l.limit ? -1 : UNLIMITED;
      if (l.blockAtLimit && l.used >= l.limit) return -1;
      const room = l.limit - l.used;
      if (room < 0) return -1;
      if (l.kind === 'tokens') return room - req.inputTokens;
      const budgetNano = BigInt(room) * MICRO - inputNano;
      if (budgetNano < 0n) return -1;
      return outRate === 0n ? UNLIMITED : toSafeNumber(budgetNano / outRate);
    };
    let tightest: { limit: Limit; allowed: number } | null = null;
    for (const l of limits) {
      const allowed = allowedBy(l);
      if (!tightest || allowed < tightest.allowed) tightest = { limit: l, allowed };
    }
    let output = req.maxOutputTokens;
    if (tightest && tightest.allowed < output) {
      const floor = req.minOutputTokens;
      if (floor === undefined || tightest.allowed < floor) {
        throw new HttpError(
          403,
          tightest.limit.code,
          `${tightest.limit.label} cannot cover the call`,
          { limit: tightest.limit.label },
        );
      }
      output = tightest.allowed;
    }

    // Concurrency: the database is the counter, so the limits hold across replicas.
    if (
      req.sessionId &&
      active.filter((r) => r.sessionId === req.sessionId).length >=
        this.options.maxConcurrentPerSession
    ) {
      throw new HttpError(
        429,
        'model_rate_limited',
        'too many concurrent model calls in this session',
      );
    }
    if (active.length >= this.options.maxConcurrentPerTenant) {
      throw new HttpError(
        429,
        'model_rate_limited',
        'too many concurrent model calls in this tenant',
      );
    }

    const reservedMicros = rates
      ? toSafeNumber(ceilDiv(inputNano + BigInt(output) * outRate, MICRO))
      : 0;
    const now = this.ctx.now();
    const deadlineMs = req.deadlineMs ?? this.options.defaultDeadlineMs;
    const expiresAt = new Date(now.getTime() + deadlineMs + this.options.graceMs);
    const id = randomUUID();
    await tx.insert(modelReservations).values({
      id,
      tenantId: scope.tenantId,
      runId: req.runId,
      sessionId: req.sessionId ?? null,
      agentId: req.agentId,
      teamId: run.teamId,
      useCase,
      provider: agent.provider,
      model: agent.model,
      reservedMicros,
      reservedInputTokens: req.inputTokens,
      reservedOutputTokens: output,
      status: 'active',
      createdAt: now,
      expiresAt,
    });

    const remaining: Remaining = {};
    for (const l of limits) {
      if (l.kind === 'cost') {
        const r = Math.max(0, l.limit - l.used - reservedMicros);
        remaining.costMicros = Math.min(remaining.costMicros ?? r, r);
      } else if (l.kind === 'tokens') {
        const r = Math.max(0, l.limit - l.used - req.inputTokens - output);
        remaining.tokens = Math.min(remaining.tokens ?? r, r);
      } else {
        const r = Math.max(0, l.limit - l.used - 1);
        remaining.modelCalls = Math.min(remaining.modelCalls ?? r, r);
      }
    }
    return {
      reservationId: id,
      provider: agent.provider,
      model: agent.model,
      reservedMicros,
      reservedInputTokens: req.inputTokens,
      reservedOutputTokens: output,
      priced: rates !== null,
      deadlineMs,
      expiresAt,
      remaining,
    };
  }

  /**
   * Settles a reservation from measured usage: one transaction writes the `model_call` step, the
   * ledger line, run counters, budget alerts and audit entries and closes the reservation. Calling
   * it again for a closed reservation changes nothing and reports the recorded outcome.
   */
  async settle(
    scope: AccountingScope,
    reservationId: string,
    req: SettleRequest = {},
  ): Promise<Settlement> {
    // Scrubbing reads the database (the broker's sessions): done before the transaction opens, never
    // inside it (a second connection while holding the tenant lock, and a deadlock on single
    // connection databases such as PGlite).
    const [row] = await this.ctx.db
      .select({
        runId: modelReservations.runId,
        agentId: modelReservations.agentId,
      })
      .from(modelReservations)
      .where(
        and(
          eq(modelReservations.id, reservationId),
          eq(modelReservations.tenantId, scope.tenantId),
        ),
      );
    let clean = req;
    if (row && req.detail) {
      const { input, output } = req.detail;
      clean = {
        ...req,
        detail: {
          ...req.detail,
          ...(input !== undefined ? { input: await this.scrub(row.runId, input) } : {}),
          ...(output !== undefined ? { output: await this.scrub(row.runId, output) } : {}),
        },
      };
    }
    const price = row ? await this.priceForRun(scope, row.runId, row.agentId) : undefined;
    const out = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await this.lockTenant(tx, scope.tenantId);
      return this.closeLocked(tx, scope.tenantId, reservationId, clean, false, price);
    });
    if (out.metric)
      this.ctx.metrics.costMicros.inc({ provider: out.metric.provider }, out.metric.costMicros);
    return out.settlement;
  }

  /**
   * Gives a reservation back after a call that failed before any generation (a 4xx from the
   * provider, a connect error): settled at zero with an error step, so the headroom returns at once.
   */
  release(scope: AccountingScope, reservationId: string, note?: string): Promise<Settlement> {
    return this.settle(scope, reservationId, {
      usage: { inputTokens: 0, outputTokens: 0 },
      status: 'error',
      ...(note ? { note, detail: { output: { message: note } } } : {}),
    });
  }

  private async closeLocked(
    tx: Db,
    tenantId: string,
    reservationId: string,
    req: SettleRequest,
    expire: boolean,
    resolvedPrice?: PriceEntry,
  ): Promise<{ settlement: Settlement; metric: { provider: string; costMicros: number } | null }> {
    const [r] = await tx
      .select()
      .from(modelReservations)
      .where(and(eq(modelReservations.id, reservationId), eq(modelReservations.tenantId, tenantId)))
      .for('update');
    if (!r) throw notFound('reservation');
    if (r.status !== 'active') {
      return {
        settlement: {
          reservationId,
          status: r.status as 'settled' | 'expired',
          costMicros: Number(r.actualMicros ?? 0),
          tokensIn: 0,
          tokensOut: 0,
          usageSource: r.status === 'expired' ? 'reservation' : 'provider',
          alreadyClosed: true,
        },
        metric: null,
      };
    }
    const price = resolvedPrice ?? this.ctx.costModel.find(r.provider, r.model);
    const rates = price ? ratesOf(price) : null;
    const reserved = Number(r.reservedMicros);
    const via = req.via ?? (r.sessionId ? 'proxy' : 'in-process');
    const outBytes = req.output ? req.output.textBytes + (req.output.toolArgBytes ?? 0) : null;

    let t: Required<Tokens>;
    let source: LedgerExtras['usageSource'];
    let floorHit = false;
    if (expire) {
      // Conservative on purpose: the provider may have billed.
      t = {
        input: r.reservedInputTokens,
        output: r.reservedOutputTokens,
        cacheRead: 0,
        cacheWrite: 0,
      };
      source = 'reservation';
    } else if (validUsage(req.usage)) {
      t = {
        input: req.usage.inputTokens,
        output: req.usage.outputTokens,
        cacheRead: req.usage.cacheReadTokens ?? 0,
        cacheWrite: req.usage.cacheWriteTokens ?? 0,
      };
      source = 'provider';
      // Lower bound against an endpoint that reports implausibly little (ADR 0009 4.1, A5).
      if (outBytes !== null && t.output < outputFloorFromBytes(outBytes)) {
        t.output = clampTokens(outputFloorFromBytes(outBytes));
        source = 'floor';
        floorHit = true;
      }
    } else {
      // Nothing usable reported: input as reserved, output measured, or as reserved if unmeasured.
      t = {
        input: r.reservedInputTokens,
        output:
          outBytes === null
            ? r.reservedOutputTokens
            : clampTokens(estimateOutputTokensFromBytes(outBytes)),
        cacheRead: 0,
        cacheWrite: 0,
      };
      source = 'estimated';
    }
    const cost = expire ? reserved : rates ? priceMicros(rates, t) : 0;
    const tokensIn = clampTokens(t.input + t.cacheRead + t.cacheWrite);
    const status = expire ? 'error' : (req.status ?? 'ok');
    const name = `${r.provider}/${r.model}`;
    const detail = req.detail ?? {};
    const step: StepInput = {
      kind: 'model_call',
      agentId: r.agentId,
      name,
      status,
      ...(detail.input !== undefined ? { input: detail.input } : {}),
      ...(expire
        ? { output: { reason: 'reservation_expired' } }
        : detail.output !== undefined
          ? { output: detail.output }
          : {}),
      tokensIn,
      tokensOut: t.output,
      costMicros: cost,
      ...(detail.durationMs !== undefined ? { durationMs: detail.durationMs } : {}),
      provider: r.provider,
      model: r.model,
    };
    const written = await writeStepRows(
      { ctx: this.ctx, agents: this.agents, budgets: this.budgets },
      tx,
      r.runId,
      step,
      {
        ledger: {
          usageSource: source,
          cacheReadTokens: t.cacheRead,
          cacheWriteTokens: t.cacheWrite,
          reservationId: r.id,
          via,
        },
      },
    );
    const now = this.ctx.now();
    await tx
      .update(modelReservations)
      .set({ status: expire ? 'expired' : 'settled', actualMicros: cost, settledAt: now })
      .where(eq(modelReservations.id, r.id));

    const base = { callId: r.id, provider: r.provider, model: r.model, agentId: r.agentId };
    const append = (action: string, payload: Record<string, unknown>) =>
      this.audit.append(
        { actor: 'system', tenantId, action, target: name, runId: r.runId, payload },
        tx,
      );
    await append(`step.model_call`, {
      ...(req.auditExtra ?? {}),
      ...base,
      status,
      tokensIn,
      tokensOut: t.output,
      cacheReadTokens: t.cacheRead,
      cacheWriteTokens: t.cacheWrite,
      costMicros: cost,
      usageSource: source,
      via,
    });
    if (expire) {
      await append('model.reservation_expired', { ...base, reservedMicros: reserved });
    } else {
      if (floorHit) {
        await append('model.usage_floor', {
          ...base,
          reportedOutputTokens: req.usage?.outputTokens ?? 0,
          flooredOutputTokens: t.output,
        });
      }
      if (cost > reserved) {
        await append('model.overrun', { ...base, reservedMicros: reserved, actualMicros: cost });
      }
    }
    return {
      settlement: {
        reservationId,
        status: expire ? 'expired' : 'settled',
        costMicros: cost,
        tokensIn,
        tokensOut: t.output,
        usageSource: source,
        alreadyClosed: false,
      },
      metric: written.metric,
    };
  }

  /**
   * Settles every reservation whose deadline passed at the reserved amount (a crashed worker or
   * node never reported). Called by the worker's scheduling loop; safe to run on every replica.
   * Returns the number of reservations expired.
   */
  async expire(limit = 100): Promise<number> {
    const overdue = await this.ctx.db
      .select({ id: modelReservations.id, tenantId: modelReservations.tenantId })
      .from(modelReservations)
      .where(
        and(
          eq(modelReservations.status, 'active'),
          lte(modelReservations.expiresAt, this.ctx.now()),
        ),
      )
      .orderBy(asc(modelReservations.expiresAt))
      .limit(limit);
    let n = 0;
    for (const o of overdue) {
      try {
        const out = await this.ctx.db.transaction(async (t) => {
          const tx = t as unknown as Db;
          await this.lockTenant(tx, o.tenantId);
          return this.closeLocked(tx, o.tenantId, o.id, {}, true);
        });
        if (!out.settlement.alreadyClosed) {
          n++;
          if (out.metric)
            this.ctx.metrics.costMicros.inc(
              { provider: out.metric.provider },
              out.metric.costMicros,
            );
        }
      } catch (err) {
        // One bad row must not stop the others; it is retried on the next round.
        this.ctx.logger.warn({ err, reservationId: o.id }, 'could not expire model reservation');
      }
    }
    return n;
  }

  /** Deletes settled and expired reservations older than the retention (the ledger keeps the money). */
  async purge(): Promise<number> {
    const cutoff = new Date(this.ctx.now().getTime() - SETTLED_RETENTION_DAYS * 86_400_000);
    const gone = await this.ctx.db
      .delete(modelReservations)
      .where(
        and(
          inArray(modelReservations.status, ['settled', 'expired']),
          lt(modelReservations.settledAt, cutoff),
        ),
      )
      .returning({ id: modelReservations.id });
    return gone.length;
  }

  /** Reservations of one tenant (never another's); for the proxy, diagnostics and tests. */
  async list(
    scope: AccountingScope,
    filter: { runId?: string; status?: 'active' | 'settled' | 'expired' } = {},
  ): Promise<ReservationRow[]> {
    return this.ctx.db
      .select()
      .from(modelReservations)
      .where(
        and(
          eq(modelReservations.tenantId, scope.tenantId),
          filter.runId ? eq(modelReservations.runId, filter.runId) : undefined,
          filter.status ? eq(modelReservations.status, filter.status) : undefined,
        ),
      )
      .orderBy(asc(modelReservations.createdAt));
  }
}
