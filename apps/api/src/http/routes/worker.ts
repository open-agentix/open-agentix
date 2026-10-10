import {
  ModelErrorEnvelopeSchema,
  ModelTokenRequestSchema,
  ModelTokenResponseSchema,
  WorkerModelRequestSchema,
  WorkerModelResponseSchema,
  type ModelErrorCode,
} from '@openagentix/providers';
import { verifyRunToken } from '@openagentix/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { bearerOf } from '../app.js';
import { HttpError, mcpRelayRefusal } from '../../errors.js';
import { parseStrictJson } from '../../services/model-proxy-json.js';
import { ModelProxyError, type StreamSink } from '../../services/model-proxy.js';
import { modelErrorHandler, modelRateKey } from './model-errors.js';
import { registerPassthroughRoutes } from './model-passthrough.js';
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
  ToolsChangedBody,
  McpRelayAnswer,
  McpRelayMessage,
  McpRelayParams,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';

/** The `traceparent` header of a request: compared with a node's stored context, never used. */
const inbound = (req: FastifyRequest): unknown => req.headers['traceparent'];

const sec = [{ runToken: [] }];
const tags = ['worker'];
export { modelRateKey };
const modelSec: Record<string, string[]>[] = [{ runToken: [] }, { modelToken: [] }];

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
      const claims = await control.authorizeStep(
        token(req),
        req.params.id,
        req.body.agentId,
        inbound(req),
      );
      const d = await control.decideForNode(claims, req.params.id, req.body.agentId, req.body.call);
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
      const claims = await control.authorizeStep(
        token(req),
        req.params.id,
        req.body.agentId,
        inbound(req),
      );
      await control.recordStep(
        req.params.id,
        req.body,
        claims.sid ? { id: claims.workerId, sid: claims.sid } : undefined,
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
      await control.authorizeStep(token(req), req.params.id, req.body.agentId, inbound(req));
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
      await control.authorize(token(req), req.params.id, inbound(req));
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
      await control.authorize(token(req), req.params.id, inbound(req));
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
      await control.authorize(token(req), req.params.id, inbound(req));
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
      const claims = await control.authorizeNodeStep(
        token(req),
        req.params.id,
        req.query.agentId,
        inbound(req),
      );
      reply.header('cache-control', 'no-store');
      return services.runNodes.handover(claims, req.params.id, req.query.agentId);
    },
  );

  app.get(
    '/v1/worker/runs/:id/workspace',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary:
          'Run node: the workspace seed of its own step (ustar archive; once per step and session)',
        description:
          'Returns the archive prepared by the worker (`application/x-tar`) with its SHA-256 in `x-oax-seed-sha256`. The node verifies the digest and unpacks the archive with its own checks. A second request is refused with 409; the bytes are deleted when the session ends.',
        security: sec,
        params: RunIdParams,
        querystring: StepHandoverQuery,
        response: { 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) => {
      const claims = await control.authorizeNodeStep(
        token(req),
        req.params.id,
        req.query.agentId,
        inbound(req),
      );
      const seed = await services.runNodes.takeSeed(claims, req.params.id, req.query.agentId);
      return (
        reply
          .header('cache-control', 'no-store')
          .header('x-oax-seed-sha256', seed.sha256)
          .type('application/x-tar')
          // raw bytes: no response schema is declared for 200, so no serializer touches them
          .send(seed.archive as never)
      );
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
      const claims = await control.authorizeNodeStep(
        token(req),
        req.params.id,
        req.body.agentId,
        inbound(req),
      );
      await services.runNodes.submitResult(claims, req.params.id, req.body);
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/worker/runs/:id/mcp-tools-changed',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary:
          'Run node: report that the tools of a pinned MCP server differ from the pin (audit entry and pending snapshot)',
        description:
          'The node fails the step closed on its own; this call lets the control node record what it saw. The digest is recomputed here, the list is bounded and scanned for credentials, and only a server the step holds a pin and a grant for is accepted.',
        security: sec,
        params: RunIdParams,
        body: ToolsChangedBody,
      },
    },
    async (req, reply) => {
      const claims = await control.authorizeNodeStep(
        token(req),
        req.params.id,
        req.body.agentId,
        inbound(req),
      );
      await services.mcpTools.reportFromNode(claims, req.params.id, req.body);
      return reply.status(204).send();
    },
  );

  registerMcpRelayRoute(app, deps);

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
      const claims = await control.authorizeNodeStep(
        token(req),
        req.params.id,
        req.body.agentId,
        inbound(req),
      );
      // Values must never be cached by an intermediary or end up in a log.
      reply.header('cache-control', 'no-store');
      return services.runNodes.issueCredentials(claims, req.params.id, req.body.agentId);
    },
  );

  registerModelRoutes(app, deps);
}

