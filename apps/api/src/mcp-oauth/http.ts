import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SecretRegistry } from './secret-registry.js';
import { scrubJsonText } from './scrub.js';

/** Names the tenant a request without a principal is served for (a run token's run), if known. */
export type TenantResolver = (req: FastifyRequest) => Promise<string | undefined>;

/**
 * Last net for an OAuth token value that an upstream error text or a tool result carried into a
 * string response (ADR 0016 section 7.5). Scrubs with the values of the tenant the response is served
 * for: the signed-in principal's, or the run's for run-token routes (`tenantOf`). Never turns valid
 * JSON into invalid JSON. Hijacked streams do not pass `onSend`; they scrub their frames with
 * `stringifyScrubbed`.
 */
export function scrubResponses(
  app: FastifyInstance,
  registry: SecretRegistry,
  tenantOf?: TenantResolver,
): void {
  app.addHook('onSend', async (req, _reply, payload) => {
    if (typeof payload !== 'string' || registry.size === 0) return payload;
    const tenant =
      (req as { principal?: { tenantId?: string } }).principal?.tenantId ?? (await tenantOf?.(req));
    return tenant ? scrubJsonText(registry, payload, tenant) : payload;
  });
}
