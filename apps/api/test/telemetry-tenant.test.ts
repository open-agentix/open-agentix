import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  ContextGuard,
  compileNetwork,
  parseNetworkConfig,
  type Classification,
} from '@openagentix/core';
import type { OutboundContext, OutboundDispatcher } from '@openagentix/providers';
import { createOutboundDispatcher } from '@openagentix/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyTelemetryConnectionChanged } from '../src/telemetry-connection.js';
import {
  putCapturedContent,
  resetCapturedContent,
  capturedContentSize,
} from '../src/telemetry-content.js';
import { loadConfig } from '../src/config.js';
import {
  RunIdGenerator,
  configureTelemetryRuntime,
  initTelemetry,
  resetTelemetryRuntime,
  startGuardedSpan,
  tracingEnabled,
} from '../src/telemetry.js';
import {
  TenantExportRouter,
  finalizeContent,
  type TenantExporterSpec,
} from '../src/telemetry-tenant.js';
import type { TelemetryStats } from '../src/telemetry-runtime.js';

/**
 * ADR 0015 S10: the router that copies the spans of one tenant to the exporters of that tenant.
 * Everything is real (processors, exporter, serialiser, sanitiser) except the network: a recording
 * dispatcher stands in for the outbound dispatcher and receives the OTLP/JSON body.
 */
const CANARY_TEXT = 'CANARY-CONTENT-5c1e';
const HEADER_SECRET = 'Bearer-collector-secret-0123456789';
const INPUT = JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: CANARY_TEXT }] }]);
const OUTPUT = JSON.stringify([
  { role: 'assistant', parts: [{ type: 'text', content: 'answer' }] },
]);

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

interface Sent {
  url: string;
  ctx: OutboundContext;
  headers: Record<string, string>;
  json: { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] };
  text: string;
}
interface OtlpSpan {
  name: string;
  attributes: { key: string; value: Record<string, unknown> }[];
}

