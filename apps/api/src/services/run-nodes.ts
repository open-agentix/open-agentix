import { randomUUID } from 'node:crypto';
import {
  StaticCredentialSource,
  credentialEnvName,
  issueRunToken,
  resolveSchema,
  secretRefAllowed,
  type AgentDefinition,
  type AgentSpec,
  type CredentialSource,
  type RunTokenClaims,
  type StepCredentials,
} from '@openagentix/core';
import type { McpServerConfig } from '@openagentix/mcp';
import type { StepHandover, StepHandoverResult } from '@openagentix/runners';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { runNodeSessions, runs, tenants } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { AgentsService } from './agents.js';
import type { AuditService } from './audit.js';
import type { CatalogService } from './catalog.js';

const ACTIVE = ['running', 'awaiting_approval'];

export type RevokeReason = 'step_end' | 'cancelled' | 'timeout' | 'lease_lost' | 'run_completed';

export interface NewSession {
  agentId: string;
  /** The validated input of the step (the orchestrator ran `when` and the handover checks). */
  input: unknown;
  timeoutSeconds: number;
  runner: string;
  image: string;
}

export interface CreatedSession {
  sessionId: string;
  nodeId: string;
  /** Step-scoped run token for the node. Only ever delivered as a file. */
  token: string;
  expiresAt: Date;
}

type SessionRow = typeof runNodeSessions.$inferSelect;

/** Secret references a step needs, with where each value goes. */
interface StepNeeds {
  declared: { secret: string; env: string }[];
  connections: {
    server: string;
    env: Record<string, string>;
    headers: Record<string, string>;
  }[];
  refs: string[];
}

/**
 * Run node sessions and the per-step credential broker (ADR 0008, sections 2 and 3). The control
 * node creates a session per isolated step, issues a step-scoped run token for it, hands the node
 * its handover and (once) its credentials, and revokes the session when the step ends. Every
 * decision is audited with names and ids only, never values.
 */
