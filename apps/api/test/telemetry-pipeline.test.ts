import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ExportResultCode } from '@opentelemetry/core';
import { context, createTraceState, propagation, trace } from '@opentelemetry/api';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ContextGuard, OaxError, StaticSecretResolver } from '@openagentix/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Metrics } from '../src/metrics.js';
import {
  DropCountingProcessor,
  GuardedSpanExporter,
  classifyExportFailure,
} from '../src/telemetry-export.js';
import {
  configureTelemetryRuntime,
  initTelemetry,
  resetTelemetryRuntime,
  telemetryRuntime,
  tracer,
  withSpan,
} from '../src/telemetry.js';
import { traceLogFields } from '../src/context.js';

// Example values only: none of these is a real credential.
const PROVIDER_TOKEN = `sk-ant-${'x9Y8'.repeat(6)}`;
const BODY_CANARY = 'CANARY-RESPONSE-BODY-4711';
const HEADER_SECRET = 'collector-key-0123456789abcdef';
const TENANT = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';

const base = { OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' };
const otel = (env: Record<string, string>) => loadConfig({ ...base, ...env }).otel;

interface Captured {
  headers: IncomingMessage['headers'];
  body: Buffer;
}

async function collector(
  behaviour: 'ok' | 'error500' | 'hang' = 'ok',
): Promise<{ url: string; requests: Captured[]; close(): Promise<void> }> {
  const requests: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks) });
      if (behaviour === 'hang') return;
      res.statusCode = behaviour === 'ok' ? 200 : 500;
      res.end(behaviour === 'ok' ? '' : BODY_CANARY);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const failWith = (message: string) => async () => {
  throw new OaxError('provider_failed', message);
};

beforeEach(() => resetTelemetryRuntime());
afterEach(() => {
  trace.disable();
  resetTelemetryRuntime();
});

describe('a thrown error never reaches an exported span (end to end over OTLP)', () => {
  it.each(['http/json', 'http/protobuf'] as const)('protocol %s', async (protocol) => {
    const c = await collector();
    const warnings: unknown[] = [];
    const t = await initTelemetry(
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url, OTEL_EXPORTER_OTLP_PROTOCOL: protocol }),
      { warn: (f, m) => warnings.push([f, m]) },
    );
    await expect(
      withSpan(
        { name: 'oax.run', kind: 'run' },
        { 'oax.run.id': TENANT, 'oax.worker': 'worker-1' },
        failWith(`upstream 401: {"error":"bad key ${PROVIDER_TOKEN}","detail":"${BODY_CANARY}"}`),
      ),
    ).rejects.toThrow(BODY_CANARY); // the caller still sees the real error
    await t.shutdown();
    expect(c.requests.length).toBeGreaterThan(0);
    for (const r of c.requests) {
      const wire = r.body.toString('latin1');
      expect(wire).not.toContain(PROVIDER_TOKEN);
      expect(wire).not.toContain(BODY_CANARY);
      expect(wire).not.toContain('upstream 401');
      expect(wire).not.toContain('stack');
      expect(wire).toContain('provider_failed');
      expect(wire).toContain('OaxError');
    }
    if (protocol === 'http/json') {
      expect(c.requests[0]!.headers['content-type']).toContain('application/json');
      const span = JSON.parse(c.requests[0]!.body.toString()).resourceSpans[0].scopeSpans[0]
        .spans[0];
      expect(span.status).toEqual({ code: 2, message: 'provider_failed' });
      const keys = span.attributes.map((a: { key: string }) => a.key).sort();
      expect(keys).toEqual(['error.type', 'oax.run.id', 'oax.worker']);
      expect(span.events.map((e: { name: string }) => e.name)).toEqual(['exception']);
      const evKeys = span.events[0].attributes.map((a: { key: string }) => a.key);
      expect(evKeys).toEqual(['exception.type']);
    } else {
      expect(c.requests[0]!.headers['content-type']).toContain('application/x-protobuf');
    }
    expect(warnings).toEqual([]);
    await c.close();
  });

  it('never exports tracestate of a parent or a link (free text from whoever sent it)', async () => {
    const c = await collector();
    const t = await initTelemetry(
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }),
    );
    const remote = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
      isRemote: true,
      traceState: createTraceState(`vendor=${BODY_CANARY}`),
    };
    const parent = trace.setSpanContext(context.active(), remote);
    tracer()
      .startSpan('oax.run', { links: [{ context: remote }] }, parent)
      .end();
    await t.shutdown();
    const wire = c.requests.map((r) => r.body.toString()).join('');
    expect(wire).toContain('oax.run');
    expect(wire).not.toContain(BODY_CANARY);
    expect(wire).not.toContain('traceState');
    await c.close();
  });

  it('defaults to http/protobuf', async () => {
    const c = await collector();
    const t = await initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url }));
    await withSpan({ name: 'oax.run', kind: 'run' }, {}, async () => 1);
    await t.shutdown();
    expect(c.requests[0]!.headers['content-type']).toContain('application/x-protobuf');
    await c.close();
  });
});