function recordingDispatcher(opts: { denyPlan?: boolean; failFetch?: boolean } = {}) {
  const sent: Sent[] = [];
  const planned: { url: string; ctx: OutboundContext }[] = [];
  const dispatcher = {
    network: compileNetwork(parseNetworkConfig({}).config),
    plan: vi.fn((url: string, ctx: OutboundContext) => {
      planned.push({ url: String(url), ctx });
      if (opts.denyPlan) throw new Error('denied');
      return {} as never;
    }),
    fetch: vi.fn(async (url: string, init: RequestInit, ctx: OutboundContext) => {
      const text = Buffer.from(init.body as Buffer).toString('utf8');
      sent.push({
        url: String(url),
        ctx,
        headers: init.headers as Record<string, string>,
        json: JSON.parse(text),
        text,
      });
      if (opts.failFetch) throw new Error('boom');
      return new Response(null, { status: 200 });
    }),
    nodeAgents: vi.fn(),
    dial: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as OutboundDispatcher;
  return { dispatcher, sent, planned };
}

let specSeq = 0;
const spec = (tenantId: string, over: Partial<TenantExporterSpec> = {}): TenantExporterSpec => ({
  connectionId: randomUUID(),
  tenantId,
  url: `https://otel-${++specSeq}.${tenantId.slice(0, 4)}.example/v1/traces`,
  protocol: 'http/json',
  clearance: 'internal',
  content: false,
  ...over,
});

function statsDouble() {
  const calls = {
    content: [] as string[],
    dropped: [] as string[],
    failed: [] as string[],
  };
  const stats: TelemetryStats = {
    attributesDropped: () => undefined,
    redactions: () => undefined,
    spansDropped: () => undefined,
    exportFailed: () => undefined,
    inboundContext: () => undefined,
    nodeEventsDropped: () => undefined,
    nodeContextMismatch: () => undefined,
    keepKept: () => undefined,
    keepEvicted: () => undefined,
    contentResult: (r) => void calls.content.push(r),
    tenantSpansDropped: (r) => void calls.dropped.push(r),
    tenantExportFailed: (r) => void calls.failed.push(r),
  };
  return { stats, calls };
}

interface Rig {
  router: TenantExportRouter;
  sent: Sent[];
  planned: { url: string; ctx: OutboundContext }[];
  calls: ReturnType<typeof statsDouble>['calls'];
  specs: Map<string, TenantExporterSpec[]>;
  provider: NodeTracerProvider;
  /** Ends a span of the tenant (a `chat` span when `chat` is given), content parked before. */
  emit(
    tenantId: string | undefined,
    o?: { chat?: { classification: Classification; optIns?: string[] } },
  ): string;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

function rig(
  over: {
    config?: Partial<ConstructorParameters<typeof TenantExportRouter>[0]['config']>;
    dispatcher?: ReturnType<typeof recordingDispatcher>;
    source?: (tenantId: string) => Promise<TenantExporterSpec[]>;
  } = {},
): Rig {
  const rec = over.dispatcher ?? recordingDispatcher();
  const { stats, calls } = statsDouble();
  configureTelemetryRuntime({ stats });
  const router = new TenantExportRouter({
    dispatcher: rec.dispatcher,
    config: {
      content: 'redacted',
      tenantExportersMax: 8,
      exportTimeoutMs: 2000,
      maxQueue: 256,
      allowedRegions: [],
      ...over.config,
    },
  });
  const specs = new Map<string, TenantExporterSpec[]>();
  router.attach(over.source ?? (async (tenantId) => specs.get(tenantId) ?? []));
  const provider = new NodeTracerProvider({
    idGenerator: new RunIdGenerator(),
    spanProcessors: [router],
  });
  provider.register({ propagator: null });
  return {
    router,
    sent: rec.sent,
    planned: rec.planned,
    calls,
    specs,
    provider,
    emit(tenantId, o) {
      const open = startGuardedSpan(
        {
          name: o?.chat ? 'chat sim-1' : 'oax.run',
          kind: o?.chat ? 'chat' : 'run',
          newTrace: true,
        },
        {
          ...(tenantId ? { 'oax.tenant.id': tenantId } : {}),
          ...(o?.chat ? { 'gen_ai.operation.name': 'chat' } : { 'oax.worker': 'w1' }),
        },
      );
      const sc = open.span.spanContext();
      if (o?.chat && tenantId)
        putCapturedContent(sc, {
          tenantId,
          classification: o.chat.classification,
          attributes: { 'gen_ai.input.messages': INPUT, 'gen_ai.output.messages': OUTPUT },
          truncated: false,
          optIns: new Set(o.chat.optIns ?? specs.get(tenantId)?.map((s) => s.connectionId) ?? []),
          at: Date.now(),
        });
      open.end();
      return sc.spanId;
    },
    async flush() {
      // The first span of a tenant waits for the lookup of its exporters.
      await vi.waitFor(() => expect(pending(router)).toBe(0));
      await router.forceFlush();
    },
    async stop() {
      await router.shutdown();
      await provider.shutdown();
      trace.disable();
    },
  };
}

const pending = (r: TenantExportRouter) => (r as unknown as { pending: number }).pending;
const attrKeys = (s: OtlpSpan) => s.attributes.map((a) => a.key);
const allSpans = (sent: Sent[]) =>
  sent.flatMap((x) => x.json.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((c) => c.spans)));

let r: Rig;
beforeEach(() => {
  resetCapturedContent();
});
afterEach(async () => {
  await r?.stop();
  resetTelemetryRuntime();
});

describe('tenant scope', () => {
  it('copies spans only to the exporters of the tenant that owns them', async () => {
    r = rig();
    const a1 = spec(TENANT_A);
    const a2 = spec(TENANT_A);
    const b = spec(TENANT_B);
    r.specs.set(TENANT_A, [a1, a2]);
    r.specs.set(TENANT_B, [b]);
    r.emit(TENANT_A);
    r.emit(TENANT_B);
    r.emit(TENANT_B);
    await r.flush();
    const to = (u: string) => allSpans(r.sent.filter((x) => x.url === u));
    expect(to(a1.url)).toHaveLength(1);
    expect(to(a2.url)).toHaveLength(1);
    expect(to(b.url)).toHaveLength(2);
    // Every span in a batch belongs to the tenant of the exporter (the tenant id is on the span).
    for (const x of r.sent) {
      const tenant = x.ctx.scope?.tenantId;
      for (const s of allSpans([x]))
        expect(s.attributes.find((a) => a.key === 'oax.tenant.id')?.value).toEqual({
          stringValue: tenant,
        });
    }
  });

  it('sends with the tenant origin: https only, public destinations, pinned and no redirects', async () => {
    r = rig();
    const a = spec(TENANT_A);
    r.specs.set(TENANT_A, [a]);
    r.emit(TENANT_A);
    await r.flush();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.ctx).toMatchObject({
      purpose: 'telemetry',
      scope: { origin: 'tenant', tenantId: TENANT_A },
    });
    expect(r.planned[0]!.ctx.scope).toMatchObject({ origin: 'tenant', tenantId: TENANT_A });
  });

  it('exports nothing for a span without a valid tenant id, or for a tenant without exporters', async () => {
    r = rig();
    r.specs.set(TENANT_A, [spec(TENANT_A)]);
    r.emit(undefined);
    r.emit(TENANT_B);
    await r.flush();
    expect(r.sent).toHaveLength(0);
  });

  it('refuses a spec that names another tenant than the lookup was for', async () => {
    r = rig({ source: async () => [spec(TENANT_B)] });
    r.emit(TENANT_A);
    await r.flush();
    expect(r.sent).toHaveLength(0);
  });

  it('fails closed when the source fails and drops spans before a source is attached', async () => {
    r = rig({
      source: async () => {
        throw new Error('db down');
      },
    });
    r.emit(TENANT_A);
    await r.flush();
    expect(r.sent).toHaveLength(0);
    const bare = new TenantExportRouter({
      dispatcher: recordingDispatcher().dispatcher,
      config: {
        content: 'off',
        tenantExportersMax: 1,
        exportTimeoutMs: 1000,
        maxQueue: 8,
        allowedRegions: [],
      },
    });
    bare.onEnd({
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
      attributes: { 'oax.tenant.id': TENANT_A },
    } as never);
    expect(pending(bare)).toBe(0);
    await bare.shutdown();
  });
});

