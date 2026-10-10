import {
  parseAnthropicRequest,
  parseOpenAIRequest,
  protocolError,
  renderAnthropicMessage,
  renderOpenAICompletion,
  type ClientEvent,
  type ModelErrorCode,
  type PassthroughRequest,
  type PassthroughSurface,
} from '@openagentix/providers';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { modelCredentialOf } from '../app.js';
import type { StreamSink } from '../../services/model-proxy.js';
import type { ZApp } from '../zapp.js';
import { modelRateKey, passthroughErrorHandler } from './model-errors.js';

const tags = ['model-proxy'];
const modelSec: Record<string, string[]>[] = [{ modelToken: [] }];

/** Writes the events of a pass-through stream; never throws and never writes after the close. */
function passSink(reply: FastifyReply, surface: PassthroughSurface, callId: string): StreamSink {
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
  const write = (text: string): Promise<void> => {
    if (!open || raw.writableEnded) return Promise.resolve();
    // Backpressure: resolve when the client drained, or when it is gone.
    if (raw.write(text)) return Promise.resolve();
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
  const frame = (ev: ClientEvent) =>
    surface === 'anthropic'
      ? `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`
      : `data: ${JSON.stringify(ev.data)}\n\n`;
  return {
    delta: () => Promise.resolve(),
    event: (ev) => write(frame(ev)),
    done: () => {
      // OpenAI streams end with a literal [DONE]; Anthropic's `message_stop` is a relayed event.
      void (surface === 'openai' ? write('data: [DONE]\n\n') : Promise.resolve()).then(end);
    },
    error: (code: ModelErrorCode, message: string) => {
      const body = protocolError(surface, code, message);
      void write(
        surface === 'anthropic'
          ? `event: error\ndata: ${JSON.stringify(body)}\n\n`
          : `data: ${JSON.stringify(body)}\n\n`,
      ).then(end);
    },
  };
}

/**
 * The pass-through endpoints for harnesses (ADR 0009 section 2.1): the Anthropic Messages and OpenAI
 * Chat Completions protocols. Registered inside the model routes' scope (strict JSON parser, body
 * limit). The model token is the only credential; it comes from `Authorization: Bearer` or
 * `x-api-key` and is never forwarded.
 */
export function registerPassthroughRoutes(
  typed: ZApp,
  deps: Deps,
  opts: {
    bodyLimit: number;
    gates: ((req: FastifyRequest) => Promise<void>)[];
  },
): void {
  const { ctx, services } = deps;
  const { modelProxy } = services;
  const rateLimit = {
    max: ctx.config.rateLimit.max,
    timeWindow: '1 minute',
    keyGenerator: modelRateKey,
  };
  const body = z
    .looseObject({})
    .describe('Request body of the protocol (a strict allowlist is applied, ADR 0009 section 6.2)');

  const callRoute = (
    surface: PassthroughSurface,
    url: string,
    summary: string,
    parse: (b: unknown) => PassthroughRequest,
    render: (r: Parameters<typeof renderAnthropicMessage>[0]) => Record<string, unknown>,
  ) => {
    typed.post(
      url,
      {
        config: { access: 'model-token', rateLimit },
        bodyLimit: opts.bodyLimit,
        errorHandler: passthroughErrorHandler(surface),
        onRequest: opts.gates,
        schema: { tags, summary, security: modelSec, body },
      },
      async (req, reply) => {
        // Authenticate first: an unauthenticated caller learns nothing from request validation.
        const auth = await modelProxy.authenticatePassthrough(
          modelCredentialOf(req),
          req.headers['traceparent'],
        );
        const parsed = parse(req.body);
        reply.header('cache-control', 'no-store');
        const gone = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) gone.abort('client_abort');
        });
        if (parsed.stream) {
          await modelProxy.streamPassthrough(auth, parsed, req.headers['anthropic-beta'], {
            signal: gone.signal,
            begin: (callId) => passSink(reply, surface, callId),
          });
          return reply;
        }
        const out = await modelProxy.callPassthrough(
          auth,
          parsed,
          req.headers['anthropic-beta'],
          gone.signal,
        );
        reply.header('x-oax-call-id', out.callId);
        reply.header('x-oax-cost-micros', String(out.costMicros));
        return render(out);
      },
    );
  };

  callRoute(
    'anthropic',
    '/v1/model-proxy/anthropic/v1/messages',
    'Model proxy, Anthropic Messages protocol (JSON, or SSE with `stream: true`)',
    parseAnthropicRequest,
    renderAnthropicMessage,
  );
  callRoute(
    'openai',
    '/v1/model-proxy/openai/v1/chat/completions',
    'Model proxy, OpenAI Chat Completions protocol (JSON, or SSE with `stream: true`)',
    parseOpenAIRequest,
    renderOpenAICompletion,
  );

  const modelsRoute = (
    surface: PassthroughSurface,
    url: string,
    render: (id: string) => Record<string, unknown>,
  ) => {
    typed.get(
      url,
      {
        config: { access: 'model-token', rateLimit },
        errorHandler: passthroughErrorHandler(surface),
        onRequest: opts.gates,
        schema: {
          tags,
          summary: "Model proxy: lists exactly the model of the token's step",
          security: modelSec,
        },
      },
      async (req, reply) => {
        const auth = await modelProxy.authenticatePassthrough(
          modelCredentialOf(req),
          req.headers['traceparent'],
        );
        reply.header('cache-control', 'no-store');
        return render(await modelProxy.stepModel(auth));
      },
    );
  };
  modelsRoute('anthropic', '/v1/model-proxy/anthropic/v1/models', (id) => ({
    data: [{ type: 'model', id, display_name: id, created_at: '1970-01-01T00:00:00Z' }],
    has_more: false,
    first_id: id,
    last_id: id,
  }));
  modelsRoute('openai', '/v1/model-proxy/openai/v1/models', (id) => ({
    object: 'list',
    data: [{ id, object: 'model', created: 0, owned_by: 'openagentix' }],
  }));
}