describe('withSpan (in-memory export)', () => {
  const setup = (guarded: boolean) => {
    const memory = new InMemorySpanExporter();
    const exporter = guarded ? new GuardedSpanExporter(memory, 1000) : memory;
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    return memory;
  };
  const dump = (m: InMemorySpanExporter) =>
    JSON.stringify(
      m.getFinishedSpans().map((s) => ({
        name: s.name,
        attributes: s.attributes,
        status: s.status,
        events: s.events.map((e) => ({ name: e.name, attributes: e.attributes })),
        links: s.links,
      })),
    );

  it('records the code and class only: no message, no stack, no exception event payload', async () => {
    const m = setup(false);
    const sensitive = `leak ${PROVIDER_TOKEN} ${BODY_CANARY}`;
    await expect(
      withSpan({ name: 'execute_tool lookup', kind: 'execute_tool' }, {}, async () => {
        throw new TypeError(sensitive);
      }),
    ).rejects.toThrow(TypeError);
    const [span] = m.getFinishedSpans();
    expect(span!.status).toEqual({ code: 2, message: '_OTHER' });
    expect(span!.attributes['error.type']).toBe('_OTHER');
    expect(span!.events).toHaveLength(1);
    expect(span!.events[0]!.attributes).toEqual({ 'exception.type': 'TypeError' });
    expect(dump(m)).not.toContain(PROVIDER_TOKEN);
    expect(dump(m)).not.toContain(BODY_CANARY);
    expect(dump(m)).not.toContain('stack');
  });

  it('uses the platform error code as error.type and status description', async () => {
    const m = setup(false);
    await expect(
      withSpan({ name: 'chat m', kind: 'chat' }, {}, failWith(`body ${BODY_CANARY}`)),
    ).rejects.toThrow();
    const [span] = m.getFinishedSpans();
    expect(span!.status).toEqual({ code: 2, message: 'provider_failed' });
    expect(span!.attributes['error.type']).toBe('provider_failed');
  });

  it('guarded detail mode adds a guarded, capped message and still never the stack', async () => {
    const m = setup(false);
    configureTelemetryRuntime({ exceptionDetail: 'guarded' });
    await expect(
      withSpan(
        { name: 'chat m', kind: 'chat' },
        {},
        failWith(`${PROVIDER_TOKEN} ${'y'.repeat(600)}`),
      ),
    ).rejects.toThrow();
    const ev = m.getFinishedSpans()[0]!.events[0]!;
    const msg = ev.attributes!['exception.message'] as string;
    expect(msg).not.toContain(PROVIDER_TOKEN);
    expect(msg.length).toBeLessThanOrEqual(256);
    expect(ev.attributes!['exception.stacktrace']).toBeUndefined();
    expect(ev.attributes!['oax.redacted']).toBe(true);
  });

  it('drops unknown and content attributes and counts them', async () => {
    const m = setup(false);
    const metrics = new Metrics('t_');
    configureTelemetryRuntime({ stats: metrics.otel });
    await withSpan(
      { name: 'oax.run', kind: 'run' },
      {
        'oax.worker': 'w',
        'tenant.name': 'Acme Corp',
        'gen_ai.input.messages': 'secret prompt',
        'oax.tenant.id': 'Acme Corp',
      },
      async (span) => {
        span.setAttributes({ 'another.unknown': 1 });
        span.addEvent('Not A Valid Name', { 'oax.worker': 'x' });
        span.addEvent('custom.event', { 'gen_ai.output.messages': 'reply' });
      },
    );
    const span = m.getFinishedSpans()[0]!;
    expect(span.attributes).toEqual({ 'oax.worker': 'w' });
    expect(span.events.map((e) => e.name)).toEqual(['custom.event']);
    expect(span.events[0]!.attributes).toEqual({});
    const text = await metrics.registry.metrics();
    expect(text).toContain('t_otel_attributes_dropped_total{key_class="unknown"} 2');
    expect(text).toContain('t_otel_attributes_dropped_total{key_class="content"} 2');
    expect(text).toContain('t_otel_attributes_dropped_total{key_class="invalid"} 1');
  });

  it('redacts secrets in attribute values and span names and counts the redactions', async () => {
    const m = setup(false);
    const metrics = new Metrics('t_');
    configureTelemetryRuntime({ stats: metrics.otel });
    await withSpan(
      { name: `chat ${PROVIDER_TOKEN}`, kind: 'chat' },
      { 'gen_ai.request.model': `m ${PROVIDER_TOKEN}` },
      async () => undefined,
    );
    const span = m.getFinishedSpans()[0]!;
    expect(span.name).toBe('chat [redacted:anthropic-key]');
    expect(span.attributes['gen_ai.request.model']).toBe('m [redacted:anthropic-key]');
    expect(span.attributes['oax.redacted']).toBe(true);
    expect(dump(m)).not.toContain(PROVIDER_TOKEN);
    expect(await metrics.registry.metrics()).toContain(
      't_otel_redactions_total{kind="anthropic-key"} 2',
    );
  });

  it('the export boundary also cleans spans created with the raw tracer', async () => {
    const m = setup(true);
    const metrics = new Metrics('t_');
    configureTelemetryRuntime({ stats: metrics.otel });
    const span = tracer().startSpan(`execute_tool ${PROVIDER_TOKEN}`, {
      attributes: {
        'gen_ai.tool.name': 'lookup',
        'gen_ai.tool.call.arguments': `{"password":"${BODY_CANARY}"}`,
        'unlisted.attribute': BODY_CANARY,
      },
    });
    span.recordException(new Error(`boom ${PROVIDER_TOKEN} ${BODY_CANARY}`));
    span.setStatus({ code: 2, message: `boom ${PROVIDER_TOKEN} ${BODY_CANARY}` });
    span.end();
    const out = m.getFinishedSpans()[0]!;
    expect(out.attributes).toEqual({ 'gen_ai.tool.name': 'lookup', 'oax.redacted': true });
    expect(out.status).toEqual({ code: 2 });
    expect(out.events[0]!.attributes).toEqual({ 'exception.type': 'Error' });
    expect(dump(m)).not.toContain(PROVIDER_TOKEN);
    expect(dump(m)).not.toContain(BODY_CANARY);
    expect(out.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(await metrics.registry.metrics()).toMatch(
      /otel_attributes_dropped_total\{key_class="content"\} [1-9]/,
    );
  });

  it('drops an over-long raw status description without scanning it', async () => {
    const m = setup(true);
    const guard = telemetryRuntime().guard;
    const scanned: number[] = [];
    const text = guard.text.bind(guard);
    guard.text = (input: string) => {
      scanned.push(input.length);
      return text(input);
    };
    const span = tracer().startSpan('oax.run');
    span.setStatus({ code: 2, message: `provider_failed${' '.repeat(1 << 20)}` });
    span.end();
    expect(m.getFinishedSpans()[0]!.status).toEqual({ code: 2 });
    expect(Math.max(0, ...scanned)).toBeLessThanOrEqual(4096);
  });

  it('keeps tenant identity to UUIDs and never the tenant name', async () => {
    const m = setup(false);
    await withSpan(
      { name: 'oax.run', kind: 'run' },
      { 'oax.tenant.id': TENANT, 'oax.tenant.name': 'Acme Corp', 'oax.tenant.slug': 'acme' },
      async () => undefined,
    );
    expect(m.getFinishedSpans()[0]!.attributes).toEqual({ 'oax.tenant.id': TENANT });
  });
});

describe('a failing telemetry pipeline never breaks the run', () => {
  const register = () => {
    const memory = new InMemorySpanExporter();
    new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] }).register();
    return memory;
  };
  const brokenGuard = () => {
    const g = new ContextGuard();
    g.text = () => {
      throw new Error('guard failure');
    };
    return g;
  };
  const throwingStats = {
    attributesDropped: () => {
      throw new Error('stats failure');
    },
    redactions: () => {
      throw new Error('stats failure');
    },
    spansDropped: () => {
      throw new Error('stats failure');
    },
    exportFailed: () => {
      throw new Error('stats failure');
    },
  };

  it('a throwing guard drops attributes and names, the run completes', async () => {
    const m = register();
    const guard = brokenGuard();
    const result = await withSpan(
      { name: 'chat m', kind: 'chat', guard },
      { 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 1 },
      async (span) => {
        span.setAttributes({ 'gen_ai.response.model': 'm' });
        span.addEvent('custom.event', { 'gen_ai.request.model': 'm' });
        return 42;
      },
    );
    expect(result).toBe(42);
    const span = m.getFinishedSpans()[0]!;
    expect(span.name).toBe('oax.span');
    expect(span.attributes).toEqual({ 'gen_ai.usage.input_tokens': 1 });
  });

  it('a throwing guard never replaces the error of the run', async () => {
    register();
    await expect(
      withSpan({ name: 'chat m', kind: 'chat', guard: brokenGuard() }, {}, failWith('real')),
    ).rejects.toMatchObject({ code: 'provider_failed', message: 'real' });
  });

  it('throwing counters break neither the span operations nor span.end()', async () => {
    register();
    configureTelemetryRuntime({ stats: throwingStats });
    const result = await withSpan(
      { name: 'oax.run', kind: 'run' },
      { 'unknown.key': 1, 'gen_ai.input.messages': 'x' },
      async (span) => {
        span.setAttributes({ 'another.unknown': PROVIDER_TOKEN });
        return 'done';
      },
    );
    expect(result).toBe('done');
    await expect(withSpan({ name: 'oax.run', kind: 'run' }, {}, failWith('x'))).rejects.toThrow(
      'x',
    );
  });

  it('an error whose message getter throws is rethrown unchanged in guarded mode', async () => {
    register();
    configureTelemetryRuntime({ exceptionDetail: 'guarded' });
    const hostile = new Error('placeholder');
    Object.defineProperty(hostile, 'message', {
      get: () => {
        throw new Error('getter');
      },
    });
    const outcome = await withSpan({ name: 'oax.run', kind: 'run' }, {}, async () => {
      throw hostile;
    }).catch((e: unknown) => e);
    expect(outcome).toBe(hostile);
  });
});

