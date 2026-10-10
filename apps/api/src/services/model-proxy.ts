import { createHmac } from 'node:crypto';
import {
  OaxError,
  estimateInputUpperBound,
  genAiProviderName,
  getEgressPolicy,
  issueModelToken,
  mayFlow,
  outputFloorFromBytes,
  MODEL_TOKEN_PREFIX,
  verifyModelToken,
  verifyRunToken,
  type AgentDefinition,
  type AgentSpec,
  type Budget,
  type HarnessKind,
  type ModelTokenClaims,
  type RunTokenClaims,
} from '@openagentix/core';
import {
  ChatStreamAggregator,
  MODEL_ERRORS,
  ProviderError,
  StreamError,
  assertPublicDestination,
  StreamAbortedError,
  UnavailableProvider,
  WorkerModelResponseSchema,
  createStreamPlan,
  modelErrorEnvelope,
  sanitizeEvent,
  anthropicMessageId,
  harnessSurface,
  openaiCompletionId,
  type SanitizeOpts,
  synthesizeEvents,
  proposeModels,
  scrub,
  type ChatRequest,
  type ChatResponse,
  type ClientEvent,
  type ModelErrorCode,
  type ModelErrorEnvelope,
  type ModelProvider,
  type ModelTokenResponse,
  type PassthroughRequest,
  type PassthroughSurface,
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
import { noteInboundContext, spanIdentity, storedParent } from './node-telemetry.js';
import { startGuardedSpan, type OpenSpan } from '../telemetry.js';

/** Output bound when neither the request, the agent nor the catalog names one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** Hard ceiling of one call's output, whatever the node asks for and the catalog knows. */
const MAX_OUTPUT_TOKENS_CEILING = 131_072;
/** A provider may overshoot the granted output bound by this factor before the stream is cut. */
const OVERRUN_FACTOR = 1.1;
/** Repeated identical denials of one session are written once per window (flood protection). */
const DENIED_WINDOW_MS = 60_000;
/** Extra output tokens tolerated above the cut-off bound when a provider reports its usage. */
const OVERRUN_ALLOWANCE_TOKENS = 256;
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

const BUDGET_MESSAGES: Record<string, string> = {
  control_budget_tokens: 'the token budget cannot cover the call',
  control_budget_cost: 'the cost budget cannot cover the call',
  control_budget_steps: 'the model call budget is used up',
  control_budget_tenant: 'a monthly budget cannot cover the call',
  control_budget_use_case: 'a monthly budget cannot cover the call',
  control_budget_team: 'a monthly budget cannot cover the call',
};

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
    if (isModelCode(code)) {
      // Budget refusals name scopes (team, use case) and numbers: the node gets a fixed text.
      if (code.startsWith('control_budget_'))
        return new ModelProxyError(
          code,
          BUDGET_MESSAGES[code] ?? 'the budget cannot cover the call',
        );
      return new ModelProxyError(code, e.message);
    }
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
  /** Model token: the endpoint family it was issued for (`null` for a run token). */
  surface: 'native' | 'harness' | null;
  steps: readonly string[];
  tenantId: string;
  /** When the session (the step) started: step timeouts are measured from here. */
  sessionCreatedAt: Date;
  /** Stored `traceparent` of the session (the parent of this call's `chat` span), or null. */
  traceContext: string | null;
}

