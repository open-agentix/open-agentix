import type { FastifyInstance } from 'fastify';
import type { SecretRegistry } from './secret-registry.js';
import { scrubJsonText } from './scrub.js';

/**
 * Last net for an OAuth token value that an upstream error text or a tool result carried into a
 * string response (ADR 0016 section 7.5). Never turns valid JSON into invalid JSON. Hijacked
 * streams (run events, the MCP relay's SSE answer) do not pass `onSend`; they scrub their frames
 * with `stringifyScrubbed`.
 */
export function scrubResponses(app: FastifyInstance, registry: SecretRegistry): void {
  app.addHook('onSend', async (_req, _reply, payload) =>
    typeof payload === 'string' ? scrubJsonText(registry, payload) : payload,
  );
}