describe('exporter credentials', () => {
  it('sends headers from the secret reference and never records or logs them', async () => {
    const c = await collector();
    const logs: unknown[] = [];
    const t = await initTelemetry(
      otel({
        OTEL_EXPORTER_OTLP_ENDPOINT: c.url,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OAX_OTEL_HEADERS_SECRET: 'otel-headers',
      }),
      {
        secrets: new StaticSecretResolver({ 'otel-headers': `x-api-key=${HEADER_SECRET}` }),
        warn: (f, m) => logs.push([f, m]),
      },
    );
    await withSpan(
      { name: 'oax.run', kind: 'run' },
      { 'oax.worker': `leaks-${HEADER_SECRET}` },
      failWith(`header was ${HEADER_SECRET}`),
    ).catch(() => undefined);
    await t.shutdown();
    expect(c.requests[0]!.headers['x-api-key']).toBe(HEADER_SECRET);
    for (const r of c.requests) expect(r.body.toString()).not.toContain(HEADER_SECRET);
    expect(JSON.stringify(logs)).not.toContain(HEADER_SECRET);
    await c.close();
  });

  it('fails start-up when the secret cannot be resolved, without echoing anything but the name', async () => {
    const cfg = otel({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.org',
      OAX_OTEL_HEADERS_SECRET: 'missing-ref',
    });
    await expect(
      initTelemetry(cfg, { secrets: new StaticSecretResolver({}) }),
    ).rejects.toMatchObject({
      code: 'config_invalid',
      message: expect.stringContaining('missing-ref'),
    });
  });

  it('fails start-up on a malformed header secret without echoing its value', async () => {
    const cfg = otel({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.org',
      OAX_OTEL_HEADERS_SECRET: 'bad',
    });
    const secrets = new StaticSecretResolver({ bad: 'host=evil.example.org,x=hunter2-hunter2' });
    const err = await initTelemetry(cfg, { secrets }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/reserved/);
    expect((err as Error).message).not.toContain('hunter2');
  });
});