export interface StreamSink {
  /** Resolves when the client is ready for more (backpressure); rejects when the client is gone. */
  delta(text: string): Promise<void>;
  /**
   * Pass-through sinks only: one rebuilt protocol event for the client (ADR 0009 section 6.3).
   * When set, `delta` is not used and `done` only closes the stream (`[DONE]` for OpenAI).
   */
  event?(ev: ClientEvent): Promise<void>;
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

/** What a pass-through call adds to the native one (ADR 0009 sections 2.4 and 6). */
export interface PassCtx {
  surface: PassthroughRequest['surface'];
  includeUsage: boolean;
  images: number;
  extraBytes: number;
  build: PassthroughRequest['build'];
  /** The request marks content for caching: the reservation prices input at the write rate. */
  cacheWrite: boolean;
  /** `anthropic-beta` values of the client, already filtered against the allowlist. */
  betas: readonly string[];
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
  /** Upper bound of the input tokens (the cap for reported usage; above the estimate reservation). */
  inputUpperBound: number;
  digest: string;
  startedAt: number;
  messageCount: number;
  toolNames: string[];
  priced: boolean;
  /** The in-flight gauges were already decremented (settled, released or expired). */
  gaugesReleased: boolean;
  pass: PassCtx | undefined;
  /** Pass-through: the upstream body built from the client's validated request. */
  upstreamBody: Record<string, unknown> | undefined;
  /** The `chat` span of this call (ADR 0015 3.3); absent while the session has no trace context. */
  span?: OpenSpan | undefined;
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
  async authenticate(
    bearer: string | null,
    runId: string,
    surface: 'native' | 'harness' = 'native',
    /** `traceparent` header of the request: compared with the stored context, never used. */
    inboundTraceparent?: unknown,
  ): Promise<CallAuth> {
    const secret = this.ctx.config.runToken.secret;
    const now = this.ctx.now().getTime();
    if (!bearer) throw new ModelProxyError('unauthenticated', 'valid model or run token required');
    let auth: Omit<CallAuth, 'tenantId' | 'sessionCreatedAt' | 'traceContext'>;
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
          surface: modelClaims.surface,
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
          surface: null,
          steps: claims.steps ?? [],
        };
      }
    } catch (e) {
      if (e instanceof ModelProxyError) throw e;
      throw new ModelProxyError('unauthenticated', 'valid model or run token required');
    }
    if (auth.runId !== runId)
      throw new ModelProxyError('model_not_allowed', 'the token is not valid for this run');
    // A model token opens one endpoint family only: the native /model route refuses a harness
    // token and the harness pass-through surfaces refuse a native one.
    if (auth.surface !== null && auth.surface !== surface)
      throw new ModelProxyError(
        'model_not_allowed',
        'the model token is not valid for this endpoint',
      );
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
    noteInboundContext(session.traceContext, inboundTraceparent);
    return {
      ...auth,
      tenantId: session.tenantId,
      sessionCreatedAt: session.createdAt,
      traceContext: session.traceContext,
    };
  }

  /**
   * Authentication of the pass-through surfaces: the model token only (a run token never opens
   * them), and the run comes from the token because the path has no run id.
   */
  async authenticatePassthrough(
    credential: string | null,
    inboundTraceparent?: unknown,
  ): Promise<CallAuth> {
    if (!credential?.startsWith(`${MODEL_TOKEN_PREFIX}.`))
      throw new ModelProxyError('unauthenticated', 'a valid model token is required');
    let claims: ModelTokenClaims;
    try {
      claims = verifyModelToken(
        this.ctx.config.runToken.secret,
        credential,
        this.ctx.now().getTime(),
      );
    } catch {
      throw new ModelProxyError('unauthenticated', 'a valid model token is required');
    }
    return this.authenticate(credential, claims.runId, 'harness', inboundTraceparent);
  }

  /** The one model of the token's step (`GET .../models` lists exactly this). */
  async stepModel(auth: CallAuth): Promise<string> {
    this.assertEnabled();
    const agentId = auth.boundAgentId;
    if (!agentId) throw new ModelProxyError('unauthenticated', 'a valid model token is required');
    const { agent } = await this.context(auth, agentId);
    return agent.model;
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
  async issueToken(
    auth: CallAuth,
    agentId: string,
    harness?: HarnessKind,
  ): Promise<ModelTokenResponse> {
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
    // A harness step (ADR 0009 section 10): the harness has to be the one the version published and
    // the platform enabled, and its protocol has to match the provider (no translation).
    let surface: PassthroughSurface | undefined;
    if (harness) {
      if (
        agent.runtime?.harness !== harness ||
        !this.ctx.config.harnesses.enabled.includes(harness)
      )
        throw await this.deny(
          auth,
          agentId,
          'model_not_allowed',
          'this step is not published for that harness',
        );
      surface = harnessSurface(harness, resolved.provider.kind) ?? undefined;
      if (!surface)
        throw await this.deny(
          auth,
          agentId,
          'model_surface_mismatch',
          `the provider of this step cannot be used by the ${harness} harness`,
        );
    } else if (agent.runtime?.harness) {
      // A harness step gets its token for the harness protocol only; the native endpoint is for
      // the built-in step loop.
      throw await this.deny(
        auth,
        agentId,
        'model_not_allowed',
        'a harness step requests its model token for the harness',
      );
    }
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
        surface: harness ? 'harness' : 'native',
        ...(harness ? { harness } : {}),
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
        ...(harness ? { harness, protocol: surface } : {}),
      },
    });
    const base = (cfg.runners.container.nodeControlUrl ?? cfg.publicUrl).replace(/\/$/, '');
    return {
      token: issued.token,
      expiresAt: new Date(issued.claims.exp * 1000).toISOString(),
      protocol: surface ?? 'native',
      baseUrl: surface
        ? `${base}/v1/model-proxy/${surface}`
        : `${base}/v1/worker/runs/${auth.runId}`,
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
    await this.refusalSpan(auth, code, extra.model);
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

  /**
   * `chat` span of an admitted call (ADR 0015 3.3): a child of the context stored for the node's
   * session, built from what the proxy itself knows (the published step, the reservation, the
   * provider family). Nothing of the node's request is exported. Undefined without a stored context.
   */
  private async startChatSpan(adm: Admitted): Promise<OpenSpan | undefined> {
    try {
      const parent = storedParent(adm.auth.traceContext);
      if (!parent) return undefined;
      return startGuardedSpan(
        { name: `chat ${adm.agent.model}`, kind: 'chat', parent },
        {
          ...(await spanIdentity(this.ctx, adm.auth.runId, adm.auth.tenantId)),
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': genAiProviderName(adm.provider.kind, adm.provider.family),
          'gen_ai.request.model': adm.agent.model,
          'oax.provider.instance': adm.provider.name,
          'oax.model.via': 'proxy',
          'oax.model.surface': adm.pass?.surface ?? 'native',
          'oax.reservation.result': 'reserved',
          'gen_ai.request.max_tokens': adm.reservation.reservedOutputTokens,
        },
      );
    } catch {
      return undefined;
    }
  }

  /** A refused call (`model_not_allowed`, `classification_denied`, budget codes, ...) ends as an error span. */
  private async refusalSpan(
    auth: CallAuth,
    code: string,
    publishedModel: string | undefined,
  ): Promise<void> {
    try {
      const parent = storedParent(auth.traceContext);
      if (!parent) return;
      const open = startGuardedSpan(
        { name: publishedModel ? `chat ${publishedModel}` : 'chat', kind: 'chat', parent },
        {
          ...(await spanIdentity(this.ctx, auth.runId, auth.tenantId)),
          'gen_ai.operation.name': 'chat',
          ...(publishedModel ? { 'gen_ai.request.model': publishedModel } : {}),
          'oax.model.via': 'proxy',
          'oax.reservation.result': 'refused',
        },
      );
      open.end(Object.assign(new Error(code), { code }));
    } catch {
      // Telemetry never changes a refusal.
    }
  }

  /** Ends the call's span once: ok, or failed with the proxy's own outcome code. */
  private endSpan(adm: Pick<Admitted, 'span'> | undefined, code: string): void {
    try {
      adm?.span?.end(code === 'ok' ? undefined : Object.assign(new Error(code), { code }));
    } catch {
      // Telemetry never changes the outcome of a call.
    }
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

  private async admit(auth: CallAuth, body: WorkerModelRequest, pass?: PassCtx): Promise<Admitted> {
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
    // Deadline: the run's timeout runs from the run start, the step's from the start of its
    // session (a late step of a long run keeps its own full step timeout).
    const now = this.ctx.now().getTime();
    const left = (seconds: number | undefined, since: number) =>
      seconds === undefined ? Number.POSITIVE_INFINITY : seconds * 1000 - (now - since);
    const timeLeftMs = Math.min(
      this.cfg().maxCallSeconds * 1000,
      left((definition.budget as Budget).timeoutSeconds, run.startedAt?.getTime() ?? now),
      left(agent.budget?.timeoutSeconds, auth.sessionCreatedAt.getTime()),
    );
    // An exhausted run or step time is a refusal, never a call with a minimum deadline.
    if (timeLeftMs <= 0)
      throw await this.deny(
        auth,
        agentId,
        'provider_timeout',
        'the run or step time is exhausted',
        pinned,
      );
    const deadlineMs = Math.max(1000, timeLeftMs);
    const resolved = await this.models.resolve(
      { tenantId: run.tenantId, teamId: run.teamId, agentId: run.agentId },
      agent.provider,
      { timeoutMs: deadlineMs },
    );
    if (!resolved)
      throw await this.deny(
        auth,
        agentId,
        'model_not_allowed',
        'the provider of this step is not available to this run',
        pinned,
      );
    const { provider, config, tenantControlled } = resolved;
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
    // A tenant-controlled endpoint must not reach loopback, private, link-local or metadata
    // addresses (SSRF), unless the operator allowlisted them (OAX_MODEL_PROXY_PRIVATE_ALLOW).
    if (config && tenantControlled) {
      try {
        for (const ep of providerEndpoints(config, 'provider'))
          await assertPublicDestination(new URL(ep.url).hostname, {
            allow: this.cfg().privateAllow,
            ...(this.ctx.hostLookup ? { lookup: this.ctx.hostLookup } : {}),
          });
      } catch (e) {
        if ((e as { code?: string }).code === 'egress_denied')
          throw await this.deny(
            auth,
            agentId,
            'egress_denied',
            'the provider endpoint is not a public address',
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
    const upper = pass
      ? Math.min(
          estimateInputUpperBound(chat, { contextTokens: null, images: pass.images }) +
            pass.extraBytes,
          contextTokens && contextTokens > 0 ? contextTokens : Number.POSITIVE_INFINITY,
        )
      : estimateInputUpperBound(chat, { contextTokens });
    const inputTokens =
      this.cfg().reservation === 'estimate' ? Math.max(1, Math.ceil(upper / 3)) : upper;
    const outputCap = [
      r.maxTokens ?? limits?.outputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      agent.maxTokensPerCall,
      limits?.outputTokens ?? undefined,
      MAX_OUTPUT_TOKENS_CEILING,
    ].filter((n): n is number => typeof n === 'number' && n > 0);
    const maxOutputTokens = Math.max(1, Math.min(...outputCap));
    const secrets = await this.models.secretValues(config);
    // Every provider with a streaming transport is called through it, for plain JSON answers too:
    // size limits, time limits and the output hard stop then apply uniformly.
    const plan =
      config && !(provider instanceof UnavailableProvider)
        ? await createStreamPlan(
            config,
            {
              secrets: this.ctx.secrets,
              fetchImpl: this.ctx.fetchImpl,
              ...(tenantControlled
                ? {
                    blockPrivateDestinations: {
                      allow: this.cfg().privateAllow,
                      ...(this.ctx.hostLookup ? { lookup: this.ctx.hostLookup } : {}),
                    },
                  }
                : {}),
            },
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

    // A pass-through step must use a provider that speaks the surface's protocol (no translation).
    if (pass && provider.kind !== 'simulated' && plan?.surface !== pass.surface)
      throw await this.deny(
        auth,
        agentId,
        'model_surface_mismatch',
        `the provider of this step does not speak the ${pass.surface} protocol`,
        pinned,
      );

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
          ...(pass?.cacheWrite ? { cacheWrite: true } : {}),
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
      inputUpperBound: upper,
      digest: this.digest(run.tenantId, chat),
      startedAt: Date.now(),
      messageCount: r.messages.length,
      toolNames: (r.tools ?? []).map((t) => t.name),
      priced: reservation.priced,
      gaugesReleased: false,
      pass,
      upstreamBody: pass
        ? pass.build(reservation.reservedOutputTokens, { maxTokensParam: plan?.maxTokensParam })
        : undefined,
    };
  }

  /**
   * Request digest for correlation: an HMAC under a key derived per tenant from the server secret,
   * so it cannot be used to confirm guesses about a prompt (a plain hash of low-entropy input can).
   */
  private digest(tenantId: string, chat: ChatRequest): string {
    const key = createHmac('sha256', this.ctx.config.runToken.secret)
      .update(`openagentix/model-digest/v1:${tenantId}`)
      .digest();
    return createHmac('sha256', key).update(JSON.stringify(chat)).digest('hex');
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
        const settled = await this.accounting.settle(
          { tenantId: adm.auth.tenantId },
          adm.reservation.reservationId,
          {
            via: 'proxy',
            ...req,
          },
        );
        this.measured(adm, settled);
        return settled;
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

  /** The proxy's own numbers on the `chat` span (never the provider's or the node's claims). */
  private measured(adm: Admitted, s: Settlement): void {
    try {
      adm.span?.span.setAttributes({
        'gen_ai.usage.input_tokens': s.tokensIn,
        'gen_ai.usage.output_tokens': s.tokensOut,
        'oax.cost.micro_usd': s.costMicros,
        'oax.cost.priced': adm.priced,
        'oax.usage.source':
          s.usageSource === 'provider'
            ? 'provider'
            : s.usageSource === 'estimated'
              ? 'estimate'
              : 'floor',
      });
    } catch {
      // Telemetry never changes the settlement.
    }
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

  /**
   * Error of the provider call as a proxy error. The node only learns the HTTP status or the kind
   * of stream failure, never text from the provider (it can carry anything, also about the
   * tenant's own network).
   */
  private providerFailure(e: unknown, _adm: Admitted): ModelProxyError {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'provider_timeout')
      return new ModelProxyError('provider_timeout', 'the provider did not answer in time');
    if (code === 'egress_denied')
      return new ModelProxyError('egress_denied', 'the provider endpoint is not allowed');
    if (e instanceof ProviderError)
      return new ModelProxyError(
        'provider_error',
        e.status === null
          ? 'the provider could not be reached'
          : `the provider answered with HTTP ${e.status}`,
      );
    if (e instanceof StreamError)
      return new ModelProxyError('provider_error', `the provider stream failed (${e.reason})`);
    return new ModelProxyError('provider_error', 'the provider call failed');
  }

  /**
   * True only when the failure provably happened before the provider could have started work:
   * an egress refusal, a DNS or connection-refused failure before the request was sent, or a 4xx
   * answer other than 408, 409 and 429. Everything else (timeouts, resets, 5xx, stream errors) may
   * have been billed and is charged conservatively.
   */
  private noWorkDone(e: unknown): boolean {
    if ((e as { code?: unknown } | null)?.code === 'egress_denied') return true;
    if (e instanceof ProviderError) {
      if (e.preSend) return true;
      const st = e.status;
      return st !== null && st >= 400 && st < 500 && ![408, 409, 429].includes(st);
    }
    return false;
  }

  private count(
    code: string,
    adm: Pick<Admitted, 'provider' | 'pass' | 'span'> | undefined,
    surface?: string,
  ): void {
    this.endSpan(adm, code);
    this.ctx.metrics.modelProxyRequests.inc({
      surface: adm?.pass?.surface ?? surface ?? 'native',
      // Bounded label: the provider family, never a tenant-chosen connection name.
      provider: adm ? (adm.provider.family ?? adm.provider.kind) : 'unknown',
      code,
    });
  }

  /** Counts a failed request once, however many catch blocks it passes. */
  private countError(
    err: ModelProxyError,
    adm: Pick<Admitted, 'provider' | 'pass' | 'span'> | undefined,
    surface?: string,
  ): void {
    if (err.counted) return;
    err.counted = true;
    this.count(err.code, adm, surface);
  }

  private tokens(
    s: Settlement,
    usage: { cacheRead: number; cacheWrite: number },
    adm?: Pick<Admitted, 'span'>,
  ): void {
    adm?.span?.span.setAttributes({
      'gen_ai.usage.cache_read.input_tokens': usage.cacheRead,
      'gen_ai.usage.cache_write.input_tokens': usage.cacheWrite,
    });
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

  /**
   * What a client-visible event may carry of the upstream: the step's model, an own id and the
   * capped usage (the same bounds `capUsage` applies to the books).
   */
  private sanitizeOpts(adm: Admitted, pass: PassCtx): SanitizeOpts {
    const resv = adm.reservation;
    return {
      includeUsage: pass.includeUsage,
      model: adm.agent.model,
      id:
        pass.surface === 'anthropic'
          ? anthropicMessageId(resv.reservationId)
          : openaiCompletionId(resv.reservationId),
      maxInput: Math.max(adm.inputUpperBound, resv.reservedInputTokens),
      maxOutput: Math.ceil(resv.reservedOutputTokens * OVERRUN_FACTOR) + OVERRUN_ALLOWANCE_TOKENS,
    };
  }

  private response(
    adm: Admitted,
    res: ChatResponse,
    s: Settlement,
    cache: { cacheRead: number; cacheWrite: number },
    validate = true,
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
        model: adm.pass ? adm.agent.model : res.model,
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
    // A relayed pass-through stream was delivered event by event before this point; only the
    // accounting record is built here, so there is nothing left to refuse.
    if (!validate) return out as WorkerModelResponse;
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
    pass?: PassCtx,
  ): Promise<WorkerModelResponse> {
    this.assertEnabled();
    this.checkRate(auth.runId);
    this.acquire();
    let adm: Admitted | undefined;
    try {
      adm = await this.admit(auth, body, pass);
      adm.span = await this.startChatSpan(adm);
      const out = adm.plan
        ? await this.runCollected(adm, adm.plan, clientGone)
        : await this.runJson(adm, clientGone);
      this.count('ok', adm);
      return out;
    } catch (e) {
      const err = toModelProxyError(e);
      this.countError(err, adm, pass?.surface);
      throw err;
    } finally {
      this.inflight--;
      // Safety net: a path that never reached a counter still ends the span.
      this.endSpan(adm, 'model_proxy_unavailable');
    }
  }

  /** A plain JSON answer produced through the streaming transport (all limits apply). */
  private async runCollected(
    adm: Admitted,
    plan: StreamPlan,
    clientGone: AbortSignal,
  ): Promise<WorkerModelResponse> {
    let result: WorkerModelResponse | undefined;
    let failure: ModelProxyError | undefined;
    const sink: StreamSink = {
      delta: async () => undefined,
      done: (r) => {
        result = r;
      },
      error: (code, message) => {
        failure = new ModelProxyError(code, message);
        // Already counted by the stream path.
        failure.counted = true;
      },
    };
    await this.runStream(adm, plan, { signal: clientGone, begin: () => sink });
    if (failure) throw failure;
    if (!result)
      throw new ModelProxyError('model_proxy_unavailable', 'the model proxy is unavailable');
    return result;
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
      const textBytes = Buffer.byteLength(res.text, 'utf8');
      const usage = await this.capUsage(
        adm,
        {
          input: res.usage.inputTokens,
          output: res.usage.outputTokens,
          cacheRead: res.usage.cacheReadTokens ?? 0,
          cacheWrite: res.usage.cacheWriteTokens ?? 0,
        },
        textBytes,
      );
      const cache = { cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens };
      const ms = Date.now() - adm.startedAt;
      closed = true;
      const s = await this.settle(adm, {
        usage,
        output: {
          textBytes,
          toolArgBytes: Buffer.byteLength(JSON.stringify(res.toolCalls.map((c) => c.args)), 'utf8'),
        },
        detail: this.detail(adm, res, ms),
        auditExtra: this.auditExtra(adm, res.stopReason, ms),
      });
      this.released(adm);
      this.tokens(s, cache, adm);
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
  async stream(
    auth: CallAuth,
    body: WorkerModelRequest,
    io: StreamIo,
    pass?: PassCtx,
  ): Promise<void> {
    this.assertEnabled();
    this.checkRate(auth.runId);
    this.acquire();
    let adm: Admitted | undefined;
    try {
      adm = await this.admit(auth, body, pass);
      adm.span = await this.startChatSpan(adm);
      if (!adm.plan) {
        // No streaming transport (simulated, Bedrock non-Anthropic): complete, then replay.
        const res = await this.runJson(adm, io.signal);
        this.count('ok', adm);
        const sink = io.begin(res.callId);
        if (adm.pass && sink.event) {
          for (const ev of synthesizeEvents(adm.pass.surface, res.response, res.callId)) {
            const out = sanitizeEvent(adm.pass.surface, ev, this.sanitizeOpts(adm, adm.pass));
            if (out) await sink.event(out);
          }
        } else if (res.response.text) await sink.delta(res.response.text);
        sink.done(res);
        return;
      }
      await this.runStream(adm, adm.plan, io);
    } catch (e) {
      const err = toModelProxyError(e);
      this.countError(err, adm, pass?.surface);
      throw err;
    } finally {
      this.inflight--;
      // Safety net: a path that never reached a counter still ends the span.
      this.endSpan(adm, 'model_proxy_unavailable');
    }
  }

  // ---------- pass-through surfaces (ADR 0009 sections 2.4 and 6) ----------

  /**
   * Builds the native-shaped request and the pass-through context from a validated client request.
   * The agent is the one the model token is bound to; the client cannot name another. Only betas on
   * the operator's allowlist survive.
   */
  private passInput(
    auth: CallAuth,
    req: PassthroughRequest,
    betaHeader: string | readonly string[] | undefined,
  ): { body: WorkerModelRequest; pass: PassCtx } {
    const agentId = auth.boundAgentId;
    if (!agentId) throw new ModelProxyError('unauthenticated', 'a valid model token is required');
    const allowed = new Set(this.cfg().anthropicBetas);
    const joined: string =
      typeof betaHeader === 'string' ? betaHeader : (betaHeader ?? []).join(',');
    const asked = joined
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    const betas =
      req.surface === 'anthropic' ? [...new Set(asked.filter((b) => allowed.has(b)))] : [];
    const c = req.chat;
    return {
      body: {
        agentId,
        request: {
          model: req.model,
          messages: c.messages as WorkerModelRequest['request']['messages'],
          ...(c.system ? { system: c.system } : {}),
          ...(c.tools ? { tools: c.tools } : {}),
          ...(req.requestedMaxTokens !== undefined ? { maxTokens: req.requestedMaxTokens } : {}),
          ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
        },
      },
      pass: {
        surface: req.surface,
        includeUsage: req.includeUsage,
        images: req.images,
        extraBytes: req.extraBytes,
        build: req.build,
        cacheWrite: req.cacheWrite,
        betas,
      },
    };
  }

  /** A pass-through call answered as one JSON document (`stream` is not set). */
  async callPassthrough(
    auth: CallAuth,
    req: PassthroughRequest,
    betaHeader: string | readonly string[] | undefined,
    clientGone: AbortSignal,
  ): Promise<WorkerModelResponse> {
    const { body, pass } = this.passInput(auth, req, betaHeader);
    return this.call(auth, body, clientGone, pass);
  }

  /** A pass-through call relayed as Server-Sent Events, with the mid-stream hard stop. */
  async streamPassthrough(
    auth: CallAuth,
    req: PassthroughRequest,
    betaHeader: string | readonly string[] | undefined,
    io: StreamIo,
  ): Promise<void> {
    const { body, pass } = this.passInput(auth, req, betaHeader);
    return this.stream(auth, body, io, pass);
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
          { body: adm.upstreamBody ?? plan.buildBody(adm.chat), model: adm.agent.model },
          {
            signal: ac.signal,
            ...(adm.pass?.betas.length ? { anthropicBeta: adm.pass.betas } : {}),
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
      try {
        sink = io.begin(adm.reservation.reservationId);
        let failure: ModelProxyError | null = null;
        try {
          for await (const ev of upstream.events) {
            const delta = agg.push(ev);
            if (adm.pass) {
              // Pass-through: the client gets the event rebuilt from allowlisted fields only.
              const out = sanitizeEvent(adm.pass.surface, ev, this.sanitizeOpts(adm, adm.pass));
              if (out && sink.event) await sink.event(out);
            } else if (delta) await sink.delta(delta);
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
      } catch (e) {
        // begin(), the aggregation or the final write failed: close the books with the estimate
        // (nothing may stay reserved) and tell the client instead of leaving it hanging.
        upstream.abort('internal_error');
        if (!adm.gaugesReleased) {
          await this.settle(adm, {
            status: 'error',
            auditExtra: this.auditExtra(adm, null, Date.now() - startedAt),
            detail: this.detail(adm, null, Date.now() - startedAt),
          }).catch(() => undefined);
          this.released(adm);
        }
        const err = toModelProxyError(e);
        this.countError(err, adm);
        if (!sink) throw err;
        sink.error(err.code, err.message);
      }
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
    const timedOut = (e as { code?: unknown } | null)?.code === 'provider_timeout';
    const abortReason =
      reason ?? (timedOut ? 'deadline' : e instanceof StreamAbortedError ? 'aborted' : undefined);
    if (!abortReason && this.noWorkDone(e)) await this.releaseQuietly(adm, out.code);
    else {
      // Possibly billed: charged with the reservation.
      await this.settle(adm, {
        status: 'error',
        auditExtra: this.auditExtra(adm, null, ms),
        detail: this.detail(adm, null, ms),
      }).catch(() => undefined);
      if (abortReason) {
        await this.abortedAudit(adm, abortReason, 0);
        this.ctx.metrics.modelProxyAborts.inc({ reason: abortReason });
      }
    }
    this.released(adm);
    this.log(adm, out.code, null, ms);
    throw out;
  }

  /**
   * Caps what the provider reports to what the reservation allows (a hostile endpoint can report
   * absurd numbers): input and cache tokens together at the reserved input bound, output at the
   * cut-off bound plus a small allowance, but never below the floor from the streamed bytes. The
   * raw numbers are written to the `model.overrun` audit entry only.
   */
  private async capUsage(
    adm: Admitted,
    u: { input: number; output: number; cacheRead: number; cacheWrite: number },
    outputBytes: number,
  ) {
    const resv = adm.reservation;
    // The bound is the upper bound of the input, not the reserved estimate (`estimate` mode reserves
    // a third of it; honest usage between the two must not be cut).
    const inputBound = Math.max(adm.inputUpperBound, resv.reservedInputTokens);
    const input = Math.min(u.input, inputBound);
    const cacheRead = Math.min(u.cacheRead, inputBound - input);
    const cacheWrite = Math.min(u.cacheWrite, inputBound - input - cacheRead);
    const cap = Math.max(
      outputFloorFromBytes(outputBytes),
      Math.ceil(resv.reservedOutputTokens * OVERRUN_FACTOR) + OVERRUN_ALLOWANCE_TOKENS,
    );
    const output = Math.min(u.output, cap);
    const capped =
      input !== u.input ||
      cacheRead !== u.cacheRead ||
      cacheWrite !== u.cacheWrite ||
      output !== u.output;
    if (capped) {
      try {
        await this.audit.append({
          actor: 'system',
          tenantId: adm.auth.tenantId,
          action: 'model.overrun',
          target: `${adm.provider.name}/${adm.agent.model}`,
          runId: adm.auth.runId,
          payload: {
            callId: resv.reservationId,
            reason: 'reported_usage_capped',
            reported: {
              input: u.input,
              output: u.output,
              cacheRead: u.cacheRead,
              cacheWrite: u.cacheWrite,
            },
            capped: { input, output, cacheRead, cacheWrite },
          },
        });
      } catch (err) {
        this.ctx.logger.warn({ err: (err as Error).name }, 'could not write model.overrun');
      }
    }
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    };
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
    let s: Settlement;
    let cache: { cacheRead: number; cacheWrite: number };
    try {
      const usage = result.usageReported
        ? await this.capUsage(
            adm,
            {
              input: result.usage.inputTokens,
              output: result.usage.outputTokens,
              cacheRead: result.usage.cacheReadTokens,
              cacheWrite: result.usage.cacheWriteTokens,
            },
            result.outputBytes,
          )
        : undefined;
      cache = {
        cacheRead: usage?.cacheReadTokens ?? result.usage.cacheReadTokens,
        cacheWrite: usage?.cacheWriteTokens ?? result.usage.cacheWriteTokens,
      };
      s = await this.settle(adm, {
        ...(usage ? { usage } : {}),
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
    this.tokens(s, cache, adm);
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
      sink.done(this.response(adm, res, s, cache, !adm.pass));
      this.count('ok', adm);
      this.log(adm, 'ok', s, ms);
    } catch (e) {
      const err = toModelProxyError(e);
      this.count(err.code, adm);
      sink.error(err.code, err.message);
    }
  }
}
