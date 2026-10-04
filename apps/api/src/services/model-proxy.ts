import { createHash } from 'node:crypto';
import {
  OaxError,
  effectiveBudget,
  estimateInputUpperBound,
  getEgressPolicy,
  issueModelToken,
  mayFlow,
  MODEL_TOKEN_PREFIX,
  verifyModelToken,
  verifyRunToken,
  type AgentDefinition,
  type AgentSpec,
  type Budget,
  type ModelTokenClaims,
  type RunTokenClaims,
} from '@openagentix/core';
import {
  ChatStreamAggregator,
  MODEL_ERRORS,
  ProviderError,
  StreamAbortedError,
  UnavailableProvider,
  WorkerModelResponseSchema,
  createStreamPlan,
  modelErrorEnvelope,
  proposeModels,
  scrub,
  type ChatRequest,
  type ChatResponse,
  type ModelErrorCode,
  type ModelErrorEnvelope,
  type ModelProvider,
  type ModelTokenResponse,
  type ProviderConfig,
  type StreamPlan,
  type StreamResult,
  type WorkerModelRequest,
  type WorkerModelResponse,
} from '@openagentix/providers';
import { eq } from 'drizzle-orm';
import { providerEndpoints } from '../airgap.js';
import type { AppContext } from '../context.js';
import { runs } from '../db/schema.js';
import { HttpError } from '../errors.js';
import type { AgentsService } from './agents.js';
import type { AuditService } from './audit.js';
import type {
  ModelAccountingService,
  Remaining,
  Reservation,
  Settlement,
} from './model-accounting.js';
import type { ModelsService } from './models.js';
import type { RunNodesService } from './run-nodes.js';

/** Output bound when neither the request, the agent nor the catalog names one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** Hard ceiling of one call's output, whatever the node asks for and the catalog knows. */
const MAX_OUTPUT_TOKENS_CEILING = 131_072;
/** A provider may overshoot the granted output bound by this factor before the stream is cut. */
const OVERRUN_FACTOR = 1.1;
/** Repeated identical denials of one session are written once per window (flood protection). */
const DENIED_WINDOW_MS = 60_000;
/** Provider error text in responses, audit entries and logs is cut to this many characters. */
const MESSAGE_MAX = 300;

/** An error of the model proxy with a stable code from `MODEL_ERRORS` (ADR 0009 section 2.5). */
export class ModelProxyError extends Error {
  /** Set once the request counter saw this error (it may pass several catch blocks). */
  counted = false;
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
  get status(): number {
    return MODEL_ERRORS[this.code].status;
  }
  envelope(): ModelErrorEnvelope {
    return modelErrorEnvelope(this.code, this.message);
  }
}

const isModelCode = (c: unknown): c is ModelErrorCode =>
  typeof c === 'string' && Object.prototype.hasOwnProperty.call(MODEL_ERRORS, c);

/**
 * Maps any thrown value to a proxy error. Known codes keep their meaning; everything else fails
 * closed as `model_proxy_unavailable` with a fixed message, so internal details (SQL, stack,
 * provider bodies) never reach a node. Provider messages must be scrubbed by the caller first.
 */
export function toModelProxyError(e: unknown): ModelProxyError {
  if (e instanceof ModelProxyError) return e;
  const code = (e as { code?: unknown } | null)?.code;
  if (e instanceof HttpError || e instanceof OaxError) {
    if (isModelCode(code)) return new ModelProxyError(code, e.message);
    // Existing platform codes that surface through shared services.
    if (code === 'invalid_state' || code === 'run_node_session_revoked')
      return new ModelProxyError('run_node_session_revoked', 'run node session is not active');
    if (code === 'not_found' || code === 'forbidden' || code === 'credential_scope')
      return new ModelProxyError('model_not_allowed', 'the call is not allowed for this step');
    if (
      code === 'run_token_invalid' ||
      code === 'run_token_expired' ||
      code === 'model_token_invalid' ||
      code === 'model_token_expired'
    )
      return new ModelProxyError('unauthenticated', 'valid model or run token required');
    if (code === 'model_token_binding')
      return new ModelProxyError('model_not_allowed', 'the token is not valid for this call');
  }
  return new ModelProxyError('model_proxy_unavailable', 'the model proxy is unavailable');
}

/** What an authenticated model call knows about its caller. Everything else is read from the DB. */
export interface CallAuth {
  via: 'model-token' | 'run-token';
  runId: string;
  sid: string;
  nodeId: string;
  /** Model token: the one step the token is bound to. Run token: `null` (checked against `steps`). */
  boundAgentId: string | null;
  steps: readonly string[];
  tenantId: string;
}

export interface StreamSink {
  /** Resolves when the client is ready for more (backpressure); rejects when the client is gone. */
  delta(text: string): Promise<void>;
  done(res: WorkerModelResponse): void;
  error(code: ModelErrorCode, message: string): void;
}

export interface StreamIo {
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
  /** Called once the upstream answered; the route sends the SSE headers here. */
  begin(callId: string): StreamSink;
}

export interface ModelProxyHooks {
  /**
   * Emergency override check (W2-3): return a reason to refuse the provider or model. Not wired
   * yet; the admission order already reserves the slot (ADR 0009 section 3, step 6).
   */
  checkOverride?: (target: { provider: string; model: string }) => Promise<string | null>;
}