describe('no resource detectors', () => {
  it('exports only static resource attributes', async () => {
    const c = await collector();
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'host.name=from-env,cloud.provider=aws';
    try {
      const t = await initTelemetry(
        otel({
          OTEL_EXPORTER_OTLP_ENDPOINT: c.url,
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
          OAX_OTEL_RESOURCE_ATTRIBUTES: 'service.version=1.2.3',
        }),
        { serviceName: 'oax-test' },
      );
      await withSpan({ name: 'oax.run', kind: 'run' }, {}, async () => 1);
      await t.shutdown();
    } finally {
      delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    }
    const resource = JSON.parse(c.requests[0]!.body.toString()).resourceSpans[0].resource;
    const keys = resource.attributes.map((a: { key: string }) => a.key);
    expect(keys.filter((k: string) => /^(host|process|cloud|container|os|k8s)\./.test(k))).toEqual(
      [],
    );
    expect(keys).toEqual(expect.arrayContaining(['service.name', 'service.version']));
    expect(
      resource.attributes.find((a: { key: string }) => a.key === 'service.name').value,
    ).toEqual({
      stringValue: 'oax-test',
    });
    await c.close();
  });
});

describe('the SDK takes nothing from OTEL_* fallbacks and propagates nothing', () => {
  const fallbacks = {
    OTEL_TRACES_SAMPLER: 'always_off',
    OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: '0',
    OTEL_ATTRIBUTE_COUNT_LIMIT: '0',
  };

  it('exports with the pinned sampler and limits whatever the environment says', async () => {
    const c = await collector();
    // Set after the configuration was built: only the SDK itself could still read them.
    Object.assign(process.env, fallbacks);
    try {
      const t = await initTelemetry(
        otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }),
      );
      await withSpan({ name: 'oax.run', kind: 'run' }, { 'oax.worker': 'w-1' }, async () => 1);
      await t.shutdown();
    } finally {
      for (const k of Object.keys(fallbacks)) delete process.env[k];
    }
    const wire = c.requests.map((r) => r.body.toString()).join('');
    expect(wire).toContain('oax.worker');
    await c.close();
  });

  it('registers no global propagator: no traceparent or baggage is ever injected', async () => {
    propagation.disable(); // other tests in this file register SDK providers with the default one
    const c = await collector();
    const t = await initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url }));
    try {
      const carrier: Record<string, string> = {};
      await withSpan({ name: 'oax.run', kind: 'run' }, {}, async () => {
        const ctx = propagation.setBaggage(
          context.active(),
          propagation.createBaggage({ tenant: { value: 'Acme Corp' } }),
        );
        propagation.inject(ctx, carrier);
      });
      expect(carrier).toEqual({});
    } finally {
      await t.shutdown();
      await c.close();
      propagation.disable();
    }
  });
});