/**
 * The MCP relay for run nodes (ADR 0016 section 6). Own scope: a strict JSON parser (no duplicate
 * keys, no prototype keys, bounded depth) and the relay's body limit apply here only. The route
 * accepts the step-scoped run token and nothing else; a missing, forged or expired token and every refusal that could tell a node
 * something about other runs, tenants or connections is the same 404 as an unknown server.
 */
function registerMcpRelayRoute(app: ZApp, deps: Deps): void {
  const { ctx, services } = deps;
  const limit = ctx.config.mcp.relay.maxRequestBytes;
  app.addHook('onClose', async () => services.mcpRelay.close());
  void app.register(async (scope) => {
    // A node has `bodyReadMs` to deliver its body: the server has no request timeout of its own, and
    // a trickle of bytes would otherwise hold a connection (and its parse buffer) forever.
    // Signature and expiry, before the body is read; the rest is checked by the service. A bad
    // token is refused like an unknown server. This runs in `preParsing`, after the route's rate
    // limit (an `onRequest` hook added per route), so these refusals carry the same headers as
    // every other one; the global auth hook leaves this route to us.
    scope.addHook('preParsing', async (req) => {
      try {
        verifyRunToken(ctx.config.runToken.secret, bearerOf(req) ?? '', ctx.now().getTime());
      } catch {
        throw mcpRelayRefusal();
      }
    });
    scope.addHook('onRequest', async (req) => {
      const timer = setTimeout(() => {
        if (!req.raw.complete) req.raw.destroy();
      }, ctx.config.mcp.relay.bodyReadMs);
      timer.unref();
      req.raw.once('end', () => clearTimeout(timer));
      req.raw.once('close', () => clearTimeout(timer));
    });
    // Every answer of the relay scope, the refusals of the global auth hook included, is uncacheable.
    scope.addHook('onSend', async (_req, reply, payload) => {
      void reply.header('cache-control', 'no-store');
      return payload;
    });
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: limit },
      (_req, body, done) => {
        try {
          done(null, parseStrictJson(String(body)));
        } catch {
          done(Object.assign(new Error('the request body is not valid JSON'), { statusCode: 400 }));
        }
      },
    );
    const typed = scope.withTypeProvider<ZodTypeProvider>();
    typed.post(
      '/v1/worker/runs/:id/mcp/:server',
      {
        config: { access: 'run-token', relay: true },
        bodyLimit: limit,
        schema: {
          tags,
          summary:
            'Run node: one JSON-RPC message for an HTTP MCP server, relayed by the control node',
          description:
            'The node never connects to the server and never holds its credentials. Allowed: `initialize`, `ping`, `tools/list`, `tools/call` and the notifications `notifications/initialized` and `notifications/cancelled`. `tools/call` is decided by the policy gate again, needs a granted approval where the decision says so, is checked against the pinned tool definitions and leaves through the same outbound dispatcher as an in-process call. Sampling, elicitation and roots are not relayed (`mcp_capability_unsupported`). A revoked or expired session, a server the step has no grant on, a connection of another tenant and a foreign run answer alike (404). Limits per session: concurrency, calls per minute, request and result size, call timeout.',
          security: sec,
          params: McpRelayParams,
          body: McpRelayMessage,
          response: {
            200: McpRelayAnswer,
            202: z.null(),
            400: ErrorSchema,
            401: ErrorSchema,
            404: ErrorSchema,
            413: ErrorSchema,
            429: ErrorSchema,
            503: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        reply.header('cache-control', 'no-store');
        const gone = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) gone.abort('client_abort');
        });
        const answer = await services.mcpRelay.handle({
          // the onRequest hook verified the token's signature and expiry; the service the rest
          token: bearerOf(req) ?? '',
          runId: req.params.id,
          server: req.params.server,
          body: req.body,
          traceparent: inbound(req),
          signal: gone.signal,
        });
        if (answer.status === 202) return reply.status(202).send(undefined as never);
        return answer.body as z.infer<typeof McpRelayAnswer>;
      },
    );
  });
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
        const auth = await modelProxy.authenticate(
          bearerOf(req),
          req.params.id,
          'native',
          inbound(req),
        );
        // Values must never be cached by an intermediary or end up in a log.
        reply.header('cache-control', 'no-store');
        return modelProxy.issueToken(auth, req.body.agentId, req.body.harness);
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
        const auth = await modelProxy.authenticate(
          bearerOf(req),
          req.params.id,
          'native',
          inbound(req),
        );
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

    registerPassthroughRoutes(typed, deps, { bodyLimit: limit, gates });
  });
}
