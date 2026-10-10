import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ExportResultCode } from '@opentelemetry/core';
import { trace } from '@opentelemetry/api';
import {
  EgressPolicy,
  OaxError,
  StaticSecretResolver,
  compileNetwork,
  parseAllowlist,
  parseNetworkConfig,
  type NetworkConfig,
} from '@openagentix/core';
import {
  createOutboundDispatcher,
  installNetworkGuard,
  type NetworkGuard,
  type OutboundDispatcher,
  type RouteAudit,
} from '@openagentix/providers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Metrics } from '../src/metrics.js';
import { DispatcherSpanExporter, MAX_IN_FLIGHT } from '../src/telemetry-transport.js';
import {
  initTelemetry,
  resetTelemetryRuntime,
  tracer,
  tracingEnabled,
  withSpan,
  type TelemetryInit,
} from '../src/telemetry.js';

// ADR 0015 slice S7: the exporter's traffic goes through the outbound dispatcher (purpose
// `telemetry`), and the air-gapped check runs before any exporter or secret exists (#220).
// Every value below is an example, none is a real credential.

const HEADER_SECRET = 'collector-key-0123456789abcdef';
const NET_SECRET = 'proxy-pass-0123456789abcdefgh';
const BODY_CANARY = 'CANARY-RESPONSE-BODY-4711';

const base = { OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' };
const otel = (env: Record<string, string>) => loadConfig({ ...base, ...env }).otel;
const netOf = (doc: Record<string, unknown>) =>
  compileNetwork(parseNetworkConfig(doc as unknown as NetworkConfig).config);

interface Captured {
  headers: IncomingMessage['headers'];
  body: Buffer;
  url: string;
}

async function collector(
  behaviour: 'ok' | 'error500' | 'hang' | 'redirect' | 'huge' = 'ok',
  redirectTo = '',
): Promise<{ url: string; port: number; requests: Captured[]; close(): Promise<void> }> {
  const requests: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url ?? '' });
      if (behaviour === 'hang') return;
      if (behaviour === 'redirect') return void res.writeHead(307, { location: redirectTo }).end();
      if (behaviour === 'huge')
        return void res
          .writeHead(200, { 'content-length': String(2 * 1024 * 1024) })
          .end('x'.repeat(2 * 1024 * 1024));
      res.statusCode = behaviour === 'ok' ? 200 : 500;
      res.end(behaviour === 'ok' ? '' : BODY_CANARY);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const policyFor = (allow: string) =>
  new EgressPolicy({ airgapped: true, allow: parseAllowlist(allow) });

/** A dispatcher that records every route decision and builds on the given network. */
function spyDispatcher(
  opts: {
    network?: ReturnType<typeof compileNetwork>;
    secrets?: (ref: string) => string | undefined;
  } = {},
) {
  const audits: RouteAudit[] = [];
  const dispatcher = createOutboundDispatcher({
    ...opts,
    onRoute: (a) => audits.push(a),
  });
  return { dispatcher, audits };
}

const span = () =>
  withSpan({ name: 'oax.run', kind: 'run' }, { 'oax.worker': 'worker-1' }, async () => 1);

const rendered = async (metrics: Metrics) => metrics.registry.metrics();

let guardHandle: NetworkGuard | undefined;
beforeEach(() => resetTelemetryRuntime());
afterEach(() => {
  guardHandle?.uninstall();
  guardHandle = undefined;
  trace.disable();
  resetTelemetryRuntime();
});

