import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { parseHeaderList, parseResourceAttributes } from '../src/telemetry-config.js';

const base = { OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' };
const otel = (env: Record<string, string> = {}) => loadConfig({ ...base, ...env }).otel;

describe('OpenTelemetry configuration (ADR 0015 section 14)', () => {
  it('has the documented defaults', () => {
    expect(otel()).toEqual({
      endpoint: undefined,
      protocol: 'http/protobuf',
      serviceName: 'openagentix-api',
      resourceAttributes: {},
      headersSecret: undefined,
      insecure: false,
      sampleRatio: 1,
      keep: ['error', 'deny', 'approval', 'budget', 'guard'],
      keepBufferSpans: 512,
      maxQueue: 2048,
      exportTimeoutMs: 10_000,
      nodeEventsMax: 128,
      inboundContext: 'ignore',
      mcpPropagation: 'deny',
      exceptionDetail: 'off',
      genaiMetrics: false,
      traceUrlTemplate: undefined,
    });
  });

  it('parses every key', () => {
    const c = otel({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.org:4318',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_SERVICE_NAME: 'oax-eu',
      OAX_OTEL_RESOURCE_ATTRIBUTES: 'service.version=1.2.3,deployment.environment.name=prod',
      OAX_OTEL_HEADERS_SECRET: 'otel-headers',
      OAX_OTEL_SAMPLE_RATIO: '0.25',
      OAX_OTEL_KEEP: 'error,deny',
      OAX_OTEL_KEEP_BUFFER_SPANS: '64',
      OAX_OTEL_MAX_QUEUE: '100',
      OAX_OTEL_EXPORT_TIMEOUT_MS: '2000',
      OAX_OTEL_NODE_EVENTS_MAX: '16',
      OAX_OTEL_INBOUND_CONTEXT: 'link',
      OAX_OTEL_MCP_PROPAGATION: 'allow',
      OAX_OTEL_EXCEPTION_DETAIL: 'guarded',
      OAX_OTEL_GENAI_METRICS: 'true',
      OAX_OTEL_TRACE_URL_TEMPLATE: 'https://tempo.internal/trace/{traceId}',
    });
    expect(c).toMatchObject({
      endpoint: 'https://collector.example.org:4318',
      protocol: 'http/json',
      serviceName: 'oax-eu',
      resourceAttributes: { 'service.version': '1.2.3', 'deployment.environment.name': 'prod' },
      headersSecret: 'otel-headers',
      sampleRatio: 0.25,
      keep: ['error', 'deny'],
      keepBufferSpans: 64,
      maxQueue: 100,
      exportTimeoutMs: 2000,
      nodeEventsMax: 16,
      inboundContext: 'link',
      mcpPropagation: 'allow',
      exceptionDetail: 'guarded',
      genaiMetrics: true,
      traceUrlTemplate: 'https://tempo.internal/trace/{traceId}',
    });
  });

  it.each([
    ['OAX_OTEL_SAMPLE_RATIO', '1.5'],
    ['OAX_OTEL_MAX_QUEUE', '0'],
    ['OAX_OTEL_INBOUND_CONTEXT', 'trust'],
    ['OAX_OTEL_EXCEPTION_DETAIL', 'full'],
    ['OAX_OTEL_KEEP', 'error,everything'],
    ['OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc'],
    ['OAX_OTEL_TRACE_URL_TEMPLATE', 'https://tempo.internal/trace/'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => otel({ [key]: value })).toThrow(new RegExp(key));
  });

  it('accepts OAX_OTEL_CONTENT=off only (content capture is slice S10)', () => {
    expect(() => otel({ OAX_OTEL_CONTENT: 'off' })).not.toThrow();
    expect(() => otel({ OAX_OTEL_CONTENT: 'redacted' })).toThrow(/OAX_OTEL_CONTENT/);
  });
});

describe('standard OTLP credential and certificate variables are refused', () => {
  const suffixes = ['HEADERS', 'CERTIFICATE', 'CLIENT_CERTIFICATE', 'CLIENT_KEY'];
  const names = suffixes.flatMap((s) => [
    `OTEL_EXPORTER_OTLP_${s}`,
    `OTEL_EXPORTER_OTLP_TRACES_${s}`,
  ]);

  it.each(names)('%s fails start-up and names the replacement', (name) => {
    expect(() => otel({ [name]: 'Authorization=Bearer fake-token-value-123' })).toThrow(
      new RegExp(`${name} \\(use `),
    );
  });

  it('refuses them even without an endpoint (fail closed, no latent second path)', () => {
    expect(() => otel({ OTEL_EXPORTER_OTLP_HEADERS: 'a=b' })).toThrow(/not supported/);
  });

  it('never echoes the value of a refused variable', () => {
    const secret = 'Authorization=Bearer super-secret-collector-token-0123456789';
    try {
      otel({ OTEL_EXPORTER_OTLP_HEADERS: secret });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret');
      expect((e as { code?: string }).code).toBe('config_invalid');
    }
  });

  it('refuses a signal-specific endpoint override (one configuration path)', () => {
    expect(() => otel({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://other.example.org' })).toThrow(
      /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/,
    );
  });

  it('treats an empty value like an unset variable', () => {
    expect(() => otel({ OTEL_EXPORTER_OTLP_HEADERS: '  ' })).not.toThrow();
  });

  it.each(['OTEL_TRACES_SAMPLER', 'OTEL_TRACES_SAMPLER_ARG'])(
    '%s is refused: the SDK would build its own sampler from it (use OAX_OTEL_SAMPLE_RATIO)',
    (name) => {
      expect(() => otel({ [name]: 'always_off' })).toThrow(
        new RegExp(`${name} \\(use OAX_OTEL_SAMPLE_RATIO`),
      );
    },
  );
});

describe('variables that look like "export off" but are not read', () => {
  const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.org' };

  it.each([
    ['OTEL_SDK_DISABLED', 'true'],
    ['OTEL_SDK_DISABLED', 'TRUE'],
    ['OTEL_TRACES_EXPORTER', 'none'],
    ['OTEL_TRACES_EXPORTER', 'console'],
  ])('%s=%s together with an endpoint fails start-up', (name, value) => {
    expect(() => otel({ ...endpoint, [name]: value })).toThrow(/unset OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  it('is harmless without an endpoint or when it agrees with the export', () => {
    expect(() => otel({ OTEL_SDK_DISABLED: 'true', OTEL_TRACES_EXPORTER: 'none' })).not.toThrow();
    expect(() =>
      otel({ ...endpoint, OTEL_SDK_DISABLED: 'false', OTEL_TRACES_EXPORTER: 'otlp' }),
    ).not.toThrow();
  });
});

describe('endpoint rules', () => {
  const endpoint = (url: string, extra: Record<string, string> = {}) =>
    otel({ OTEL_EXPORTER_OTLP_ENDPOINT: url, ...extra });

  it('accepts https and loopback http', () => {
    expect(endpoint('https://collector.example.org').endpoint).toBe(
      'https://collector.example.org',
    );
    for (const url of ['http://127.0.0.1:4318', 'http://localhost:4318', 'http://[::1]:4318'])
      expect(endpoint(url).endpoint).toBe(url);
  });

  it('refuses plain http to a non-loopback host unless OAX_OTEL_INSECURE=true', () => {
    expect(() => endpoint('http://otel-collector.monitoring.svc:4318')).toThrow(
      /OAX_OTEL_INSECURE/,
    );
    expect(() => endpoint('http://10.1.2.3:4318')).toThrow(/OAX_OTEL_INSECURE/);
    expect(
      endpoint('http://otel-collector.monitoring.svc:4318', { OAX_OTEL_INSECURE: 'true' }).endpoint,
    ).toBe('http://otel-collector.monitoring.svc:4318');
  });

  it('refuses credentials, queries and fragments in the URL', () => {
    for (const url of [
      'https://user:pw@collector.example.org',
      'https://collector.example.org?api_key=abc',
      'https://collector.example.org#frag',
    ])
      expect(() => endpoint(url)).toThrow(/OAX_OTEL_HEADERS_SECRET/);
  });

  it('applies the loopback rule to the address the URL parser normalises to', () => {
    for (const url of [
      'http://2130706433:4318', // decimal 127.0.0.1
      'http://0x7f.1:4318', // hex/short form
      'http://127.1.2.3:4318',
      'http://[::ffff:127.0.0.1]:4318',
      'http://LOCALHOST:4318',
    ])
      expect(() => endpoint(url)).not.toThrow();
    for (const url of [
      'http://127.0.0.1.nip.io:4318',
      'http://localhost.example.org:4318',
      'http://0.0.0.0:4318',
      'http://169.254.169.254',
      'http://[::]:4318',
      'http://[fe80::1]:4318',
    ])
      expect(() => endpoint(url)).toThrow(/OAX_OTEL_INSECURE/);
  });

  it('refuses non-http schemes and garbage', () => {
    expect(() => endpoint('file:///etc/passwd')).toThrow(/http\(s\)/);
    expect(() => endpoint('not a url')).toThrow(/valid URL/);
  });

  it('does not echo the URL (it may have carried a credential)', () => {
    try {
      endpoint('https://user:hunter2-hunter2@collector.example.org');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });
});

describe('resource attributes are static and validated', () => {
  it('parses a key=value list', () => {
    expect(parseResourceAttributes('a.b=1, c_d = two ')).toEqual({ 'a.b': '1', c_d: 'two' });
    expect(parseResourceAttributes(undefined)).toEqual({});
  });

  it.each([
    ['service.name=x', /OTEL_SERVICE_NAME/],
    ['oax.tenant.id=3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b', /not allowed/],
    ['api_key=abc', /not allowed/],
    ['auth.token=abc', /not allowed/],
    ['Bad Key=1', /lower-case/],
    ['k=', /printable/],
    ['k=ghp_' + 'a1B2c3D4e5'.repeat(4), /looks like a secret/],
    ['k=1,k=2', /duplicate/],
  ])('refuses %s', (raw, why) => {
    expect(() => parseResourceAttributes(raw)).toThrow(why);
  });
});

describe('exporter header list', () => {
  it('parses Name=value pairs', () => {
    expect(parseHeaderList('x-api-key=abc123, X-Org=1')).toEqual({
      'x-api-key': 'abc123',
      'X-Org': '1',
    });
  });

  it('refuses reserved names, empty values and empty lists without echoing values', () => {
    expect(() => parseHeaderList('Host=evil.example.org')).toThrow(/reserved/);
    expect(() => parseHeaderList('content-type=text/plain')).toThrow(/reserved/);
    expect(() => parseHeaderList('x-key=')).toThrow(/empty or invalid/);
    expect(() => parseHeaderList(' , ')).toThrow(/no headers/);
    try {
      parseHeaderList('x-key=abc\nInjected: yes');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('Injected');
    }
  });
});
