import { randomUUID } from 'node:crypto';
import type { OaxError } from '@openagentix/core';
import {
  evaluateToolCall,
  issueRunToken,
  redact,
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
  PreparedRun,
  RunResult,
  StepInput,
} from '@openagentix/runners';
import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { approvals, costLedger, events, runSteps, runs } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { AgentsService } from './agents.js';
import type { AuditService } from './audit.js';
import type { BudgetsService } from './budgets.js';
import type { CatalogService } from './catalog.js';
import type { GuidelinesService } from './guidelines.js';
import type { RunNodesService } from './run-nodes.js';
import { monthOf } from './runs.js';

const ACTIVE = ['running', 'awaiting_approval'];

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
      completeRun: async (runId, result) => (
        await this.authorize(token, runId),
        this.completeRun(runId, result)
      ),
    };
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
      payload: { args: call.args, effect: decision.effect, reasons: decision.reasons },
    });
    return decision;
  }

  async recordStep(runId: string, rawStep: StepInput): Promise<void> {
    // Values the broker handed out for this run never reach step rows or audit payloads.
    const known = this.nodes.knownSecrets(runId);
    const step = known.length > 0 ? redact(rawStep, { knownSecrets: known }) : rawStep;
    await this.ctx.db.transaction(async (tx) => {
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
        createdAt: this.ctx.now(),
      });
      if ((step.costMicros ?? 0) > 0 || (step.tokensIn ?? 0) > 0 || (step.tokensOut ?? 0) > 0) {
        const { definition } = await this.agents.definitionOf(run.versionId);
        await tx.insert(costLedger).values({
          runId,
          stepSeq: run.seq,
          tenantId: run.tenantId,
          useCase: definition.labels.useCase ?? null,
          agentId: run.agentId,
          teamId: run.teamId,
          provider: step.provider ?? null,
          model: step.model ?? null,
          month: monthOf(this.ctx.now()),
          tokensIn: step.tokensIn ?? 0,
          tokensOut: step.tokensOut ?? 0,
          costMicros: step.costMicros ?? 0,
        });
        this.ctx.metrics.costMicros.inc(
          { provider: step.provider ?? 'tool' },
          step.costMicros ?? 0,
        );
        // Alerts at 50/80/100 % of every budget this cost line counts against.
        await this.budgets.raiseAlerts(
          tx as unknown as Db,
          {
            tenantId: run.tenantId,
            teamId: run.teamId,
            useCase: definition.labels.useCase ?? null,
          },
          step.costMicros ?? 0,
        );
      }
    });
    // Redaction of secrets happens inside the audit entry creation.
    const special = stepAuditEntry(step);
    await this.audit.append({
      actor: `agent:${step.agentId ?? 'executor'}`,
      action: special?.action ?? `step.${step.kind}`,
      target: step.name,
      runId,
      payload: special?.payload ?? step,
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
      args: call.args,
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
      payload: { tool: `${call.server}/${call.tool}`, args: call.args },
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
    });
  }
}
