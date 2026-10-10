import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace, type Span } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { GuardedSpanExporter } from '../src/telemetry-export.js';
import { KEEP_CLASSES, type KeepClass } from '../src/telemetry-config.js';
import {
  KEEP_BUFFER_MAX_BYTES,
  OaxKeepProcessor,
  OaxRatioSampler,
  estimateSpanBytes,
  keepClassOf,
  type KeepStats,
} from '../src/telemetry-sampling.js';
import { initTelemetry, resetTelemetryRuntime, tracer, withSpan } from '../src/telemetry.js';
import { Metrics } from '../src/metrics.js';
import { configureTelemetryRuntime } from '../src/telemetry.js';

const base = { OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' };
const otel = (env: Record<string, string>) => loadConfig({ ...base, ...env }).otel;

/** Collects what reaches the export pipeline (stand-in for the batch processor). */
class Collect implements SpanProcessor {
  spans: ReadableSpan[] = [];
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    // Same rule as the batch processor: unsampled spans are not exported.
    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) return;
    this.spans.push(span);
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

function counters() {
  const kept: KeepClass[] = [];
  const evicted = { run_buffer: 0, process_cap: 0 };
  const stats: KeepStats = {
    kept: (c) => void kept.push(c),
    evicted: (r, n) => void (evicted[r] += n),
  };
  return { kept, evicted, stats };
}

function setup(opts: {
  classes?: readonly KeepClass[];
  bufferSpans?: number;
  maxBytes?: number;
  ratio?: number;
}) {
  const out = new Collect();
  const c = counters();
  const keep = new OaxKeepProcessor({
    classes: opts.classes ?? KEEP_CLASSES,
    bufferSpans: opts.bufferSpans ?? 512,
    ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
    downstream: out,
    stats: c.stats,
  });
  const provider = new NodeTracerProvider({
    sampler: new OaxRatioSampler(opts.ratio ?? 0, true),
    spanProcessors: [keep, out],
  });
  return { out, keep, provider, tr: provider.getTracer('test'), ...c };
}

type Tr = ReturnType<typeof setup>['tr'];

/** One run attempt: an `invoke_workflow` root with `children` child spans; `mark` runs on the last. */
function run(tr: Tr, children: number, mark?: (s: Span) => void): string {
  const root = tr.startSpan('invoke_workflow wf');
  const ctx = trace.setSpan(ROOT_CONTEXT, root);
  for (let i = 0; i < children; i++) {
    const s = tr.startSpan(`execute_tool t${i}`, { attributes: { 'oax.run.id': 'r', i } }, ctx);
    if (i === children - 1) mark?.(s);
    s.end();
  }
  root.end();
  return root.spanContext().traceId;
}

describe('OaxRatioSampler', () => {
  const sample = (s: OaxRatioSampler, traceId: string, ctx = ROOT_CONTEXT) =>
    s.shouldSample(ctx, traceId).decision;
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => (i * 2654435761).toString(16).padStart(32, '0'));

  it('ratio 1 samples everything', () => {
    const s = new OaxRatioSampler(1, true);
    for (const id of ids(50)) expect(sample(s, id)).toBe(2);
  });

  it('decides by trace id only: identical in every process, parent flags are ignored', () => {
    const a = new OaxRatioSampler(0.3, true);
    const b = new OaxRatioSampler(0.3, false);
    const unsampledParent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '1'.repeat(32),
      spanId: '2'.repeat(16),
      traceFlags: TraceFlags.NONE,
      isRemote: true,
    });
    const sampledParent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '1'.repeat(32),
      spanId: '2'.repeat(16),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    for (const id of ids(200)) {
      const x = sample(a, id) === 2;
      expect(sample(b, id) === 2).toBe(x);
      expect(sample(a, id, unsampledParent) === 2).toBe(x);
      expect(sample(a, id, sampledParent) === 2).toBe(x);
    }
  });

  it('keeps about the configured share of random trace ids', () => {
    const s = new OaxRatioSampler(0.25, true);
    let hit = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const id = [...Array(4)]
        .map(() =>
          Math.floor(Math.random() * 2 ** 32)
            .toString(16)
            .padStart(8, '0'),
        )
        .join('');
      if (sample(s, id) === 2) hit++;
    }
    expect(hit / n).toBeGreaterThan(0.22);
    expect(hit / n).toBeLessThan(0.28);
  });

  it('records unsampled spans only when a keep list needs them', () => {
    const id = 'f'.repeat(32);
    expect(sample(new OaxRatioSampler(0, true), id)).toBe(1); // RECORD
    expect(sample(new OaxRatioSampler(0, false), id)).toBe(0); // NOT_RECORD
  });
});

