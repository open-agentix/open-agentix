import { randomUUID } from 'node:crypto';
import {
  expandProfiles,
  loadAgentDefinition,
  LEGACY_REMOVED_CODE,
  legacyRemovedMessage,
  newRunTraceIdentity,
  type AgentDefinition,
  type Principal,
} from '@openagentix/core';
import { createEvent, isCloudEvent, parseCloudEvent } from '@openagentix/events';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { agentDraftRevisions, devRunDefinitions, events, runs, users } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import { triggerLabel } from '../metric-labels.js';
import type { AgentRow, AgentsService } from './agents.js';
import type { AuditService } from './audit.js';
import type { BudgetsService } from './budgets.js';
import type { CatalogService } from './catalog.js';
import type { DevRunGate } from './dev-run-gate.js';
import { DEV_RUN_LOCK_NS } from './dev-run-lock.js';
import type { LifecyclePolicyService } from './lifecycle-policy.js';

/**
 * How many development runs of one user may be queued or running at once. A development run spends
 * real tokens and acts with real credentials, so it is rate limited per person, on top of the
 * development budget of the node and the budget of the run itself.
 */
export const MAX_ACTIVE_DEV_RUNS_PER_USER = 3;

/** The statuses in which a run still counts as active. */
const ACTIVE = ['queued', 'running', 'awaiting_approval'];

/** `triggeredBy` of every development run: `dev:<user id>`. No other trigger writes this prefix. */
export const devTrigger = (userId: string) => `dev:${userId}`;

export interface StartDevRunInput {
  /** The revision to run; the head revision of the draft when omitted. */
  revisionId?: string | undefined;
  /** Event payload, wrapped into a manual CloudEvent, or a full CloudEvent. */
  data?: unknown;
}

/**
 * Development runs: a run of a draft REVISION of an agent with real tools and models, started by a
 * person and executed with that person's own credentials (ADR 0017 section 8).
 *
 * The only entry is {@link start}, an interactive call. Webhooks, mail, Kafka, cron and the other
 * triggers go through `RunsService.enqueue`, which can only name a published version, so a draft can
 * never be run by an event. The definition is frozen at admission (`dev_run_definitions`), the run is
 * `stage: development` for ever (a database trigger forbids changing it), and its spend is counted
 * against the development budget of the node only.
 */
