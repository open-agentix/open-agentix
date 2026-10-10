import type { FastifyInstance } from 'fastify';
import type { SecretRegistry } from './secret-registry.js';
import { scrubJsonText } from './scrub.js';

/**
 * Last net for an OAuth token value that an upstream error text or a tool result carried into a
 * string response of a signed-in tenant (ADR 0016 section 7.5). Never turns valid JSON into invalid JSON. Hijacked
 * streams (run events, the MCP relay's SSE answer) do not pass `onSend`; they scrub their frames
 * with `stringifyScrubbed`.
 */
export function scrubResponses(app: FastifyInstance, registry: SecretRegistry): void {
  app.addHook('onSend', async (req, _reply, payload) => {
    // The tenant the response is served to; requests without a principal carry no tenant text.
    const tenant = (req as { principal?: { tenantId?: string } }).principal?.tenantId;
    return typeof payload === 'string' && tenant
      ? scrubJsonText(registry, payload, tenant)
      : payload;
  });
}