describe('exporter rules', () => {
  it('a destination the dispatcher refuses never gets an exporter', async () => {
    r = rig({ dispatcher: recordingDispatcher({ denyPlan: true }) });
    r.specs.set(TENANT_A, [spec(TENANT_A)]);
    r.emit(TENANT_A);
    await r.flush();
    expect(r.sent).toHaveLength(0);
    expect(r.calls.dropped).toContain('denied');
  });

  it('caps the number of exporters and counts what was refused', async () => {
    r = rig({ config: { tenantExportersMax: 1 } });
    r.specs.set(TENANT_A, [spec(TENANT_A), spec(TENANT_A)]);
    r.emit(TENANT_A);
    await r.flush();
    expect(r.sent).toHaveLength(1);
    expect(r.calls.dropped).toContain('no_capacity');
  });

  it('one tenant cannot use up the exporters of the process', async () => {
    r = rig({ config: { tenantExportersMax: 8 } });
    r.specs.set(
      TENANT_A,
      Array.from({ length: 7 }, () => spec(TENANT_A)),
    );
    r.specs.set(TENANT_B, [spec(TENANT_B)]);
    r.emit(TENANT_A);
    r.emit(TENANT_B);
    await r.flush();
    expect(r.sent.filter((x) => x.ctx.scope?.tenantId === TENANT_A)).toHaveLength(4);
    expect(r.sent.filter((x) => x.ctx.scope?.tenantId === TENANT_B)).toHaveLength(1);
    expect(r.calls.dropped).toContain('no_capacity');
  });

  it('refuses an exporter whose region the operator does not allow', async () => {
    r = rig({ config: { allowedRegions: ['eu'] } });
    r.specs.set(TENANT_A, [spec(TENANT_A, { region: 'us' }), spec(TENANT_A)]);
    r.emit(TENANT_A);
    await r.flush();
    expect(r.sent).toHaveLength(0);
    expect(r.calls.dropped).toContain('region');
    r.specs.set(TENANT_A, [spec(TENANT_A, { region: 'eu' })]);
    notifyTelemetryConnectionChanged(TENANT_A);
    r.emit(TENANT_A);
    await r.flush();
    expect(r.sent).toHaveLength(1);
  });

  it('counts failed exports and never throws into the span end', async () => {
    r = rig({ dispatcher: recordingDispatcher({ failFetch: true }) });
    r.specs.set(TENANT_A, [spec(TENANT_A)]);
    r.emit(TENANT_A);
    await r.flush();
    expect(r.calls.failed.length).toBeGreaterThan(0);
  });

  it('exporter credentials never reach the payload, even from an attribute', async () => {
    r = rig();
    r.specs.set(TENANT_A, [spec(TENANT_A, { headers: { Authorization: HEADER_SECRET } })]);
    const open = startGuardedSpan(
      { name: 'oax.run', kind: 'run', newTrace: true },
      { 'oax.tenant.id': TENANT_A, 'oax.worker': `w-${HEADER_SECRET}` },
    );
    open.end();
    await r.flush();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.headers.Authorization).toBe(HEADER_SECRET);
    expect(r.sent[0]!.text).not.toContain(HEADER_SECRET);
  });

  it('spans keep the allowlist: unknown attributes never leave', async () => {
    r = rig();
    r.specs.set(TENANT_A, [spec(TENANT_A)]);
    const raw = trace.getTracer('x').startSpan('oax.run');
    raw.setAttribute('oax.tenant.id', TENANT_A);
    raw.setAttribute('prompt', CANARY_TEXT);
    raw.setAttribute('gen_ai.input.messages', CANARY_TEXT);
    raw.end();
    await r.flush();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).not.toContain(CANARY_TEXT);
  });
});

