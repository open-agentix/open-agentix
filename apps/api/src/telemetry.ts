import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';

/**
 * OpenTelemetry hooks. Spans are created through the API (no-op unless a provider is registered);
 * `initTelemetry` registers an OTLP/HTTP exporter when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */
export function tracer(): Tracer {
  return trace.getTracer('openagentix');
}

export interface Telemetry {
  enabled: boolean;
  shutdown(): Promise<void>;
}

export async function initTelemetry(
  endpoint: string | undefined,
  serviceName: string,
): Promise<Telemetry> {
  if (!endpoint) return { enabled: false, shutdown: async () => undefined };
  const [
    { NodeTracerProvider },
    { BatchSpanProcessor },
    { OTLPTraceExporter },
    { resourceFromAttributes },
  ] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
  ]);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
      ),
    ],
  });
  provider.register();
  return { enabled: true, shutdown: () => provider.shutdown() };
}

/** Runs `fn` in a span, recording errors. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}