describe('OaxKeepProcessor: keep classes', () => {
  const cases: [KeepClass, (s: Span) => void][] = [
    ['error', (s) => s.setStatus({ code: SpanStatusCode.ERROR, message: 'provider_failed' })],
    ['deny', (s) => s.setAttribute('oax.policy.effect', 'deny')],
    ['approval', (s) => s.setAttribute('oax.approval.outcome', 'rejected')],
    ['budget', (s) => void s.addEvent('oax.budget.breach', { 'oax.budget.scopes': ['tenant'] })],
    ['guard', (s) => void s.addEvent('oax.guard.report', { 'oax.guard.secrets': 1 })],
  ];

  it.each(cases)('exports the whole trace of a %s run', (cls, mark) => {
    const t = setup({});
    const traceId = run(t.tr, 3, mark);
    // The children ended before the root; the whole attempt is released, in end order.
    expect(t.out.spans.map((s) => s.name)).toEqual([
      'execute_tool t0',
      'execute_tool t1',
      'execute_tool t2',
      'invoke_workflow wf',
    ]);
    for (const s of t.out.spans) {
      expect(s.spanContext().traceId).toBe(traceId);
      expect(s.spanContext().traceFlags & TraceFlags.SAMPLED).toBe(TraceFlags.SAMPLED);
    }
    expect(t.kept).toEqual([cls]);
  });

  it('exports spans of a kept trace that end later', () => {
    const t = setup({});
    const root = t.tr.startSpan('invoke_workflow wf');
    const ctx = trace.setSpan(ROOT_CONTEXT, root);
    const a = t.tr.startSpan('execute_tool a', {}, ctx);
    const b = t.tr.startSpan('execute_tool b', {}, ctx);
    a.setStatus({ code: SpanStatusCode.ERROR });
    a.end();
    b.end(); // ends after the decision
    root.end();
    expect(t.out.spans.map((s) => s.name).sort()).toEqual([
      'execute_tool a',
      'execute_tool b',
      'invoke_workflow wf',
    ]);
  });

  it('does not export a run that matches no class', () => {
    const t = setup({});
    run(t.tr, 5);
    run(t.tr, 5, (s) => s.setAttribute('oax.policy.effect', 'allow'));
    run(t.tr, 5, (s) => s.setAttribute('oax.approval.outcome', 'approved'));
    run(t.tr, 5, (s) => void s.addEvent('oax.control.decision', {}));
    expect(t.out.spans).toEqual([]);
    expect(t.kept).toEqual([]);
    // Finished runs leave nothing behind.
    expect(t.keep.usage()).toEqual({ traces: 0, bytes: 0 });
  });

  it('only the configured classes keep a run', () => {
    const t = setup({ classes: ['error'] });
    run(t.tr, 2, (s) => s.setAttribute('oax.policy.effect', 'deny'));
    expect(t.out.spans).toEqual([]);
    run(t.tr, 2, (s) => s.setStatus({ code: SpanStatusCode.ERROR }));
    expect(t.out.spans).toHaveLength(3);
  });

  it('never touches spans of sampled traces (ratio decision is final)', () => {
    const t = setup({ ratio: 1 });
    run(t.tr, 2, (s) => s.setStatus({ code: SpanStatusCode.ERROR }));
    expect(t.out.spans).toHaveLength(3); // exported once each, by the normal path
    expect(t.kept).toEqual([]);
    expect(t.keep.usage().traces).toBe(0);
  });

  it('classifies by fixed values only', () => {
    const all = new Set<KeepClass>(KEEP_CLASSES);
    const t = setup({});
    const s = t.tr.startSpan('x');
    s.setAttribute('oax.policy.effect', 'allow');
    s.setAttribute('oax.approval.outcome', 'approved');
    s.end();
    expect(keepClassOf(s as unknown as ReadableSpan, all)).toBeUndefined();
  });
});

