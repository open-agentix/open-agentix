import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ProxyTracerProvider,
  ROOT_CONTEXT,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  TraceFlags,
  context,
  isSpanContextValid,
  trace,
  type Context,
  type Link,
  type Span,
  type SpanContext,
  type MeterProvider,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';
import type { BufferConfig, IdGenerator } from '@opentelemetry/sdk-trace-base';
import {
  type ContextGuard,
  OaxError,
  DefaultSecretResolver,
  type SecretResolver,
  describeError,
  isSpanId,
  isTraceId,
  MAX_INPUT_CHARS,
  newSpanId,
  newTraceId,
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

/** A trace position taken from stored columns, never from a request. */
export interface StoredSpanIds {
  traceId: string;
  spanId: string;
}

export interface SpanSpec {
  name: string;
  kind: SpanKind;
  /** Per-run guard that also knows the run's resolved secret values (default: the runtime guard). */
  guard?: ContextGuard;
  /**
   * The span is the root of a trace and gets exactly these ids (the admission span of a run uses
   * the ids stored on the run row). It has no parent: the active span is not inherited.
   */
  root?: StoredSpanIds;
  /**
   * Parent is a remote context rebuilt from stored ids (an attempt of an existing run). The span
   * gets a fresh span id. Invalid ids are ignored: the span then starts its own trace (it does not
   * inherit the active span).
   */
  parent?: StoredSpanIds;
  /** Start a new trace instead of continuing the active one (HTTP server spans). */
  newTrace?: boolean;
  /** Links by id; flags only, no trace state, no attributes. */
  links?: readonly StoredSpanIds[];
  /** Link the span that is active now (admission links the request span, ADR 0015 section 2). */
  linkActive?: boolean;
}

const EVENT_NAME = /^[a-z][a-z0-9_.]{0,63}$/;

/** Raw span to the guarded view the code received, for `activeGuardedSpan`. */
const guardedBySpan = new WeakMap<Span, GuardedSpan>();

function guardedSpan(span: Span, kind: SpanKind, guard: ContextGuard | undefined): GuardedSpan {
  const g: GuardedSpan = {
    setAttributes(attributes) {
      span.setAttributes(sanitizeForSpan(kind, attributes, guard));
    },
    addEvent(name, attributes = {}) {
      if (!EVENT_NAME.test(name)) return;
      span.addEvent(name, sanitizeForSpan(kind, attributes, guard));
    },
    spanContext: () => span.spanContext(),
  };
  guardedBySpan.set(span, g);
  return g;
}

/**
 * The active span as the guarded view, when it was created by `withSpan`/`startGuardedSpan` and
 * belongs to the given trace. Anything else (a foreign span, another trace, no span) is undefined.
 */
export function activeGuardedSpan(traceId: string): GuardedSpan | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx) || ctx.traceId !== traceId) return undefined;
  return guardedBySpan.get(span);
}

/** The span id of the active span when it is valid and part of `traceId`. */
export function activeSpanIdIn(traceId: string): string | undefined {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && isSpanContextValid(ctx) && ctx.traceId === traceId ? ctx.spanId : undefined;
}

/**
 * Id generator of the provider. Every id comes from the operating system CSPRNG (the SDK's default
 * generator uses `Math.random`). `withIds` makes the next span that is started synchronously inside
 * the callback take the given ids, which is how the admission span gets the ids stored on the run.
 */
export class RunIdGenerator implements IdGenerator {
  private static readonly slot = new AsyncLocalStorage<{
    traceId?: string;
    spanId?: string;
  }>();

  static withIds<T>(ids: StoredSpanIds, fn: () => T): T {
    return RunIdGenerator.slot.run({ traceId: ids.traceId, spanId: ids.spanId }, fn);
  }

  generateTraceId = (): string => {
    const store = RunIdGenerator.slot.getStore();
    const forced = store?.traceId;
    if (store && forced) {
      delete store.traceId;
      return forced;
    }
    return newTraceId();
  };

  generateSpanId = (): string => {
    const store = RunIdGenerator.slot.getStore();
    const forced = store?.spanId;
    if (store && forced) {
      delete store.spanId;
      return forced;
    }
    return newSpanId();
  };
}

