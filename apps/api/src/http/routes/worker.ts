import {
  ModelErrorEnvelopeSchema,
  ModelTokenRequestSchema,
  ModelTokenResponseSchema,
  WorkerModelRequestSchema,
  WorkerModelResponseSchema,
  type ModelErrorCode,
} from '@openagentix/providers';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Deps } from '../app.js';
import { bearerOf } from '../app.js';
import { OaxError } from '@openagentix/core';
import { HttpError } from '../../errors.js';
import { StrictJsonError, parseStrictJson } from '../../services/model-proxy-json.js';
import { ModelProxyError, toModelProxyError, type StreamSink } from '../../services/model-proxy.js';
import {
  ApprovalCreatedSchema,
  ApprovalParams,
  ApprovalRequestBody,
  ApprovalStatusSchema,
  BudgetVerdictSchema,
  CancelStatusSchema,
  DecisionSchema,
  ErrorSchema,
  GateBody,
  RunIdParams,
  RunResultBody,
  StepBody,
  ModelReservationBody,
  ModelReservationSchema,
  StepCredentialsRequestBody,
  StepCredentialsSchema,
  StepHandoverQuery,
  StepHandoverResultBody,
  StepHandoverSchema,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ runToken: [] }];
const tags = ['worker'];
/**
 * Rate limit bucket of a model route, evaluated before authentication: the peer address only.
 * (A token-derived key would let anyone mint unlimited buckets with invalid tokens, and the
 * claims of all model tokens start with the same bytes.)
 */
export const modelRateKey = (req: Pick<FastifyRequest, 'ip'>): string => req.ip;
const modelSec: Record<string, string[]>[] = [{ runToken: [] }, { modelToken: [] }];

/** Parameter names are echoed in refusals; anything else is cut so an error never reflects input. */
const safeName = (k: unknown): string =>
  String(k)
    .replace(/[^\w.-]/g, '')
    .slice(0, 64);

/** Error handler of the model routes: every failure uses the model envelope and stable codes. */
function modelErrorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  let out: ModelProxyError;
  const fe = err as FastifyError;
  if (hasZodFastifySchemaValidationErrors(err)) {
    const unknown = err.validation.find((v) => v.keyword === 'unrecognized_keys');
    const keys = (unknown?.params as { keys?: unknown } | undefined)?.keys;
    out = unknown
      ? new ModelProxyError(
          'model_parameter_refused',
          `parameter not allowed: ${(Array.isArray(keys) ? keys : []).map(safeName).join(', ') || 'unknown'}`,
        )
      : new ModelProxyError(
          'model_request_invalid',
          `request validation failed: ${[...new Set(err.validation.map((v) => v.instancePath || '/'))].slice(0, 5).join(', ')}`,
        );
  } else if (fe.statusCode === 429 && !(err instanceof ModelProxyError)) {
    // @fastify/rate-limit: keep its Retry-After header, answer in the model envelope
    out = new ModelProxyError('model_rate_limited', 'too many requests', undefined);
    const retry = reply.getHeader('retry-after');
    if (retry !== undefined) void reply.header('retry-after', String(retry));
  } else if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || fe.statusCode === 413) {
    out = new ModelProxyError('model_request_too_large', 'request body is too large');
  } else if (err instanceof StrictJsonError) {
    out = new ModelProxyError(
      err.reason === 'forbidden_key' ? 'model_parameter_refused' : 'model_request_invalid',
      err.message,
    );
  } else if (
    !(err instanceof ModelProxyError) &&
    !(err instanceof OaxError) &&
    typeof fe.statusCode === 'number' &&
    fe.statusCode >= 400 &&
    fe.statusCode < 500
  ) {
    out = new ModelProxyError('model_request_invalid', 'the request could not be read');
  } else {
    out = toModelProxyError(err);
    if (out.code === 'model_proxy_unavailable' && !(err instanceof ModelProxyError))
      req.log.error({ err: { name: err.name, code: fe.code } }, 'model route failed');
  }
  if (out.retryAfterSeconds) void reply.header('retry-after', String(out.retryAfterSeconds));
  void reply.header('cache-control', 'no-store');
  return reply.status(out.status).send(out.envelope());
}