describe('air-gapped mode (zero egress, fail closed before the exporter exists)', () => {
  it('runs a full scenario without an endpoint with no blocked attempt and no SDK', async () => {
    const policy = policyFor('');
    guardHandle = installNetworkGuard(policy);
    const t = await initTelemetry(otel({}), { egress: policy });
    expect(t.enabled).toBe(false);
    expect(tracingEnabled()).toBe(false);
    await span();
    await t.shutdown();
    expect(policy.status().blocked).toBe(0);
  });

  it('refuses a non-allowlisted endpoint before the secret is read and before any dispatcher or exporter', async () => {
    const policy = policyFor('collector.internal.example:4318');
    const resolve = vi.fn(async () => `x-api-key=${HEADER_SECRET}`);
    const plan = vi.fn();
    const outbound = { plan } as unknown as OutboundDispatcher;
    const err = await initTelemetry(
      otel({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.vendor.example',
        OAX_OTEL_HEADERS_SECRET: 'otel-headers',
      }),
      { egress: policy, secrets: { resolve }, outbound },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OaxError);
    expect((err as OaxError).code).toBe('airgap_violation');
    expect((err as Error).message).toContain('telemetry.vendor.example');
    expect(resolve).not.toHaveBeenCalled(); // the header secret was never resolved (#220)
    expect(plan).not.toHaveBeenCalled(); // no route, no exporter
    expect(tracingEnabled()).toBe(false); // no SDK provider was registered
    expect(JSON.stringify([(err as Error).message])).not.toContain(HEADER_SECRET);
    expect(policy.status().blocked).toBe(0); // nothing was contacted
  });

  it('refuses a different port of an allowlisted host', async () => {
    const policy = policyFor('collector.internal.example:4318');
    await expect(
      initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.internal.example' }), {
        egress: policy,
      }),
    ).rejects.toMatchObject({ code: 'airgap_violation' });
  });

  it('contacts only the allowlisted internal collector and never trips the guard', async () => {
    const c = await collector();
    const other = await collector();
    const policy = policyFor(`127.0.0.1:${c.port}`);
    guardHandle = installNetworkGuard(policy);
    const { dispatcher, audits } = spyDispatcher({
      network: compileNetwork(parseNetworkConfig({} as NetworkConfig).config, { egress: policy }),
    });
    const t = await initTelemetry(
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }),
      { egress: policy, outbound: dispatcher },
    );
    await span();
    await t.shutdown();
    expect(c.requests.length).toBeGreaterThan(0);
    expect(other.requests).toEqual([]);
    expect(new Set(audits.map((a) => a.target?.host))).toEqual(new Set(['127.0.0.1']));
    expect(new Set(audits.map((a) => a.purpose))).toEqual(new Set(['telemetry']));
    expect(policy.status().blocked).toBe(0);
    await c.close();
    await other.close();
    await dispatcher.close();
  });

  it('the dispatcher refuses the endpoint on its own when the network carries the policy (defence in depth)', async () => {
    const policy = policyFor('collector.internal.example:4318');
    const fetchImpl = vi.fn();
    const dispatcher = createOutboundDispatcher({
      network: compileNetwork(parseNetworkConfig({} as NetworkConfig).config, { egress: policy }),
      fetchImpl,
    });
    // `egress` is omitted on purpose: only the dispatcher's own air-gapped rule is in play.
    await expect(
      initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://telemetry.vendor.example' }), {
        egress: new EgressPolicy({ airgapped: false }),
        outbound: dispatcher,
      }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tracingEnabled()).toBe(false);
  });
});

