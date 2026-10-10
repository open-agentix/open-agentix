import { createHash } from 'node:crypto';
import { TraceFlags, type Context, type MeterProvider } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import {
  BatchSpanProcessor,
  type BufferConfig,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ContextGuard, mayFlow, redactPii, type Classification } from '@openagentix/core';
import type { OutboundDispatcher } from '@openagentix/providers';
import {
  classifyExportFailure,
  dropCountingMeterProvider,
  sanitizeReadableSpan,
} from './telemetry-export.js';
import { CONTENT_MAX_BYTES } from '@openagentix/core';
import type { OtelConfig } from './telemetry-config.js';
import { onTelemetryConnectionChanged } from './telemetry-connection.js';
import { takeCapturedContent, type CapturedContent } from './telemetry-content.js';
import {
  telemetryRuntime,
  type ContentResult,
  type TenantDropReason,
} from './telemetry-runtime.js';
import { DispatcherSpanExporter } from './telemetry-transport.js';

/**
 * Tenant-owned exporters (ADR 0015 section 7.3, slice S10): the second span pipeline.
 *
 * The platform pipeline (the shared collector of the operator) is unchanged. This processor sits
 * next to it and hands a copy of the spans of ONE tenant to the exporters that tenant defined as
 * `telemetry` connections. The tenant of a span is its `oax.tenant.id`, set by the control plane
 * from the run row (never from a node); a span without a valid id goes nowhere.
 *
 * Trust boundaries (see docs/observability.md):
 * - the destination is tenant-controlled: every request goes through the outbound dispatcher with
 *   `origin: 'tenant'` (https only, public destinations by name and by every resolved address,
 *   pinned at connect time, no redirects, the operator's deny routes and the air-gapped allowlist);
 * - what leaves is rebuilt from the attribute allowlist for each exporter (same sanitiser as the
 *   platform pipeline, plus the exporter's own secret values in the guard);
 * - content is not on the span: it is parked by the model proxy (`telemetry-content.ts`) and only
 *   attached here, per exporter, when the operator allow, the tenant opt-in, the clearance and the
 *   region all hold at the moment of export;
 * - the number of exporters, the queue of each and the number of spans waiting for a lookup are
 *   bounded; a slow or hostile collector can only lose its own tenant's spans.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long the exporters of a tenant are cached in this process. */
export const TENANT_CACHE_MS = 15_000;
const FAILURE_CACHE_MS = 5_000;
/** Spans waiting for the lookup of their tenant's exporters (a burst while the source is slow). */
const MAX_PENDING = 4096;
const QUEUE_MAX = 1024;

/** A tenant-owned exporter as the source resolved it (secrets already read, checks already made). */
export interface TenantExporterSpec {
  connectionId: string;
  tenantId: string;
  url: string;
  protocol: 'http/protobuf' | 'http/json';
  headers?: Record<string, string> | undefined;
  region?: string | undefined;
  clearance: Classification;
  /** The tenant's stored opt-in to content (the operator allow is checked separately). */
  content: boolean;
}

export type TenantExporterSource = (tenantId: string) => Promise<TenantExporterSpec[]>;

const fingerprintOf = (s: TenantExporterSpec): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        s.url,
        s.protocol,
        Object.entries(s.headers ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
      ]),
    )
    .digest('hex');

/** The span with the content attributes added (the sanitised span keeps its identity and timing). */
function withAttributes(span: ReadableSpan, extra: Record<string, string | boolean>): ReadableSpan {
  return Object.create(span, {
    attributes: { value: { ...span.attributes, ...extra }, enumerable: true },
  }) as ReadableSpan;
}

class Handle {
  contentRevoked = false;
  readonly guard = new ContextGuard();
  readonly fingerprint: string;
  readonly processor: BatchSpanProcessor;

  constructor(
    public spec: TenantExporterSpec,
    private readonly router: TenantExportRouter,
    dispatcher: OutboundDispatcher,
  ) {
    this.fingerprint = fingerprintOf(spec);
    for (const v of Object.values(spec.headers ?? {})) this.guard.addSecret(v);
    const cfg = router.config;
    const exporter = new TenantSpanExporter(
      new DispatcherSpanExporter({
        dispatcher,
        url: spec.url,
        protocol: spec.protocol,
        headers: spec.headers,
        compression: 'none',
        timeoutMs: cfg.exportTimeoutMs,
        scope: { origin: 'tenant', tenantId: spec.tenantId },
      }),
      this,
      router,
    );
    const buffer: BufferConfig & { selfObsMeterProvider: MeterProvider } = {
      maxQueueSize: Math.min(cfg.maxQueue, QUEUE_MAX),
      maxExportBatchSize: Math.min(256, cfg.maxQueue),
      scheduledDelayMillis: 5000,
      exportTimeoutMillis: cfg.exportTimeoutMs + 1000,
      selfObsMeterProvider: dropCountingMeterProvider((n) =>
        telemetryRuntime().stats.tenantSpansDropped?.('queue_full', n),
      ),
    };
    this.processor = new BatchSpanProcessor(exporter, buffer);
  }
}

