import { randomUUID } from 'node:crypto';
import type { OaxError } from '@openagentix/core';
import {
  evaluateToolCall,
  issueRunToken,
  auditShapeOfReport,
  stepAuditEntry,
  verifyRunToken,
  type AgentDefinition,
  type OaxEvent,
  type PublishedDefinition,
  type PolicyDecision,
  type RunTokenClaims,
  type ToolCallRequest,
} from '@openagentix/core';
import type {
  ApprovalOutcome,
  ControlPlane,
  ModelReservationGrant,
  ModelReservationRequest,
  PreparedRun,
  RunResult,
  StepInput,
} from '@openagentix/runners';
import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { approvals, events, runSteps, runs } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { AgentsService } from './agents.js';
import type { AuditService } from './audit.js';
import type { BudgetsService } from './budgets.js';
import type { CatalogService } from './catalog.js';
import type { GuidelinesService } from './guidelines.js';
import type { ModelAccountingService } from './model-accounting.js';
import type { RunNodesService } from './run-nodes.js';
import { writeStepRows } from './step-writer.js';

const ACTIVE = ['running', 'awaiting_approval'];
/** Largest input or output a run node may attach to one step record. */
const NODE_STEP_MAX_BYTES = 64 * 1024;
/** Step kinds a run node may report. */
const NODE_STEP_KINDS: ReadonlySet<string> = new Set(['tool_call', 'output', 'error']);
/** The one control step a node may report: what its context guard removed (counts only). */
const isNodeGuardStep = (s: StepInput): boolean => s.kind === 'control' && s.name === 'input_guard';
/** Values of `source` in a guard step; anything else from a node is dropped. */
const GUARD_SOURCES: ReadonlySet<string> = new Set(['input', 'tool_result', 'tool_error']);
/** Shape of an MCP tool name (spec: letters, digits, `_`, `-`, `.`, at most 128). */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The control node side of the worker contract. Every method is scoped by a signed run token,
 * whether the worker is in-process (direct call) or remote (HTTP routes under /v1/worker).
 */