describe('destination checks at start-up (SSRF-style)', () => {
  it.each([
    ['the cloud metadata address', 'https://169.254.169.254'],
    ['the IPv6 metadata address', 'https://[fd00:ec2::254]'],
    ['the GCP metadata name', 'https://metadata.google.internal'],
  ])('refuses %s and sends nothing', async (_name, endpoint) => {
    const fetchImpl = vi.fn();
    const dispatcher = createOutboundDispatcher({ fetchImpl });
    const err = await initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }), {
      outbound: dispatcher,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'egress_denied' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tracingEnabled()).toBe(false);
  });

  it('the metadata address stays refused with an explicit insecure http endpoint', async () => {
    const dispatcher = createOutboundDispatcher({ fetchImpl: vi.fn() });
    await expect(
      initTelemetry(
        otel({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://169.254.169.254',
          OAX_OTEL_INSECURE: 'true',
        }),
        { outbound: dispatcher },
      ),
    ).rejects.toMatchObject({ code: 'egress_denied' });
  });

  it('honours a deny route of the network configuration for purpose telemetry', async () => {
    const dispatcher = createOutboundDispatcher({
      network: netOf({
        routes: [
          {
            name: 'no-vendor',
            match: { hosts: ['*.vendor.example'], purposes: ['telemetry'] },
            via: 'deny',
          },
        ],
      }),
      fetchImpl: vi.fn(),
    });
    await expect(
      initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.vendor.example' }), {
        outbound: dispatcher,
      }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
  });

  it('does not follow a redirect: the target of the redirect is never contacted', async () => {
    const victim = await collector();
    const c = await collector('redirect', `${victim.url}/v1/traces`);
    const stats = failureRecorder();
    const t = await initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url }), {
      secrets: new StaticSecretResolver({}),
    });
    t.attachStats(stats.stats);
    await span();
    await t.shutdown();
    expect(c.requests.length).toBeGreaterThan(0);
    expect(victim.requests).toEqual([]);
    expect(stats.reasons).toContain('network');
    await c.close();
    await victim.close();
  });
});

function failureRecorder() {
  const reasons: string[] = [];
  const stats = {
    attributesDropped: () => undefined,
    redactions: () => undefined,
    spansDropped: () => undefined,
    exportFailed: (r: string) => void reasons.push(r),
    inboundContext: () => undefined,
    nodeEventsDropped: () => undefined,
    nodeContextMismatch: () => undefined,
    keepKept: () => undefined,
    keepEvicted: () => undefined,
  };
  return { stats, reasons };
}

describe('the traffic goes through the dispatcher', () => {
  it('posts with purpose telemetry, the configured headers and the right content type', async () => {
    const c = await collector();
    const { dispatcher, audits } = spyDispatcher();
    const t = await initTelemetry(
      otel({
        OTEL_EXPORTER_OTLP_ENDPOINT: c.url,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OAX_OTEL_HEADERS_SECRET: 'otel-headers',
      }),
      {
        outbound: dispatcher,
        secrets: new StaticSecretResolver({ 'otel-headers': `x-api-key=${HEADER_SECRET}` }),
      },
    );
    await span();
    await t.shutdown();
    expect(audits.length).toBeGreaterThan(1); // start-up plan and at least one request
    expect(audits.every((a) => a.purpose === 'telemetry' && a.decision === 'direct')).toBe(true);
    const r = c.requests[0]!;
    expect(r.url).toBe('/v1/traces');
    expect(r.headers['x-api-key']).toBe(HEADER_SECRET);
    expect(r.headers['content-type']).toBe('application/json');
    expect(JSON.parse(r.body.toString()).resourceSpans[0].scopeSpans[0].spans[0].name).toBe(
      'oax.run',
    );
    // The audit record the dispatcher reports never carries the credential.
    expect(JSON.stringify(audits)).not.toContain(HEADER_SECRET);
    await c.close();
  });

  it('sends protobuf by default and gzip on request', async () => {
    const c = await collector();
    const t = await initTelemetry(
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url, OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip' }),
    );
    await span();
    await t.shutdown();
    const r = c.requests[0]!;
    expect(r.headers['content-type']).toBe('application/x-protobuf');
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(r.body).byteLength).toBeGreaterThan(0);
    await c.close();
  });

  it('a dispatcher it created itself is closed on shutdown; one that was passed in is not', async () => {
    const c = await collector();
    const closed = vi.fn(async () => undefined);
    const real = createOutboundDispatcher();
    const passed = Object.assign(Object.create(real) as OutboundDispatcher, { close: closed });
    const t = await initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url }), {
      outbound: passed,
    });
    await span();
    await t.shutdown();
    expect(closed).not.toHaveBeenCalled();
    await c.close();
    await real.close();
  });
});

