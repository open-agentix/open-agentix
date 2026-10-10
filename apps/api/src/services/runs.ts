import { randomUUID } from 'node:crypto';
import {
  bindingPermissions,
  hasPermission,
  isTerminal,
  newRunTraceIdentity,
  visibleAgents,
  visibleTeams,
  type AgentDefinition,
  type OaxEvent,
  type Principal,
  type RunStatus,
} from '@openagentix/core';
import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { agents, approvals, events, runSteps, runs } from '../db/schema.js';
import { HttpError, forbidden, notFound } from '../errors.js';
import { startGuardedSpan } from '../telemetry.js';
import {
  decodeSeqCursor,
  decodeTimeCursor,
  encodeSeqCursor,
  encodeTimeCursor,
  page,
} from '../pagination.js';
import type { AgentsService } from './agents.js';
import type { AuditService } from './audit.js';
import type { BudgetsService } from './budgets.js';
import { triggerLabel } from '../metric-labels.js';
import type { ResolvedScope } from './subtree-scope.js';

/** What `enqueue` reads before it opens its transaction. */
interface AdmissionPlan {
  latest: Awaited<ReturnType<AgentsService['latestVersionId']>>;
  versionId: string | null;
  definition: AgentDefinition | null;
}

/** Trigger family for the admission span (`api`, `cron`, `webhook`, ...); a closed slug or `other`. */
function triggerKind(triggeredBy: string): string {
  const kind = triggeredBy.split(':')[0] ?? '';
  return /^[a-z][a-z0-9_-]{0,31}$/.test(kind) ? kind : 'other';
}

/** The 409 every trigger path gets for a disabled agent. */
export const agentDisabled = () =>
  new HttpError(409, 'agent_disabled', 'agent is disabled and accepts no new runs');

export type RunRow = typeof runs.$inferSelect;
export type StepRow = typeof runSteps.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;

