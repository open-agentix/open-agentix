import { OaxError, ValidationError } from '@openagentix/core';
import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

/** HTTP status for stable error codes. */
const STATUS: Record<string, number> = {
  validation_failed: 400,
  invalid_cursor: 400,
  payload_invalid: 400,
  unauthenticated: 401,
  signature_missing: 401,
  signature_invalid: 401,
  timestamp_invalid: 401,
  run_token_invalid: 401,
  run_token_expired: 401,
  forbidden: 403,
  policy_denied: 403,
  not_found: 404,
  conflict: 409,
  replayed: 409,
  version_immutable: 409,
  version_not_increasing: 409,
  invalid_state: 409,
  not_implemented: 501,
  team_budget_exceeded: 402,
};

export class HttpError extends OaxError {
  constructor(
    readonly statusCode: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(code, message, details);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'insufficient permissions') => new HttpError(403, 'forbidden', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | OaxError | Error, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: 'validation_failed',
        message: 'request validation failed',
        details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply
        .status(err.statusCode)
        .send({ error: err.code, message: err.message, details: err.details ?? undefined });
    }
    if (err instanceof ValidationError) {
      return reply.status(400).send({ error: err.code, message: err.message, details: err.issues });
    }
    if (err instanceof OaxError) {
      const status = STATUS[err.code] ?? 422;
      return reply.status(status).send({ error: err.code, message: err.message });
    }
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode < 500) {
      return reply
        .status(fe.statusCode)
        .send({ error: fe.code ?? 'bad_request', message: fe.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'internal server error' });
  });
}