export class DevRunsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
    private readonly catalog: CatalogService,
    private readonly budgets: BudgetsService,
    private readonly policy: LifecyclePolicyService,
    private readonly gate: DevRunGate,
  ) {}

  async start(principal: Principal, agentId: string, input: StartDevRunInput) {
    const agent = await this.agents.get(agentId, principal);
    await this.agents.assertAccess(principal, agent, 'agents:write');
    if (agent.disabledAt)
      throw new HttpError(409, 'agent_disabled', 'agent is disabled and accepts no new runs');
    const policy = await this.policy.effectiveForTenant(agent.tenantId);
    if (policy.allowDraftRuns === 'off')
      throw new HttpError(
        403,
        'draft_runs_disabled',
        'development runs are switched off by the lifecycle policy (allowDraftRuns)',
      );
    const revision = await this.revisionOf(agent, input.revisionId);
    const definition = await this.definitionOf(principal, agent, revision.source);
    await this.gate.assertNoProductionCredentials(definition, {
      tenantId: agent.tenantId,
      teamId: agent.teamId,
      agentId: agent.id,
    });
    await this.assertRoom(principal.userId);
    return this.admit(principal, agent, revision, definition, input.data);
  }

  private async revisionOf(agent: AgentRow, revisionId: string | undefined) {
    const id = revisionId ?? agent.draftRevisionId;
    if (!id) throw new HttpError(409, 'invalid_state', 'agent has no draft revision to run');
    const [row] = await this.ctx.db
      .select()
      .from(agentDraftRevisions)
      .where(eq(agentDraftRevisions.id, id));
    // A revision of another agent or tenant looks exactly like a missing one.
    if (!row || row.agentId !== agent.id || row.tenantId !== agent.tenantId)
      throw notFound('revision');
    return row;
  }

  /** The definition the run will execute: the same checks and profile expansion as a publish. */
  private async definitionOf(
    principal: Principal,
    agent: AgentRow,
    source: string,
  ): Promise<AgentDefinition> {
    if (this.agents.legacyPhase === 'removed')
      throw new HttpError(400, LEGACY_REMOVED_CODE, legacyRemovedMessage());
    const def = loadAgentDefinition(source);
    this.agents.assertLabelInScope(principal, 'agents:write', agent, def.labels.useCase || null);
    this.agents.checkRuntime(def);
    const scope = { tenantId: agent.tenantId, teamId: agent.teamId, agentId: agent.id };
    const { definition, errors } = expandProfiles(def, await this.catalog.accessCatalog(scope));
    if (errors.length > 0)
      throw new HttpError(400, 'validation_failed', 'the draft grants cannot be expanded', errors);
    const stdio = await this.catalog.stdioIsolationIssues(def, scope);
    if (stdio.length > 0)
      throw new HttpError(
        400,
        'mcp_stdio_requires_isolation',
        'tenant stdio connections run only in run nodes',
        stdio.map(({ path, message }) => ({ path, message })),
      );
    return definition;
  }

  /** At most {@link MAX_ACTIVE_DEV_RUNS_PER_USER} active development runs per person. */
  private async assertRoom(userId: string, db: Db = this.ctx.db): Promise<void> {
    const [row] = await db
      .select({ n: count() })
      .from(runs)
      .where(
        and(
          eq(runs.stage, 'development'),
          eq(runs.startedBy, userId),
          inArray(runs.status, ACTIVE),
        ),
      );
    if (Number(row?.n ?? 0) >= MAX_ACTIVE_DEV_RUNS_PER_USER)
      throw new HttpError(
        429,
        'dev_run_limit',
        `at most ${MAX_ACTIVE_DEV_RUNS_PER_USER} development runs can be active at once`,
      );
  }

  private async admit(
    principal: Principal,
    agent: AgentRow,
    revision: typeof agentDraftRevisions.$inferSelect,
    definition: AgentDefinition,
    data: unknown,
  ) {
    const event = isCloudEvent(data)
      ? parseCloudEvent(data)
      : createEvent({
          source: `/users/${principal.userId}`,
          type: 'io.openagentix.manual',
          data: data ?? null,
        });
    const verdict = await this.budgets.verdictFor({
      tenantId: agent.tenantId,
      teamId: agent.teamId,
      useCase: definition.labels.useCase ?? null,
      stage: 'development',
    });
    const breach = verdict.breaches[0];
    const id = randomUUID();
    const now = this.ctx.now();
    const trace = newRunTraceIdentity();
    const row = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      // Counted again inside the transaction of the insert, per person, so that two simultaneous
      // calls cannot both pass the limit through a check-then-insert gap.
      await tx.execute(
        sql`select pg_advisory_xact_lock(${DEV_RUN_LOCK_NS}::int, hashtext(${principal.userId}))`,
      );
      // The account may have been disabled since the request was authenticated.
      const [account] = await tx
        .select({ disabled: users.disabled })
        .from(users)
        .where(eq(users.id, principal.userId));
      if (!account || account.disabled)
        throw new HttpError(403, 'dev_run_not_permitted', 'the account is disabled');
      await this.assertRoom(principal.userId, tx);
      const eventRowId = randomUUID();
      await tx.insert(events).values({
        id: eventRowId,
        tenantId: agent.tenantId,
        sourceId: null,
        cloudEventId: event.id,
        type: event.type,
        subject: event.subject ?? null,
        payload: event as object,
      });
      const [run] = await tx
        .insert(runs)
        .values({
          id,
          traceId: trace.traceId,
          traceRootSpanId: trace.rootSpanId,
          tenantId: agent.tenantId,
          agentId: agent.id,
          agentVersionId: null,
          agentRevisionId: revision.id,
          stage: 'development',
          startedBy: principal.userId,
          teamId: agent.teamId,
          eventId: eventRowId,
          status: breach ? 'blocked_by_policy' : 'queued',
          triggeredBy: devTrigger(principal.userId),
          createdAt: now,
          availableAt: now,
          ...(breach
            ? {
                finishedAt: now,
                errorCode: `${breach.scope}_budget_exceeded`,
                errorMessage: breach.message,
              }
            : {}),
        })
        .returning();
      await tx.insert(devRunDefinitions).values({ runId: id, definition: definition as object });
      await this.audit.append(
        {
          actor: principal.userId,
          tenantId: agent.tenantId,
          action: breach ? 'run.blocked' : 'run.queued',
          target: agent.id,
          runId: id,
          payload: {
            stage: 'development',
            revisionId: revision.id,
            revisionSeq: revision.seq,
            digest: revision.digest,
            eventId: event.id,
            reason: breach?.message ?? null,
            ...(principal.tokenId ? { tokenId: principal.tokenId } : {}),
          },
        },
        tx,
      );
      return run!;
    });
    this.ctx.metrics.runsCreated.inc({ trigger: triggerLabel(devTrigger(principal.userId)) });
    return row;
  }
}