describe('another OpenTelemetry SDK in the process (auto-instrumentation)', () => {
  const foreign = () => {
    const memory = new InMemorySpanExporter();
    new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] }).register();
    return memory;
  };

  it.each([
    ['without an endpoint', {}],
    ['with an endpoint', { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.org' }],
  ])('fails start-up %s: its exporter would bypass the guard', async (_label, env) => {
    const memory = foreign();
    await expect(initTelemetry(otel(env))).rejects.toMatchObject({
      code: 'config_invalid',
      message: expect.stringContaining('another OpenTelemetry SDK'),
    });
    expect(memory.getFinishedSpans()).toEqual([]);
  });

  it('starts normally once nothing else is registered', async () => {
    const t = await initTelemetry(otel({}));
    expect(t.enabled).toBe(false);
  });
});

describe('an unavailable exporter never blocks a run', () => {
  const run = async (n: number) => {
    const started = Date.now();
    for (let i = 0; i < n; i++)
      await withSpan({ name: 'oax.run', kind: 'run' }, { 'oax.worker': 'w' }, async () => i);
    return Date.now() - started;
  };

  it('collector down: runs are fast, failures are counted, the log line is rate-limited', async () => {
    const dead = await collector();
    await dead.close();
    const metrics = new Metrics('t_');
    const warnings: Array<[Record<string, unknown>, string]> = [];
    const t = await initTelemetry(
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: dead.url, OAX_OTEL_EXPORT_TIMEOUT_MS: '500' }),
      { warn: (f, m) => warnings.push([f, m]) },
    );
    t.attachStats(metrics.otel);
    expect(await run(200)).toBeLessThan(1500);
    await t.shutdown();
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/t_otel_export_failures_total\{reason="(network|timeout|other)"\} \d+/);
    expect(warnings.length).toBeLessThanOrEqual(1);
    for (const [fields] of warnings) expect(Object.keys(fields)).toEqual(['reason']);
  });

  it('collector answers 500: counted as failure with a closed reason, body never logged', async () => {
    const c = await collector('error500');
    const metrics = new Metrics('t_');
    const warnings: unknown[] = [];
    const t = await initTelemetry(
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url, OAX_OTEL_EXPORT_TIMEOUT_MS: '2000' }),
      { warn: (f, m) => warnings.push([f, m]) },
    );
    t.attachStats(metrics.otel);
    await run(3);
    await t.shutdown();
    expect(await metrics.registry.metrics()).toMatch(
      /t_otel_export_failures_total\{reason="\w+"\} \d+/,
    );
    expect(JSON.stringify(warnings)).not.toContain(BODY_CANARY);
    await c.close();
  });

  it('collector hangs: the export times out, runs are unaffected, shutdown is bounded', async () => {
    const c = await collector('hang');
    const metrics = new Metrics('t_');
    const t = await initTelemetry(
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url, OAX_OTEL_EXPORT_TIMEOUT_MS: '300' }),
    );
    t.attachStats(metrics.otel);
    expect(await run(20)).toBeLessThan(1000);
    const started = Date.now();
    await t.shutdown();
    expect(Date.now() - started).toBeLessThan(6000);
    expect(await metrics.registry.metrics()).toContain(
      't_otel_export_failures_total{reason="timeout"}',
    );
    await c.close();
  });

  it('counts spans a full queue drops', async () => {
    const metrics = new Metrics('t_');
    configureTelemetryRuntime({ stats: metrics.otel });
    const stuck = { export: () => undefined, shutdown: async () => undefined };
    const batch = new BatchSpanProcessor(stuck, { maxQueueSize: 3, maxExportBatchSize: 3 });
    new NodeTracerProvider({ spanProcessors: [new DropCountingProcessor(batch, 3)] }).register();
    for (let i = 0; i < 10; i++)
      await withSpan({ name: 'oax.run', kind: 'run' }, {}, async () => i);
    // 3 spans are in the (never finishing) export, 3 wait in the queue, the other 4 are dropped.
    expect(await metrics.registry.metrics()).toContain('t_otel_spans_dropped_total 4');
  });
});

