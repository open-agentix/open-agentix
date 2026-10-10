import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { Context, SpanContext } from '@opentelemetry/api';
import type {
  BatchSpanProcessor,
  ReadableSpan,
  Span,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ERROR_CODE_PATTERN, sanitizeAttributes, spanKindFromName } from '@openagentix/core';
import {
  recordSanitized,
  sanitizeSpanName,
  telemetryRuntime,
  type ExportFailureReason,
  type TelemetryRuntime,
} from './telemetry-runtime.js';

/**
 * Last line of defence at the export boundary. Code is supposed to create spans through
 * `withSpan`, but a raw `tracer().startSpan` (or a library) must not be able to put an unknown
 * attribute, an exception message or a stack on the wire either: every span is rebuilt from the
 * allowlist right before it is handed to the exporter.
 */

const MAX_EVENTS = 128;
const EVENT_NAME = /^[a-z][a-z0-9_.]{0,63}$/;
/** Longest status description that can still be an error code; longer ones are never guarded. */
const MAX_STATUS_MESSAGE = 64;

function sanitizeStatus(
  status: ReadableSpan['status'],
  rt: TelemetryRuntime,
): ReadableSpan['status'] {
  if (status.message === undefined) return status;
  // The description is the error code (3.5); anything that is not shaped like one is removed.
  // Checked before the guard runs, so a raw span's megabyte-long description costs nothing.
  if (typeof status.message !== 'string' || status.message.length > MAX_STATUS_MESSAGE)
    return { code: status.code };
  const guarded = rt.guard.text(status.message).text;
  return ERROR_CODE_PATTERN.test(guarded) && guarded.length <= 64
    ? { ...status, message: guarded }
    : { code: status.code };
}

/**
 * The ids and flags of a context without its `tracestate`: vendor entries come from whoever sent
 * the context (an inbound `traceparent`/`tracestate`, a node) and are free text, so they are never
 * exported.
 */
function withoutTraceState(c: SpanContext): SpanContext {
  return {
    traceId: c.traceId,
    spanId: c.spanId,
    traceFlags: c.traceFlags,
    ...(c.isRemote === undefined ? {} : { isRemote: c.isRemote }),
  };
}

/** A span with the same identity and timing but only allowlisted attributes, events and status. */
export function sanitizeReadableSpan(span: ReadableSpan, rt: TelemetryRuntime): ReadableSpan {
  const kind = spanKindFromName(span.name);
  const options = { allowExceptionMessage: rt.exceptionDetail === 'guarded' };
  const attrs = sanitizeAttributes(kind, span.attributes, rt.guard, options);
  recordSanitized(attrs, rt.stats);
  const events = span.events
    .filter((e) => EVENT_NAME.test(e.name))
    .slice(0, MAX_EVENTS)
    .map((e) => {
      const r = sanitizeAttributes(kind, e.attributes ?? {}, rt.guard, options);
      recordSanitized(r, rt.stats);
      return { name: e.name, time: e.time, attributes: r.attributes };
    });
  const dropped = span.events.length - events.length;
  if (dropped > 0) rt.stats.attributesDropped('overflow', dropped);
  // Link attributes are not part of the allowlist: a link keeps its ids and flags only.
  const links = span.links.map((l) => ({ context: withoutTraceState(l.context), attributes: {} }));
  const context = withoutTraceState(span.spanContext());
  const name = sanitizeSpanName(span.name, rt.guard);
  const attributes = name.redacted
    ? { ...attrs.attributes, 'oax.redacted': true }
    : attrs.attributes;
  return Object.create(span, {
    name: { value: name.name, enumerable: true },
    attributes: { value: attributes, enumerable: true },
    events: { value: events, enumerable: true },
    links: { value: links, enumerable: true },
    status: { value: sanitizeStatus(span.status, rt), enumerable: true },
    spanContext: { value: () => context },
  }) as ReadableSpan;
}

const SYSTEM_NETWORK_CODES = /^(?:E[A-Z]+|UND_ERR_.*)$/;

/** Maps an exporter failure to a closed reason. Only the code and name are read, never the message. */
export function classifyExportFailure(error: unknown): ExportFailureReason {
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'AbortError' || code === 'ETIMEDOUT' || code === 'ECONNABORTED') return 'timeout';
  if (typeof code === 'number' || name === 'OTLPExporterError') return 'http';
  if (typeof code === 'string' && SYSTEM_NETWORK_CODES.test(code)) return 'network';
  return 'other';
}

/** Wraps an exporter: sanitises every span, bounds the wait, counts and rate-limits failures. */
export class GuardedSpanExporter implements SpanExporter {
  private lastWarn = 0;

  constructor(
    private readonly inner: SpanExporter,
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const rt = telemetryRuntime();
    let safe: ReadableSpan[];
    try {
      safe = spans.map((s) => sanitizeReadableSpan(s, rt));
    } catch {
      // Cannot sanitise: export nothing rather than something unchecked.
      this.fail('other', rt);
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.fail('timeout', rt);
    }, this.timeoutMs);
    timer.unref();
    this.inner.export(safe, (result) => {
      clearTimeout(timer);
      if (!settled && result.code !== ExportResultCode.SUCCESS)
        this.fail(classifyExportFailure(result.error), rt);
      settled = true;
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }

  private fail(reason: ExportFailureReason, rt: TelemetryRuntime): void {
    rt.stats.exportFailed(reason);
    const t = this.now();
    if (t - this.lastWarn < 60_000) return;
    this.lastWarn = t;
    rt.warn({ reason }, 'OpenTelemetry export failed (spans are dropped, runs are not affected)');
  }
}

/**
 * Counts the spans a full export queue drops. The batch processor drops silently; the queue
 * length is read from its buffer (a private field of the pinned SDK, covered by a test that fails
 * when the field disappears, in which case drops are no longer counted but nothing else changes).
 */
export class DropCountingProcessor implements SpanProcessor {
  constructor(
    private readonly inner: BatchSpanProcessor,
    private readonly maxQueue: number,
  ) {}

  private queued(): number {
    const buffer = (this.inner as unknown as { _finishedSpans?: unknown })._finishedSpans;
    return Array.isArray(buffer) ? buffer.length : 0;
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (this.queued() >= this.maxQueue) telemetryRuntime().stats.spansDropped(1);
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