describe('TLS and mTLS', () => {
  let dir: string;
  let key: string;
  let cert: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'oax-otlp-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        path.join(dir, 'k.pem'),
        '-out',
        path.join(dir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    );
    key = readFileSync(path.join(dir, 'k.pem'), 'utf8');
    cert = readFileSync(path.join(dir, 'c.pem'), 'utf8');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function tlsCollector(requireCert: boolean) {
    const seen: { peer: boolean }[] = [];
    const server: TlsServer = createTlsServer(
      { key, cert, requestCert: requireCert, rejectUnauthorized: false, ca: cert },
      (req, res) => {
        const peer = Boolean((req.socket as TLSSocket).getPeerCertificate().subject);
        req.resume();
        req.on('end', () => {
          seen.push({ peer });
          res.statusCode = requireCert && !peer ? 401 : 200;
          res.end();
        });
      },
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `https://localhost:${port}`,
      seen,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  }

  it('verifies the certificate: an untrusted collector receives nothing', async () => {
    const c = await tlsCollector(false);
    const stats = failureRecorder();
    const t = await initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url }));
    t.attachStats(stats.stats);
    await span();
    await t.shutdown();
    expect(c.seen).toEqual([]);
    expect(stats.reasons).toContain('network');
    await c.close();
  });

  it('trusts a bundle from the network configuration and presents the client certificate (mTLS route)', async () => {
    const c = await tlsCollector(true);
    // The pre-loaded snapshot comes from the secret resolver, as in the entry points.
    const t = await initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url }), {
      network: netOf({
        trust: { mode: 'system+extra', bundles: [{ name: 'pki', secret: 'pki.ca' }] },
        clientCertificates: [{ name: 'gw', certSecret: 'gw.cert', keySecret: 'gw.key' }],
        routes: [
          {
            name: 'otel-mtls',
            match: { hosts: ['localhost'], purposes: ['telemetry'] },
            via: 'direct',
            clientCertificate: 'gw',
          },
        ],
      }),
      secrets: new StaticSecretResolver({ 'pki.ca': cert, 'gw.cert': cert, 'gw.key': key }),
    });
    await span();
    await t.shutdown();
    expect(c.seen.length).toBeGreaterThan(0);
    expect(c.seen.every((s) => s.peer)).toBe(true);
    await c.close();
  });

  it('the route to the mTLS collector is reported with the client certificate name only', async () => {
    const { dispatcher, audits } = spyDispatcher({
      network: netOf({
        clientCertificates: [{ name: 'gw', certSecret: 'gw.cert', keySecret: 'gw.key' }],
        routes: [
          {
            match: { hosts: ['localhost'], purposes: ['telemetry'] },
            via: 'direct',
            clientCertificate: 'gw',
          },
        ],
      }),
      secrets: (ref) => ({ 'gw.cert': cert, 'gw.key': key })[ref],
    });
    dispatcher.plan('https://localhost:4318/v1/traces', { purpose: 'telemetry' });
    expect(audits[0]?.clientCertificate).toBe('gw');
    expect(JSON.stringify(audits)).not.toContain('PRIVATE KEY');
    await dispatcher.close();
  });

  it('refuses start-up when the route needs a secret that cannot be loaded', async () => {
    const err = await initTelemetry(
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://localhost:4318' }),
      {
        network: netOf({
          clientCertificates: [{ name: 'gw', certSecret: 'gw.cert', keySecret: 'gw.key' }],
          routes: [
            {
              match: { hosts: ['localhost'], purposes: ['telemetry'] },
              via: 'direct',
              clientCertificate: 'gw',
            },
          ],
        }),
        secrets: new StaticSecretResolver({}),
      },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'network_secret_unavailable' });
    expect(tracingEnabled()).toBe(false);
  });

  it('plain http needs OAX_OTEL_INSECURE (or loopback)', () => {
    expect(() =>
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.internal.example:4318' }),
    ).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
    expect(
      otel({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.internal.example:4318',
        OAX_OTEL_INSECURE: 'true',
      }).endpoint,
    ).toBe('http://collector.internal.example:4318');
  });

  it('refuses to run with TLS verification switched off', async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      await expect(
        initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.org' })),
      ).rejects.toBeInstanceOf(OaxError);
      expect(tracingEnabled()).toBe(false);
    } finally {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  });
});

