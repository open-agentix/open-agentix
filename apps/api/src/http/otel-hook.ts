import type { FastifyInstance } from 'fastify';
import { parseTraceparent } from '@openagentix/core';
import { startGuardedSpan, telemetryRuntime, tracingEnabled, type OpenSpan } from '../telemetry.js';

/**
 * HTTP server spans and the inbound trace context (ADR 0015 sections 2 and 3.1).
 *
 * One SERVER span per request, named `{METHOD} {route pattern}` and started from a Fastify hook, not
 * by `@opentelemetry/instrumentation-http`: only the method, the route pattern, the status code
 * and the access class are recorded, never a path with identifiers, a query string, a header or a
 * body. Requests that match no route and the probe and scrape routes get no span.
 *
 * A `traceparent` header is never used as a parent. Each request starts its own trace. With
 * `OAX_OTEL_INBOUND_CONTEXT=link` a well-formed header becomes a span link (ids and flags only, no
 * `tracestate`, no baggage); with `ignore` (default) it is dropped. Either way it is counted in
 * `oax_otel_inbound_context_total{result}`.
 */
const NO_SPAN_ROUTES: ReadonlySet<string> = new Set(['/healthz', '/readyz', '/metrics']);
const METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

function accessClass(access: unknown): 'user' | 'run-token' | 'model-token' | 'public' {
  if (access === 'public' || access === 'webhook') return 'public';
  if (access === 'run-token' || access === 'model-token') return access;
  return 'user';
}

export function registerHttpSpans(app: FastifyInstance, inbound: 'ignore' | 'link'): void {
  app.addHook('onRequest', (req, reply, done) => {
    let open: OpenSpan | undefined;
    try {
      const header = req.headers['traceparent'];
      const parsed = header === undefined ? null : parseTraceparent(header);
      const route = req.routeOptions.url;
      const spanned =
        route !== undefined &&
        route.startsWith('/') &&
        !NO_SPAN_ROUTES.has(route) &&
        METHODS.has(req.method) &&
        tracingEnabled();
      const linked = inbound === 'link' && parsed !== null && spanned;
      if (header !== undefined)
        telemetryRuntime().stats.inboundContext(
          parsed === null ? 'invalid' : linked ? 'linked' : 'ignored',
          1,
        );
      if (spanned) {
        const started = startGuardedSpan(
          {
            name: `${req.method} ${route}`,
            kind: 'http_server',
            newTrace: true,
            ...(linked ? { links: [{ traceId: parsed.traceId, spanId: parsed.spanId }] } : {}),
          },
          { 'http.request.method': req.method, 'http.route': route },
        );
        open = started;
        // `close` fires after the response was sent and when the client aborted.
        reply.raw.once('close', () => {
          try {
            started.span.setAttributes({
              'http.response.status_code': reply.statusCode,
              'oax.access': accessClass(req.routeOptions.config?.access),
            });
            started.end();
          } catch {
            // Telemetry never affects a response.
          }
        });
      }
    } catch {
      // Telemetry never affects a request.
    }
    if (open) open.run(done);
    else done();
  });
}