/** Worker node contract: every call carries the signed run token of exactly one run. */
export function registerWorkerRoutes(app: ZApp, deps: Deps): void {
  const { services } = deps;
  const { control } = services;
  const token = (h: Parameters<typeof bearerOf>[0]) => {
    const t = bearerOf(h);
    if (!t) throw new HttpError(401, 'unauthenticated', 'run token required');
    return t;
  };

  app.post(
    '/v1/worker/runs/:id/gate',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Policy gate: decide a tool call before execution',
        security: sec,
        params: RunIdParams,
        body: GateBody,
        response: { 200: DecisionSchema, 401: ErrorSchema },
      },
    },
    async (req) => {
      await control.authorizeStep(token(req), req.params.id, req.body.agentId);
      const d = await control.decide(req.params.id, req.body.agentId, req.body.call);
      return { effect: d.effect, reasons: d.reasons };
    },
  );

  app.post(
    '/v1/worker/runs/:id/steps',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Record a step (with cost and audit entry)',
        security: sec,
        params: RunIdParams,
        body: StepBody,
      },
    },
    async (req, reply) => {
      const claims = await control.authorizeStep(token(req), req.params.id, req.body.agentId);
      await control.recordStep(
        req.params.id,
        req.body,
        claims.sid ? { id: claims.workerId } : undefined,
      );
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/worker/runs/:id/approvals',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Request a human approval',
        security: sec,
        params: RunIdParams,
        body: ApprovalRequestBody,
        response: { 201: ApprovalCreatedSchema },
      },
    },
    async (req, reply) => {
      await control.authorizeStep(token(req), req.params.id, req.body.agentId);
      const approvalId = await control.requestApproval(
        req.params.id,
        req.body.agentId,
        req.body.call,
        req.body.reasons ?? [],
      );
      return reply.status(201).send({ approvalId });
    },
  );

  app.get(
    '/v1/worker/runs/:id/approvals/:approvalId',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Poll an approval',
        security: sec,
        params: ApprovalParams,
        response: { 200: ApprovalStatusSchema },
      },
    },
    async (req) => {
      await control.authorize(token(req), req.params.id);
      return { status: await control.approvalStatus(req.params.id, req.params.approvalId) };
    },
  );

  app.get(
    '/v1/worker/runs/:id/status',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Cancellation flag of a run',
        security: sec,
        params: RunIdParams,
        response: { 200: CancelStatusSchema },
      },
    },
    async (req) => {
      await control.authorize(token(req), req.params.id);
      return { cancelled: await control.isCancelled(req.params.id) };
    },
  );

  app.get(
    '/v1/worker/runs/:id/budget',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Monthly tenant, use case and team budgets of a run (hard stop)',
        security: sec,
        params: RunIdParams,
        response: { 200: BudgetVerdictSchema },
      },
    },
    async (req) => {
      await control.authorize(token(req), req.params.id);
      return services.budgets.verdictForRun(req.params.id);
    },
  );

  app.post(
    '/v1/worker/runs/:id/complete',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Report the final result of a run',
        security: sec,
        params: RunIdParams,
        body: RunResultBody,
      },
    },
    async (req, reply) => {
      await control.authorizeOrchestrator(token(req), req.params.id);
      await control.completeRun(req.params.id, req.body);
      return reply.status(204).send();
    },
  );

  // ---------- run node protocol: step-scoped run tokens only ----------

  app.get(
    '/v1/worker/runs/:id/handover',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Run node: the handover of its own step (spec, input, output schema)',
        security: sec,
        params: RunIdParams,
        querystring: StepHandoverQuery,
        response: { 200: StepHandoverSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const claims = await control.authorizeNodeStep(token(req), req.params.id, req.query.agentId);
      reply.header('cache-control', 'no-store');
      return services.runNodes.handover(claims, req.params.id, req.query.agentId);
    },
  );

  app.post(
    '/v1/worker/runs/:id/handover/result',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Run node: post the final result of its step',
        security: sec,
        params: RunIdParams,
        body: StepHandoverResultBody,
      },
    },
    async (req, reply) => {
      const claims = await control.authorizeNodeStep(token(req), req.params.id, req.body.agentId);
      await services.runNodes.submitResult(claims, req.params.id, req.body);
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/worker/runs/:id/credentials',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary:
          'Credential broker: the secret values of exactly this step, once per step and session',
        security: sec,
        params: RunIdParams,
        body: StepCredentialsRequestBody,
        response: { 200: StepCredentialsSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      const claims = await control.authorizeNodeStep(token(req), req.params.id, req.body.agentId);
      // Values must never be cached by an intermediary or end up in a log.
      reply.header('cache-control', 'no-store');
      return services.runNodes.issueCredentials(claims, req.params.id, req.body.agentId);
    },
  );

  registerModelRoutes(app, deps);
}

/** Writes Server-Sent Events to a hijacked reply; never throws, never writes after close. */
function sseSink(reply: FastifyReply, callId: string): StreamSink {
  const raw = reply.raw;
  reply.hijack();
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-oax-call-id': callId,
  });
  let open = true;
  raw.once('close', () => (open = false));
  const write = (event: string, data: unknown): Promise<void> => {
    if (!open || raw.writableEnded) return Promise.resolve();
    const ok = raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (ok) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        raw.off('drain', done);
        raw.off('close', done);
        resolve();
      };
      raw.once('drain', done);
      raw.once('close', done);
    });
  };
  const end = () => {
    if (open && !raw.writableEnded) raw.end();
  };
  void write('start', { callId });
  return {
    delta: (text) => write('delta', { text }),
    done: (res) => {
      void write('done', res);
      end();
    },
    error: (code: ModelErrorCode, message: string) => {
      void write('error', { code, message });
      end();
    },
  };
}

