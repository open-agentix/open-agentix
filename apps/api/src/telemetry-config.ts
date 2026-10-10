import { ContextGuard, OaxError, classifyAddress, parseIp } from '@openagentix/core';
import { z } from 'zod';

/**
 * OpenTelemetry configuration (ADR 0015 sections 8 and 14). Everything is validated at start-up
 * and fails closed with an error that names the variable and never echoes a value that could be a
 * credential. Keys of later slices are parsed here already so that a bad value is found early;
 * what each one does is documented in docs/observability.md.
 */

const flag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');
const bounded = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

export const KEEP_CLASSES = ['error', 'deny', 'approval', 'budget', 'guard'] as const;
export type KeepClass = (typeof KEEP_CLASSES)[number];

/** Zod fields merged into the environment schema of `config.ts`. */
export const OTEL_ENV_SHAPE = {
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_EXPORTER_OTLP_PROTOCOL: z.enum(['http/protobuf', 'http/json']).default('http/protobuf'),
  OTEL_SERVICE_NAME: z.string().optional(),
  OAX_OTEL_RESOURCE_ATTRIBUTES: z.string().optional(),
  OAX_OTEL_HEADERS_SECRET: z.string().optional(),
  OAX_OTEL_INSECURE: flag.default(false),
  OAX_OTEL_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),
  OAX_OTEL_KEEP: z.string().default(KEEP_CLASSES.join(',')),
  OAX_OTEL_KEEP_BUFFER_SPANS: bounded(512, 1, 100_000),
  OAX_OTEL_MAX_QUEUE: bounded(2048, 1, 1_000_000),
  OAX_OTEL_EXPORT_TIMEOUT_MS: bounded(10_000, 100, 600_000),
  OAX_OTEL_NODE_EVENTS_MAX: bounded(128, 0, 10_000),
  OAX_OTEL_INBOUND_CONTEXT: z.enum(['ignore', 'link']).default('ignore'),
  OAX_OTEL_MCP_PROPAGATION: z.enum(['deny', 'allow']).default('deny'),
  OAX_OTEL_EXCEPTION_DETAIL: z.enum(['off', 'guarded']).default('off'),
  // Content capture is a separate, owner-gated decision (slice S10): only `off` is accepted.
  OAX_OTEL_CONTENT: z.literal('off').default('off'),
  OAX_OTEL_GENAI_METRICS: flag.default(false),
  OAX_OTEL_TRACE_URL_TEMPLATE: z.string().optional(),
};

export interface OtelConfig {
  endpoint: string | undefined;
  protocol: 'http/protobuf' | 'http/json';
  serviceName: string;
  resourceAttributes: Record<string, string>;
  /** Reference (never the value) of the secret that holds the exporter headers. */
  headersSecret: string | undefined;
  insecure: boolean;
  sampleRatio: number;
  keep: KeepClass[];
  keepBufferSpans: number;
  maxQueue: number;
  exportTimeoutMs: number;
  nodeEventsMax: number;
  inboundContext: 'ignore' | 'link';
  mcpPropagation: 'deny' | 'allow';
  exceptionDetail: 'off' | 'guarded';
  genaiMetrics: boolean;
  traceUrlTemplate: string | undefined;
}

/**
 * The standard exporter variables that carry credentials or trust material, or that would add a
 * second configuration path next to ours. The SDK reads them implicitly (`otlp-exporter-base`),
 * merges headers with what the code passes and loads certificate files, so they are refused rather
 * than ignored: exactly one path (`OAX_OTEL_HEADERS_SECRET`, the network configuration) exists.
 */
const REFUSED: Record<string, string> = {};
for (const [suffix, instead] of [
  ['HEADERS', 'OAX_OTEL_HEADERS_SECRET (a secret reference holding the headers)'],
  ['CERTIFICATE', 'a trust bundle in the network configuration (ADR 0011)'],
  ['CLIENT_CERTIFICATE', 'a client certificate in the network configuration (ADR 0011)'],
  ['CLIENT_KEY', 'a client certificate in the network configuration (ADR 0011)'],
] as const) {
  REFUSED[`OTEL_EXPORTER_OTLP_${suffix}`] = instead;
  REFUSED[`OTEL_EXPORTER_OTLP_TRACES_${suffix}`] = instead;
}
REFUSED.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'OTEL_EXPORTER_OTLP_ENDPOINT';
REFUSED.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'OTEL_EXPORTER_OTLP_PROTOCOL';
// The SDK builds its sampler from these; sampling is configured with OAX_OTEL_SAMPLE_RATIO
// (ADR 0015 section 9), and the code passes its own sampler.
REFUSED.OTEL_TRACES_SAMPLER = 'OAX_OTEL_SAMPLE_RATIO';
REFUSED.OTEL_TRACES_SAMPLER_ARG = 'OAX_OTEL_SAMPLE_RATIO';

