import type { FastifyInstance } from 'fastify';
import type { SecretRegistry } from './secret-registry.js';

/**
 * Last net for an OAuth token value that an upstream error text or a tool result carried into a
 * JSON response (ADR 0016 section 7.5). A no-op while no token has been handed out. Streams are
 * not touched; they carry run events, which are scrubbed where they are written.
 */
export function scrubResponses(app: FastifyInstance, registry: SecretRegistry): void {
  app.addHook('onSend', async (_req, _reply, payload) =>
    typeof payload === 'string' ? registry.scrub(payload) : payload,
  );
}