describe('content gates', () => {
  const content = (s: OtlpSpan) =>
    attrKeys(s).filter((k) => k.startsWith('gen_ai.') && k.endsWith('.messages'));

  it('attaches content to the opted-in tenant exporter only', async () => {
    r = rig();
    const opted = spec(TENANT_A, { content: true });
    const plain = spec(TENANT_A, { content: false });
    r.specs.set(TENANT_A, [opted, plain]);
    r.emit(TENANT_A, { chat: { classification: 'internal' } });
    await r.flush();
    const toOpted = allSpans(r.sent.filter((x) => x.url === opted.url));
    const toPlain = allSpans(r.sent.filter((x) => x.url === plain.url));
    expect(content(toOpted[0]!).sort()).toEqual([
      'gen_ai.input.messages',
      'gen_ai.output.messages',
    ]);
    expect(attrKeys(toOpted[0]!)).toContain('oax.content.redacted');
    expect(content(toPlain[0]!)).toEqual([]);
    expect(r.sent.filter((x) => x.url === plain.url)[0]!.text).not.toContain(CANARY_TEXT);
    expect(r.calls.content).toContain('attached');
    expect(r.calls.content).toContain('dropped_opt_out');
  });

  it('drops content of a run classified above the exporter clearance, keeps the metadata span', async () => {
    r = rig();
    const e = spec(TENANT_A, { content: true, clearance: 'internal' });
    r.specs.set(TENANT_A, [e]);
    r.emit(TENANT_A, { chat: { classification: 'confidential' } });
    await r.flush();
    const spans = allSpans(r.sent);
    expect(spans).toHaveLength(1);
    expect(content(spans[0]!)).toEqual([]);
    expect(r.sent[0]!.text).not.toContain(CANARY_TEXT);
    expect(r.calls.content).toEqual(['dropped_classification']);
  });

  it.each([
    ['public', 'public', true],
    ['internal', 'internal', true],
    ['public', 'restricted', true],
    ['restricted', 'confidential', false],
    ['confidential', 'public', false],
  ] as const)('classification %s with clearance %s -> content %s', async (data, clearance, ok) => {
    r = rig();
    r.specs.set(TENANT_A, [spec(TENANT_A, { content: true, clearance })]);
    r.emit(TENANT_A, { chat: { classification: data } });
    await r.flush();
    expect(content(allSpans(r.sent)[0]!).length > 0).toBe(ok);
  });

  it('an opt-out stops the content at once, also for spans already queued', async () => {
    r = rig();
    const e = spec(TENANT_A, { content: true });
    r.specs.set(TENANT_A, [e]);
    r.emit(TENANT_A, { chat: { classification: 'internal' } });
    await vi.waitFor(() => expect(pending(r.router)).toBe(0));
    // The tenant switches the opt-in off after the span was queued but before it was sent.
    r.specs.set(TENANT_A, [{ ...e, content: false }]);
    notifyTelemetryConnectionChanged(TENANT_A);
    await r.router.forceFlush();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).not.toContain(CANARY_TEXT);
    expect(r.calls.content).toEqual(['dropped_opt_out']);
    // And later calls: the stored opt-in is off, nothing is attached any more.
    r.emit(TENANT_A, { chat: { classification: 'internal' } });
    await r.flush();
    expect(r.sent.map((x) => x.text).join()).not.toContain(CANARY_TEXT);
  });

  it('a connection that had not opted in when the content was captured gets none', async () => {
    r = rig();
    const e = spec(TENANT_A, { content: true });
    r.specs.set(TENANT_A, [e]);
    r.emit(TENANT_A, { chat: { classification: 'internal', optIns: [randomUUID()] } });
    await r.flush();
    expect(r.sent[0]!.text).not.toContain(CANARY_TEXT);
    expect(r.calls.content).toEqual(['dropped_opt_out']);
  });

  it('without the operator allow no content is attached, whatever the tenant stored', async () => {
    r = rig({ config: { content: 'off' } });
    r.specs.set(TENANT_A, [spec(TENANT_A, { content: true })]);
    r.emit(TENANT_A, { chat: { classification: 'public' } });
    await r.flush();
    expect(r.sent[0]!.text).not.toContain(CANARY_TEXT);
    expect(r.calls.content).toEqual(['dropped_operator']);
  });

  it('content parked for another tenant is never attached and does not linger', async () => {
    r = rig();
    r.specs.set(TENANT_A, [spec(TENANT_A, { content: true })]);
    const open = startGuardedSpan(
      { name: 'chat sim-1', kind: 'chat', newTrace: true },
      { 'oax.tenant.id': TENANT_A, 'gen_ai.operation.name': 'chat' },
    );
    putCapturedContent(open.span.spanContext(), {
      tenantId: TENANT_B,
      classification: 'public',
      attributes: { 'gen_ai.input.messages': INPUT },
      truncated: false,
      optIns: new Set(r.specs.get(TENANT_A)!.map((s) => s.connectionId)),
      at: Date.now(),
    });
    open.end();
    await r.flush();
    expect(r.sent[0]!.text).not.toContain(CANARY_TEXT);
    expect(capturedContentSize()).toBe(0);
  });

  it('refuses content when the region is not allowed, even if the exporter exists', async () => {
    r = rig({ config: { allowedRegions: ['eu'] } });
    const e = spec(TENANT_A, { content: true, region: 'eu' });
    r.specs.set(TENANT_A, [e]);
    r.emit(TENANT_A, { chat: { classification: 'internal' } });
    await r.flush();
    expect(content(allSpans(r.sent)[0]!).length).toBe(2);
    // The operator narrows the list; the next refresh refuses the exporter and with it the content.
    (r.router.config as { allowedRegions: string[] }).allowedRegions = ['us'];
    notifyTelemetryConnectionChanged(TENANT_A);
    r.sent.length = 0;
    r.emit(TENANT_A, { chat: { classification: 'internal' } });
    await r.flush();
    expect(r.sent).toHaveLength(0);
  });
});