/** Sanitises for one exporter, attaches content when every gate holds, counts the outcome. */
class TenantSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly handle: Handle,
    private readonly router: TenantExportRouter,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const rt = telemetryRuntime();
    let safe: ReadableSpan[];
    try {
      const own = { ...rt, guard: this.handle.guard };
      safe = spans.map((s) =>
        this.router.withContent(this.handle, s, sanitizeReadableSpan(s, own)),
      );
    } catch {
      rt.stats.tenantExportFailed?.('other');
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }
    this.inner.export(safe, (result) => {
      if (result.code !== ExportResultCode.SUCCESS)
        rt.stats.tenantExportFailed?.(classifyExportFailure(result.error));
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

interface CacheEntry {
  at: number;
  ttl: number;
  handles: Handle[];
  refused: number;
}

export interface TenantExportRouterOptions {
  dispatcher: OutboundDispatcher;
  config: Pick<
    OtelConfig,
    'content' | 'tenantExportersMax' | 'exportTimeoutMs' | 'maxQueue' | 'allowedRegions'
  >;
  now?: () => number;
}

export class TenantExportRouter implements SpanProcessor {
  readonly config: TenantExportRouterOptions['config'];
  private source: TenantExporterSource | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly loading = new Map<string, Promise<CacheEntry>>();
  /** Captured content per finished span until the exporters have taken what they may. */
  private readonly captured = new WeakMap<ReadableSpan, CapturedContent>();
  private pending = 0;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: TenantExportRouterOptions) {
    this.config = opts.config;
    this.unsubscribe = onTelemetryConnectionChanged((tenantId) => this.invalidate(tenantId));
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Connects the DB-backed source (the exporters of a tenant). Spans before that are dropped. */
  attach(source: TenantExporterSource): void {
    this.source = source;
  }

  /**
   * A connection of the tenant changed: forget what is cached and withdraw content at once. The
   * exporters are re-read when the next span of the tenant ends; until then queued content spans
   * of this tenant lose their content (an opt-out stops the export immediately).
   */
  invalidate(tenantId: string): void {
    const hit = this.cache.get(tenantId);
    if (!hit) return;
    for (const h of hit.handles) h.contentRevoked = true;
    // Stale, not removed: the next lookup reconciles against the handles that exist, so none is
    // orphaned (and everything still flushes and shuts down).
    hit.at = Number.NEGATIVE_INFINITY;
  }

  onStart(_span: Span, _ctx: Context): void {
    // nothing to do at start
  }

  onEnd(span: ReadableSpan): void {
    const sc = span.spanContext();
    // Always consume parked content so it cannot linger, then bind it to this span only if it
    // belongs to the span's own tenant.
    const parked = takeCapturedContent(sc);
    if (this.closed || !this.source) return;
    const tenantId = span.attributes['oax.tenant.id'];
    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return;
    if ((sc.traceFlags & TraceFlags.SAMPLED) === 0) return;
    if (parked && parked.tenantId === tenantId) this.captured.set(span, parked);
    const hit = this.cache.get(tenantId);
    if (hit && this.now() - hit.at < hit.ttl) {
      this.deliver(hit, span, parked !== undefined);
      return;
    }
    if (this.pending >= MAX_PENDING) {
      telemetryRuntime().stats.tenantSpansDropped?.('pending_cap', 1);
      return;
    }
    this.pending++;
    void this.resolve(tenantId)
      .then((entry) => this.deliver(entry, span, parked !== undefined))
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
      });
  }

  private deliver(entry: CacheEntry, span: ReadableSpan, hadContent: boolean): void {
    const rt = telemetryRuntime();
    if (entry.refused > 0) rt.stats.tenantSpansDropped?.('no_capacity', entry.refused);
    if (entry.handles.length === 0 && hadContent)
      rt.stats.contentResult?.('dropped_no_exporter', 1);
    for (const h of entry.handles) h.processor.onEnd(span);
  }

  private resolve(tenantId: string): Promise<CacheEntry> {
    const running = this.loading.get(tenantId);
    if (running) return running;
    const source = this.source;
    const p = (async (): Promise<CacheEntry> => {
      let specs: TenantExporterSpec[];
      let ttl = TENANT_CACHE_MS;
      try {
        specs = source ? await source(tenantId) : [];
      } catch {
        // Fail closed: nothing is exported for this tenant until the source answers again.
        specs = [];
        ttl = FAILURE_CACHE_MS;
      }
      const entry = await this.reconcile(tenantId, specs);
      entry.ttl = ttl;
      this.cache.set(tenantId, entry);
      return entry;
    })().finally(() => this.loading.delete(tenantId));
    this.loading.set(tenantId, p);
    return p;
  }

  private totalHandles(): number {
    let n = 0;
    for (const e of this.cache.values()) n += e.handles.length;
    return n;
  }

  private async reconcile(tenantId: string, specs: TenantExporterSpec[]): Promise<CacheEntry> {
    const rt = telemetryRuntime();
    const old = this.cache.get(tenantId)?.handles ?? [];
    const kept: Handle[] = [];
    let refused = 0;
    const regions = this.config.allowedRegions;
    for (const spec of specs) {
      if (spec.tenantId !== tenantId) continue; // defence: never route a foreign spec
      if (regions.length > 0 && (!spec.region || !regions.includes(spec.region))) {
        refused++;
        rt.stats.tenantSpansDropped?.('region', 1);
        continue;
      }
      const existing = old.find((h) => h.spec.connectionId === spec.connectionId);
      if (existing && existing.fingerprint === fingerprintOf(spec)) {
        existing.spec = spec;
        existing.contentRevoked = false;
        kept.push(existing);
        continue;
      }
      if (this.totalHandles() - old.length + kept.length >= this.config.tenantExportersMax) {
        refused++;
        continue;
      }
      try {
        // Resolves the route now (deny route, tenant destination rules, air-gapped allowlist) so a
        // refused destination never gets a handle.
        this.opts.dispatcher.plan(spec.url, {
          purpose: 'telemetry',
          scope: { origin: 'tenant', tenantId },
        });
      } catch {
        rt.stats.tenantSpansDropped?.('denied', 1);
        rt.warn({ reason: 'tenant_exporter_denied' }, 'a tenant telemetry exporter was refused');
        continue;
      }
      kept.push(new Handle(spec, this, this.opts.dispatcher));
    }
    for (const h of old) if (!kept.includes(h)) void h.processor.shutdown().catch(() => undefined);
    return { at: this.now(), ttl: TENANT_CACHE_MS, handles: kept, refused };
  }

  /**
   * Adds the captured content to the span copy of ONE exporter when every gate holds right now:
   * the operator allow, this exporter's stored opt-in (and that the connection had opted in when
   * the content was captured), the clearance against the run's classification, and the region.
   */
  withContent(handle: Handle, original: ReadableSpan, sanitized: ReadableSpan): ReadableSpan {
    const stats = telemetryRuntime().stats;
    const c = this.captured.get(original);
    if (!c) return sanitized;
    const spec = handle.spec;
    const result = (r: ContentResult): ReadableSpan => {
      stats.contentResult?.(r, 1);
      return sanitized;
    };
    if (this.config.content !== 'redacted') return result('dropped_operator');
    if (!spec.content || handle.contentRevoked || !c.optIns.has(spec.connectionId))
      return result('dropped_opt_out');
    const regions = this.config.allowedRegions;
    if (regions.length > 0 && (!spec.region || !regions.includes(spec.region)))
      return result('dropped_region');
    if (!mayFlow(c.classification, spec.clearance)) return result('dropped_classification');
    const extra: Record<string, string | boolean> = {};
    for (const [k, v] of Object.entries(c.attributes)) {
      const safe = finalizeContent(v, handle.guard);
      if (safe !== null) extra[k] = safe;
    }
    if (Object.keys(extra).length === 0) return sanitized;
    extra['oax.content.redacted'] = true;
    if (c.truncated) extra['oax.content.truncated'] = true;
    stats.contentResult?.('attached', 1);
    return withAttributes(sanitized, extra);
  }

  /** Waits (bounded) for the spans that still wait for the lookup of their tenant's exporters. */
  private async drainPending(): Promise<void> {
    const until = this.now() + 2000;
    while (this.pending > 0 && this.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async forceFlush(): Promise<void> {
    await this.drainPending();
    const all = [...this.cache.values()].flatMap((e) => e.handles);
    await Promise.allSettled(all.map((h) => h.processor.forceFlush()));
  }

  async shutdown(): Promise<void> {
    await this.drainPending();
    this.closed = true;
    this.unsubscribe();
    const all = [...this.cache.values()].flatMap((e) => e.handles);
    await Promise.allSettled(all.map((h) => h.processor.shutdown()));
    this.cache.clear();
  }
}

/**
 * Last pass over one content attribute right before it is sent: the exporter's own secrets and the
 * guard again, the personal data redactor again, valid JSON, within the cap. A value that fails any
 * of this is dropped, never cut.
 */
export function finalizeContent(value: string, guard: ContextGuard): string | null {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > CONTENT_MAX_BYTES)
    return null;
  const out = redactPii(guard.text(value).text).text;
  if (Buffer.byteLength(out, 'utf8') > CONTENT_MAX_BYTES) return null;
  try {
    JSON.parse(out);
  } catch {
    return null;
  }
  return out;
}

export type { TenantDropReason };