describe('OaxKeepProcessor: bounds', () => {
  it('per-run buffer: spans beyond the limit are dropped and counted', () => {
    const t = setup({ bufferSpans: 4 });
    // 10 children + the root ending: the root closes the buffer, nothing is kept.
    run(t.tr, 10);
    expect(t.evicted.run_buffer).toBe(6);
    expect(t.out.spans).toEqual([]);
    expect(t.keep.usage()).toEqual({ traces: 0, bytes: 0 });
  });

  it('a match after the buffer filled still exports the buffered part and the matching span', () => {
    const t = setup({ bufferSpans: 2 });
    run(t.tr, 5, (s) => s.setStatus({ code: SpanStatusCode.ERROR }));
    // t0, t1 buffered; t2, t3 dropped (counted); t4 matches -> 2 buffered + t4 + root.
    expect(t.evicted.run_buffer).toBe(2);
    expect(t.out.spans.map((s) => s.name)).toEqual([
      'execute_tool t0',
      'execute_tool t1',
      'execute_tool t4',
      'invoke_workflow wf',
    ]);
  });

  it('process cap: oldest unfinished traces are evicted and counted, bytes stay under the cap', () => {
    const cap = 64 * 1024;
    const t = setup({ maxBytes: cap });
    // Runs that never finish (no root end), so their buffers stay until evicted.
    for (let r = 0; r < 500; r++) {
      const root = t.tr.startSpan('invoke_workflow wf');
      const ctx = trace.setSpan(ROOT_CONTEXT, root);
      for (let i = 0; i < 4; i++) t.tr.startSpan(`execute_tool t${i}`, {}, ctx).end();
      expect(t.keep.usage().bytes).toBeLessThanOrEqual(cap);
    }
    expect(t.evicted.process_cap).toBeGreaterThan(0);
    expect(t.out.spans).toEqual([]);
    expect(t.keep.usage().traces).toBeLessThan(500);
  });

  it('10 000 runs: estimated bytes never exceed the 4 MiB cap, kept markers are bounded too', () => {
    const t = setup({});
    let peak = 0;
    for (let r = 0; r < 10_000; r++) {
      const root = t.tr.startSpan('invoke_workflow wf');
      const ctx = trace.setSpan(ROOT_CONTEXT, root);
      const n = 2 + (r % 7);
      for (let i = 0; i < n; i++) {
        const s = t.tr.startSpan(
          `execute_tool t${i}`,
          { attributes: { 'oax.run.id': `r${r}` } },
          ctx,
        );
        // Every 7th run is kept (leaves a marker); every 3rd never ends its root (stays buffered).
        if (r % 7 === 0 && i === n - 1) s.setStatus({ code: SpanStatusCode.ERROR });
        s.end();
      }
      if (r % 3 !== 0) root.end();
      peak = Math.max(peak, t.keep.usage().bytes);
    }
    console.log(
      `keep peak ${peak} bytes, ${t.kept.length} kept, evicted ${JSON.stringify(t.evicted)}`,
    );
    expect(peak).toBeLessThanOrEqual(KEEP_BUFFER_MAX_BYTES);
    expect(t.kept.length).toBeGreaterThan(1000);
    expect(t.evicted.process_cap).toBeGreaterThan(0);
  });

  it('real heap stays within a small multiple of the cap under 10 000 stuck runs', () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const t = setup({});
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let r = 0; r < 10_000; r++) {
      const root = t.tr.startSpan('invoke_workflow wf');
      const ctx = trace.setSpan(ROOT_CONTEXT, root);
      for (let i = 0; i < 4; i++)
        t.tr
          .startSpan(
            `execute_tool t${i}`,
            { attributes: { 'oax.run.id': `run-${r}`, 'gen_ai.tool.name': 'search' } },
            ctx,
          )
          .end();
    }
    gc();
    const grown = process.memoryUsage().heapUsed - before;
    // The estimate does not count the SDK's own objects (measured: about 1.4x); allow 2x slack. Without bounds this loop would retain 40 000 spans (tens of MiB).
    console.log(`heap grown ${grown} bytes, estimate ${t.keep.usage().bytes}`);
    expect(t.keep.usage().bytes).toBeLessThanOrEqual(KEEP_BUFFER_MAX_BYTES);
    expect(grown).toBeLessThan(2 * KEEP_BUFFER_MAX_BYTES);
  });

  it('estimate is linear in size and larger for larger spans', () => {
    const t = setup({});
    const small = t.tr.startSpan('a');
    small.end();
    const big = t.tr.startSpan('a', { attributes: { k: 'x'.repeat(1000) } });
    big.end();
    expect(estimateSpanBytes(big as unknown as ReadableSpan)).toBeGreaterThan(
      estimateSpanBytes(small as unknown as ReadableSpan) + 1000,
    );
  });

  it('micro-benchmark: a buffered, non-matching span costs well under 30 microseconds', () => {
    const t = setup({});
    const spans: ReadableSpan[] = [];
    const root = t.tr.startSpan('invoke_workflow wf');
    const ctx = trace.setSpan(ROOT_CONTEXT, root);
    for (let i = 0; i < 2000; i++) {
      const s = t.tr.startSpan('execute_tool t', { attributes: { 'oax.run.id': 'r', i } }, ctx);
      s.end();
      spans.push(s as unknown as ReadableSpan);
    }
    root.end();
    const fresh = new OaxKeepProcessor({
      classes: KEEP_CLASSES,
      bufferSpans: 100_000,
      downstream: new Collect(),
    });
    // Warm up, then time the processor alone (span creation is not part of the budget).
    for (const s of spans.slice(0, 200)) fresh.onEnd(s);
    const durations: number[] = [];
    for (let rep = 0; rep < 20; rep++) {
      const f = new OaxKeepProcessor({
        classes: KEEP_CLASSES,
        bufferSpans: 100_000,
        downstream: new Collect(),
      });
      const start = process.hrtime.bigint();
      for (const s of spans) f.onEnd(s);
      durations.push(Number(process.hrtime.bigint() - start) / 1000 / spans.length);
    }
    durations.sort((a, b) => a - b);
    const median = durations[10]!;
    // The ADR budget for creating and sanitising a span is 30 us; the keep path must be a small part.
    console.log(`keep onEnd median ${median.toFixed(2)} us per span`);
    expect(median).toBeLessThan(30);
  });
});