interface Admitted {
  auth: CallAuth;
  agent: AgentSpec;
  definition: AgentDefinition;
  provider: ModelProvider;
  config: ProviderConfig | null;
  secrets: string[];
  chat: ChatRequest;
  reservation: Reservation;
  plan: StreamPlan | null;
  deadlineMs: number;
  digest: string;
  startedAt: number;
  messageCount: number;
  toolNames: string[];
  priced: boolean;
  /** The in-flight gauges were already decremented (settled, released or expired). */
  gaugesReleased: boolean;
}

type SessionRow = NonNullable<Awaited<ReturnType<RunNodesService['sessionById']>>>;

/**
 * The native model endpoint and the model token of the control node (ADR 0009 sections 2, 3, 4, 6).
 * A run node never holds a provider key: the key is resolved here, per call, and never leaves this
 * process. Every refusal and every internal error fails closed: nothing is forwarded and no
 * reservation stays open. Request and response bodies are never logged or audited.
 */
export class ModelProxyService {
  private inflight = 0;
  private readonly windows = new Map<string, number[]>();
  private readonly denied = new Map<string, { at: number; suppressed: number }>();

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
    private readonly models: ModelsService,
    private readonly accounting: ModelAccountingService,
    private readonly nodes: RunNodesService,
    private readonly hooks: ModelProxyHooks = {},
  ) {}

  get enabled(): boolean {
    return this.ctx.config.modelProxy.enabled;
  }

  /** Throws `model_proxy_unavailable` while the feature flag is off. */
  assertEnabled(): void {
    if (!this.enabled)
      throw new ModelProxyError('model_proxy_unavailable', 'the model proxy is not enabled');
  }

  private cfg() {
    return this.ctx.config.modelProxy;
  }

  // ---------- authentication ----------

  /**
   * Verifies a bearer token for a model call and binds it to the path's run, its session and its
   * step. Accepts the step-scoped run token of the node or its model token; an orchestrator token
   * (no `sid`), a token of another run and a token whose session is gone are refused.
   */
  async authenticate(bearer: string | null, runId: string): Promise<CallAuth> {
    const secret = this.ctx.config.runToken.secret;
    const now = this.ctx.now().getTime();
    if (!bearer) throw new ModelProxyError('unauthenticated', 'valid model or run token required');
    let auth: Omit<CallAuth, 'tenantId'>;
    let modelClaims: ModelTokenClaims | null = null;
    try {
      if (bearer.startsWith(`${MODEL_TOKEN_PREFIX}.`)) {
        modelClaims = verifyModelToken(secret, bearer, now);
        auth = {
          via: 'model-token',
          runId: modelClaims.runId,
          sid: modelClaims.sid,
          nodeId: modelClaims.nodeId,
          boundAgentId: modelClaims.agentId,
          steps: [modelClaims.agentId],
        };
      } else {
        const claims: RunTokenClaims = verifyRunToken(secret, bearer, now);
        if (!claims.sid)
          throw new ModelProxyError(
            'model_not_allowed',
            'a step-scoped token of a run node is required',
          );
        auth = {
          via: 'run-token',
          runId: claims.runId,
          sid: claims.sid,
          nodeId: claims.workerId,
          boundAgentId: null,
          steps: claims.steps ?? [],
        };
      }
    } catch (e) {
      if (e instanceof ModelProxyError) throw e;
      throw new ModelProxyError('unauthenticated', 'valid model or run token required');
    }
    if (auth.runId !== runId)
      throw new ModelProxyError('model_not_allowed', 'the token is not valid for this run');
    const session = await this.nodes.sessionById(auth.sid);
    const dead = (message: string) => new ModelProxyError('run_node_session_revoked', message);
    if (!session || session.runId !== runId || session.nodeId !== auth.nodeId)
      throw dead('run node session is not valid for this token');
    if (JSON.stringify(session.steps) !== JSON.stringify(auth.steps))
      throw dead('run node session is not valid for this token');
    const state = await this.sessionState(session, runId);
    if (state) throw dead(state);
    if (modelClaims && session.modelTokenJti !== modelClaims.jti)
      throw new ModelProxyError('unauthenticated', 'model token is not the one issued');
    return { ...auth, tenantId: session.tenantId };
  }

  /** Why a session cannot make calls any more, or `null` when it is alive and its run is running. */
  private async sessionState(session: SessionRow, runId: string): Promise<string | null> {
    if (session.revokedAt) return 'run node session was revoked';
    if (session.expiresAt.getTime() <= this.ctx.now().getTime()) return 'run node session expired';
    const [run] = await this.ctx.db
      .select({
        status: runs.status,
        lockedBy: runs.lockedBy,
        cancel: runs.cancelRequested,
      })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run || run.status !== 'running') return 'run is not running';
    if (run.lockedBy !== session.orchestratorId) return 'run was taken over by another worker';
    if (run.cancel) return 'run was cancelled';
    return null;
  }

  // ---------- model token ----------

  /** Issues the model token of one step, once per step and session (ADR 0009 section 2.2). */
  async issueToken(auth: CallAuth, agentId: string): Promise<ModelTokenResponse> {
    this.assertEnabled();
    if (auth.via !== 'run-token')
      throw new ModelProxyError('unauthenticated', 'a step-scoped run token is required');
    if (!auth.steps.includes(agentId))
      throw await this.deny(auth, agentId, 'model_not_allowed', 'agent is not part of the token');
    const { run, agent } = await this.context(auth, agentId);
    const resolved = await this.models.resolve(
      { tenantId: run.tenantId, teamId: run.teamId, agentId: run.agentId },
      agent.provider,
    );
    if (!resolved || resolved.provider instanceof UnavailableProvider)
      throw await this.deny(
        auth,
        agentId,
        'model_not_allowed',
        'the provider of this step is not available',
      );
    const session = await this.nodes.sessionById(auth.sid);
    if (!session) throw new ModelProxyError('run_node_session_revoked', 'session not found');
    const cfg = this.ctx.config;
    const issued = issueModelToken(
      cfg.runToken.secret,
      {
        runId: auth.runId,
        sid: auth.sid,
        nodeId: auth.nodeId,
        agentId,
        ttlSeconds: cfg.runToken.ttlSeconds,
        notAfterMs: session.expiresAt.getTime(),
      },
      this.ctx.now().getTime(),
    );
    if (!(await this.nodes.recordModelToken(auth.sid, issued.claims.jti)))
      throw await this.deny(
        auth,
        agentId,
        'model_token_already_issued',
        'a model token was already issued to this session',
      );
    await this.audit.append({
      actor: `node:${auth.nodeId}`,
      tenantId: auth.tenantId,
      action: 'model_token.issued',
      target: agentId,
      runId: auth.runId,
      payload: {
        runId: auth.runId,
        nodeId: auth.nodeId,
        agentId,
        jti: issued.claims.jti,
        expiresAt: new Date(issued.claims.exp * 1000).toISOString(),
      },
    });
    const base = (cfg.runners.container.nodeControlUrl ?? cfg.publicUrl).replace(/\/$/, '');
    return {
      token: issued.token,
      expiresAt: new Date(issued.claims.exp * 1000).toISOString(),
      protocol: 'native',
      baseUrl: `${base}/v1/worker/runs/${auth.runId}`,
      model: agent.model,
    };
  }

  // ---------- context, denial audit, rate limit ----------

  private async context(auth: CallAuth, agentId: string) {
    const [run] = await this.ctx.db.select().from(runs).where(eq(runs.id, auth.runId));
    // The run row decides the tenant. A token for a run of another tenant cannot get here.
    if (!run || run.tenantId !== auth.tenantId)
      throw new ModelProxyError('model_not_allowed', 'the call is not allowed for this step');
    const { definition } = await this.agents.definitionOf(run.agentVersionId);
    const agent = definition.agents.find((a) => a.id === agentId);
    if (!agent)
      throw new ModelProxyError(
        'model_not_allowed',
        'agent is not part of the published definition',
      );
    return { run, definition, agent };
  }

  /** Audit entry `model.denied` (names only), at most once per minute per session and reason. */
  private async deny(
    auth: CallAuth,
    agentId: string,
    code: ModelErrorCode,
    message: string,
    extra: { provider?: string; model?: string } = {},
  ): Promise<ModelProxyError> {
    const err = new ModelProxyError(code, message);
    const key = `${auth.sid}:${code}`;
    const now = Date.now();
    const prev = this.denied.get(key);
    if (prev && now - prev.at < DENIED_WINDOW_MS) {
      prev.suppressed++;
      return err;
    }
    this.denied.set(key, { at: now, suppressed: 0 });
    if (this.denied.size > 10_000) {
      for (const [k, v] of this.denied) if (now - v.at >= DENIED_WINDOW_MS) this.denied.delete(k);
    }
    try {
      await this.audit.append({
        actor: `node:${auth.nodeId}`,
        tenantId: auth.tenantId,
        action: 'model.denied',
        target: agentId,
        runId: auth.runId,
        payload: {
          runId: auth.runId,
          nodeId: auth.nodeId,
          agentId,
          reason: code,
          ...(prev ? { suppressed: prev.suppressed } : {}),
          ...(extra.provider ? { provider: extra.provider } : {}),
          ...(extra.model ? { model: extra.model } : {}),
        },
      });
    } catch (e) {
      this.ctx.logger.warn({ err: (e as Error).name }, 'could not write model.denied');
    }
    return err;
  }

  /** Sliding window per run (per replica; the database-backed concurrency limits span replicas). */
  private checkRate(runId: string): void {
    const limit = this.cfg().callsPerMinute;
    const now = Date.now();
    const recent = (this.windows.get(runId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) {
      this.windows.set(runId, recent);
      const retry = Math.max(1, Math.ceil((60_000 - (now - recent[0]!)) / 1000));
      throw new ModelProxyError('model_rate_limited', 'too many model calls for this run', retry);
    }
    recent.push(now);
    this.windows.set(runId, recent);
    if (this.windows.size > 10_000) {
      for (const [k, v] of this.windows)
        if (v.every((t) => now - t >= 60_000)) this.windows.delete(k);
    }
  }

  // ---------- admission (ADR 0009 section 3) ----------

  private async admit(
    auth: CallAuth,
    body: WorkerModelRequest,
    wantStream: boolean,
  ): Promise<Admitted> {
    const agentId = body.agentId;
    // 3. The token binds the step; a node cannot call for another agent of the run.
    if (auth.boundAgentId !== null ? auth.boundAgentId !== agentId : !auth.steps.includes(agentId))
      throw await this.deny(auth, agentId, 'model_not_allowed', 'agent is not part of the token');
    const { run, definition, agent } = await this.context(auth, agentId);
    const pinned = { provider: agent.provider, model: agent.model };
    // Model allowlist: the published step fixes provider and model. The request cannot choose.
    if (body.request.model !== agent.model)
      throw await this.deny(
        auth,
        agentId,
        'model_not_allowed',
        'model is not the one published for this step',
        pinned,
      );
    const resolved = await this.models.resolve(
      { tenantId: run.tenantId, teamId: run.teamId, agentId: run.agentId },
      agent.provider,
    );
    if (!resolved)
      throw await this.deny(
        auth,
        agentId,
        'model_not_allowed',
        'the provider of this step is not available to this run',
        pinned,
      );
    const { provider, config } = resolved;
    // Data classification: checked here with the published classification, never from the node.
    if (!mayFlow(definition.classification, provider.clearance))
      throw await this.deny(
        auth,
        agentId,
        'classification_denied',
        `"${definition.classification}" data must not be sent to a provider cleared for "${provider.clearance}"`,
        pinned,
      );
    // Air-gapped mode: every endpoint of the provider must be allowlisted before any connection.
    if (config) {
      try {
        const policy = getEgressPolicy();
        for (const ep of providerEndpoints(config, `provider "${agent.provider}"`))
          policy.assert(ep.url, ep.purpose);
      } catch (e) {
        if ((e as { code?: string }).code === 'egress_denied')
          throw await this.deny(
            auth,
            agentId,
            'egress_denied',
            'the provider endpoint is not on the air-gap allowlist',
            pinned,
          );
        throw e;
      }
    }
    if (provider instanceof UnavailableProvider)
      throw await this.deny(
        auth,
        agentId,
        'model_proxy_unavailable',
        'the provider of this step is unavailable',
        pinned,
      );
    const override = await this.hooks.checkOverride?.(pinned);
    if (override) throw await this.deny(auth, agentId, 'security_override', override, pinned);
    // Cancellation was part of the session check; the run row is read again by `reserve`.

    // Request normalisation: a new request built from the validated fields only. The simulation of
    // a simulated provider comes from the published definition, never from the node.
    const r = body.request;
    const entry = config?.models?.find((m) => m.id === agent.model);
    const [limits] = proposeModels(this.ctx.modelCatalog, provider.catalogProvider ?? null, [
      { id: agent.model, ...(entry?.catalogModel ? { catalogModel: entry.catalogModel } : {}) },
    ]);
    const chat: ChatRequest = {
      model: agent.model,
      messages: r.messages,
      ...(r.system !== undefined ? { system: r.system } : {}),
      ...(r.tools ? { tools: r.tools } : {}),
      ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
      hints: {
        ...(agent.simulation ? { simulation: agent.simulation.responses } : {}),
        ...(r.hints?.context ? { context: r.hints.context } : {}),
      },
    };
    const contextTokens = limits?.contextTokens ?? null;
    const upper = estimateInputUpperBound(chat, { contextTokens });
    const inputTokens =
      this.cfg().reservation === 'estimate' ? Math.max(1, Math.ceil(upper / 3)) : upper;
    const outputCap = [
      r.maxTokens ?? limits?.outputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      agent.maxTokensPerCall,
      limits?.outputTokens ?? undefined,
      MAX_OUTPUT_TOKENS_CEILING,
    ].filter((n): n is number => typeof n === 'number' && n > 0);
    const maxOutputTokens = Math.max(1, Math.min(...outputCap));
    const budget: Budget = effectiveBudget(definition.budget as Budget, agent.budget);
    const startedMs = run.startedAt?.getTime() ?? this.ctx.now().getTime();
    const remainingMs =
      budget.timeoutSeconds === undefined
        ? Number.POSITIVE_INFINITY
        : budget.timeoutSeconds * 1000 - (this.ctx.now().getTime() - startedMs);
    const deadlineMs = Math.max(1000, Math.min(this.cfg().maxCallSeconds * 1000, remainingMs));

    const secrets = await this.models.secretValues(config);
    const plan =
      wantStream && config
        ? await createStreamPlan(
            config,
            { secrets: this.ctx.secrets, fetchImpl: this.ctx.fetchImpl },
            {
              model: agent.model,
              limits: {
                ttfbMs: this.cfg().ttfbSeconds * 1000,
                idleMs: this.cfg().idleSeconds * 1000,
                deadlineMs,
                maxTotalBytes: this.cfg().maxResponseBytes,
              },
            },
          )
        : null;

    let reservation: Reservation;
    try {
      reservation = await this.accounting.reserve(
        { tenantId: run.tenantId },
        {
          runId: run.id,
          agentId,
          sessionId: auth.sid,
          inputTokens,
          maxOutputTokens,
          minOutputTokens: Math.min(this.cfg().minOutputTokens, maxOutputTokens),
          deadlineMs,
        },
      );
    } catch (e) {
      const err = toModelProxyError(e);
      if (err.code === 'model_proxy_unavailable') throw err;
      throw await this.deny(auth, agentId, err.code, err.message, pinned);
    }
    chat.maxTokens = reservation.reservedOutputTokens;
    this.ctx.metrics.modelProxyReservedMicros.inc(reservation.reservedMicros);
    this.ctx.metrics.modelProxyReservationsActive.inc();
    return {
      auth,
      agent,
      definition,
      provider,
      config,
      secrets,
      chat,
      reservation,
      plan,
      deadlineMs,
      digest: createHash('sha256').update(JSON.stringify(chat)).digest('hex'),
      startedAt: Date.now(),
      messageCount: r.messages.length,
      toolNames: (r.tools ?? []).map((t) => t.name),
      priced: reservation.priced,
      gaugesReleased: false,
    };
  }

  // ---------- running a call ----------

  /** Polls the session while a call is open; ends the call within one poll interval of a revoke. */
  private watch(adm: Admitted, stop: (reason: string) => void): () => void {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const session = await this.nodes.sessionById(adm.auth.sid);
          const why = session ? await this.sessionState(session, adm.auth.runId) : 'gone';
          if (why)
            stop(session?.revokedAt ? 'revoked' : why.includes('cancel') ? 'cancelled' : 'revoked');
        } catch {
          // Cannot tell: fail closed and end the call.
          stop('revoked');
        }
      })();
    }, this.cfg().revocationPollMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async settle(
    adm: Admitted,
    req: Parameters<ModelAccountingService['settle']>[2],
  ): Promise<Settlement> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 3 ** attempt));
      try {
        return await this.accounting.settle(
          { tenantId: adm.auth.tenantId },
          adm.reservation.reservationId,
          {
            via: 'proxy',
            ...req,
          },
        );
      } catch (e) {
        last = e;
      }
    }
    // The reaper settles the reservation at the reserved amount (fail closed in money).
    this.ctx.logger.error(
      { callId: adm.reservation.reservationId, err: (last as Error)?.name },
      'model call settlement failed; the reservation will expire',
    );
    throw new ModelProxyError('model_proxy_unavailable', 'the call could not be settled');
  }

  private released(adm: Admitted): void {
    if (adm.gaugesReleased) return;
    adm.gaugesReleased = true;
    this.ctx.metrics.modelProxyReservedMicros.dec(adm.reservation.reservedMicros);
    this.ctx.metrics.modelProxyReservationsActive.dec();
  }

  private async releaseQuietly(adm: Admitted, note: string): Promise<void> {
    try {
      await this.accounting.release(
        { tenantId: adm.auth.tenantId },
        adm.reservation.reservationId,
        note,
      );
    } catch (e) {
      this.ctx.logger.error({ err: (e as Error).name }, 'could not release a model reservation');
    }
  }

  private auditExtra(adm: Admitted, stopReason: string | null, ms: number) {
    return {
      nodeId: adm.auth.nodeId,
      requestDigest: adm.digest,
      latencyMs: ms,
      ...(stopReason ? { stopReason } : {}),
    };
  }

  private detail(adm: Admitted, res: ChatResponse | null, ms: number) {
    const full = this.cfg().capture === 'metadata';
    return {
      input: { messageCount: adm.messageCount, tools: adm.toolNames },
      ...(res
        ? {
            output: {
              ...(full ? { text: res.text, toolCalls: res.toolCalls } : {}),
              stopReason: res.stopReason,
            },
          }
        : {}),
      durationMs: ms,
    };
  }

  private scrubMessage(text: string, adm: Admitted): string {
    return scrub(text, adm.secrets, MESSAGE_MAX);
  }

  /** Error of the provider call as a proxy error with a scrubbed message (no body, no key). */
  private providerFailure(e: unknown, adm: Admitted): ModelProxyError {
    const raw = e instanceof Error ? e.message : 'upstream error';
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'provider_timeout')
      return new ModelProxyError('provider_timeout', this.scrubMessage(raw, adm));
    if (code === 'egress_denied')
      return new ModelProxyError('egress_denied', 'the provider endpoint is not allowed');
    return new ModelProxyError('provider_error', this.scrubMessage(raw, adm));
  }

  /** True when the failure means the provider did no work (nothing to bill). */
  private noWorkDone(e: unknown): boolean {
    if (e instanceof ProviderError) return e.status === null || (e.status >= 400 && e.status < 504);
    return (e as { code?: unknown } | null)?.code === 'egress_denied';
  }

  private count(code: string, adm: Pick<Admitted, 'provider'> | undefined): void {
    this.ctx.metrics.modelProxyRequests.inc({
      surface: 'native',
      provider: adm?.provider.name ?? 'unknown',
      code,
    });
  }

  /** Counts a failed request once, however many catch blocks it passes. */
  private countError(err: ModelProxyError, adm: Pick<Admitted, 'provider'> | undefined): void {
    if (err.counted) return;
    err.counted = true;
    this.count(err.code, adm);
  }

  private tokens(s: Settlement, usage: { cacheRead: number; cacheWrite: number }): void {
    const m = this.ctx.metrics.modelProxyTokens;
    m.inc(
      { direction: 'input', source: s.usageSource },
      Math.max(0, s.tokensIn - usage.cacheRead - usage.cacheWrite),
    );
    m.inc({ direction: 'output', source: s.usageSource }, s.tokensOut);
    if (usage.cacheRead) m.inc({ direction: 'cache_read', source: s.usageSource }, usage.cacheRead);
    if (usage.cacheWrite)
      m.inc({ direction: 'cache_write', source: s.usageSource }, usage.cacheWrite);
  }

  private response(
    adm: Admitted,
    res: ChatResponse,
    s: Settlement,
    cache: { cacheRead: number; cacheWrite: number },
  ): WorkerModelResponse {
    const resv = adm.reservation;
    const refundMicros = Math.max(0, resv.reservedMicros - s.costMicros);
    const refundTokens = Math.max(
      0,
      resv.reservedInputTokens + resv.reservedOutputTokens - s.tokensIn - s.tokensOut,
    );
    const remaining: Remaining = {};
    if (resv.remaining.costMicros !== undefined)
      remaining.costMicros = resv.remaining.costMicros + refundMicros;
    if (resv.remaining.tokens !== undefined)
      remaining.tokens = resv.remaining.tokens + refundTokens;
    if (resv.remaining.modelCalls !== undefined) remaining.modelCalls = resv.remaining.modelCalls;
    const out = {
      callId: resv.reservationId,
      response: {
        text: res.text,
        toolCalls: res.toolCalls,
        usage: {
          inputTokens: Math.max(0, s.tokensIn - cache.cacheRead - cache.cacheWrite),
          outputTokens: s.tokensOut,
          cacheReadTokens: cache.cacheRead,
          cacheWriteTokens: cache.cacheWrite,
        },
        stopReason: res.stopReason,
        model: res.model,
      },
      usage: {
        inputTokens: Math.max(0, s.tokensIn - cache.cacheRead - cache.cacheWrite),
        outputTokens: s.tokensOut,
        cacheReadTokens: cache.cacheRead,
        cacheWriteTokens: cache.cacheWrite,
        source: s.usageSource === 'reservation' ? 'estimated' : s.usageSource,
      },
      costMicros: s.costMicros,
      priced: adm.priced,
      remaining,
    };
    // The response is validated against the wire schema: a malformed provider answer (for example a
    // tool call with a prototype key) fails closed instead of reaching the node.
    const parsed = WorkerModelResponseSchema.safeParse(out);
    if (!parsed.success)
      throw new ModelProxyError('provider_error', 'the provider answered with an invalid response');
    return parsed.data;
  }

  private acquire(): void {
    if (this.inflight >= this.cfg().maxStreams)
      throw new ModelProxyError('model_rate_limited', 'too many concurrent model calls', 1);
    this.inflight++;
  }

  // ---------- JSON (non-streaming) ----------

  /** The native call without streaming: `WorkerModelRequest` -> `WorkerModelResponse`. */
  async call(
    auth: CallAuth,
    body: WorkerModelRequest,
    clientGone: AbortSignal,
  ): Promise<WorkerModelResponse> {
    this.assertEnabled();
    this.checkRate(auth.runId);
    this.acquire();
    let adm: Admitted | undefined;
    try {
      adm = await this.admit(auth, body, false);
      const out = await this.runJson(adm, clientGone);
      this.count('ok', adm);
      return out;
    } catch (e) {
      const err = toModelProxyError(e);
      this.countError(err, adm);
      throw err;
    } finally {
      this.inflight--;
    }
  }

  private async runJson(adm: Admitted, clientGone: AbortSignal): Promise<WorkerModelResponse> {
    const ac = new AbortController();
    let reason: string | null = null;
    const stop = (r: string) => {
      reason ??= r;
      ac.abort(r);
    };
    const stopWatch = this.watch(adm, stop);
    const deadline = setTimeout(() => stop('deadline'), adm.deadlineMs);
    deadline.unref();
    const onGone = () => stop('client_abort');
    if (clientGone.aborted) onGone();
    else clientGone.addEventListener('abort', onGone, { once: true });
    let contacted = false;
    let closed = false;
    try {
      contacted = true;
      const res = await adm.provider.complete(adm.chat, { signal: ac.signal });
      if (reason) throw new StreamAbortedError(reason);
      const cache = {
        cacheRead: res.usage.cacheReadTokens ?? 0,
        cacheWrite: res.usage.cacheWriteTokens ?? 0,
      };
      const ms = Date.now() - adm.startedAt;
      closed = true;
      const s = await this.settle(adm, {
        usage: {
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          cacheReadTokens: cache.cacheRead,
          cacheWriteTokens: cache.cacheWrite,
        },
        output: {
          textBytes: Buffer.byteLength(res.text, 'utf8'),
          toolArgBytes: Buffer.byteLength(JSON.stringify(res.toolCalls.map((c) => c.args)), 'utf8'),
        },
        detail: this.detail(adm, res, ms),
        auditExtra: this.auditExtra(adm, res.stopReason, ms),
      });
      this.released(adm);
      this.tokens(s, cache);
      this.ctx.metrics.modelProxyDuration.observe({ phase: 'total' }, ms / 1000);
      const out = this.response(adm, res, s, cache);
      this.log(adm, 'ok', s, ms);
      return out;
    } catch (e) {
      if (closed) {
        this.released(adm);
        throw toModelProxyError(e);
      }
      return await this.failJson(adm, e, reason, contacted);
    } finally {
      clearTimeout(deadline);
      stopWatch();
      clientGone.removeEventListener('abort', onGone);
    }
  }

  /** Settles or releases after a failed upstream call and raises the matching proxy error. */
  private async failJson(
    adm: Admitted,
    e: unknown,
    reason: string | null,
    contacted: boolean,
  ): Promise<never> {
    const ms = Date.now() - adm.startedAt;
    let out: ModelProxyError;
    if (reason) {
      out = this.abortError(reason);
      // Nothing is known about the work the provider did: charge the reservation (conservative).
      await this.settle(adm, {
        status: 'error',
        note: reason,
        auditExtra: this.auditExtra(adm, null, ms),
        detail: this.detail(adm, null, ms),
      }).catch(() => undefined);
      await this.abortedAudit(adm, reason, 0);
      this.ctx.metrics.modelProxyAborts.inc({ reason });
    } else {
      out = e instanceof ModelProxyError ? e : this.providerFailure(e, adm);
      if (!contacted || this.noWorkDone(e)) await this.releaseQuietly(adm, out.code);
      else
        await this.settle(adm, {
          status: 'error',
          auditExtra: this.auditExtra(adm, null, ms),
          detail: this.detail(adm, null, ms),
        }).catch(() => undefined);
    }
    this.released(adm);
    this.log(adm, out.code, null, ms);
    throw out;
  }

  private abortError(reason: string): ModelProxyError {
    switch (reason) {
      case 'deadline':
        return new ModelProxyError('provider_timeout', 'the model call exceeded its deadline');
      case 'cancelled':
        return new ModelProxyError('run_node_session_revoked', 'run was cancelled');
      case 'output_overrun':
        return new ModelProxyError(
          'control_budget_cost',
          'the response exceeded the reserved budget',
        );
      case 'override':
        return new ModelProxyError('security_override', 'the provider was blocked by an override');
      case 'client_abort':
        return new ModelProxyError('provider_error', 'the client closed the connection');
      default:
        return new ModelProxyError('run_node_session_revoked', 'run node session was revoked');
    }
  }

  private async abortedAudit(adm: Admitted, reason: string, outputTokensEstimated: number) {
    try {
      await this.audit.append({
        actor: 'system',
        tenantId: adm.auth.tenantId,
        action: 'model.aborted',
        target: `${adm.provider.name}/${adm.agent.model}`,
        runId: adm.auth.runId,
        payload: {
          callId: adm.reservation.reservationId,
          reason,
          outputTokensEstimated,
        },
      });
    } catch (e) {
      this.ctx.logger.warn({ err: (e as Error).name }, 'could not write model.aborted');
    }
  }

  private log(adm: Admitted, code: string, s: Settlement | null, ms: number): void {
    // Metadata only: never a prompt, a response, a header or a key.
    this.ctx.logger.debug(
      {
        callId: adm.reservation.reservationId,
        runId: adm.auth.runId,
        agentId: adm.agent.id,
        provider: adm.provider.name,
        model: adm.agent.model,
        code,
        ...(s ? { tokensIn: s.tokensIn, tokensOut: s.tokensOut, costMicros: s.costMicros } : {}),
        durationMs: ms,
      },
      'model call',
    );
  }

  // ---------- streaming ----------

  /**
   * The native call as a stream. Errors raised before `io.begin` are ordinary HTTP errors; after
   * it, failures are sent as an `error` event. Providers without a streaming transport answer with
   * a single `delta` and `done`.
   */
  async stream(auth: CallAuth, body: WorkerModelRequest, io: StreamIo): Promise<void> {
    this.assertEnabled();
    this.checkRate(auth.runId);
    this.acquire();
    let adm: Admitted | undefined;
    try {
      adm = await this.admit(auth, body, true);
      if (!adm.plan) {
        // No streaming transport (simulated, Bedrock non-Anthropic): complete, then replay.
        const res = await this.runJson(adm, io.signal);
        this.count('ok', adm);
        const sink = io.begin(res.callId);
        if (res.response.text) await sink.delta(res.response.text);
        sink.done(res);
        return;
      }
      await this.runStream(adm, adm.plan, io);
    } catch (e) {
      const err = toModelProxyError(e);
      this.countError(err, adm);
      throw err;
    } finally {
      this.inflight--;
    }
  }

  private async runStream(adm: Admitted, plan: StreamPlan, io: StreamIo): Promise<void> {
    const ac = new AbortController();
    let stopReason: string | undefined;
    const stop = (r: string) => {
      stopReason ??= r;
      ac.abort(r);
    };
    const stopWatch = this.watch(adm, stop);
    const onGone = () => stop('client_abort');
    if (io.signal.aborted) onGone();
    else io.signal.addEventListener('abort', onGone, { once: true });
    const bound = adm.reservation.reservedOutputTokens;
    const agg = new ChatStreamAggregator(plan.surface, adm.agent.model);
    const startedAt = Date.now();
    let upstream: Awaited<ReturnType<StreamPlan['transport']['open']>> | undefined;
    let sink: StreamSink | undefined;
    this.ctx.metrics.modelProxyStreamsActive.inc();
    try {
      try {
        upstream = await plan.transport.open(
          { body: plan.buildBody(adm.chat), model: adm.agent.model },
          {
            signal: ac.signal,
            inputEstimate: adm.reservation.reservedInputTokens,
            shouldStop: (snap) => {
              if (stopReason) return stopReason;
              const out = Math.max(snap.usage.outputTokens, Math.ceil(snap.outputBytes / 8));
              return out > bound * OVERRUN_FACTOR ? 'output_overrun' : undefined;
            },
          },
        );
      } catch (e) {
        // Before the first byte: an ordinary error response.
        return await this.failOpen(adm, e, stopReason);
      }
      this.ctx.metrics.modelProxyDuration.observe(
        { phase: 'ttfb' },
        (Date.now() - startedAt) / 1000,
      );
      sink = io.begin(adm.reservation.reservationId);
      let failure: ModelProxyError | null = null;
      try {
        for await (const ev of upstream.events) {
          const delta = agg.push(ev);
          if (delta) await sink.delta(delta);
        }
      } catch (e) {
        failure = stopReason
          ? this.abortError(stopReason)
          : e instanceof ModelProxyError
            ? e
            : this.providerFailure(e, adm);
      }
      const result = upstream.result();
      const reason = result.abortReason ?? stopReason;
      const ms = Date.now() - startedAt;
      await this.finishStream(adm, agg, result, reason, failure, sink, ms);
    } finally {
      stopWatch();
      io.signal.removeEventListener('abort', onGone);
      upstream?.abort('closed');
      this.ctx.metrics.modelProxyStreamsActive.dec();
    }
  }

  private async failOpen(adm: Admitted, e: unknown, reason: string | undefined): Promise<never> {
    const ms = Date.now() - adm.startedAt;
    const out = reason ? this.abortError(reason) : this.providerFailure(e, adm);
    if (reason || e instanceof StreamAbortedError) {
      await this.settle(adm, {
        status: 'error',
        auditExtra: this.auditExtra(adm, null, ms),
        detail: this.detail(adm, null, ms),
      }).catch(() => undefined);
      await this.abortedAudit(adm, reason ?? 'aborted', 0);
      this.ctx.metrics.modelProxyAborts.inc({ reason: reason ?? 'aborted' });
    } else if (this.noWorkDone(e)) await this.releaseQuietly(adm, out.code);
    else
      await this.settle(adm, {
        status: 'error',
        auditExtra: this.auditExtra(adm, null, ms),
        detail: this.detail(adm, null, ms),
      }).catch(() => undefined);
    this.released(adm);
    this.log(adm, out.code, null, ms);
    throw out;
  }

  private async finishStream(
    adm: Admitted,
    agg: ChatStreamAggregator,
    result: StreamResult,
    reason: string | undefined,
    failure: ModelProxyError | null,
    sink: StreamSink,
    ms: number,
  ): Promise<void> {
    const complete = result.complete && !reason && !failure;
    const res = agg.finish(result.usage);
    const cache = {
      cacheRead: result.usage.cacheReadTokens,
      cacheWrite: result.usage.cacheWriteTokens,
    };
    let s: Settlement;
    try {
      s = await this.settle(adm, {
        ...(result.usageReported
          ? {
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                cacheReadTokens: cache.cacheRead,
                cacheWriteTokens: cache.cacheWrite,
              },
            }
          : {}),
        output: { textBytes: agg.textBytes, toolArgBytes: agg.toolArgBytes },
        status: complete ? 'ok' : 'error',
        ...(reason ? { note: reason } : {}),
        detail: this.detail(adm, complete ? res : null, ms),
        auditExtra: this.auditExtra(adm, complete ? res.stopReason : null, ms),
      });
    } catch (e) {
      this.released(adm);
      const err = toModelProxyError(e);
      this.count(err.code, adm);
      sink.error(err.code, err.message);
      return;
    }
    this.released(adm);
    this.tokens(s, cache);
    this.ctx.metrics.modelProxyDuration.observe({ phase: 'total' }, ms / 1000);
    if (reason) {
      this.ctx.metrics.modelProxyAborts.inc({ reason });
      await this.abortedAudit(adm, reason, s.tokensOut);
    }
    if (reason === 'client_abort') {
      this.count('client_abort', adm);
      return;
    }
    if (reason || failure || !complete) {
      const err =
        failure ??
        (reason
          ? this.abortError(reason)
          : new ModelProxyError('provider_error', 'the provider stream ended early'));
      this.count(err.code, adm);
      this.log(adm, err.code, s, ms);
      sink.error(err.code, err.message);
      return;
    }
    try {
      sink.done(this.response(adm, res, s, cache));
      this.count('ok', adm);
      this.log(adm, 'ok', s, ms);
    } catch (e) {
      const err = toModelProxyError(e);
      this.count(err.code, adm);
      sink.error(err.code, err.message);
    }
  }
}
