import {
  SpanStatusCode,
  TraceFlags,
  type Attributes,
  type AttributeValue,
  type Context,
  type SpanContext,
} from '@opentelemetry/api';
import {
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type Sampler,
  type SamplingResult,
  type Span,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { KeepClass } from './telemetry-config.js';
import { telemetryRuntime } from './telemetry-runtime.js';

/**
 * Sampling (ADR 0015 section 9, slice S6).
 *
 * - {@link OaxRatioSampler} decides by the run's trace id alone (never by the parent), so the api
 *   and the worker, which see the same stored trace id, make the same decision without talking to
 *   each other. A span that is not sampled is still *recorded* when an always-keep class is
 *   configured, so {@link OaxKeepProcessor} can look at it; it just does not carry the sampled flag
 *   and the batch processor skips it.
 * - {@link OaxKeepProcessor} holds the finished spans of a not-sampled trace in a small bounded
 *   buffer. When a span of that trace turns out to belong to a keep class (error, deny, approval,
 *   budget, guard) the buffer is handed to the export pipeline. It only decides *whether* spans go
 *   to the exporter: it never edits a span, and everything it releases passes the same sanitising
 *   exporter as every other span (the allowlist and the guard run at the export boundary).
 */

const RECORD_ONLY: SamplingResult = { decision: SamplingDecision.RECORD };
const SAMPLED: SamplingResult = { decision: SamplingDecision.RECORD_AND_SAMPLED };
const DROPPED: SamplingResult = { decision: SamplingDecision.NOT_RECORD };

/**
 * Ratio sampler on the trace id. `recordUnsampled` keeps not-sampled spans alive for the keep
 * processor; without a keep list they are not recorded at all (no cost).
 */
export class OaxRatioSampler implements Sampler {
  private readonly inner: TraceIdRatioBasedSampler;

  constructor(
    private readonly ratio: number,
    private readonly recordUnsampled: boolean,
  ) {
    this.inner = new TraceIdRatioBasedSampler(ratio);
  }

  shouldSample(_context: Context, traceId: string): SamplingResult {
    // The parent is ignored on purpose: stored remote contexts are always flagged as sampled, and a
    // per-process parent decision would split a run across processes.
    if (this.ratio >= 1) return SAMPLED;
    if (this.inner.shouldSample(_context, traceId).decision === SamplingDecision.RECORD_AND_SAMPLED)
      return SAMPLED;
    return this.recordUnsampled ? RECORD_ONLY : DROPPED;
  }

  toString(): string {
    return `OaxRatioSampler{${this.ratio}}`;
  }
}

/** Why spans left the keep buffer without being exported (a closed set, also a metric label). */
export type KeepEvictionReason = 'run_buffer' | 'process_cap';

/** What the keep processor reports; wired to `TelemetryStats` by the provider setup. */
export interface KeepStats {
  /** A trace was released to the exporter because of `keepClass`. */
  kept(keepClass: KeepClass): void;
  /** `n` finished spans were discarded unexported because a bound was hit. */
  evicted(reason: KeepEvictionReason, n: number): void;
}

export interface KeepOptions {
  classes: readonly KeepClass[];
  /** Spans buffered per trace; further spans of the same trace are dropped and counted. */
  bufferSpans: number;
  /** Upper bound of the estimated bytes held by the whole process (default 4 MiB). */
  maxBytes?: number;
  /** Where kept spans go (the batch processor of the export pipeline). */
  downstream: SpanProcessor;
  stats?: KeepStats;
}

export const KEEP_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

/** Fixed cost of a span object plus its context, name and timing fields. */
const SPAN_BASE_BYTES = 512;
const ATTRIBUTE_BASE_BYTES = 64;
const EVENT_BASE_BYTES = 96;
const LINK_BYTES = 160;
/** What a released trace leaves behind: only the fact that it was kept. */
const MARKER_BYTES = 128;
/** JavaScript strings are UTF-16: two bytes per code unit. The SDK's own objects add about 40 % (measured). */
const CHAR_BYTES = 2;

function valueBytes(v: AttributeValue | undefined): number {
  if (typeof v === 'string') return v.length * CHAR_BYTES;
  if (Array.isArray(v)) {
    let n = 16;
    for (const item of v) n += typeof item === 'string' ? item.length * CHAR_BYTES + 8 : 8;
    return n;
  }
  return 8;
}

function attributesBytes(attributes: Attributes | undefined): number {
  if (!attributes) return 0;
  let n = 0;
  for (const key in attributes)
    n += ATTRIBUTE_BASE_BYTES + key.length * CHAR_BYTES + valueBytes(attributes[key]);
  return n;
}

/** Estimated retained size of a finished span. Linear in what the span holds, so cheap. */
export function estimateSpanBytes(span: ReadableSpan): number {
  let n = SPAN_BASE_BYTES + span.name.length * CHAR_BYTES + attributesBytes(span.attributes);
  for (const e of span.events)
    n += EVENT_BASE_BYTES + e.name.length * CHAR_BYTES + attributesBytes(e.attributes);
  n += span.links.length * LINK_BYTES;
  return n;
}

const GUARD_EVENTS: ReadonlySet<string> = new Set(['oax.guard.report', 'oax.node.guard']);

/**
 * The keep class of a finished span, or undefined. Only fixed strings are compared: nothing of the
 * span is copied, logged or exported by this function. A guard report event is only emitted when
 * the report is non-empty, so its presence is the condition.
 */
export function keepClassOf(
  span: ReadableSpan,
  enabled: ReadonlySet<KeepClass>,
): KeepClass | undefined {
  if (enabled.has('error') && span.status.code === SpanStatusCode.ERROR) return 'error';
  const a = span.attributes;
  if (enabled.has('deny') && a['oax.policy.effect'] === 'deny') return 'deny';
  if (enabled.has('approval')) {
    const outcome = a['oax.approval.outcome'];
    if (outcome !== undefined && outcome !== 'approved') return 'approval';
  }
  for (const e of span.events) {
    if (enabled.has('budget') && e.name === 'oax.budget.breach') return 'budget';
    if (enabled.has('guard') && GUARD_EVENTS.has(e.name)) return 'guard';
  }
  return undefined;
}

interface TraceBuffer {
  /** Finished spans waiting for a decision; empty once the trace was kept. */
  spans: ReadableSpan[];
  bytes: number;
  kept: boolean;
}

/** The span as the export pipeline must see it: same data, sampled flag set. */
function asSampled(span: ReadableSpan): ReadableSpan {
  const ctx = span.spanContext();
  const sampled: SpanContext = { ...ctx, traceFlags: ctx.traceFlags | TraceFlags.SAMPLED };
  return Object.create(span, { spanContext: { value: () => sampled } }) as ReadableSpan;
}

/**
 * Always-keep processor. One bounded buffer per trace id of the *local process* (a run's attempt
 * on the worker, a session on the api), oldest trace evicted first when the process-wide estimate
 * exceeds the cap. Memory therefore does not grow with the number of runs or tenants.
 */
export class OaxKeepProcessor implements SpanProcessor {
  private readonly enabled: ReadonlySet<KeepClass>;
  private readonly maxBytes: number;
  /** Insertion order is eviction order (Map keeps it). */
  private readonly traces = new Map<string, TraceBuffer>();
  private totalBytes = 0;

  constructor(private readonly options: KeepOptions) {
    this.enabled = new Set(options.classes);
    this.maxBytes = options.maxBytes ?? KEEP_BUFFER_MAX_BYTES;
  }

  /** Test and diagnostics view: tracked traces and the estimated bytes held. */
  usage(): { traces: number; bytes: number } {
    return { traces: this.traces.size, bytes: this.totalBytes };
  }

  onStart(_span: Span, _context: Context): void {
    // Nothing is known before a span ends.
  }

  onEnd(span: ReadableSpan): void {
    try {
      // Sampled spans already take the normal path; the ratio decision is final for them.
      if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0) return;
      this.handle(span);
    } catch {
      // Sampling must never break a run or a span end.
    }
  }

  private handle(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    let buf = this.traces.get(traceId);
    if (buf?.kept) {
      this.options.downstream.onEnd(asSampled(span));
      return;
    }
    const keepClass = keepClassOf(span, this.enabled);
    if (keepClass) {
      if (buf) this.release(traceId, buf);
      this.options.downstream.onEnd(asSampled(span));
      this.mark(traceId);
      this.options.stats?.kept(keepClass);
      return;
    }
    if (isTraceEnd(span)) {
      // The local root ended without anything worth keeping: the buffer is no longer needed.
      if (buf) this.drop(traceId, buf);
      return;
    }
    if (!buf) {
      buf = { spans: [], bytes: 0, kept: false };
      this.traces.set(traceId, buf);
    }
    if (buf.spans.length >= this.options.bufferSpans) {
      this.options.stats?.evicted('run_buffer', 1);
      return;
    }
    const size = estimateSpanBytes(span);
    buf.spans.push(span);
    buf.bytes += size;
    this.totalBytes += size;
    this.enforceCap(traceId);
  }

  /** Releases the buffered spans of a trace that was just recognised as worth keeping. */
  private release(traceId: string, buf: TraceBuffer): void {
    for (const s of buf.spans) this.options.downstream.onEnd(asSampled(s));
    this.totalBytes -= buf.bytes;
    this.traces.delete(traceId);
  }

  /** Remembers that a trace was kept, so its later spans are exported as they end. */
  private mark(traceId: string): void {
    this.traces.set(traceId, { spans: [], bytes: MARKER_BYTES, kept: true });
    this.totalBytes += MARKER_BYTES;
    this.enforceCap(traceId);
  }

  private drop(traceId: string, buf: TraceBuffer): void {
    this.totalBytes -= buf.bytes;
    this.traces.delete(traceId);
  }

  /** Evicts the oldest traces (never `keepId`, the one just written) until under the cap. */
  private enforceCap(keepId: string): void {
    if (this.totalBytes <= this.maxBytes) return;
    let evictedSpans = 0;
    for (const [id, buf] of this.traces) {
      if (this.totalBytes <= this.maxBytes) break;
      if (id === keepId) continue;
      evictedSpans += buf.spans.length;
      this.drop(id, buf);
    }
    // A single trace larger than the cap (only possible with an extreme buffer setting) is trimmed.
    const own = this.traces.get(keepId);
    while (own && this.totalBytes > this.maxBytes && own.spans.length > 0) {
      const s = own.spans.shift()!;
      const size = estimateSpanBytes(s);
      own.bytes -= size;
      this.totalBytes -= size;
      evictedSpans += 1;
    }
    if (evictedSpans > 0) this.options.stats?.evicted('process_cap', evictedSpans);
  }

  async forceFlush(): Promise<void> {
    // Buffered spans are undecided: a flush does not export them.
  }

  async shutdown(): Promise<void> {
    this.traces.clear();
    this.totalBytes = 0;
  }
}

/** A span that ends its trace locally: a true root or the attempt span of a run. */
function isTraceEnd(span: ReadableSpan): boolean {
  return span.parentSpanContext === undefined || span.name.startsWith('invoke_workflow');
}

/** Counters of the keep processor on the pipeline's stats sink (never throws, closed labels). */
export function keepStatsFromRuntime(): KeepStats {
  return {
    kept: (c) => telemetryRuntime().stats.keepKept(c),
    evicted: (r, n) => telemetryRuntime().stats.keepEvicted(r, n),
  };
}