describe('wiring through initTelemetry', () => {
  let server: Server;
  let url: string;
  const bodies: string[] = [];

  beforeEach(async () => {
    bodies.length = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString());
        res.statusCode = 200;
        res.end('');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resetTelemetryRuntime();
  });
  afterEach(async () => {
    trace.disable();
    resetTelemetryRuntime();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const cfg = (env: Record<string, string>) =>
    otel({ OTEL_EXPORTER_OTLP_ENDPOINT: url, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', ...env });

  async function twoRuns(env: Record<string, string>) {
    const metrics = new Metrics();
    const t = await initTelemetry(cfg(env));
    t.attachStats(metrics.otel);
    await withSpan(
      { name: 'invoke_workflow wf', kind: 'run' },
      { 'oax.run.id': 'ok-run' },
      async () => withSpan({ name: 'execute_tool a', kind: 'execute_tool' }, {}, async () => 1),
    );
    await withSpan(
      { name: 'invoke_workflow wf', kind: 'run' },
      { 'oax.run.id': 'bad-run' },
      async () => {
        await withSpan({ name: 'execute_tool b', kind: 'execute_tool' }, {}, async () => 1);
        await withSpan({ name: 'execute_tool c', kind: 'execute_tool' }, {}, async () => {
          throw new Error('boom-message-never-exported');
        });
      },
    ).catch(() => undefined);
    await t.shutdown();
    return { wire: bodies.join(''), metrics };
  }

  it('ratio 1 and no keep list behaves as before: everything is exported', async () => {
    const { wire } = await twoRuns({ OAX_OTEL_KEEP: '' });
    expect(wire).toContain('execute_tool a');
    expect(wire).toContain('execute_tool b');
    expect(wire).toContain('execute_tool c');
  });

  it('ratio 0 without a keep list exports nothing and records nothing', async () => {
    const { wire } = await twoRuns({ OAX_OTEL_SAMPLE_RATIO: '0', OAX_OTEL_KEEP: '' });
    expect(wire).toBe('');
  });

  it('ratio 0 with the default keep list exports only the failed run, through the allowlist', async () => {
    const { wire, metrics } = await twoRuns({ OAX_OTEL_SAMPLE_RATIO: '0' });
    expect(wire).toContain('execute_tool c');
    expect(wire).toContain('execute_tool b'); // buffered sibling of the failure
    expect(wire).not.toContain('execute_tool a');
    expect(wire).not.toContain('ok-run');
    expect(wire).not.toContain('boom-message-never-exported');
    const text = await metrics.registry.metrics();
    expect(text).toContain('oax_otel_keep_kept_total{class="error"} 1');
  });

  it('a kept span exports exactly what a sampled span would (allowlist and guard unchanged)', async () => {
    const attrs = {
      'oax.run.id': 'same-run',
      'not.allowed': 'LEAK-1',
      'gen_ai.prompt': 'LEAK-2',
    };
    const exportOne = async (env: Record<string, string>) => {
      bodies.length = 0;
      const t = await initTelemetry(cfg(env));
      const span = tracer().startSpan('execute_tool x', { attributes: attrs });
      span.setAttribute('oax.policy.effect', 'deny');
      span.recordException(new Error('LEAK-3'));
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'LEAK-4 free text' });
      span.end();
      await t.shutdown();
      trace.disable();
      const body = JSON.parse(bodies.join('')) as {
        resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
      };
      const s = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
      return { s, wire: bodies.join('') };
    };
    const sampled = await exportOne({});
    const kept = await exportOne({ OAX_OTEL_SAMPLE_RATIO: '0' });
    for (const r of [sampled, kept]) {
      expect(r.wire).not.toMatch(/LEAK-/);
    }
    const strip = (s: Record<string, unknown>) => ({
      name: s.name,
      attributes: s.attributes,
      events: ((s.events as { name: string; attributes?: unknown }[]) ?? []).map((e) => ({
        name: e.name,
        attributes: e.attributes,
      })),
      status: s.status,
    });
    expect(strip(kept.s)).toEqual(strip(sampled.s));
  });
});

describe('guarded exporter sees released spans as sampled', () => {
  it('sanitised copies of released spans keep the sampled flag', () => {
    const mem = new InMemorySpanExporter();
    const keepOut = new SimpleSpanProcessor(new GuardedSpanExporter(mem, 1000));
    const keep = new OaxKeepProcessor({
      classes: KEEP_CLASSES,
      bufferSpans: 8,
      downstream: keepOut,
    });
    const provider = new NodeTracerProvider({
      sampler: new OaxRatioSampler(0, true),
      spanProcessors: [keep, keepOut],
    });
    const tr = provider.getTracer('t');
    const s = tr.startSpan('execute_tool x');
    s.setStatus({ code: SpanStatusCode.ERROR });
    s.end();
    const exported = mem.getFinishedSpans();
    expect(exported).toHaveLength(1);
    expect(exported[0]!.spanContext().traceFlags & TraceFlags.SAMPLED).toBe(1);
  });
});
void configureTelemetryRuntime;