describe('never blocking, bounded', () => {
  it('a hanging collector fails the export within the timeout and does not delay the caller', async () => {
    const c = await collector('hang');
    const stats = failureRecorder();
    const t = await initTelemetry(
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url, OAX_OTEL_EXPORT_TIMEOUT_MS: '300' }),
    );
    t.attachStats(stats.stats);
    const started = Date.now();
    await span();
    expect(Date.now() - started).toBeLessThan(250);
    await t.shutdown();
    expect(stats.reasons).toContain('timeout');
    await c.close();
  });

  it('an unreachable collector and an oversized response are counted and never throw', async () => {
    const down = await collector();
    const gone = down.url;
    await down.close();
    const huge = await collector('huge');
    for (const url of [gone, huge.url]) {
      trace.disable();
      resetTelemetryRuntime();
      const stats = failureRecorder();
      const t = await initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: url }));
      t.attachStats(stats.stats);
      await expect(span()).resolves.toBe(1);
      await t.shutdown();
      expect(stats.reasons.length, url).toBeGreaterThan(0);
    }
    await huge.close();
  });

  it('limits concurrent requests and fails the surplus batch at once', async () => {
    let pending = 0;
    const dispatcher = {
      fetch: () => {
        pending++;
        return new Promise<Response>(() => undefined); // never answers
      },
      close: async () => undefined,
    } as unknown as OutboundDispatcher;
    const exporter = new DispatcherSpanExporter({
      dispatcher,
      url: 'https://collector.example.org/v1/traces',
      protocol: 'http/json',
      compression: 'none',
      timeoutMs: 1000,
    });
    const results: ExportResultCode[] = [];
    for (let i = 0; i < MAX_IN_FLIGHT + 1; i++) exporter.export([], (r) => results.push(r.code));
    await new Promise((r) => setTimeout(r, 20));
    expect(pending).toBe(MAX_IN_FLIGHT);
    expect(results).toEqual([ExportResultCode.FAILED]);
  });
});