export class RunNodesService {
  /**
   * Values handed out per run, so that step records and audit payloads of that run are scrubbed
   * with them. Kept in memory of the issuing control node only; a best-effort second layer on top
   * of the generic redaction patterns.
   */
  private readonly issued = new Map<string, Set<string>>();
  /** Handles of dynamic credentials per session, recalled when the session is revoked. */
  private readonly handles = new Map<string, string[]>();

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
    private readonly catalog: CatalogService,
    private readonly source: CredentialSource = new StaticCredentialSource(ctx.secrets),
  ) {}

  /** Secret values issued for a run so far (for redaction). */
  knownSecrets(runId: string): readonly string[] {
    return [...(this.issued.get(runId) ?? [])];
  }

  private async runContext(runId: string) {
    const [run] = await this.ctx.db.select().from(runs).where(eq(runs.id, runId));
    if (!run) throw notFound('run');
    const { definition } = await this.agents.definitionOf(run.agentVersionId);
    return { run, definition };
  }

  private stripSecrets(cfg: McpServerConfig): McpServerConfig {
    if (cfg.transport === 'stdio') return { ...cfg, envSecrets: {} };
    if (cfg.transport === 'streamable-http') return { ...cfg, headerSecrets: {} };
    return cfg;
  }

  private serversOf(agent: AgentSpec): Set<string> {
    return new Set([
      ...agent.tools.map((t) => t.server),
      ...(agent.profileGrants ?? []).map((p) => p.server),
    ]);
  }

  private async configsFor(
    run: typeof runs.$inferSelect,
    agent: AgentSpec,
  ): Promise<McpServerConfig[]> {
    const wanted = this.serversOf(agent);
    const all = await this.catalog.mcpConfigs({
      tenantId: run.tenantId,
      teamId: run.teamId,
      agentId: run.agentId,
    });
    return all.filter((c) => wanted.has(c.name));
  }

  private needs(agent: AgentSpec, configs: readonly McpServerConfig[]): StepNeeds {
    const declared = (agent.credentials ?? []).map((c) => ({
      secret: c.secret,
      env: credentialEnvName(c),
    }));
    const connections = configs.map((c) => ({
      server: c.name,
      env: c.transport === 'stdio' ? { ...c.envSecrets } : {},
      headers: c.transport === 'streamable-http' ? { ...c.headerSecrets } : {},
    }));
    const refs = new Set<string>(declared.map((d) => d.secret));
    for (const c of connections)
      for (const ref of [...Object.values(c.env), ...Object.values(c.headers)]) refs.add(ref);
    return { declared, connections, refs: [...refs].sort() };
  }

  // ---------- orchestrator side (trusted worker, lease checked by the caller) ----------

  /**
   * Creates the session of one isolated step and the step-scoped token. The caller must have
   * authorised the orchestrator's own (unscoped) run token for this run first.
   */
  async createSession(
    runId: string,
    orchestratorId: string,
    req: NewSession,
  ): Promise<CreatedSession> {
    const { run, definition } = await this.runContext(runId);
    if (!ACTIVE.includes(run.status) || run.lockedBy !== orchestratorId)
      throw new HttpError(409, 'invalid_state', 'run is not active for this worker');
    const agent = definition.agents.find((a) => a.id === req.agentId);
    if (!agent) throw new HttpError(400, 'validation_failed', `unknown agent "${req.agentId}"`);
    const cfg = this.ctx.config;
    const ttl = Math.min(cfg.runToken.ttlSeconds, Math.ceil(req.timeoutSeconds) + 60);
    const now = this.ctx.now();
    const sessionId = randomUUID();
    const nodeId = randomUUID();
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    const output = agent.output
      ? {
          ...agent.output,
          schema: resolveSchema(agent.output.schema, definition.schemas) as Record<string, unknown>,
        }
      : undefined;
    const spec: AgentSpec = {
      ...agent,
      // The node runs exactly this step: no condition, no handover plumbing, no secret references.
      ...(output ? { output } : {}),
    };
    delete (spec as Partial<AgentSpec>).when;
    delete (spec as Partial<AgentSpec>).input;
    delete (spec as Partial<AgentSpec>).credentials;
    const handover: StepHandover = {
      agentId: agent.id,
      agent: spec,
      input: req.input ?? null,
      ...(output ? { outputSchema: output.schema } : {}),
      attempt: 1,
      run: {
        name: definition.name,
        version: definition.version,
        classification: definition.classification,
        budget: definition.budget,
      },
      mcp: (await this.configsFor(run, agent)).map((c) => this.stripSecrets(c)),
    };
    await this.ctx.db.insert(runNodeSessions).values({
      id: sessionId,
      runId,
      tenantId: run.tenantId,
      nodeId,
      steps: [agent.id],
      expiresAt,
      handover: { [agent.id]: handover },
      createdAt: now,
    });
    const token = issueRunToken(
      cfg.runToken.secret,
      { runId, workerId: nodeId, ttlSeconds: ttl, sid: sessionId, steps: [agent.id] },
      now.getTime(),
    );
    await this.audit.append({
      actor: `worker:${orchestratorId}`,
      tenantId: run.tenantId,
      action: 'runnode.started',
      target: nodeId,
      runId,
      payload: { runId, nodeId, steps: [agent.id], runner: req.runner, image: req.image },
    });
    return { sessionId, nodeId, token, expiresAt };
  }

  /**
   * Revokes a session (idempotent): its token is dead from now on. The stored handover (the step's
   * input) is dropped; the result stays for the orchestrator.
   */
  async revoke(sessionId: string, reason: RevokeReason): Promise<void> {
    const [row] = await this.ctx.db
      .update(runNodeSessions)
      .set({ revokedAt: this.ctx.now(), revokeReason: reason, handover: null })
      .where(and(eq(runNodeSessions.id, sessionId), isNull(runNodeSessions.revokedAt)))
      .returning();
    if (!row) return;
    const handles = this.handles.get(row.id) ?? [];
    this.handles.delete(row.id);
    // A failing backend must not keep the session alive: it is revoked in the database first.
    for (const h of handles) await this.source.revoke?.(h).catch(() => undefined);
    await this.audit.append({
      actor: 'system',
      tenantId: row.tenantId,
      action: 'credential.revoked',
      target: row.nodeId,
      runId: row.runId,
      payload: { runId: row.runId, nodeId: row.nodeId, reason },
    });
  }

  /** Revokes every session of a run (cancellation, timeout, lease loss, completion). */
  async revokeRun(runId: string, reason: RevokeReason): Promise<void> {
    const rows = await this.ctx.db
      .select({ id: runNodeSessions.id })
      .from(runNodeSessions)
      .where(and(eq(runNodeSessions.runId, runId), isNull(runNodeSessions.revokedAt)));
    for (const r of rows) await this.revoke(r.id, reason);
    this.issued.delete(runId);
  }

  async recordStopped(
    sessionId: string,
    info: { exitCode: number | null; durationMs: number; reason?: string },
  ): Promise<void> {
    const [row] = await this.ctx.db
      .select()
      .from(runNodeSessions)
      .where(eq(runNodeSessions.id, sessionId));
    if (!row) return;
    await this.audit.append({
      actor: 'system',
      tenantId: row.tenantId,
      action: 'runnode.stopped',
      target: row.nodeId,
      runId: row.runId,
      payload: {
        runId: row.runId,
        nodeId: row.nodeId,
        exitCode: info.exitCode,
        durationMs: info.durationMs,
        ...(info.reason ? { reason: info.reason } : {}),
      },
    });
  }

  /** The result a node posted for its step, or `null` (the orchestrator then fails closed). */
  async resultOf(sessionId: string): Promise<StepHandoverResult | null> {
    const [row] = await this.ctx.db
      .select({ result: runNodeSessions.result })
      .from(runNodeSessions)
      .where(eq(runNodeSessions.id, sessionId));
    return (row?.result as StepHandoverResult | null | undefined) ?? null;
  }

  // ---------- node side (step-scoped token; every call checks the session) ----------

  /** The active session behind a step-scoped token; throws when it is revoked, expired or foreign. */
  async checkSession(claims: RunTokenClaims, runId: string): Promise<SessionRow> {
    const [s] = await this.ctx.db
      .select()
      .from(runNodeSessions)
      .where(eq(runNodeSessions.id, claims.sid ?? ''));
    const dead = (message: string) => new HttpError(401, 'run_node_session_revoked', message);
    if (
      !s ||
      s.runId !== runId ||
      s.nodeId !== claims.workerId ||
      JSON.stringify(s.steps) !== JSON.stringify(claims.steps)
    )
      throw dead('run node session is not valid for this token');
    if (s.revokedAt) throw dead('run node session was revoked');
    if (s.expiresAt.getTime() <= this.ctx.now().getTime()) throw dead('run node session expired');
    const [run] = await this.ctx.db
      .select({ status: runs.status, lockedBy: runs.lockedBy })
      .from(runs)
      .where(eq(runs.id, runId));
    // The lease belongs to the orchestrator; a node only needs the run to be live and leased.
    if (!run || !ACTIVE.includes(run.status) || run.lockedBy === null)
      throw new HttpError(409, 'invalid_state', 'run is not active');
    return s;
  }

  /** The node's handover: its own step's spec, input, output schema and MCP connections. */
  async handover(claims: RunTokenClaims, runId: string, agentId: string): Promise<StepHandover> {
    const s = await this.checkSession(claims, runId);
    this.assertStep(claims, agentId);
    const h = (s.handover as Record<string, StepHandover> | null)?.[agentId];
    if (!h) throw notFound('handover');
    return h;
  }

  assertStep(claims: RunTokenClaims, agentId: string): void {
    if (!claims.sid) return;
    if (!claims.steps?.includes(agentId))
      throw new HttpError(403, 'credential_scope', `run token is not valid for agent "${agentId}"`);
  }

  async submitResult(
    claims: RunTokenClaims,
    runId: string,
    result: StepHandoverResult,
  ): Promise<void> {
    const s = await this.checkSession(claims, runId);
    this.assertStep(claims, result.agentId);
    const [row] = await this.ctx.db
      .update(runNodeSessions)
      .set({ result })
      .where(and(eq(runNodeSessions.id, s.id), sql`${runNodeSessions.result} is null`))
      .returning({ id: runNodeSessions.id });
    if (!row) throw new HttpError(409, 'conflict', 'the step result was already submitted');
  }

  private async deny(
    s: SessionRow,
    agentId: string,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<never> {
    await this.audit.append({
      actor: `node:${s.nodeId}`,
      tenantId: s.tenantId,
      action: 'credential.denied',
      target: agentId,
      runId: s.runId,
      payload: { runId: s.runId, nodeId: s.nodeId, agentId, reason, ...extra },
    });
    throw new HttpError(
      reason === 'already_issued' ? 409 : 403,
      reason === 'already_issued' ? 'credential_already_issued' : 'credential_scope',
      reason === 'already_issued'
        ? `credentials for "${agentId}" were already issued to this session`
        : `credentials for "${agentId}" are not available (${reason})`,
    );
  }

  /**
   * The broker: hands out the values of exactly the references the step declares (plus those of the
   * MCP connections it holds grants for), once per step and session, only for references the
   * tenant allows. Values are resolved after the issue is recorded, so a failure never leaves a
   * second chance on the same session.
   */
  async issueCredentials(
    claims: RunTokenClaims,
    runId: string,
    agentId: string,
  ): Promise<StepCredentials> {
    const s = await this.checkSession(claims, runId);
    if (!claims.steps?.includes(agentId)) return this.deny(s, agentId, 'agent_not_in_token');
    const { run, definition } = await this.runContext(runId);
    const agent = (definition as AgentDefinition).agents.find((a) => a.id === agentId);
    if (!agent) return this.deny(s, agentId, 'unknown_agent');
    const needs = this.needs(agent, await this.configsFor(run, agent));
    const [tenant] = await this.ctx.db
      .select({ secretRefs: tenants.secretRefs })
      .from(tenants)
      .where(eq(tenants.id, run.tenantId));
    const allowed = tenant?.secretRefs ?? [];
    const refused = needs.refs.filter((r) => !secretRefAllowed(allowed, r));
    if (refused.length > 0) return this.deny(s, agentId, 'secret_not_allowed', { refs: refused });
    const [mark] = await this.ctx.db
      .update(runNodeSessions)
      .set({
        credentialsIssued: sql`${runNodeSessions.credentialsIssued} || jsonb_build_array(${agentId}::text)`,
      })
      .where(
        and(
          eq(runNodeSessions.id, s.id),
          isNull(runNodeSessions.revokedAt),
          sql`not (${runNodeSessions.credentialsIssued} @> jsonb_build_array(${agentId}::text))`,
        ),
      )
      .returning({ id: runNodeSessions.id });
    if (!mark) return this.deny(s, agentId, 'already_issued');
    const values = new Map<string, string>();
    let expiresAt = s.expiresAt;
    try {
      for (const ref of needs.refs) {
        const issued = await this.source.issue(ref, {
          runId,
          tenantId: run.tenantId,
          agentId,
          nodeId: s.nodeId,
        });
        values.set(ref, issued.value);
        if (issued.handle)
          this.handles.set(s.id, [...(this.handles.get(s.id) ?? []), issued.handle]);
        if (issued.expiresAt && issued.expiresAt < expiresAt) expiresAt = issued.expiresAt;
      }
    } catch {
      // The reason stays out of the response (it can name backends); the audit entry has the refs.
      return this.deny(s, agentId, 'unavailable', { refs: needs.refs });
    }
    let known = this.issued.get(runId);
    if (!known) this.issued.set(runId, (known = new Set()));
    for (const v of values.values()) known.add(v);
    const val = (ref: string) => values.get(ref)!;
    const result: StepCredentials = {
      agentId,
      expiresAt: expiresAt.toISOString(),
      credentials: needs.declared.map((d) => ({
        secret: d.secret,
        env: d.env,
        value: val(d.secret),
      })),
      connections: needs.connections
        .filter((c) => Object.keys(c.env).length + Object.keys(c.headers).length > 0)
        .map((c) => ({
          server: c.server,
          ...(Object.keys(c.env).length
            ? { env: Object.fromEntries(Object.entries(c.env).map(([k, ref]) => [k, val(ref)])) }
            : {}),
          ...(Object.keys(c.headers).length
            ? {
                headers: Object.fromEntries(
                  Object.entries(c.headers).map(([k, ref]) => [k, val(ref)]),
                ),
              }
            : {}),
        })),
    };
    await this.audit.append({
      actor: `node:${s.nodeId}`,
      tenantId: s.tenantId,
      action: 'credential.issued',
      target: agentId,
      runId,
      payload: {
        runId,
        nodeId: s.nodeId,
        agentId,
        refs: needs.refs,
        connections: needs.connections.map((c) => c.server),
        expiresAt: result.expiresAt,
        source: this.source.name,
      },
    });
    return result;
  }
}