export function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export interface RunFilter {
  agentId?: string | undefined;
  status?: RunStatus | undefined;
  teamId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export interface RunStats {
  total: number;
  byStatus: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  costUsd: number;
  avgDurationMs: number | null;
}

/** Runs, steps, cancellation and human approvals. */
export class RunsService {
  private readonly getRunQuery;
  private readonly stepsQuery;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
    private readonly budgets: BudgetsService,
  ) {
    // Prepared statements for the hottest read paths.
    this.getRunQuery = ctx.db
      .select()
      .from(runs)
      .where(eq(runs.id, sql.placeholder('id')))
      .prepare('oax_get_run');
    this.stepsQuery = ctx.db
      .select()
      .from(runSteps)
      .where(
        and(
          eq(runSteps.runId, sql.placeholder('runId')),
          gt(runSteps.seq, sql.placeholder('after')),
        ),
      )
      .orderBy(asc(runSteps.seq))
      .limit(sql.placeholder('limit'))
      .prepare('oax_run_steps');
  }

  /**
   * Stores an event (if not stored yet) and queues a run for the agent's latest published version.
   *
   * Every trigger (API, cron, webhook, event sources, demo scenarios) is admitted here. A disabled
   * agent is refused with `409 agent_disabled`: the agent row is read with `FOR SHARE` in the same
   * transaction that inserts the run, so a concurrent `disable` (which updates that row) either
   * commits first and the check sees it, or waits until this transaction has committed. The event
   * is stored and the refusal is audited (`run.refused`) before the error is thrown.
   */
  async enqueue(input: {
    agentId: string;
    event: OaxEvent;
    eventRowId?: string | null;
    triggeredBy: string;
    versionId?: string;
    tx?: Db;
    /** Fixed run id (deterministic demo seed); random when omitted. */
    id?: string;
  }): Promise<RunRow> {
    // Reads of immutable or cached data happen before the transaction: PGlite (tests, demo) runs
    // one connection, so a query on `ctx.db` while a transaction is open would wait for it.
    const latest = await this.agents.latestVersionId(input.agentId);
    const versionId = input.versionId ?? latest.versionId;
    const definition = versionId ? (await this.agents.definitionOf(versionId)).definition : null;
    const plan = { latest, versionId, definition };
    const outcome = input.tx
      ? await this.admit(input.tx, input, plan)
      : await this.ctx.db.transaction((tx) => this.admit(tx as unknown as Db, input, plan));
    if (outcome.refused) throw agentDisabled();
    this.emitAdmitSpan(outcome.run, input.triggeredBy, outcome.auditSeq);
    return outcome.run;
  }

  /**
   * The admission span `oax.run.admit` (ADR 0015 section 2): root span of the run's trace, created
   * with exactly the ids stored on the run row, so the audit entry `run.queued` / `run.blocked`
   * (`payload.otel.spanId`) and the exported span name the same span. The request span that is
   * active here (API, webhook) is linked, never the parent. Emitting is best effort and must never
   * fail an admission that is already stored.
   */
  private emitAdmitSpan(run: RunRow, triggeredBy: string, auditSeq: number): void {
    const traceId = run.traceId;
    const spanId = run.traceRootSpanId;
    if (!traceId || !spanId) return;
    try {
      const open = startGuardedSpan(
        { name: 'oax.run.admit', kind: 'run_admit', root: { traceId, spanId }, linkActive: true },
        {
          'oax.run.id': run.id,
          'oax.tenant.id': run.tenantId,
          'oax.trigger.kind': triggerKind(triggeredBy),
          'oax.admission.result': run.status === 'queued' ? 'queued' : 'blocked',
          'oax.audit.seq': auditSeq,
        },
      );
      open.end();
    } catch {
      // Telemetry never decides whether a run exists.
    }
  }

  private async admit(
    db: Db,
    input: Parameters<RunsService['enqueue']>[0],
    { latest, versionId, definition }: AdmissionPlan,
  ): Promise<{ refused: false; run: RunRow; auditSeq: number } | { refused: true }> {
    // Share lock on the agent row: serialises with disable/enable until this transaction ends.
    const lockedRes = (await db.execute(
      sql`select disabled_at from agents where id = ${input.agentId} for share`,
    )) as unknown as { rows: { disabled_at: Date | string | null }[] };
    if (lockedRes.rows.length === 0) throw notFound('agent');
    const disabled = lockedRes.rows[0]!.disabled_at !== null;
    if (!disabled && !versionId)
      throw new HttpError(409, 'invalid_state', 'agent has no published version');
    let eventRowId = input.eventRowId ?? null;
    if (!eventRowId) {
      eventRowId = randomUUID();
      await db.insert(events).values({
        id: eventRowId,
        tenantId: latest.tenantId,
        sourceId: null,
        cloudEventId: input.event.id,
        type: input.event.type,
        subject: input.event.subject ?? null,
        payload: input.event as object,
      });
    }
    if (disabled) {
      this.ctx.metrics.runsRefused.inc({
        trigger: triggerLabel(input.triggeredBy),
        reason: 'agent_disabled',
      });
      await this.audit.append(
        {
          actor: input.triggeredBy,
          tenantId: latest.tenantId,
          action: 'run.refused',
          target: input.agentId,
          payload: {
            reason: 'agent_disabled',
            versionId: versionId ?? null,
            eventId: input.event.id,
          },
        },
        db,
      );
      return { refused: true };
    }
    const verdict = await this.budgets.verdictFor(
      {
        tenantId: latest.tenantId,
        teamId: latest.teamId,
        useCase: definition!.labels.useCase ?? null,
      },
      db,
    );
    // Hard stop at admission: the first breached scope names the error code and reason.
    const breach = verdict.breaches[0];
    const budget = breach ? breach.message : null;
    const id = input.id ?? randomUUID();
    const now = this.ctx.now();
    // Trace identity from the CSPRNG, written once with the row. Never derived from the run id and
    // never read from the event, a header or any other input (ADR 0015 section 2).
    const trace = newRunTraceIdentity();
    const [row] = await db
      .insert(runs)
      .values({
        id,
        traceId: trace.traceId,
        traceRootSpanId: trace.rootSpanId,
        tenantId: latest.tenantId,
        agentId: input.agentId,
        agentVersionId: versionId!,
        teamId: latest.teamId,
        eventId: eventRowId,
        status: budget ? 'blocked_by_policy' : 'queued',
        triggeredBy: input.triggeredBy,
        createdAt: now,
        availableAt: now,
        ...(budget
          ? { finishedAt: now, errorCode: `${breach!.scope}_budget_exceeded`, errorMessage: budget }
          : {}),
      })
      .returning();
    this.ctx.metrics.runsCreated.inc({ trigger: triggerLabel(input.triggeredBy) });
    const queued = await this.audit.append(
      {
        actor: input.triggeredBy,
        tenantId: latest.tenantId,
        action: budget ? 'run.blocked' : 'run.queued',
        target: input.agentId,
        runId: id,
        payload: {
          versionId,
          eventId: input.event.id,
          reason: budget,
          ...(verdict.blocked ? { breaches: verdict.breaches } : {}),
        },
      },
      db,
    );
    return { refused: false, run: row!, auditSeq: queued.seq };
  }

  async get(id: string): Promise<RunRow> {
    const [row] = await this.getRunQuery.execute({ id });
    if (!row) throw notFound('run');
    return row;
  }

  async getVisible(
    principal: Principal,
    id: string,
    permission: 'runs:read' | 'runs:cancel' | 'runs:approve' | 'costs:read' = 'runs:read',
  ): Promise<RunRow> {
    const run = await this.get(id);
    if (
      run.tenantId !== principal.tenantId ||
      !hasPermission(principal, permission, run.teamId, run.agentId)
    ) {
      await this.audit.append({
        actor: principal.userId,
        tenantId: principal.tenantId,
        action: 'access.denied',
        target: id,
        runId: id,
        payload: { permission, resource: 'run' },
      });
      throw notFound('run');
    }
    return run;
  }

  async list(
    principal: Principal,
    filter: RunFilter,
    limit: number,
    cursor?: string,
    subtree?: ResolvedScope,
  ) {
    const c = decodeTimeCursor(cursor);
    const visibility = this.visibility(principal, subtree);
    if (!visibility) return { items: [], nextCursor: null };
    const rows = await this.ctx.db
      .select()
      .from(runs)
      .where(
        and(
          visibility,
          filter.agentId ? eq(runs.agentId, filter.agentId) : undefined,
          filter.status ? eq(runs.status, filter.status) : undefined,
          filter.teamId ? eq(runs.teamId, filter.teamId) : undefined,
          filter.from ? gte(runs.createdAt, filter.from) : undefined,
          filter.to ? lt(runs.createdAt, filter.to) : undefined,
          c
            ? or(lt(runs.createdAt, c.t), and(eq(runs.createdAt, c.t), lt(runs.id, c.id)))
            : undefined,
        ),
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit + 1);
    return page(rows, limit, (r) => encodeTimeCursor(r.createdAt, r.id));
  }

  /**
   * The row filter for the runs the principal may read: the acting tenant with team and
   * agent-scoped bindings applied, or the resolved predicate of a `scope=subtree` list.
   * `undefined` when nothing is readable.
   */
  private visibility(principal: Principal, subtree: ResolvedScope | undefined): SQL | undefined {
    if (subtree)
      return subtree.isEmpty
        ? undefined
        : subtree.predicate({ tenantId: runs.tenantId, teamId: runs.teamId, agent: runs.agentId });
    const scope = visibleTeams(principal, 'runs:read');
    const scopedAgents = visibleAgents(principal, 'runs:read');
    if (Array.isArray(scope) && scope.length === 0 && scopedAgents.length === 0) return undefined;
    return and(
      eq(runs.tenantId, principal.tenantId),
      scope === 'all' ? undefined : this.runScope(scope, scopedAgents),
    );
  }

  /** Aggregates for dashboards (same filters and team scoping as the list). */
  async stats(principal: Principal, filter: Omit<RunFilter, 'status'>): Promise<RunStats> {
    const scope = visibleTeams(principal, 'runs:read');
    const empty: RunStats = {
      total: 0,
      byStatus: {},
      tokensIn: 0,
      tokensOut: 0,
      costMicros: 0,
      costUsd: 0,
      avgDurationMs: null,
    };
    const scopedAgents = visibleAgents(principal, 'runs:read');
    if (Array.isArray(scope) && scope.length === 0 && scopedAgents.length === 0) return empty;
    const rows = await this.ctx.db
      .select({
        status: runs.status,
        n: sql<number>`count(*)::int`,
        tokensIn: sql<number>`coalesce(sum(${runs.tokensIn}), 0)::bigint`,
        tokensOut: sql<number>`coalesce(sum(${runs.tokensOut}), 0)::bigint`,
        cost: sql<number>`coalesce(sum(${runs.costMicros}), 0)::bigint`,
        durMs: sql<
          number | null
        >`sum(extract(epoch from (${runs.finishedAt} - ${runs.startedAt})) * 1000)`,
        durN: sql<number>`count(${runs.finishedAt})::int`,
      })
      .from(runs)
      .where(
        and(
          eq(runs.tenantId, principal.tenantId),
          filter.agentId ? eq(runs.agentId, filter.agentId) : undefined,
          filter.teamId ? eq(runs.teamId, filter.teamId) : undefined,
          filter.from ? gte(runs.createdAt, filter.from) : undefined,
          filter.to ? lt(runs.createdAt, filter.to) : undefined,
          scope === 'all' ? undefined : this.runScope(scope, scopedAgents),
        ),
      )
      .groupBy(runs.status);
    const out: RunStats = { ...empty, byStatus: {} };
    let dur = 0;
    let durN = 0;
    for (const r of rows) {
      out.byStatus[r.status] = Number(r.n);
      out.total += Number(r.n);
      out.tokensIn += Number(r.tokensIn);
      out.tokensOut += Number(r.tokensOut);
      out.costMicros += Number(r.cost);
      dur += Number(r.durMs ?? 0);
      durN += Number(r.durN);
    }
    out.costUsd = out.costMicros / 1e6;
    out.avgDurationMs = durN > 0 ? Math.round(dur / durN) : null;
    return out;
  }

  /** agent id -> agent name (one query per page). */
  async agentNames(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.ctx.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** run id -> pipeline (agent) name. */
  async pipelineNames(runIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(runIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.ctx.db
      .select({ id: runs.id, name: agents.name })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(inArray(runs.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Team scope OR agent-scoped bindings. */
  private runScope(teamsIn: string[], agentsIn: string[]) {
    return or(
      teamsIn.length ? inArray(runs.teamId, teamsIn) : undefined,
      agentsIn.length ? inArray(runs.agentId, agentsIn) : undefined,
    );
  }

  async steps(
    runId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: StepRow[]; nextCursor: string | null }> {
    const after = decodeSeqCursor(cursor) ?? 0;
    const rows = await this.stepsQuery.execute({ runId, after, limit: limit + 1 });
    return page(rows, limit, (s) => encodeSeqCursor(s.seq));
  }

  async cancel(principal: Principal, id: string): Promise<RunRow> {
    const run = await this.getVisible(principal, id, 'runs:cancel');
    if (isTerminal(run.status as RunStatus))
      throw new HttpError(409, 'invalid_state', `run is already ${run.status}`);
    const now = this.ctx.now();
    const [row] =
      run.status === 'queued'
        ? await this.ctx.db
            .update(runs)
            .set({
              status: 'cancelled',
              cancelRequested: true,
              finishedAt: now,
              errorCode: 'cancelled',
              errorMessage: 'cancelled before start',
            })
            .where(and(eq(runs.id, id), eq(runs.status, 'queued')))
            .returning()
        : await this.ctx.db
            .update(runs)
            .set({ cancelRequested: true })
            .where(eq(runs.id, id))
            .returning();
    await this.ctx.db
      .update(approvals)
      .set({ status: 'rejected', decidedAt: now, comment: 'run cancelled' })
      .where(and(eq(approvals.runId, id), eq(approvals.status, 'pending')));
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: 'run.cancel_requested',
      target: id,
      runId: id,
    });
    return row ?? (await this.get(id));
  }

  // ---------- approvals ----------

  async listApprovals(
    principal: Principal,
    status: string,
    limit: number,
    cursor?: string,
    runId?: string,
    subtree?: ResolvedScope,
  ) {
    const c = decodeTimeCursor(cursor);
    const visibility = this.approvalVisibility(principal, subtree);
    if (!visibility) return { items: [], nextCursor: null };
    const rows = await this.ctx.db
      .select()
      .from(approvals)
      .where(
        and(
          visibility,
          eq(approvals.status, status),
          runId ? eq(approvals.runId, runId) : undefined,
          c
            ? or(
                lt(approvals.requestedAt, c.t),
                and(eq(approvals.requestedAt, c.t), lt(approvals.id, c.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(approvals.requestedAt), desc(approvals.id))
      .limit(limit + 1);
    return page(rows, limit, (r) => encodeTimeCursor(r.requestedAt, r.id));
  }

  /** Like {@link visibility} for approvals, whose agent scope goes through the run. */
  private approvalVisibility(
    principal: Principal,
    subtree: ResolvedScope | undefined,
  ): SQL | undefined {
    const byAgent = (agentIds: string[]) =>
      inArray(
        approvals.runId,
        this.ctx.db.select({ id: runs.id }).from(runs).where(inArray(runs.agentId, agentIds)),
      );
    if (subtree)
      return subtree.isEmpty
        ? undefined
        : subtree.predicate({
            tenantId: approvals.tenantId,
            teamId: approvals.teamId,
            agent: byAgent,
          });
    const scope = visibleTeams(principal, 'runs:read');
    const scopedAgents = visibleAgents(principal, 'runs:read');
    if (Array.isArray(scope) && scope.length === 0 && scopedAgents.length === 0) return undefined;
    return and(
      eq(approvals.tenantId, principal.tenantId),
      scope === 'all'
        ? undefined
        : or(
            scope.length ? inArray(approvals.teamId, scope) : undefined,
            scopedAgents.length ? byAgent(scopedAgents) : undefined,
          ),
    );
  }

  /** A human decision; the approver needs `runs:approve` and one of the approver roles of the agent. */
  async decide(
    principal: Principal,
    approvalId: string,
    decision: 'approve' | 'reject',
    comment?: string,
  ): Promise<ApprovalRow> {
    const [a] = await this.ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
    const [run] = a
      ? await this.ctx.db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, a.runId))
      : [];
    if (
      !a ||
      !run ||
      a.tenantId !== principal.tenantId ||
      !hasPermission(principal, 'runs:approve', a.teamId, run.agentId)
    )
      throw notFound('approval');
    const roleOk = principal.bindings.some(
      (b) =>
        a.approverRoles.includes(b.role) &&
        (b.agentId ? b.agentId === run.agentId : b.teamId === null || b.teamId === a.teamId) &&
        bindingPermissions(b).includes('runs:approve'),
    );
    if (!roleOk)
      throw forbidden(`approval requires one of the roles: ${a.approverRoles.join(', ')}`);
    if (a.status !== 'pending')
      throw new HttpError(409, 'invalid_state', `approval is already ${a.status}`);
    if (a.expiresAt.getTime() <= this.ctx.now().getTime())
      throw new HttpError(409, 'invalid_state', 'approval has expired');
    const [row] = await this.ctx.db
      .update(approvals)
      .set({
        status: decision === 'approve' ? 'approved' : 'rejected',
        decidedBy: principal.userId,
        decidedAt: this.ctx.now(),
        comment: comment ?? null,
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')))
      .returning();
    if (!row) throw new HttpError(409, 'invalid_state', 'approval was decided concurrently');
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: `approval.${row.status}`,
      target: approvalId,
      runId: a.runId,
      payload: { tool: a.tool, comment: comment ?? null },
    });
    return row;
  }
}