describe('export failure reasons stay a closed set', () => {
  it('classifies an oversized declared response and a runtime egress denial on their own', async () => {
    const huge = await collector('huge');
    const stats = failureRecorder();
    const t = await initTelemetry(otel({ OTEL_EXPORTER_OTLP_ENDPOINT: huge.url }));
    t.attachStats(stats.stats);
    await span();
    await t.shutdown();
    expect(stats.reasons).toContain('too_large');
    await huge.close();

    trace.disable();
    resetTelemetryRuntime();
    // Loopback is always direct, so use a named internal collector and a stub transport.
    const policy = policyFor('collector.internal.example:4318');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const network = compileNetwork(parseNetworkConfig({} as NetworkConfig).config, {
      egress: policy,
    });
    const stats2 = failureRecorder();
    const t2 = await initTelemetry(
      otel({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.internal.example:4318' }),
      { egress: policy, outbound: createOutboundDispatcher({ network, fetchImpl }) },
    );
    t2.attachStats(stats2.stats);
    // The policy changes after start-up: the next request is refused by the dispatcher.
    const closed = new EgressPolicy({ airgapped: true, allow: [] });
    Object.assign(policy, {
      isAllowed: closed.isAllowed.bind(closed),
      covers: closed.covers.bind(closed),
    });
    await span();
    await t2.shutdown();
    expect(stats2.reasons).toContain('denied');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('secret canary on every error path', () => {
  const HEADERS = `x-api-key=${HEADER_SECRET}`;

  async function scenario(
    endpoint: string,
    extra: Record<string, string> = {},
    init: TelemetryInit = {},
  ) {
    const logs: unknown[] = [];
    const metrics = new Metrics('oax_');
    const outcome: unknown[] = [];
    try {
      const t = await initTelemetry(
        otel({
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          OAX_OTEL_HEADERS_SECRET: 'otel-headers',
          ...extra,
        }),
        {
          secrets: new StaticSecretResolver({ 'otel-headers': HEADERS }),
          warn: (f, m) => logs.push([f, m]),
          ...init,
        },
      );
      t.attachStats(metrics.otel);
      await withSpan(
        { name: 'oax.run', kind: 'run' },
        { 'oax.worker': `leaks-${HEADER_SECRET}` },
        async () => {
          throw new OaxError('provider_failed', `header was ${HEADER_SECRET}`);
        },
      ).catch(() => undefined);
      await t.shutdown();
    } catch (e) {
      outcome.push(e);
    }
    const wire = JSON.stringify({
      logs,
      metrics: await rendered(metrics),
      outcome: outcome.map((e) => ({
        message: (e as Error).message,
        name: (e as Error).name,
        cause: String((e as Error).cause ?? ''),
        details: (e as OaxError).details ?? null,
      })),
    });
    return { wire, logs, outcome };
  }

  it.each([
    ['collector answers 500 with a body', 'error500'],
    ['collector hangs', 'hang'],
    ['collector redirects', 'redirect'],
    ['collector sends a huge answer', 'huge'],
  ] as const)('%s', async (_name, behaviour) => {
    const c = await collector(behaviour, 'http://127.0.0.1:9/steal');
    const { wire, outcome } = await scenario(c.url, { OAX_OTEL_EXPORT_TIMEOUT_MS: '300' });
    expect(outcome).toEqual([]);
    expect(wire).not.toContain(HEADER_SECRET);
    expect(wire).not.toContain(BODY_CANARY);
    expect(wire).not.toContain('127.0.0.1:9');
    for (const r of c.requests) expect(r.body.toString('latin1')).not.toContain(HEADER_SECRET);
    await c.close();
  });

  it('connection refused', async () => {
    const c = await collector();
    const url = c.url;
    await c.close();
    const { wire } = await scenario(url);
    expect(wire).not.toContain(HEADER_SECRET);
    expect(wire).toContain('network');
  });

  it('start-up refusals: air gap, metadata address, deny route, missing network secret', async () => {
    const proxied = {
      proxies: [{ name: 'corp', url: 'https://proxy.example:3128', authSecret: 'proxy.auth' }],
      routes: [{ match: { hosts: ['*.corp.example'], purposes: ['telemetry'] }, via: 'corp' }],
    };
    const cases: Array<[string, TelemetryInit]> = [
      ['https://telemetry.vendor.example', { egress: policyFor('') }],
      ['https://169.254.169.254', {}],
      [
        'https://otlp.vendor.example',
        {
          network: netOf({
            routes: [{ name: 'no', match: { hosts: ['*.vendor.example'] }, via: 'deny' }],
          }),
        },
      ],
      // the proxy credential is not available: the route cannot be built
      [
        'https://otlp.corp.example',
        {
          network: netOf(proxied),
          secrets: new StaticSecretResolver({ 'otel-headers': HEADERS }),
        },
      ],
    ];
    for (const [endpoint, init] of cases) {
      trace.disable();
      resetTelemetryRuntime();
      const { wire, outcome } = await scenario(endpoint, {}, init);
      expect(outcome, endpoint).toHaveLength(1);
      expect(wire).not.toContain(HEADER_SECRET);
      expect(tracingEnabled()).toBe(false);
    }
  });

  it('a proxy credential never shows up in logs, metrics or errors, also when the export fails', async () => {
    const { wire, outcome } = await scenario(
      'https://otlp.corp.example',
      { OAX_OTEL_EXPORT_TIMEOUT_MS: '500' },
      {
        network: netOf({
          proxies: [{ name: 'corp', url: 'http://127.0.0.1:9', authSecret: 'proxy.auth' }],
          routes: [{ match: { hosts: ['*.corp.example'], purposes: ['telemetry'] }, via: 'corp' }],
        }),
        secrets: new StaticSecretResolver({ 'otel-headers': HEADERS, 'proxy.auth': NET_SECRET }),
      },
    );
    expect(outcome).toEqual([]);
    expect(wire).not.toContain(NET_SECRET);
    expect(wire).not.toContain(Buffer.from(NET_SECRET).toString('base64'));
    expect(wire).not.toContain(HEADER_SECRET);
  });

  it('an unresolvable or malformed header secret names the reference only', async () => {
    const err = await initTelemetry(
      otel({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.org',
        OAX_OTEL_HEADERS_SECRET: 'bad',
      }),
      { secrets: new StaticSecretResolver({ bad: `host=evil.example.org,k=${HEADER_SECRET}` }) },
    ).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(HEADER_SECRET);
  });
});

describe('no behaviour change when the exporter is off', () => {
  it('creates no dispatcher, reads no secret and registers no provider', async () => {
    const resolve = vi.fn();
    const plan = vi.fn();
    const t = await initTelemetry(otel({}), {
      secrets: { resolve },
      outbound: { plan } as unknown as OutboundDispatcher,
      egress: policyFor(''),
    });
    expect(t.enabled).toBe(false);
    expect(tracingEnabled()).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    // spans still go to the no-op tracer
    expect(tracer().startSpan('x').isRecording()).toBe(false);
  });
});

describe('hostile collector responses are cancelled, not read', () => {
  async function hostile(handler: (res: ServerResponse) => void) {
    const state = { closed: false, written: 0 };
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.on('close', () => (state.closed = true));
        handler(res);
        const write = res.write.bind(res);
        res.write = ((chunk: Buffer | string, ...rest: unknown[]) => {
          state.written += chunk.length;
          return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof res.write;
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}/v1/traces`,
      state,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  }

  const exportOnce = async (url: string) => {
    const dispatcher = createOutboundDispatcher();
    const exporter = new DispatcherSpanExporter({
      dispatcher,
      url,
      protocol: 'http/json',
      compression: 'none',
      timeoutMs: 5000,
    });
    const before = process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed;
    const result = await new Promise<ExportResultCode>((r) =>
      exporter.export([], (x) => r(x.code)),
    );
    return { result, before, dispatcher };
  };

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  };

  it('200 with an endless chunked body: success, the connection is closed, nothing piles up', async () => {
    let timer: NodeJS.Timeout | undefined;
    const c = await hostile((res) => {
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      timer = setInterval(() => res.write(Buffer.alloc(64 * 1024, 120)), 1);
    });
    const { result, before, dispatcher } = await exportOnce(c.url);
    expect(result).toBe(ExportResultCode.SUCCESS);
    await until(() => c.state.closed);
    clearInterval(timer);
    expect(c.state.closed).toBe(true); // the client dropped the socket instead of draining it
    expect(c.state.written).toBeLessThan(32 * 1024 * 1024);
    const after = process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(64 * 1024 * 1024);
    await c.close();
    await dispatcher.close();
  });

  it('200 with a large gzip body: success, the connection is closed, it is not inflated', async () => {
    const bomb = gzipSync(Buffer.alloc(256 * 1024 * 1024, 0));
    let timer: NodeJS.Timeout | undefined;
    const c = await hostile((res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      let off = 0;
      timer = setInterval(() => {
        if (off < bomb.length) res.write(bomb.subarray(off, (off += 16 * 1024)));
      }, 1);
    });
    const { result, before, dispatcher } = await exportOnce(c.url);
    expect(result).toBe(ExportResultCode.SUCCESS);
    await until(() => c.state.closed);
    clearInterval(timer);
    expect(c.state.closed).toBe(true);
    const after = process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(64 * 1024 * 1024);
    await c.close();
    await dispatcher.close();
  });
});
