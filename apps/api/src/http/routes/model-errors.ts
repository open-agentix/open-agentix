import { OaxError } from '@openagentix/core';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  PassthroughRequestError,
  protocolError,
  type PassthroughSurface,
} from '@openagentix/providers';
import { StrictJsonError } from '../../services/model-proxy-json.js';
import { ModelProxyError, toModelProxyError } from '../../services/model-proxy.js';

/**
 * Rate limit bucket of a model route, evaluated before authentication: the peer address only.
 * (A token-derived key would let anyone mint unlimited buckets with invalid tokens, and the
 * claims of all model tokens start with the same bytes.)
 */
export const modelRateKey = (req: Pick<FastifyRequest, 'ip'>): string => req.ip;

/** Parameter names are echoed in refusals; anything else is cut so an error never reflects input. */
const safeName = (k: unknown): string =>
  String(k)
    .replace(/[^\w.-]/g, '')
    .slice(0, 64);

/** Error handler of the model routes: every failure uses the model envelope and stable codes. */
export function modelFailure(
  err: FastifyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): ModelProxyError {
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
  } else if (err instanceof PassthroughRequestError) {
    out = new ModelProxyError(err.code, err.message);
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
  return out;
}

/** Error handler of the native model routes: the platform envelope `{ error: { code, message } }`. */
export function modelErrorHandler(
  err: FastifyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const out = modelFailure(err, req, reply);
  return reply.status(out.status).send(out.envelope());
}

/** Error handler of a pass-through surface: the protocol's own error envelope (ADR 0009 section 2.5). */
export const passthroughErrorHandler =
  (surface: PassthroughSurface) =>
  (err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const out = modelFailure(err, req, reply);
    return reply.status(out.status).send(protocolError(surface, out.code, out.message));
  };