describe('classifyExportFailure', () => {
  it('maps to a closed set from the code and name only', () => {
    expect(classifyExportFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(
      'timeout',
    );
    expect(classifyExportFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      'network',
    );
    expect(
      classifyExportFailure(
        Object.assign(new Error('x'), { code: 500, name: 'OTLPExporterError' }),
      ),
    ).toBe('http');
    expect(classifyExportFailure(new Error(`boom ${PROVIDER_TOKEN}`))).toBe('other');
    expect(classifyExportFailure(undefined)).toBe('other');
  });

  it('fails closed when sanitising throws: nothing unchecked is exported', () => {
    const sent: unknown[] = [];
    const ex = new GuardedSpanExporter(
      { export: (s) => sent.push(s), shutdown: async () => undefined },
      1000,
    );
    let code: number | undefined;
    ex.export([{} as never], (r) => (code = r.code));
    expect(code).toBe(ExportResultCode.FAILED);
    expect(sent).toEqual([]);
  });
});

describe('metric label hygiene of the telemetry counters', () => {
  it('keeps a constant number of series whatever tenants and attackers put in', async () => {
    const memory = new InMemorySpanExporter();
    new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new GuardedSpanExporter(memory, 1000))],
    }).register();
    const metrics = new Metrics('t_');
    configureTelemetryRuntime({ stats: metrics.otel });
    const word = () => Math.random().toString(36).slice(2);
    const series = async () =>
      (await metrics.registry.getMetricsAsJSON())
        .filter((m) => m.name.startsWith('t_otel_'))
        .reduce((n, m) => n + m.values.length, 0);
    const iterate = async (n: number) => {
      for (let i = 0; i < n; i++)
        await withSpan(
          { name: `chat ${word()}`, kind: 'chat' },
          {
            [`random.${word()}`]: word(),
            'oax.tenant.id': `Tenant ${word()}`,
            'gen_ai.request.model': `model-${word()}-${PROVIDER_TOKEN}`,
            'gen_ai.input.messages': word(),
          },
          async () => {
            if (i % 3 === 0) throw new OaxError(`code_${word()}`, word());
          },
        ).catch(() => undefined);
    };
    await iterate(50);
    const after50 = await series();
    await iterate(950);
    expect(await series()).toBe(after50);
    expect(after50).toBeLessThanOrEqual(8);
    const text = await metrics.registry.metrics();
    expect(text).not.toMatch(/Tenant|model-|random\./);
    for (const s of memory.getFinishedSpans())
      expect(
        Object.keys(s.attributes).every((k) => /^(gen_ai|oax|error|exception)\./.test(k)),
      ).toBe(true);
  });
});

describe('log correlation', () => {
  it('adds trace_id and span_id of the active span, and nothing outside a span', async () => {
    new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    }).register();
    expect(traceLogFields()).toEqual({});
    let inside: ReturnType<typeof traceLogFields> = {};
    let expected = { traceId: '', spanId: '' };
    await withSpan({ name: 'oax.run', kind: 'run' }, {}, async (span) => {
      inside = traceLogFields();
      expected = span.spanContext();
    });
    expect(inside).toEqual({ trace_id: expected.traceId, span_id: expected.spanId });
    expect(inside.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(inside.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the runtime guard independent of the model-context switches', () => {
    process.env.OAX_REDACT_MODEL_CONTEXT = 'off';
    try {
      resetTelemetryRuntime();
      expect(telemetryRuntime().guard.redactSecrets).toBe(true);
      expect(telemetryRuntime().guard.stripInvisible).toBe(true);
    } finally {
      delete process.env.OAX_REDACT_MODEL_CONTEXT;
    }
  });
});