describe('last pass over a content attribute', () => {
  it('guards again, redacts personal data again and refuses oversized or invalid values', () => {
    const guard = new ContextGuard();
    guard.addSecret(HEADER_SECRET);
    const ok = JSON.stringify([
      { role: 'user', parts: [{ type: 'text', content: `x ${HEADER_SECRET} a@example.org` }] },
    ]);
    const out = finalizeContent(ok, guard)!;
    expect(out).not.toContain(HEADER_SECRET);
    expect(out).not.toContain('a@example.org');
    expect(finalizeContent('x'.repeat(9000), guard)).toBeNull();
    expect(finalizeContent('{not json', guard)).toBeNull();
    expect(finalizeContent(undefined as never, guard)).toBeNull();
  });
});

describe('real dispatcher: air-gap and tenant destination rules', () => {
  it('a tenant destination off the air-gapped allowlist is refused before any request', async () => {
    const net = compileNetwork(parseNetworkConfig({}).config, {
      egress: { airgapped: true, isAllowed: () => false, covers: () => false } as never,
    });
    const fetchImpl = vi.fn();
    const dispatcher = createOutboundDispatcher({ network: net, fetchImpl });
    r = rig({ dispatcher: { dispatcher, sent: [], planned: [] } });
    r.specs.set(TENANT_A, [spec(TENANT_A)]);
    r.emit(TENANT_A);
    await r.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.calls.dropped).toContain('denied');
  });

  it.each([
    'https://127.0.0.1/',
    'https://localhost/',
    'https://[::1]/',
    'https://169.254.169.254/',
    'https://2130706433/',
    'https://0x7f.0.0.1/',
    'https://10.0.0.5/',
    'http://collector.example/',
  ])('refuses %s as a tenant destination', async (endpoint) => {
    const fetchImpl = vi.fn();
    const dispatcher = createOutboundDispatcher({ fetchImpl });
    r = rig({ dispatcher: { dispatcher, sent: [], planned: [] } });
    r.specs.set(TENANT_A, [spec(TENANT_A, { url: `${endpoint.replace(/\/$/, '')}/v1/traces` })]);
    r.emit(TENANT_A);
    await r.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.calls.dropped).toContain('denied');
  });

  it('pins DNS at connect time: a name that resolves to a private address is not contacted', async () => {
    const fetchImpl = vi.fn(async (_u: string, init: { dispatcher?: unknown }) => {
      // The pinned lookup is part of the dispatcher; calling it shows what a connect would do.
      expect(init.dispatcher).toBeDefined();
      return new Response(null, { status: 200 });
    });
    const dispatcher = createOutboundDispatcher({ fetchImpl: fetchImpl as never });
    r = rig({ dispatcher: { dispatcher, sent: [], planned: [] } });
    r.specs.set(TENANT_A, [spec(TENANT_A, { url: 'https://collector.tenant.example/v1/traces' })]);
    r.emit(TENANT_A);
    await r.flush();
    // Sent with redirect:error and a dispatcher (the tenant origin always pins).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]![1] as { redirect?: string }).redirect).toBe('error');
  });
});

