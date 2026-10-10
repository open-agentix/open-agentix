import {
  SpanStatusCode,
  trace,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api';
import {
  type ContextGuard,
  OaxError,
  DefaultSecretResolver,
  type SecretResolver,
  describeError,
  MAX_INPUT_CHARS,
  type SpanKind,
} from '@openagentix/core';
import type { OtelConfig } from './telemetry-config.js';
import { parseHeaderList } from './telemetry-config.js';
import {
  configureTelemetryRuntime,
  sanitizeForSpan,
  sanitizeSpanName,
  telemetryRuntime,
  type TelemetryStats,
} from './telemetry-runtime.js';

export {
  configureTelemetryRuntime,
  resetTelemetryRuntime,
  telemetryRuntime,
  type TelemetryStats,
} from './telemetry-runtime.js';

/**
 * OpenTelemetry hooks. Spans are created through the API (no-op unless a provider is registered);
 * `initTelemetry` registers an OTLP exporter when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Code creates spans with {@link withSpan} only: it hands out a {@link GuardedSpan} that accepts
 * attributes through the allowlist (`packages/core/src/telemetry`) and records errors as a code
 * and a class name, never a message or a stack. The raw tracer stays exported for the SDK
 * internals, and the export boundary re-applies the allowlist to whatever it is given.
 */
export function tracer(): Tracer {
  return trace.getTracer('openagentix');
}

/** The only span surface callers get: no raw `setAttribute`, `recordException` or `setStatus`. */
export interface GuardedSpan {
  setAttributes(attributes: Record<string, unknown>): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  spanContext(): SpanContext;
}

export interface SpanSpec {
  name: string;
  kind: SpanKind;
  /** Per-run guard that also knows the run's resolved secret values (default: the runtime guard). */
  guard?: ContextGuard;
}

const EVENT_NAME = /^[a-z][a-z0-9_.]{0,63}$/;

function guardedSpan(span: Span, kind: SpanKind, guard: ContextGuard | undefined): GuardedSpan {
  return {
    setAttributes(attributes) {
      span.setAttributes(sanitizeForSpan(kind, attributes, guard));
    },
    addEvent(name, attributes = {}) {
      if (!EVENT_NAME.test(name)) return;
      span.addEvent(name, sanitizeForSpan(kind, attributes, guard));
    },
    spanContext: () => span.spanContext(),
  };
}

/** Marks the span failed: status description and `error.type` are the code, the event the class. */
function recordFailure(
  span: Span,
  kind: SpanKind,
  guard: ContextGuard | undefined,
  e: unknown,
): void {
  const { code, type } = describeError(e);
  const attrs = sanitizeForSpan(kind, { 'error.type': code }, guard);
  const safeCode = typeof attrs['error.type'] === 'string' ? attrs['error.type'] : '_OTHER';
  span.setAttributes(attrs);
  span.setStatus({ code: SpanStatusCode.ERROR, message: safeCode });
  const event: Record<string, unknown> = { 'exception.type': type };
  // Opt-in (OAX_OTEL_EXCEPTION_DETAIL=guarded): the message passes the guard and the 256 cap.
  // The stack is never recorded.
  if (telemetryRuntime().exceptionDetail === 'guarded' && e instanceof Error)
    event['exception.message'] = e.message;
  span.addEvent('exception', sanitizeForSpan(kind, event, guard));
}

/** Runs `fn` in a span, recording errors without their messages. */
export async function withSpan<T>(
  spec: SpanSpec,
  attributes: Record<string, unknown>,
  fn: (span: GuardedSpan) => Promise<T>,
): Promise<T> {
  const name = sanitizeSpanName(spec.name, spec.guard);
  const options = {
    attributes: {
      ...sanitizeForSpan(spec.kind, attributes, spec.guard),
      ...(name.redacted ? { 'oax.redacted': true } : {}),
    },
  };
  return tracer().startActiveSpan(name.name, options, async (span) => {
    try {
      return await fn(guardedSpan(span, spec.kind, spec.guard));
    } catch (e) {
      try {
        recordFailure(span, spec.kind, spec.guard, e);
      } catch {
        // Telemetry must never replace or hide the caller's error (e.g. a throwing message getter).
      }
      throw e;
    } finally {
      span.end();
    }
  });
}

export interface Telemetry {
  enabled: boolean;
  /** Connects the `oax_otel_*` counters (the metrics registry exists after the context is built). */
  attachStats(stats: TelemetryStats): void;
  shutdown(): Promise<void>;
}

export interface TelemetryInit {
  /** Overrides `config.serviceName` (the worker has its own default). */
  serviceName?: string;
  secrets?: SecretResolver;
  warn?: (fields: Record<string, string | number>, message: string) => void;
}

const SHUTDOWN_TIMEOUT_MS = 5000;
const BATCH_TIMEOUT_MARGIN_MS = 1000;
const SCHEDULE_DELAY_MS = 5000;
/** Bounds for spans created with the raw tracer (the allowlist bounds everything else further). */
const SPAN_LIMITS = {
  attributeValueLengthLimit: MAX_INPUT_CHARS,
  attributeCountLimit: 128,
  linkCountLimit: 128,
  eventCountLimit: 128,
  attributePerEventCountLimit: 128,
  attributePerLinkCountLimit: 128,
};

/** Resolves the exporter headers from the secret reference and registers them with the guard. */
async function resolveHeaders(
  config: OtelConfig,
  secrets: SecretResolver,
): Promise<Record<string, string> | undefined> {
  if (!config.headersSecret) return undefined;
  let raw: string;
  try {
    raw = await secrets.resolve(config.headersSecret);
  } catch (e) {
    const code = e instanceof OaxError ? e.code : '_OTHER';
    throw new OaxError(
      'config_invalid',
      `OAX_OTEL_HEADERS_SECRET: secret "${config.headersSecret}" could not be resolved (${code})`,
    );
  }
  const headers = parseHeaderList(raw);
  // Whatever happens later, these values must not be able to appear in a span or a log line.
  const guard = telemetryRuntime().guard;
  guard.addSecret(raw);
  for (const v of Object.values(headers)) guard.addSecret(v);
  return headers;
}

export async function initTelemetry(
  config: OtelConfig,
  init: TelemetryInit = {},
): Promise<Telemetry> {
  configureTelemetryRuntime({
    exceptionDetail: config.exceptionDetail,
    ...(init.warn ? { warn: init.warn } : {}),
  });
  const attachStats = (stats: TelemetryStats) => configureTelemetryRuntime({ stats });
  if (!config.endpoint) return { enabled: false, attachStats, shutdown: async () => undefined };
  const headers = await resolveHeaders(config, init.secrets ?? new DefaultSecretResolver());
  const [
    { NodeTracerProvider },
    { AlwaysOnSampler, BatchSpanProcessor, ParentBasedSampler },
    { resourceFromAttributes },
    { GuardedSpanExporter, DropCountingProcessor },
  ] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/resources'),
    import('./telemetry-export.js'),
  ]);
  const url = `${config.endpoint.replace(/\/$/, '')}/v1/traces`;
  const exporterConfig = {
    url,
    timeoutMillis: config.exportTimeoutMs,
    ...(headers ? { headers } : {}),
  };
  const exporter =
    config.protocol === 'http/json'
      ? new (await import('@opentelemetry/exporter-trace-otlp-http')).OTLPTraceExporter(
          exporterConfig,
        )
      : new (await import('@opentelemetry/exporter-trace-otlp-proto')).OTLPTraceExporter(
          exporterConfig,
        );
  // Every option is passed explicitly, so none of the SDK's OTEL_BSP_* fallbacks applies.
  const batch = new BatchSpanProcessor(new GuardedSpanExporter(exporter, config.exportTimeoutMs), {
    maxQueueSize: config.maxQueue,
    maxExportBatchSize: Math.min(512, config.maxQueue),
    scheduledDelayMillis: SCHEDULE_DELAY_MS,
    // A backstop behind the exporter's own timeout and the counting wrapper's (both exportTimeoutMs).
    exportTimeoutMillis: config.exportTimeoutMs + BATCH_TIMEOUT_MARGIN_MS,
  });
  // Static resource only: no detectors, so nothing calls a cloud metadata endpoint or reads host
  // details (ADR 0015 section 8). `resourceFromAttributes` does not read OTEL_RESOURCE_ATTRIBUTES.
  // Sampler and limits are explicit too: the SDK would otherwise build them from OTEL_TRACES_SAMPLER
  // and OTEL_SPAN_* / OTEL_ATTRIBUTE_* (sampling by ratio is slice S6, OAX_OTEL_SAMPLE_RATIO).
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      ...config.resourceAttributes,
      'service.name': init.serviceName ?? config.serviceName,
    }),
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanLimits: SPAN_LIMITS,
    generalLimits: {
      attributeValueLengthLimit: SPAN_LIMITS.attributeValueLengthLimit,
      attributeCountLimit: SPAN_LIMITS.attributeCountLimit,
    },
    spanProcessors: [new DropCountingProcessor(batch, config.maxQueue)],
  });
  // No global propagator: nothing injects or extracts `traceparent`/`baggage` until a slice names
  // the place deliberately (ADR 0015 sections 2, 6.1 and 6.4).
  provider.register({ propagator: null });
  return {
    enabled: true,
    attachStats,
    // Never throws and never waits longer than the bound: a failed final flush is already counted.
    shutdown: () =>
      Promise.race([
        provider.shutdown().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
      ]),
  };
}