/** Fails start-up when a refused standard variable is set (values are never echoed). */
export function refuseStandardOtlpVariables(env: NodeJS.ProcessEnv): void {
  const found = Object.keys(REFUSED).filter((k) => (env[k] ?? '').trim() !== '');
  if (found.length === 0) return;
  const details = found.map((k) => `${k} (use ${REFUSED[k]})`).join('; ');
  throw new OaxError(
    'config_invalid',
    `invalid configuration: the standard OpenTelemetry exporter variable(s) are not supported: ${details}`,
  );
}

/**
 * `OTEL_SDK_DISABLED=true` and `OTEL_TRACES_EXPORTER=none` (or any exporter but `otlp`) are read
 * by the SDK's auto-configuration only, which this platform does not use. Together with an endpoint
 * they would look like "export off" while spans are exported, so that combination is refused.
 */
export function refuseDisablingVariables(
  env: NodeJS.ProcessEnv,
  endpoint: string | undefined,
): void {
  if (!endpoint) return;
  const disabled = (env.OTEL_SDK_DISABLED ?? '').trim().toLowerCase() === 'true';
  const exporter = (env.OTEL_TRACES_EXPORTER ?? '').trim().toLowerCase();
  if (disabled || (exporter !== '' && exporter !== 'otlp'))
    throw new OaxError(
      'config_invalid',
      'invalid configuration: OTEL_SDK_DISABLED and OTEL_TRACES_EXPORTER are not read; to turn the export off, unset OTEL_EXPORTER_OTLP_ENDPOINT',
    );
}

function bad(variable: string, why: string): never {
  throw new OaxError('config_invalid', `invalid configuration: ${variable}: ${why}`);
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const ip = parseIp(hostname);
  return ip !== null && classifyAddress(ip) === 'loopback';
}

/** Endpoint rules: absolute http(s) URL, no credentials/query/fragment, TLS unless loopback. */
function validateEndpoint(endpoint: string, insecure: boolean): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return bad('OTEL_EXPORTER_OTLP_ENDPOINT', 'must be a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    bad('OTEL_EXPORTER_OTLP_ENDPOINT', 'must be an http(s) URL');
  if (url.username || url.password || url.search || url.hash)
    bad(
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'must not contain credentials, a query or a fragment (use OAX_OTEL_HEADERS_SECRET for credentials)',
    );
  if (url.protocol === 'http:' && !insecure && !isLoopbackHost(url.hostname))
    bad(
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'plain http:// is only accepted for loopback; use https:// or set OAX_OTEL_INSECURE=true for an in-cluster collector',
    );
  return endpoint;
}

const RESOURCE_KEY = /^[a-z][a-z0-9_.]{0,63}$/;
const SECRET_LIKE_KEY = /secret|password|passwd|token|credential|authorization|api[_.]?key|private/;
const MAX_RESOURCE_ATTRIBUTES = 32;

/** `key=value,key=value`: static, validated, no tenant identity and nothing secret-shaped. */
export function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw?.trim()) return out;
  const guard = new ContextGuard();
  const entries = raw.split(',').filter((s) => s.trim() !== '');
  if (entries.length > MAX_RESOURCE_ATTRIBUTES)
    bad('OAX_OTEL_RESOURCE_ATTRIBUTES', `at most ${MAX_RESOURCE_ATTRIBUTES} entries`);
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const key = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    const value = eq < 0 ? '' : entry.slice(eq + 1).trim();
    if (!RESOURCE_KEY.test(key))
      bad(
        'OAX_OTEL_RESOURCE_ATTRIBUTES',
        'keys must be lower-case dotted names (a-z, 0-9, _ and .)',
      );
    if (key === 'service.name')
      bad('OAX_OTEL_RESOURCE_ATTRIBUTES', 'service.name is set with OTEL_SERVICE_NAME');
    if (key.startsWith('oax.tenant') || SECRET_LIKE_KEY.test(key))
      bad(
        'OAX_OTEL_RESOURCE_ATTRIBUTES',
        `key "${key}" is not allowed (tenant identity or secret-like)`,
      );
    // eslint-disable-next-line no-control-regex
    if (value === '' || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value))
      bad('OAX_OTEL_RESOURCE_ATTRIBUTES', `value of "${key}" must be 1-128 printable characters`);
    if (guard.text(value).text !== value)
      bad('OAX_OTEL_RESOURCE_ATTRIBUTES', `value of "${key}" looks like a secret or hidden text`);
    if (key in out) bad('OAX_OTEL_RESOURCE_ATTRIBUTES', `duplicate key "${key}"`);
    out[key] = value;
  }
  return out;
}