export class ControlPlaneService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
    private readonly catalog: CatalogService,
    private readonly budgets: BudgetsService,
    private readonly nodes: RunNodesService,
    private readonly guidelines?: GuidelinesService,
    /** Reservation and settlement of model calls (ADR 0009 section 4.4); absent in unit tests. */
    private readonly accounting?: ModelAccountingService,
  ) {}

  /** Policy bundles + the hardening agent's guideline bundle (stricter only). */
  private async bundlesFor(definition: AgentDefinition, tenantId: string) {
    const bundles = await this.catalog.enabledBundles(tenantId);
    const g = await this.guidelines?.bundleFor(definition, tenantId);
    return g ? [...bundles, g] : bundles;
  }

  issueToken(runId: string, workerId: string): string {
    return issueRunToken(
      this.ctx.config.runToken.secret,
      { runId, workerId, ttlSeconds: this.ctx.config.runToken.ttlSeconds },
      this.ctx.now().getTime(),
    );
  }

  /** Verifies the token and that the run is currently leased by that worker. */
  async authorize(token: string, runId: string): Promise<RunTokenClaims> {
    let claims: RunTokenClaims;
    try {
      claims = verifyRunToken(this.ctx.config.runToken.secret, token, this.ctx.now().getTime());
    } catch (e) {
      throw new HttpError(401, (e as OaxError).code, (e as Error).message);
    }
    if (claims.runId !== runId)
      throw new HttpError(403, 'forbidden', 'run token is not valid for this run');
    // Step-scoped token of an isolated run node: the session must be live; the lease belongs to
    // the orchestrator, so the lockedBy check below does not apply to it.
    if (claims.sid) {
      await this.nodes.checkSession(claims, runId);
      return claims;
    }
    const [run] = await this.ctx.db
      .select({ status: runs.status, lockedBy: runs.lockedBy })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run || !ACTIVE.includes(run.status) || run.lockedBy !== claims.workerId) {
      throw new HttpError(409, 'invalid_state', 'run is not active for this worker');
    }
    return claims;
  }

  /** {@link authorize} plus the step scope: a node token may only act for its own steps. */
  async authorizeStep(
    token: string,
    runId: string,
    agentId: string | null,
  ): Promise<RunTokenClaims> {
    const claims = await this.authorize(token, runId);
    if (claims.sid) {
      if (agentId === null)
        throw new HttpError(403, 'credential_scope', 'a run node must name the agent it acts for');
      this.nodes.assertStep(claims, agentId);
    }
    return claims;
  }

  /** Like {@link authorizeStep}, but only for step-scoped (run node) tokens. */
  async authorizeNodeStep(token: string, runId: string, agentId: string): Promise<RunTokenClaims> {
    const claims = await this.authorizeStep(token, runId, agentId);
    if (!claims.sid)
      throw new HttpError(403, 'credential_scope', 'a step-scoped run node token is required');
    return claims;
  }

  /** Only the trusted worker that holds the lease may complete a run, never a run node. */
  async authorizeOrchestrator(token: string, runId: string): Promise<RunTokenClaims> {
    const claims = await this.authorize(token, runId);
    if (claims.sid)
      throw new HttpError(403, 'forbidden', 'a run node token cannot perform this operation');
    return claims;
  }

  /** A ControlPlane bound to one run token (what runners use). */
  forToken(token: string): ControlPlane {
    return {
      decideToolCall: async (runId, agentId, call) => (
        await this.authorize(token, runId),
        this.decide(runId, agentId, call)
      ),
      recordStep: async (runId, step) => (
        await this.authorize(token, runId),
        this.recordStep(runId, step)
      ),
      awaitApproval: async (runId, agentId, call, decision, signal) => {
        const claims = await this.authorize(token, runId);
        return this.awaitApproval(runId, claims.workerId, agentId, call, decision, signal);
      },
      isCancelled: async (runId) => (await this.authorize(token, runId), this.isCancelled(runId)),
      checkBudget: async (runId) => (
        await this.authorize(token, runId),
        this.budgets.verdictForRun(runId)
      ),
      reserveModelCall: async (runId, req) => (
        await this.authorizeOrchestrator(token, runId),
        this.reserveModelCall(runId, req)
      ),
      completeRun: async (runId, result) => (
        await this.authorize(token, runId),
        this.completeRun(runId, result)
      ),
    };
  }

  /**
   * Reserves the worst-case cost of an in-process model call (ADR 0009 section 4.4): the same
   * reservation as the model proxy makes for a run node, so the monthly and run budgets hold across
   * concurrent runs. Refusals carry the `control_budget_*` / `model_unpriced` codes.
   */
  async reserveModelCall(
    runId: string,
    req: ModelReservationRequest,
  ): Promise<ModelReservationGrant> {
    if (!this.accounting)
      throw new HttpError(503, 'model_proxy_unavailable', 'model accounting is not available');
    const [run] = await this.ctx.db
      .select({ tenantId: runs.tenantId })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run) throw notFound('run');
    const r = await this.accounting.reserve(
      { tenantId: run.tenantId },
      {
        runId,
        agentId: req.agentId,
        inputTokens: req.inputTokens,
        maxOutputTokens: req.maxOutputTokens,
        ...(req.minOutputTokens !== undefined ? { minOutputTokens: req.minOutputTokens } : {}),
        ...(req.cacheWrite ? { cacheWrite: true } : {}),
      },
    );
    return {
      reservationId: r.reservationId,
      maxOutputTokens: r.reservedOutputTokens,
      reservedMicros: r.reservedMicros,
      priced: r.priced,
      deadlineMs: r.deadlineMs,
      remaining: r.remaining,
    };
  }

  /**
   * Counters of the run as written by the ledger (proxy settlements and trusted steps). The
   * dispatcher reads them after a node step: they, and never the node's report, are authoritative.
   */
  async runUsage(
    runId: string,
  ): Promise<{ tokensIn: number; tokensOut: number; costMicros: number }> {
    const [r] = await this.ctx.db
      .select({ i: runs.tokensIn, o: runs.tokensOut, c: runs.costMicros })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!r) throw notFound('run');
    return { tokensIn: Number(r.i), tokensOut: Number(r.o), costMicros: Number(r.c) };
  }

  /**
   * A trusted `model_call` (or the `error` of a failed call) that carries a reservation settles it:
   * the accounting service computes the cost from the usage and writes step, ledger and audit entry.
   * Returns false when the step is not tied to a reservation and must be written the normal way.
   */
  private async settleReserved(runId: string, step: StepInput): Promise<boolean> {
    if (!step.reservationId || (step.kind !== 'model_call' && step.kind !== 'error')) return false;
    if (!this.accounting)
      throw new HttpError(503, 'model_proxy_unavailable', 'model accounting is not available');
    const [run] = await this.ctx.db
      .select({ tenantId: runs.tenantId })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run) throw notFound('run');
    const scope = { tenantId: run.tenantId };
    // A reservation of another run, of a proxied session or of another agent looks exactly like a
    // missing one: only the in-process executor of this very step may settle it.
    const mine = (await this.accounting.list(scope, { runId })).find(
      (r) => r.id === step.reservationId && r.sessionId === null && r.agentId === step.agentId,
    );
    if (!mine) throw notFound('reservation');
    if (mine.status === 'settled') throw notFound('reservation');
    if (mine.status !== 'active') {
      // The reaper already booked the reserved amount (the call outlived its deadline or the
      // worker was slow). A late report must not fail a run whose call succeeded: record the
      // reported usage as a correction in the audit trail; the ledger keeps the conservative
      // amount that was already booked.
      if (step.kind === 'model_call') {
        await this.audit.append({
          actor: 'system',
          tenantId: scope.tenantId,
          action: 'model.late_settlement',
          target: `${mine.provider}/${mine.model}`,
          runId,
          payload: {
            callId: mine.id,
            agentId: mine.agentId,
            reservedMicros: Number(mine.reservedMicros),
            bookedMicros: Number(mine.actualMicros ?? 0),
            reportedTokensIn: step.tokensIn ?? 0,
            reportedTokensOut: step.tokensOut ?? 0,
          },
        });
      }
      return true;
    }
    if (step.kind === 'error') {
      const message = (step.output as { message?: unknown } | undefined)?.message;
      await this.accounting.release(
        scope,
        step.reservationId,
        typeof message === 'string' ? message.slice(0, 300) : 'model call failed',
      );
      return true;
    }
    await this.accounting.settle(scope, step.reservationId, {
      usage: { inputTokens: step.tokensIn ?? 0, outputTokens: step.tokensOut ?? 0 },
      status: step.status === 'ok' ? 'ok' : 'error',
      detail: {
        ...(step.input !== undefined ? { input: step.input } : {}),
        ...(step.output !== undefined ? { output: step.output } : {}),
        ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
      },
    });
    return true;
  }

  async prepare(runId: string): Promise<PreparedRun> {
    const [run] = await this.ctx.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) throw notFound('run');
    const { definition } = await this.agents.definitionOf(run.agentVersionId);
    const [ev] = run.eventId
      ? await this.ctx.db
          .select({ payload: events.payload })
          .from(events)
          .where(eq(events.id, run.eventId))
      : [];
    return {
      runId,
      definition,
      event: (ev?.payload as OaxEvent | undefined) ?? {
        specversion: '1.0',
        id: runId,
        source: '/openagentix',
        type: 'io.openagentix.manual',
        data: null,
      },
      policies: await this.bundlesFor(definition, run.tenantId),
      limits: { maxToolCallsPerMinute: this.ctx.config.control.maxToolCallsPerMinute },
    };
  }

  private async definitionForRun(
    runId: string,
  ): Promise<{ definition: AgentDefinition; teamId: string | null; tenantId: string }> {
    const [run] = await this.ctx.db
      .select({ v: runs.agentVersionId, t: runs.teamId, tenantId: runs.tenantId })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run) throw notFound('run');
    return {
      definition: (await this.agents.definitionOf(run.v)).definition,
      teamId: run.t,
      tenantId: run.tenantId,
    };
  }

  async decide(runId: string, agentId: string, call: ToolCallRequest): Promise<PolicyDecision> {
    const { definition, tenantId } = await this.definitionForRun(runId);
    const agent = definition.agents.find((a) => a.id === agentId) ?? { id: agentId, tools: [] };
    const counts = await this.ctx.db
      .select({ name: runSteps.name, n: sql<number>`count(*)::int` })
      .from(runSteps)
      .where(
        and(eq(runSteps.runId, runId), eq(runSteps.kind, 'tool_call'), eq(runSteps.status, 'ok')),
      )
      .groupBy(runSteps.name);
    const decision = evaluateToolCall(call, {
      definition,
      agent,
      toolAccess: (definition as PublishedDefinition).toolAccess,
      bundles: await this.bundlesFor(definition, tenantId),
      callCounts: new Map(counts.map((c) => [c.name, Number(c.n)])),
    });
    this.ctx.metrics.policyDecisions.inc({ effect: decision.effect });
    await this.audit.append({
      actor: `agent:${definition.name}/${agentId}`,
      action: 'policy.decision',
      target: `${call.server}/${call.tool}`,
      runId,
      payload: {
        args: await this.nodes.scrub(runId, call.args),
        effect: decision.effect,
        reasons: decision.reasons,
      },
    });
    return decision;
  }

  /**
   * A step reported by an untrusted run node. Cost, token counts, provider and model are measured
   * by the control node only (through the model proxy); a node's own numbers would feed
   * the cost ledger and the budget alerts, so they are dropped. Everything else is bounded.
   */
  private sanitizeNodeStep(step: StepInput): StepInput {
    const cap = (v: unknown): unknown => {
      if (v === undefined || v === null) return v;
      const text = JSON.stringify(v);
      return text.length <= NODE_STEP_MAX_BYTES ? v : { truncated: true, bytes: text.length };
    };
    if (isNodeGuardStep(step)) {
      // Whatever the node sends, only counts and class names are kept.
      const o = (step.output ?? {}) as { source?: unknown; tool?: unknown };
      const source = typeof o.source === 'string' && GUARD_SOURCES.has(o.source) ? o.source : null;
      const tool = typeof o.tool === 'string' && TOOL_NAME.test(o.tool) ? o.tool : null;
      return {
        kind: 'control',
        agentId: step.agentId,
        name: 'input_guard',
        status: 'ok',
        output: {
          ...(source ? { source } : {}),
          ...(tool ? { tool } : {}),
          ...auditShapeOfReport(step.output),
        },
      };
    }
    return {
      kind: step.kind,
      agentId: step.agentId,
      name: step.name.slice(0, 200),
      status: step.status,
      ...(step.input !== undefined ? { input: cap(step.input) } : {}),
      ...(step.output !== undefined ? { output: cap(step.output) } : {}),
      ...(step.durationMs !== undefined
        ? { durationMs: Math.min(step.durationMs, 86_400_000) }
        : {}),
    };
  }

  async recordStep(
    runId: string,
    rawStep: StepInput,
    /** Set when an untrusted run node reports the step (never for the trusted worker). */
    node?: { id: string },
  ): Promise<void> {
    // A node may only report what it can observe itself. Everything that decides or documents the
    // run (conditions, handover validation, control decisions, policy decisions, approvals) is
    // recorded by the control node and the orchestrator; a node's claim of such a step is ignored,
    // so it can neither forge nor trigger the audit entries derived from them (step.skipped,
    // condition.error, handover.invalid, ...).
    // Model calls are recorded by the model proxy from its own measurement (ADR 0009 section 5).
    if (node && rawStep.kind === 'model_call')
      throw new HttpError(
        400,
        'step_kind_refused',
        'a run node cannot report model calls; the model proxy records them',
      );
    if (node && !NODE_STEP_KINDS.has(rawStep.kind) && !isNodeGuardStep(rawStep)) return;
    if (!node && (await this.settleReserved(runId, rawStep))) return;
    // Values the broker handed out for this run never reach step rows or audit payloads.
    const step = await this.nodes.scrub(runId, node ? this.sanitizeNodeStep(rawStep) : rawStep);
    const written = await this.ctx.db.transaction((tx) =>
      writeStepRows(
        { ctx: this.ctx, agents: this.agents, budgets: this.budgets },
        tx as unknown as Db,
        runId,
        step,
        { reportedBy: node ? `node:${node.id}` : null },
      ),
    );
    if (written.metric)
      this.ctx.metrics.costMicros.inc(
        { provider: written.metric.provider },
        written.metric.costMicros,
      );
    // Redaction of secrets happens inside the audit entry creation.
    const special = node ? undefined : stepAuditEntry(step);
    await this.audit.append({
      // Provenance: entries derived from a node's report are marked as such.
      actor: node ? `node:${node.id}` : `agent:${step.agentId ?? 'executor'}`,
      action: special?.action ?? `step.${step.kind}`,
      target: step.name,
      runId,
      payload: node ? { reportedBy: `node:${node.id}`, ...step } : (special?.payload ?? step),
    });
  }

  async requestApproval(
    runId: string,
    agentId: string,
    call: ToolCallRequest,
    reasons: unknown,
  ): Promise<string> {
    const { definition, teamId, tenantId } = await this.definitionForRun(runId);
    const id = randomUUID();
    const now = this.ctx.now();
    await this.ctx.db.insert(approvals).values({
      id,
      tenantId,
      runId,
      teamId,
      agentId,
      tool: `${call.server}/${call.tool}`,
      args: await this.nodes.scrub(runId, call.args),
      reasons: (reasons ?? []) as object,
      approverRoles: definition.approvals.approverRoles,
      status: 'pending',
      requestedAt: now,
      expiresAt: new Date(now.getTime() + definition.approvals.timeoutSeconds * 1000),
    });
    await this.ctx.db.update(runs).set({ status: 'awaiting_approval' }).where(eq(runs.id, runId));
    await this.audit.append({
      actor: `agent:${definition.name}/${agentId}`,
      action: 'approval.requested',
      target: id,
      runId,
      payload: {
        tool: `${call.server}/${call.tool}`,
        args: await this.nodes.scrub(runId, call.args),
      },
    });
    return id;
  }

  /** Current approval status; expires pending approvals and resumes the run when decided. */
  async approvalStatus(runId: string, approvalId: string): Promise<'pending' | ApprovalOutcome> {
    const [a] = await this.ctx.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.runId, runId)));
    if (!a) throw notFound('approval');
    let status = a.status;
    if (status === 'pending' && a.expiresAt.getTime() <= this.ctx.now().getTime()) {
      const [u] = await this.ctx.db
        .update(approvals)
        .set({ status: 'timeout', decidedAt: this.ctx.now() })
        .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')))
        .returning();
      status =
        u?.status ??
        (
          await this.ctx.db
            .select({ s: approvals.status })
            .from(approvals)
            .where(eq(approvals.id, approvalId))
        )[0]!.s;
      if (status === 'timeout')
        await this.audit.append({
          actor: 'system',
          action: 'approval.timeout',
          target: approvalId,
          runId,
        });
    }
    if (status !== 'pending') {
      await this.ctx.db
        .update(runs)
        .set({ status: 'running' })
        .where(and(eq(runs.id, runId), eq(runs.status, 'awaiting_approval')));
    }
    return status as 'pending' | ApprovalOutcome;
  }

  async awaitApproval(
    runId: string,
    workerId: string,
    agentId: string,
    call: ToolCallRequest,
    decision: PolicyDecision,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome> {
    const id = await this.requestApproval(runId, agentId, call, decision.reasons);
    for (;;) {
      const status = await this.approvalStatus(runId, id);
      if (status !== 'pending') return status;
      // Keep the lease alive while waiting for a human.
      await this.ctx.db
        .update(runs)
        .set({
          leaseUntil: new Date(
            this.ctx.now().getTime() + this.ctx.config.worker.leaseSeconds * 1000,
          ),
        })
        .where(and(eq(runs.id, runId), eq(runs.lockedBy, workerId)));
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.ctx.config.worker.approvalPollMs);
        signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason as Error)), {
          once: true,
        });
      });
    }
  }

  async isCancelled(runId: string): Promise<boolean> {
    const [r] = await this.ctx.db
      .select({ c: runs.cancelRequested })
      .from(runs)
      .where(eq(runs.id, runId));
    return r?.c ?? true;
  }

  async completeRun(runId: string, result: RunResult): Promise<void> {
    await this.ctx.db
      .update(runs)
      .set({
        status: result.status,
        finishedAt: this.ctx.now(),
        outputs: result.outputs as unknown as object,
        errorCode: result.error?.code ?? null,
        errorMessage: result.error?.message ?? null,
        lockedBy: null,
        leaseUntil: null,
      })
      .where(eq(runs.id, runId));
    await this.ctx.db
      .update(approvals)
      .set({ status: 'rejected', decidedAt: this.ctx.now(), comment: 'run finished' })
      .where(and(eq(approvals.runId, runId), eq(approvals.status, 'pending')));
    await this.nodes.revokeRun(runId, 'run_completed');
    await this.ctx.cache.delPrefix('costs:');
    this.ctx.metrics.runsFinished.inc({ status: result.status });
    await this.audit.append({
      actor: 'worker',
      action: 'run.completed',
      target: runId,
      runId,
      payload: { status: result.status, usage: result.usage, error: result.error ?? null },
      // The attempt span `invoke_workflow` documents this entry (payload.otel, oax.audit.seq).
      linkSpan: true,
    });
  }
}