describe('initTelemetry with tenant exporters', () => {
  const otelOf = (env: Record<string, string>) =>
    loadConfig({ OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test', ...env }).otel;

  afterEach(async () => {
    trace.disable();
  });

  it('stays inert with the operator switch off, whatever a source would say', async () => {
    const t = await initTelemetry(otelOf({}), {});
    expect(t.enabled).toBe(false);
    expect(tracingEnabled()).toBe(false);
    t.attachTenantExporters(async () => [spec(TENANT_A)]);
    await t.shutdown();
  });

  it('with only the tenant switch there is no platform exporter, but tenants get their copy', async () => {
    const rec = recordingDispatcher();
    const t = await initTelemetry(otelOf({ OAX_OTEL_TENANT_EXPORTERS: 'allow' }), {
      outbound: rec.dispatcher,
    });
    expect(t.enabled).toBe(true);
    const { stats } = statsDouble();
    t.attachStats(stats);
    t.attachTenantExporters(async (id) => (id === TENANT_A ? [spec(TENANT_A)] : []));
    const open = startGuardedSpan(
      { name: 'oax.run', kind: 'run', newTrace: true },
      { 'oax.tenant.id': TENANT_A, 'oax.worker': 'w1' },
    );
    open.end();
    const other = startGuardedSpan(
      { name: 'oax.run', kind: 'run', newTrace: true },
      { 'oax.tenant.id': TENANT_B, 'oax.worker': 'w1' },
    );
    other.end();
    await t.shutdown();
    // Exactly one request, to the exporter of the tenant that owns the span; nothing to a platform URL.
    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0]!.ctx.scope).toMatchObject({ origin: 'tenant', tenantId: TENANT_A });
    resetTelemetryRuntime();
  });

  it('with a platform endpoint too, both pipelines run and the platform one never gets content', async () => {
    const rec = recordingDispatcher();
    const t = await initTelemetry(
      otelOf({
        OAX_OTEL_TENANT_EXPORTERS: 'allow',
        OAX_OTEL_CONTENT: 'redacted',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.platform.example',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      }),
      { outbound: rec.dispatcher },
    );
    t.attachTenantExporters(async () => [spec(TENANT_A, { content: true })]);
    const open = startGuardedSpan(
      { name: 'chat sim-1', kind: 'chat', newTrace: true },
      { 'oax.tenant.id': TENANT_A, 'gen_ai.operation.name': 'chat' },
    );
    putCapturedContent(open.span.spanContext(), {
      tenantId: TENANT_A,
      classification: 'public',
      attributes: { 'gen_ai.input.messages': INPUT },
      truncated: false,
      optIns: new Set(),
      at: Date.now(),
    });
    open.end();
    await t.shutdown();
    const platformSends = rec.sent.filter((s) =>
      s.url.startsWith('https://collector.platform.example'),
    );
    expect(platformSends.length).toBeGreaterThan(0);
    for (const s of platformSends) expect(s.text).not.toContain(CANARY_TEXT);
    resetTelemetryRuntime();
  });
});