function parseKeep(raw: string): KeepClass[] {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = items.filter((i) => !(KEEP_CLASSES as readonly string[]).includes(i));
  if (unknown.length > 0)
    bad('OAX_OTEL_KEEP', `unknown class(es), expected any of ${KEEP_CLASSES.join(', ')}`);
  return [...new Set(items)] as KeepClass[];
}

function validateTemplate(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!raw.includes('{traceId}')) bad('OAX_OTEL_TRACE_URL_TEMPLATE', 'must contain {traceId}');
  try {
    const u = new URL(raw.replace('{traceId}', '0'.repeat(32)));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    if (u.username || u.password) throw new Error('credentials');
  } catch {
    bad('OAX_OTEL_TRACE_URL_TEMPLATE', 'must be an http(s) URL without credentials');
  }
  return raw;
}

type OtelEnv = z.infer<z.ZodObject<typeof OTEL_ENV_SHAPE>>;

/** Builds the typed configuration; throws `config_invalid` for anything unsafe. */
export function buildOtelConfig(
  e: OtelEnv,
  defaultServiceName: string,
  env: NodeJS.ProcessEnv,
): OtelConfig {
  refuseStandardOtlpVariables(env);
  const endpoint = e.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
    ? validateEndpoint(e.OTEL_EXPORTER_OTLP_ENDPOINT.trim(), e.OAX_OTEL_INSECURE)
    : undefined;
  refuseDisablingVariables(env, endpoint);
  return {
    endpoint,
    protocol: e.OTEL_EXPORTER_OTLP_PROTOCOL,
    serviceName: e.OTEL_SERVICE_NAME || defaultServiceName,
    resourceAttributes: parseResourceAttributes(e.OAX_OTEL_RESOURCE_ATTRIBUTES),
    headersSecret: e.OAX_OTEL_HEADERS_SECRET?.trim() || undefined,
    insecure: e.OAX_OTEL_INSECURE,
    sampleRatio: e.OAX_OTEL_SAMPLE_RATIO,
    keep: parseKeep(e.OAX_OTEL_KEEP),
    keepBufferSpans: e.OAX_OTEL_KEEP_BUFFER_SPANS,
    maxQueue: e.OAX_OTEL_MAX_QUEUE,
    exportTimeoutMs: e.OAX_OTEL_EXPORT_TIMEOUT_MS,
    nodeEventsMax: e.OAX_OTEL_NODE_EVENTS_MAX,
    inboundContext: e.OAX_OTEL_INBOUND_CONTEXT,
    mcpPropagation: e.OAX_OTEL_MCP_PROPAGATION,
    exceptionDetail: e.OAX_OTEL_EXCEPTION_DETAIL,
    genaiMetrics: e.OAX_OTEL_GENAI_METRICS,
    traceUrlTemplate: validateTemplate(e.OAX_OTEL_TRACE_URL_TEMPLATE),
  };
}

/** Parses `Name=value,Name2=value2` header lists (the OTLP format) from a resolved secret. */
export function parseHeaderList(raw: string): Record<string, string> {
  const FORBIDDEN = new Set([
    'host',
    'content-length',
    'content-type',
    'content-encoding',
    'transfer-encoding',
    'connection',
  ]);
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    if (part.trim() === '') continue;
    const eq = part.indexOf('=');
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    const value = eq < 0 ? '' : part.slice(eq + 1).trim();
    // Names only in the error: the value is a credential.
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name) || FORBIDDEN.has(name.toLowerCase()))
      throw new OaxError(
        'config_invalid',
        'OAX_OTEL_HEADERS_SECRET holds an invalid or reserved header name',
      );
    // eslint-disable-next-line no-control-regex
    if (value === '' || /[\u0000-\u001f\u007f]/.test(value))
      throw new OaxError(
        'config_invalid',
        `OAX_OTEL_HEADERS_SECRET: header "${name}" has an empty or invalid value`,
      );
    out[name] = value;
  }
  if (Object.keys(out).length === 0)
    throw new OaxError('config_invalid', 'OAX_OTEL_HEADERS_SECRET holds no headers');
  return out;
}
