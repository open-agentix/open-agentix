import { randomUUID } from 'node:crypto';
import {
  OaxError,
  StaticCredentialSource,
  canonicalSecretRef,
  credentialEnvName,
  issueRunToken,
  redact,
  resolveSchema,
  secretRefAllowed,
  type Budget,
  type SecretResolver,
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
import { connections, eventSources, runNodeSessions, runs, tenants } from '../db/schema.js';
import { secretRefsOf } from '@openagentix/providers';
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
   * Nothing secret is kept in memory: the values a run's nodes received are re-resolved on demand
   * for redaction (see {@link knownSecrets}), and the opaque handles of dynamic credentials live in
   * the session row, so any control node instance can revoke them.
   */
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
    private readonly catalog: CatalogService,
    private readonly source: CredentialSource = new StaticCredentialSource(ctx.secrets),
  ) {}

  /**
   * Values of the secrets this run's nodes were given, for scrubbing step records, audit payloads
   * and node results. Re-resolved from the secret store (static source only; a dynamic source's
   * values are not recoverable and are covered by the generic patterns only). This is a net for
   * ACCIDENTAL leaks: a compromised node holds the plain values and can encode them.
   */
  async knownSecrets(runId: string): Promise<string[]> {
    if (this.source.name !== 'static') return [];
    const sessions = await this.ctx.db
      .select({ issued: runNodeSessions.credentialsIssued })
      .from(runNodeSessions)
      .where(eq(runNodeSessions.runId, runId));
    const agentIds = new Set(sessions.flatMap((x) => x.issued));
    if (agentIds.size === 0) return [];
    const { run, definition } = await this.runContext(runId);
    const out = new Set<string>();
    for (const id of agentIds) {
      const agent = definition.agents.find((a) => a.id === id);
      if (!agent) continue;
      const needs = this.needs(agent, await this.configsFor(run, agent));
      for (const ref of needs.refs) {
        try {
          out.add(await this.ctx.secrets.resolve(ref));
        } catch {
          // not resolvable any more: nothing to scrub
        }
      }
    }
    return [...out];
  }

  /** Scrubs known secret values (and the generic patterns) from a value that a node influenced. */
  async scrub<T>(runId: string, value: T): Promise<T> {
    const known = await this.knownSecrets(runId);
    return known.length > 0 ? redact(value, { knownSecrets: known }) : value;
  }

  /**
   * Secret references that belong to the PLATFORM and are never handed to a run node, whatever a
   * tenant allowlist says: provider keys (environment providers and every model connection), event
   * source secrets (webhook signing, Kafka credentials), and the secrets of platform connections.
   * Canonical form (see `canonicalSecretRef`).
   */
  async platformSecretRefs(): Promise<Set<string>> {
    const out = new Set<string>();
    const walk = (v: unknown, secretish: boolean): void => {
      if (typeof v === 'string') {
        if (secretish && v) out.add(canonicalSecretRef(v));
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, secretish));
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) walk(x, secretish || /secret/i.test(k));
    };
    for (const p of this.ctx.config.providers) {
      walk(p, false);
      try {
        for (const r of secretRefsOf(p as never)) out.add(canonicalSecretRef(r));
      } catch {
        // unusual provider shape: the walk above already covered the *Secret fields
      }
    }
    for (const c of await this.ctx.db
      .select({ kind: connections.kind, scope: connections.scope, config: connections.config })
      .from(connections))
      if (c.kind === 'model' || c.scope === 'platform') walk(c.config, false);
    for (const e of await this.ctx.db
      .select({ refs: eventSources.secretRefs, config: eventSources.config })
      .from(eventSources)) {
      e.refs.forEach((r) => out.add(canonicalSecretRef(r)));
      walk(e.config, false);
    }
    return out;
  }

  /**
   * The secret resolver of IN-PROCESS runs of a tenant: the same allowlist as the broker. A tenant
   * connection may only use references the tenant allows (`tenants.secret_refs`); references of
   * platform connections are operator-chosen and stay resolvable for them.
   */
  async resolverFor(tenantId: string): Promise<SecretResolver> {
    const [t] = await this.ctx.db
      .select({ refs: tenants.secretRefs })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const allowed = t?.refs ?? [];
    const platform = new Set<string>();
    for (const c of await this.ctx.db
      .select({ config: connections.config })
      .from(connections)
      .where(and(eq(connections.kind, 'mcp'), eq(connections.scope, 'platform'))))
      for (const k of ['envSecrets', 'headerSecrets'])
        for (const v of Object.values(
          ((c.config as Record<string, unknown>)[k] ?? {}) as Record<string, string>,
        ))
          platform.add(canonicalSecretRef(v));
    const inner = this.ctx.secrets;
    return {
      resolve: async (ref: string) => {
        if (!secretRefAllowed(allowed, ref) && !platform.has(canonicalSecretRef(ref)))
          throw new OaxError(
            'secret_not_allowed',
            `secret "${ref}" is not allowed for this tenant (tenants.secret_refs)`,
          );
        return inner.resolve(ref);
      },
    };
  }

  /** What is left of the run's budget; a node enforces only this, never the full budget. */
  private remainingBudget(budget: Budget, run: typeof runs.$inferSelect, now: number): Budget {
    const out: Budget = {};
    if (budget.maxTokens !== undefined)
      out.maxTokens = Math.max(1, budget.maxTokens - run.tokensIn - run.tokensOut);
    if (budget.maxCostUsd !== undefined)
      out.maxCostUsd = Math.max(0.000001, budget.maxCostUsd - Number(run.costMicros) / 1e6);
    // Steps are not stored per kind here; the step sequence number over-counts, which only tightens.
    if (budget.maxSteps !== undefined) out.maxSteps = Math.max(1, budget.maxSteps - run.lastSeq);
    if (budget.maxToolCalls !== undefined)
      out.maxToolCalls = Math.max(1, budget.maxToolCalls - run.toolCalls);
    if (budget.timeoutSeconds !== undefined) {
      const elapsed = run.startedAt ? (now - run.startedAt.getTime()) / 1000 : 0;
      out.timeoutSeconds = Math.max(1, Math.floor(budget.timeoutSeconds - elapsed));
    }
    return out;
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
        budget: this.remainingBudget(definition.budget, run, now.getTime()),
      },
      mcp: (await this.configsFor(run, agent)).map((c) => this.stripSecrets(c)),
    };
    await this.ctx.db.insert(runNodeSessions).values({
      id: sessionId,
      runId,
      tenantId: run.tenantId,
      nodeId,
      orchestratorId,
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
    const handles = row.credentialHandles;
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

  /**
   * The result a node posted for its step, or `null` (the orchestrator then fails closed). It is
   * deleted when read: the orchestrator is the only consumer and the data lives on in the run.
   */
  async resultOf(sessionId: string): Promise<StepHandoverResult | null> {
    const [row] = await this.ctx.db
      .select({ result: runNodeSessions.result })
      .from(runNodeSessions)
      .where(eq(runNodeSessions.id, sessionId));
    if (!row?.result) return null;
    await this.ctx.db
      .update(runNodeSessions)
      .set({ result: null })
      .where(eq(runNodeSessions.id, sessionId));
    return row.result as StepHandoverResult;
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
    // The lease belongs to the orchestrator that created the session; when another worker took the
    // run over, every session of the old attempt is dead (a restarted attempt gets new sessions).
    if (!run || !ACTIVE.includes(run.status) || run.lockedBy !== s.orchestratorId)
      throw new HttpError(409, 'invalid_state', 'run is not active for this session');
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
    // Scrub what a node says before it is stored (and later shown): content, JSON and the message.
    const clean = await this.scrub(runId, result);
    const [row] = await this.ctx.db
      .update(runNodeSessions)
      .set({ result: clean })
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
    // Platform secrets (provider keys, event sources, platform connections) never reach a node.
    const platform = await this.platformSecretRefs();
    const platformHit = needs.refs.filter((r) => platform.has(canonicalSecretRef(r)));
    if (platformHit.length > 0)
      return this.deny(s, agentId, 'platform_secret', { refs: platformHit });
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
    const handles: string[] = [];
    const persistHandles = async () => {
      if (handles.length > 0)
        await this.ctx.db
          .update(runNodeSessions)
          .set({ credentialHandles: handles })
          .where(eq(runNodeSessions.id, s.id));
    };
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
        if (issued.handle) handles.push(issued.handle);
        if (issued.expiresAt && issued.expiresAt < expiresAt) expiresAt = issued.expiresAt;
      }
    } catch {
      // Handles issued before the failure are still recalled when the session is revoked.
      await persistHandles();
      // The reason stays out of the response (it can name backends); the audit entry has the refs.
      return this.deny(s, agentId, 'unavailable', { refs: needs.refs });
    }
    await persistHandles();
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