/** The remote span context of a stored position: sampled, no trace state. */
function remoteContext(ids: StoredSpanIds): SpanContext {
  return {
    traceId: ids.traceId,
    spanId: ids.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
}

function linksOf(spec: SpanSpec): Link[] {
  const links: Link[] = [];
  for (const l of spec.links ?? [])
    if (isTraceId(l.traceId) && isSpanId(l.spanId)) links.push({ context: remoteContext(l) });
  if (spec.linkActive) {
    const active = trace.getActiveSpan()?.spanContext();
    if (active && isSpanContextValid(active))
      links.push({
        context: {
          traceId: active.traceId,
          spanId: active.spanId,
          traceFlags: active.traceFlags,
        },
      });
  }
  return links;
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

/** A started span for callers that cannot wrap the work in a callback (a Fastify hook). */
export interface OpenSpan {
  span: GuardedSpan;
  /** Runs `fn` with this span as the active one. */
  run<T>(fn: () => T): T;
  /** Ends the span; a failure is recorded as a code and a class name only. */
  end(failure?: unknown): void;
}

function openSpan(spec: SpanSpec, attributes: Record<string, unknown>): OpenSpan {
  const name = sanitizeSpanName(spec.name, spec.guard);
  const options = {
    attributes: {
      ...sanitizeForSpan(spec.kind, attributes, spec.guard),
      ...(name.redacted ? { 'oax.redacted': true } : {}),
    },
    // Only the request span is a SERVER span; model calls (CLIENT) arrive with the executor slice.
    kind: spec.kind === 'http_server' ? OtelSpanKind.SERVER : OtelSpanKind.INTERNAL,
    links: linksOf(spec),
  };
  let parent: Context = context.active();
  if (spec.root || spec.newTrace) parent = ROOT_CONTEXT;
  else if (spec.parent)
    parent =
      isTraceId(spec.parent.traceId) && isSpanId(spec.parent.spanId)
        ? trace.setSpanContext(ROOT_CONTEXT, remoteContext(spec.parent))
        : ROOT_CONTEXT;
  const start = () => tracer().startSpan(name.name, options, parent);
  const raw =
    spec.root && isTraceId(spec.root.traceId) && isSpanId(spec.root.spanId)
      ? RunIdGenerator.withIds(spec.root, start)
      : start();
  if (spec.root && raw.isRecording() && raw.spanContext().spanId !== spec.root.spanId)
    // The provider ignores the id generator: audit links would point at a span that does not exist.
    telemetryRuntime().warn(
      { reason: 'span_id_not_applied' },
      'telemetry root span id not applied',
    );
  const spanContext = trace.setSpan(parent, raw);
  let ended = false;
  return {
    span: guardedSpan(raw, spec.kind, spec.guard),
    run: (fn) => context.with(spanContext, fn),
    end(failure) {
      if (ended) return;
      ended = true;
      if (failure !== undefined) {
        try {
          recordFailure(raw, spec.kind, spec.guard, failure);
        } catch {
          // Telemetry must never replace or hide the caller's error (e.g. a throwing message getter).
        }
      }
      raw.end();
    },
  };
}

export function startGuardedSpan(spec: SpanSpec, attributes: Record<string, unknown>): OpenSpan {
  return openSpan(spec, attributes);
}

/** Runs `fn` in a span, recording errors without their messages. */
export async function withSpan<T>(
  spec: SpanSpec,
  attributes: Record<string, unknown>,
  fn: (span: GuardedSpan) => Promise<T>,
): Promise<T> {
  const open = openSpan(spec, attributes);
  try {
    return await open.run(() => fn(open.span));
  } catch (e) {
    open.end(e ?? new Error('thrown value'));
    throw e;
  } finally {
    open.end();
  }
}

/** True while an SDK provider is registered, i.e. while spans are recorded at all. */
export function tracingEnabled(): boolean {
  return registeredProvider() !== undefined;
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

/** What the API's proxy delegates to while no SDK is registered. */
const NO_PROVIDER = new ProxyTracerProvider().getDelegate();

/** The provider spans currently go to, or undefined when none is registered. */
function registeredProvider(): TracerProvider | undefined {
  const global = trace.getTracerProvider() as TracerProvider & {
    getDelegate?: () => TracerProvider;
  };
  const delegate = typeof global.getDelegate === 'function' ? global.getDelegate() : global;
  return delegate === NO_PROVIDER ? undefined : delegate;
}

/**
 * Fails start-up when another OpenTelemetry SDK owns the global provider, typically
 * auto-instrumentation loaded with `NODE_OPTIONS=--require/--import` (or injected by an operator).
 * Its exporter would bypass the allowlist and the export guard, and its HTTP instrumentation would
 * record full URLs and inject `traceparent` everywhere (ADR 0015 section 6.3). Our own
 * registration would silently lose against it, so the only safe answer is to refuse.
 */
function refuseForeignProvider(own?: TracerProvider): void {
  const current = registeredProvider();
  if (current === undefined || current === own) return;
  throw new OaxError(
    'config_invalid',
    'invalid configuration: another OpenTelemetry SDK is registered in this process (auto-instrumentation via NODE_OPTIONS?); it is not supported, remove it and use OTEL_EXPORTER_OTLP_ENDPOINT',
  );
}

export async function initTelemetry(
  config: OtelConfig,
  init: TelemetryInit = {},
): Promise<Telemetry> {
  refuseForeignProvider();
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
    { GuardedSpanExporter, dropCountingMeterProvider },
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
  // `selfObsMeterProvider` is an option of the underlying processor that the BufferConfig type of
  // the env shim does not declare; it carries the queue-full drops to our counter.
  const bufferConfig: BufferConfig & { selfObsMeterProvider: MeterProvider } = {
    maxQueueSize: config.maxQueue,
    maxExportBatchSize: Math.min(512, config.maxQueue),
    scheduledDelayMillis: SCHEDULE_DELAY_MS,
    // A backstop behind the exporter's own timeout and the counting wrapper's (both exportTimeoutMs).
    exportTimeoutMillis: config.exportTimeoutMs + BATCH_TIMEOUT_MARGIN_MS,
    selfObsMeterProvider: dropCountingMeterProvider(),
  };
  const batch = new BatchSpanProcessor(
    new GuardedSpanExporter(exporter, config.exportTimeoutMs),
    bufferConfig,
  );
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
    idGenerator: new RunIdGenerator(),
    spanLimits: SPAN_LIMITS,
    generalLimits: {
      attributeValueLengthLimit: SPAN_LIMITS.attributeValueLengthLimit,
      attributeCountLimit: SPAN_LIMITS.attributeCountLimit,
    },
    spanProcessors: [batch],
  });
  // No global propagator: nothing injects or extracts `traceparent`/`baggage` until a slice names
  // the place deliberately (ADR 0015 sections 2, 6.1 and 6.4).
  provider.register({ propagator: null });
  refuseForeignProvider(provider);
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