/**
 * The native model endpoint and the model-token endpoint (ADR 0009). Registered in their own
 * encapsulated scope: a strict JSON parser (no duplicate keys, no prototype keys, bounded depth,
 * `OAX_MODEL_PROXY_MAX_BODY_BYTES`) and the model error envelope apply to these routes only.
 */
function registerModelRoutes(app: ZApp, deps: Deps): void {
  const { ctx, services } = deps;
  const { modelProxy, control } = services;
  const limit = ctx.config.modelProxy.maxBodyBytes;
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: limit },
      (_req, body, done) => {
        try {
          done(null, parseStrictJson(String(body)));
        } catch (e) {
          done(e as Error);
        }
      },
    );
    const typed = scope.withTypeProvider<ZodTypeProvider>();
    const refusals = {
      400: ModelErrorEnvelopeSchema,
      401: ModelErrorEnvelopeSchema,
      403: ModelErrorEnvelopeSchema,
      413: ModelErrorEnvelopeSchema,
      422: ModelErrorEnvelopeSchema,
      429: ModelErrorEnvelopeSchema,
      502: ModelErrorEnvelopeSchema,
      503: ModelErrorEnvelopeSchema,
      504: ModelErrorEnvelopeSchema,
    };
    const gates = [
      // Flag off: nothing else of the request is looked at (ADR 0009 section 2.1).
      async () => modelProxy.assertEnabled(),
      // Both framing headers at once is a request smuggling signal.
      async (req: FastifyRequest) => {
        if (
          req.headers['content-length'] !== undefined &&
          req.headers['transfer-encoding'] !== undefined
        )
          throw new ModelProxyError(
            'model_request_invalid',
            'content-length and transfer-encoding must not be combined',
          );
      },
    ];

    // In-process model calls of the trusted orchestrator reserve their cost here (ADR 0009 section
    // 4.4). Not gated by the proxy flag: the accounting applies to every model call.
    typed.post(
      '/v1/worker/runs/:id/model-reservations',
      {
        config: { access: 'run-token' },
        bodyLimit: 4096,
        errorHandler: modelErrorHandler,
        onRequest: [gates[1]!],
        schema: {
          tags,
          summary: 'Orchestrator: reserve the worst-case cost of an in-process model call',
          security: sec,
          params: RunIdParams,
          body: ModelReservationBody,
          response: { 200: ModelReservationSchema, ...refusals },
        },
      },
      async (req, reply) => {
        const bearer = bearerOf(req);
        if (!bearer) throw new ModelProxyError('unauthenticated', 'valid run token required');
        reply.header('cache-control', 'no-store');
        await control.authorizeOrchestrator(bearer, req.params.id);
        return control.reserveModelCall(req.params.id, req.body);
      },
    );

    typed.post(
      '/v1/worker/runs/:id/model-token',
      {
        config: {
          access: 'run-token',
          rateLimit: {
            max: ctx.config.rateLimit.max,
            timeWindow: '1 minute',
            keyGenerator: modelRateKey,
          },
        },
        bodyLimit: 4096,
        errorHandler: modelErrorHandler,
        onRequest: gates,
        schema: {
          tags,
          summary: 'Run node: the model token of its own step, once per step and session',
          security: sec,
          params: RunIdParams,
          body: ModelTokenRequestSchema,
          response: { 200: ModelTokenResponseSchema, 409: ModelErrorEnvelopeSchema, ...refusals },
        },
      },
      async (req, reply) => {
        const auth = await modelProxy.authenticate(bearerOf(req), req.params.id);
        // Values must never be cached by an intermediary or end up in a log.
        reply.header('cache-control', 'no-store');
        return modelProxy.issueToken(auth, req.body.agentId);
      },
    );

    typed.post(
      '/v1/worker/runs/:id/model',
      {
        config: {
          access: 'model-token',
          rateLimit: {
            max: ctx.config.rateLimit.max,
            timeWindow: '1 minute',
            keyGenerator: modelRateKey,
          },
        },
        bodyLimit: limit,
        errorHandler: modelErrorHandler,
        onRequest: gates,
        schema: {
          tags,
          summary:
            'Model proxy: one model call of a run node (JSON, or Server-Sent Events with `Accept: text/event-stream`)',
          security: modelSec,
          params: RunIdParams,
          body: WorkerModelRequestSchema,
          response: { 200: WorkerModelResponseSchema, ...refusals },
        },
      },
      async (req, reply) => {
        const auth = await modelProxy.authenticate(bearerOf(req), req.params.id);
        reply.header('cache-control', 'no-store');
        const gone = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) gone.abort('client_abort');
        });
        if (String(req.headers.accept ?? '').includes('text/event-stream')) {
          await modelProxy.stream(auth, req.body, {
            signal: gone.signal,
            begin: (callId) => sseSink(reply, callId),
          });
          return reply;
        }
        return modelProxy.call(auth, req.body, gone.signal);
      },
    );
  });
}
