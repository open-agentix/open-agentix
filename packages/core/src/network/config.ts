import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../canonical.js';
import { CLASSIFICATIONS, type Classification } from '../classification.js';
import type { AllowEntry, EgressPolicy } from '../egress.js';
import { OaxError } from '../errors.js';
import { isWildcardAll, parseHostPattern, parseNoProxy, type HostPattern } from './hosts.js';
import {
  NEVER_PRIVATE_CLASSES,
  PRIVATE_ALLOW_MIN_BITS,
  classifyAddress,
  parseIp,
  rangeTouchesForbidden,
} from './ip.js';

/**
 * Network configuration contract (ADR 0011 section 1): named proxies with credentials from secret
 * references, trust bundles, client certificates, ordered routes and the tenant selection rules.
 * Everything in this file is pure (parsing, validation, compilation); the only I/O is the optional
 * config file read in `loadNetworkSettings`, through an injectable reader.
 */
export const NETWORK_PURPOSES = [
  'model',
  'mcp',
  'webhook',
  'identity',
  'catalog',
  'git',
  'probe',
  'telemetry',
  'node-egress',
  'test',
] as const;
export type NetworkPurpose = (typeof NETWORK_PURPOSES)[number];

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const SECRET_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const RESERVED = new Set(['direct', 'deny']);

const Name = z.string().regex(NAME, 'must be 1-63 characters of letters, digits, "_", "." or "-"');
const SecretRef = z.string().regex(SECRET_REF, 'must be a secret reference name (not a value)');

const ProxySchema = z.strictObject({
  name: Name,
  url: z.string().min(1),
  authSecret: SecretRef.optional(),
  caBundle: Name.optional(),
  tlsInspection: z.boolean().default(false),
  maxClassification: z.enum(CLASSIFICATIONS).optional(),
});

const BundleSchema = z.strictObject({
  name: Name,
  file: z
    .string()
    .regex(/^\/[^\0]+$/, 'must be an absolute path')
    .optional(),
  secret: SecretRef.optional(),
});

const ClientCertSchema = z.strictObject({
  name: Name,
  certSecret: SecretRef,
  keySecret: SecretRef,
});

const RouteSchema = z.strictObject({
  name: Name.optional(),
  match: z.strictObject({
    hosts: z.array(z.string().min(1)).min(1),
    purposes: z.array(z.enum(NETWORK_PURPOSES)).min(1).optional(),
  }),
  via: z.string().min(1),
  clientCertificate: Name.optional(),
});

export const NetworkConfigSchema = z.strictObject({
  proxies: z.array(ProxySchema).default([]),
  trust: z
    .strictObject({
      mode: z.enum(['system+extra', 'extra-only']).default('system+extra'),
      bundles: z.array(BundleSchema).default([]),
    })
    .default({ mode: 'system+extra', bundles: [] }),
  clientCertificates: z.array(ClientCertSchema).default([]),
  routes: z.array(RouteSchema).default([]),
  tenantSelectable: z.array(Name).default([]),
  /** Client certificates a tenant connection may name; every other name is refused for tenants. */
  tenantSelectableCertificates: z.array(Name).default([]),
  tenantDirect: z.boolean().default(false),
  privateAllow: z.array(z.string().min(1)).default([]),
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

export interface NetworkIssue {
  path: string;
  message: string;
}

/** Key names that would switch certificate verification off: refused anywhere in the document. */
const INSECURE_KEY =
  /insecure|reject[-_]?unauthori[sz]ed|skip[-_]?(tls|ssl|cert|verif)|no[-_]?verify|verify[-_]?(tls|ssl|cert|peer|host)|disable[-_]?(tls|ssl|cert|verif)|tls[-_]?verify|ssl[-_]?verify/i;
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Recursively refuses prototype keys and keys that would disable TLS verification. */
export function scanForbiddenKeys(value: unknown, path = '', depth = 0): NetworkIssue[] {
  const out: NetworkIssue[] = [];
  if (depth > 24) return [{ path, message: 'document is nested too deeply' }];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...scanForbiddenKeys(v, `${path}[${i}]`, depth + 1)));
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const here = path ? `${path}.${key}` : key;
      if (PROTOTYPE_KEYS.has(key)) out.push({ path: here, message: 'prototype keys are refused' });
      else if (INSECURE_KEY.test(key))
        out.push({
          path: here,
          message: 'certificate verification cannot be disabled; configure a trust bundle instead',
        });
      out.push(...scanForbiddenKeys((value as Record<string, unknown>)[key], here, depth + 1));
    }
  }
  return out;
}

/** Credential-free origin of a proxy URL. Returns an issue text when the URL is not acceptable. */
function parseProxyUrl(
  raw: string,
): { scheme: 'http' | 'https'; host: string; port: number } | string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'is not a valid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'must use http:// or https://';
  if (u.username || u.password)
    return 'must not contain credentials; put them in a secret and reference it with authSecret';
  if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
    return 'must be a bare origin (scheme, host, optional port)';
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) return 'has no host';
  const scheme = u.protocol === 'https:' ? 'https' : 'http';
  return { scheme, host, port: u.port ? Number(u.port) : scheme === 'https' ? 443 : 80 };
}

export interface NetworkValidationResult {
  errors: NetworkIssue[];
  warnings: string[];
}

export interface NetworkValidateOptions {
  /** Production profile: plain `http://` proxies are refused (owner decision, ADR 0011 question 5). */
  production?: boolean;
}

/** Cross-reference and policy checks that the structural schema cannot express. */
export function validateNetworkConfig(
  cfg: NetworkConfig,
  opts: NetworkValidateOptions = {},
): NetworkValidationResult {
  const errors: NetworkIssue[] = [];
  const warnings: string[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  const unique = (names: Array<string | undefined>, path: string) => {
    const seen = new Set<string>();
    names.forEach((n, i) => {
      if (n === undefined) return;
      if (seen.has(n)) err(`${path}[${i}].name`, `duplicate name "${n}"`);
      seen.add(n);
    });
  };
  unique(
    cfg.proxies.map((p) => p.name),
    'proxies',
  );
  unique(
    cfg.trust.bundles.map((b) => b.name),
    'trust.bundles',
  );
  unique(
    cfg.clientCertificates.map((c) => c.name),
    'clientCertificates',
  );
  unique(
    cfg.routes.map((r) => r.name),
    'routes',
  );

  const bundles = new Set(cfg.trust.bundles.map((b) => b.name));
  const certs = new Set(cfg.clientCertificates.map((c) => c.name));
  const proxies = new Map(cfg.proxies.map((p) => [p.name, p]));

  cfg.trust.bundles.forEach((b, i) => {
    if ((b.file === undefined) === (b.secret === undefined))
      err(`trust.bundles[${i}]`, 'set exactly one of "file" and "secret"');
  });
  if (cfg.trust.mode === 'extra-only' && cfg.trust.bundles.length === 0)
    err(
      'trust.mode',
      '"extra-only" needs at least one bundle (otherwise nothing would be trusted)',
    );

  cfg.proxies.forEach((p, i) => {
    const at = `proxies[${i}]`;
    if (RESERVED.has(p.name.toLowerCase())) err(`${at}.name`, `"${p.name}" is reserved`);
    const parsed = parseProxyUrl(p.url);
    if (typeof parsed === 'string') {
      err(`${at}.url`, parsed);
      return;
    }
    if (parsed.scheme === 'http') {
      if (opts.production)
        err(
          `${at}.url`,
          'plain http:// proxies are refused in production (code proxy_plain_http); use an https:// proxy',
        );
      else warnings.push(`proxy "${p.name}" uses plain http:// (refused in production)`);
    }
    if (p.caBundle !== undefined) {
      if (!bundles.has(p.caBundle)) err(`${at}.caBundle`, `unknown trust bundle "${p.caBundle}"`);
      if (parsed.scheme === 'http') err(`${at}.caBundle`, 'only valid for an https:// proxy');
    }
  });

  let catchAllAt = -1;
  cfg.routes.forEach((r, i) => {
    const at = `routes[${i}]`;
    const patterns: HostPattern[] = [];
    r.match.hosts.forEach((h, j) => {
      try {
        patterns.push(parseHostPattern(h));
      } catch (e) {
        err(`${at}.match.hosts[${j}]`, (e as Error).message);
      }
    });
    if (r.via !== 'direct' && r.via !== 'deny' && !proxies.has(r.via))
      err(`${at}.via`, `"${r.via}" is neither "direct", "deny" nor a configured proxy`);
    if (r.clientCertificate !== undefined) {
      if (!certs.has(r.clientCertificate))
        err(`${at}.clientCertificate`, `unknown client certificate "${r.clientCertificate}"`);
      if (r.via === 'deny') err(`${at}.clientCertificate`, 'meaningless on a deny route');
    }
    if (catchAllAt >= 0)
      warnings.push(`${at} is unreachable: routes[${catchAllAt}] matches everything`);
    if (!r.match.purposes && patterns.some(isWildcardAll) && catchAllAt < 0) catchAllAt = i;
  });

  const seen = new Set<string>();
  cfg.tenantSelectable.forEach((n, i) => {
    if (!proxies.has(n)) err(`tenantSelectable[${i}]`, `unknown proxy "${n}"`);
    if (seen.has(n)) err(`tenantSelectable[${i}]`, `duplicate "${n}"`);
    seen.add(n);
  });

  const seenCerts = new Set<string>();
  cfg.tenantSelectableCertificates.forEach((n, i) => {
    if (!certs.has(n))
      err(`tenantSelectableCertificates[${i}]`, `unknown client certificate "${n}"`);
    if (seenCerts.has(n)) err(`tenantSelectableCertificates[${i}]`, `duplicate "${n}"`);
    seenCerts.add(n);
  });

  cfg.privateAllow.forEach((t, i) => {
    const issue = privateAllowIssue(t);
    if (issue) err(`privateAllow[${i}]`, issue);
  });
  return { errors, warnings };
}

/**
 * Checks one `privateAllow` entry (file or `OAX_NETWORK_PRIVATE_ALLOW`, same rules). Returns the
 * problem or `null`. Only IPs and CIDR ranges are accepted (never a name or a wildcard), a range
 * needs a minimum prefix, and nothing may open loopback, link-local, unspecified or multicast
 * space or a metadata address (ADR 0011 section 6).
 */
export function privateAllowIssue(token: string): string | null {
  let p: HostPattern;
  try {
    p = parseHostPattern(token);
  } catch (e) {
    return (e as Error).message;
  }
  if (p.kind === 'cidr') {
    const min = PRIVATE_ALLOW_MIN_BITS[p.version];
    if (p.bits < min)
      return `CIDR range is too wide: the prefix must be at least /${min} for IPv${p.version}`;
    if (rangeTouchesForbidden(p.version, p.base, p.bits))
      return 'must not cover loopback, link-local, unspecified or multicast addresses';
    return null;
  }
  const ip = p.kind === 'host' ? parseIp(p.host) : null;
  if (!ip) return 'must be an IP or a CIDR range (never a wildcard or a name)';
  if (NEVER_PRIVATE_CLASSES.has(classifyAddress(ip)))
    return 'must not be a loopback, link-local, unspecified, multicast or metadata address';
  return null;
}

function fail(code: string, issues: NetworkIssue[]): never {
  const text = issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
  throw new OaxError(code, `invalid network configuration: ${text}`, issues);
}

/** Validates a parsed document (JSON/YAML value). Throws `network_config_invalid`. */
export function parseNetworkConfig(
  raw: unknown,
  opts: NetworkValidateOptions = {},
): { config: NetworkConfig; warnings: string[] } {
  if (raw === null || raw === undefined) raw = {};
  const forbidden = scanForbiddenKeys(raw);
  if (forbidden.length) fail('network_config_invalid', forbidden);
  const parsed = NetworkConfigSchema.safeParse(raw);
  if (!parsed.success)
    fail(
      'network_config_invalid',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  const { errors, warnings } = validateNetworkConfig(parsed.data, opts);
  if (errors.length) {
    const code = errors.some((e) => e.message.includes('proxy_plain_http'))
      ? 'proxy_plain_http'
      : 'network_config_invalid';
    fail(code, errors);
  }
  return { config: parsed.data, warnings };
}

/* ------------------------------------------------------------------------------------------ */

export interface CompiledProxy {
  name: string;
  /** Origin without credentials: `scheme://host[:port]`. Safe to log. */
  url: string;
  scheme: 'http' | 'https';
  host: string;
  port: number;
  authSecret?: string;
  caBundle?: string;
  tlsInspection: boolean;
  maxClassification: Classification | null;
  source: 'config' | 'env' | 'connection';
  /** True when the environment URL carries userinfo (read it from the legacy environment). */
  envUserinfo?: boolean;
}

export interface CompiledRoute {
  name: string;
  patterns: HostPattern[];
  purposes: ReadonlySet<NetworkPurpose> | null;
  via: string;
  clientCertificate?: string;
}

/** `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`: the implicit last route (existing installs keep working). */
export interface LegacyProxyEnv {
  httpProxy?: CompiledProxy;
  httpsProxy?: CompiledProxy;
  noProxy: HostPattern[];
}

export interface CompiledNetwork {
  config: NetworkConfig;
  proxies: ReadonlyMap<string, CompiledProxy>;
  routes: readonly CompiledRoute[];
  legacy: LegacyProxyEnv;
  tenantSelectable: ReadonlySet<string>;
  tenantSelectableCertificates: ReadonlySet<string>;
  tenantDirect: boolean;
  privateAllow: readonly HostPattern[];
  trust: { mode: 'system+extra' | 'extra-only'; bundles: readonly string[] };
  clientCertificates: ReadonlySet<string>;
  /** Air-gapped policy to enforce on the target and the proxy host, when active. */
  egress?: Pick<EgressPolicy, 'airgapped' | 'isAllowed' | 'covers'> | undefined;
  /** Digest of the effective configuration (no secret values exist in it), for `/readyz`. */
  digest: string;
}

/** Compiles one explicit proxy URL (legacy `proxyUrl` of a connection or an env value). */
export function compileProxyUrl(
  raw: string,
  name: string,
  source: 'env' | 'connection',
): CompiledProxy | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) return null;
  const scheme = u.protocol === 'https:' ? 'https' : 'http';
  const port = u.port ? Number(u.port) : scheme === 'https' ? 443 : 80;
  const shown = host.includes(':') ? `[${host}]` : host;
  return {
    name,
    url: `${scheme}://${shown}${u.port ? `:${u.port}` : ''}`,
    scheme,
    host,
    port,
    tlsInspection: false,
    maxClassification: null,
    source,
    ...(u.username || u.password ? { envUserinfo: true } : {}),
  };
}

type Env = Record<string, string | undefined>;

/** Upper-case name first; an empty or blank value never shadows the lower-case spelling. */
function envValue(env: Env, name: string): string | undefined {
  for (const key of [name, name.toLowerCase()]) {
    const v = env[key]?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * Maps the legacy environment to its implicit route. A bare `host:port` (no scheme, as many
 * installs write it) is read as `http://host:port` with a warning; any other unusable value
 * (`socks5://...`, garbage) is refused, not skipped, because ignoring it would send traffic
 * around the proxy the operator meant to enforce.
 */
export function legacyProxyFromEnv(env: Env, warnings: string[] = []): LegacyProxyEnv {
  const make = (key: string, name: string) => {
    const raw = envValue(env, key);
    if (raw === undefined) return undefined;
    let value = raw;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      value = `http://${raw}`;
      warnings.push(`${key} has no scheme; it is read as http://<host>:<port> (add "http://")`);
    }
    const p = compileProxyUrl(value, name, 'env');
    if (!p)
      throw new OaxError(
        'network_config_invalid',
        `${key} is not a valid http:// or https:// proxy URL (socks and other schemes are not supported)`,
      );
    return p;
  };
  const httpsProxy = make('HTTPS_PROXY', 'env:https');
  const httpProxy = make('HTTP_PROXY', 'env:http');
  return {
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(httpProxy ? { httpProxy } : {}),
    noProxy: parseNoProxy(envValue(env, 'NO_PROXY')),
  };
}

export interface CompileOptions {
  legacy?: LegacyProxyEnv;
  /** Extra private-allow CIDRs from `OAX_NETWORK_PRIVATE_ALLOW`. */
  privateAllow?: readonly string[];
  egress?: CompiledNetwork['egress'];
}

/** Compiles a validated configuration. Throws `network_config_invalid` for an invalid one. */
export function compileNetwork(
  cfg: NetworkConfig,
  opts: CompileOptions & NetworkValidateOptions = {},
): CompiledNetwork {
  const { errors } = validateNetworkConfig(cfg, opts);
  if (errors.length) fail('network_config_invalid', errors);
  const proxies = new Map<string, CompiledProxy>();
  for (const p of cfg.proxies) {
    const parsed = parseProxyUrl(p.url);
    if (typeof parsed === 'string')
      fail('network_config_invalid', [{ path: p.name, message: parsed }]);
    const shown = parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host;
    const isDefault = parsed.port === (parsed.scheme === 'https' ? 443 : 80);
    proxies.set(p.name, {
      name: p.name,
      url: `${parsed.scheme}://${shown}${isDefault ? '' : `:${parsed.port}`}`,
      scheme: parsed.scheme,
      host: parsed.host,
      port: parsed.port,
      ...(p.authSecret ? { authSecret: p.authSecret } : {}),
      ...(p.caBundle ? { caBundle: p.caBundle } : {}),
      tlsInspection: p.tlsInspection,
      // An inspecting proxy sees clear text: it defaults to "internal" (ADR 0011 section 5).
      maxClassification: p.maxClassification ?? (p.tlsInspection ? 'internal' : null),
      source: 'config',
    });
  }
  const routes: CompiledRoute[] = cfg.routes.map((r, i) => ({
    name: r.name ?? `route-${i + 1}`,
    patterns: r.match.hosts.map(parseHostPattern),
    purposes: r.match.purposes ? new Set(r.match.purposes) : null,
    via: r.via,
    ...(r.clientCertificate ? { clientCertificate: r.clientCertificate } : {}),
  }));
  // The environment extension follows exactly the same rules as the file (no '*', no names).
  const extra = (opts.privateAllow ?? []).flatMap((t, i) => {
    const issue = privateAllowIssue(t);
    return issue ? [{ path: `OAX_NETWORK_PRIVATE_ALLOW[${i}]`, message: issue }] : [];
  });
  if (extra.length) fail('network_config_invalid', extra);
  const privateAllow = [...cfg.privateAllow, ...(opts.privateAllow ?? [])].map(parseHostPattern);
  const legacy = opts.legacy ?? { noProxy: [] };
  return {
    config: cfg,
    proxies,
    routes,
    legacy,
    tenantSelectable: new Set(cfg.tenantSelectable),
    tenantSelectableCertificates: new Set(cfg.tenantSelectableCertificates),
    tenantDirect: cfg.tenantDirect,
    privateAllow,
    trust: { mode: cfg.trust.mode, bundles: cfg.trust.bundles.map((b) => b.name) },
    clientCertificates: new Set(cfg.clientCertificates.map((c) => c.name)),
    egress: opts.egress,
    digest: sha256Hex(
      canonicalJson({
        cfg,
        extra: opts.privateAllow ?? [],
        // Environment routes change routing too, so they are part of the effective configuration.
        env: {
          https: legacy.httpsProxy?.url ?? null,
          http: legacy.httpProxy?.url ?? null,
          noProxy: legacy.noProxy.map((p) => p.raw),
        },
      }),
    ),
  };
}

/* ------------------------------------------------------------------------------------------ */

/** `NODE_TLS_REJECT_UNAUTHORIZED=0` turns certificate verification off for the whole process. */
export function assertTlsVerificationOn(env: Env): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === '0')
    throw new OaxError(
      'tls_insecure',
      'NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification and is refused; add the CA to a trust bundle (OAX_NETWORK_CONFIG_FILE) or NODE_EXTRA_CA_CERTS instead',
    );
}

export interface NetworkSettings {
  source: 'file' | 'env' | 'none';
  config: NetworkConfig;
  net: CompiledNetwork;
  warnings: string[];
  /** `OAX_NETWORK_TEST_ENABLED` (default true). */
  testEnabled: boolean;
}

export interface LoadNetworkOptions extends NetworkValidateOptions {
  /** Injectable for tests; defaults to a size-limited `readFileSync`. */
  readFile?: (path: string) => string;
  egress?: CompiledNetwork['egress'];
}

const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Reads a regular file through one descriptor with a hard length limit. The open is non-blocking
 * (a FIFO cannot hang start-up) and the type is checked on the descriptor, so devices such as
 * `/dev/zero`, FIFOs, sockets and directories are refused instead of read.
 */
export function readConfigFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let len = 0;
    while (len < buf.length) {
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n === 0) break;
      len += n;
    }
    if (len > MAX_FILE_BYTES) throw new Error('file is larger than 1 MiB');
    return buf.toString('utf8', 0, len);
  } finally {
    closeSync(fd);
  }
}
const defaultRead = readConfigFile;

const csv = (v: string | undefined) => (v ?? '').split(/[,\s]+/).filter(Boolean);

/**
 * Loads the network configuration from `OAX_NETWORK_CONFIG_FILE` (YAML or JSON) or
 * `OAX_NETWORK_CONFIG` (inline JSON), maps the legacy proxy environment to the implicit last route
 * and refuses an insecure TLS environment. Configuration comes only from file/environment: there
 * is no write API.
 */
export function loadNetworkSettings(env: Env, opts: LoadNetworkOptions = {}): NetworkSettings {
  assertTlsVerificationOn(env);
  const file = env.OAX_NETWORK_CONFIG_FILE?.trim();
  const inline = env.OAX_NETWORK_CONFIG?.trim();
  if (file && inline)
    throw new OaxError(
      'network_config_invalid',
      'set either OAX_NETWORK_CONFIG_FILE or OAX_NETWORK_CONFIG, not both',
    );
  let raw: unknown = {};
  let source: NetworkSettings['source'] = 'none';
  if (file) {
    source = 'file';
    let text: string;
    try {
      text = (opts.readFile ?? defaultRead)(file);
    } catch (e) {
      throw new OaxError(
        'network_config_invalid',
        `OAX_NETWORK_CONFIG_FILE: cannot read the file (${(e as Error).message.split('\n')[0]})`,
      );
    }
    raw = parseText(text, 'OAX_NETWORK_CONFIG_FILE', true);
  } else if (inline) {
    source = 'env';
    raw = parseText(inline, 'OAX_NETWORK_CONFIG', false);
  }
  const { config, warnings } = parseNetworkConfig(raw, opts);
  const legacy = legacyProxyFromEnv(env, warnings);
  for (const p of [legacy.httpsProxy, legacy.httpProxy])
    if (p?.scheme === 'http') warnings.push(`${p.name} proxy ${p.url} uses plain http://`);
  const net = compileNetwork(config, {
    ...opts,
    legacy,
    privateAllow: csv(env.OAX_NETWORK_PRIVATE_ALLOW),
  });
  const testFlag = env.OAX_NETWORK_TEST_ENABLED?.trim().toLowerCase();
  return {
    source,
    config,
    net,
    warnings,
    testEnabled: !(testFlag === 'false' || testFlag === '0' || testFlag === 'no'),
  };
}

function parseText(text: string, label: string, yaml: boolean): unknown {
  try {
    // YAML 1.2 is a superset of JSON; the inline variable is strict JSON.
    return yaml ? parseYaml(text, { maxAliasCount: 20 }) : JSON.parse(text);
  } catch (e) {
    throw new OaxError(
      'network_config_invalid',
      `${label}: not valid ${yaml ? 'YAML/JSON' : 'JSON'} (${(e as Error).message.split('\n')[0]})`,
    );
  }
}

/* ------------------------------------------------------------------------------------------ */

/**
 * Air-gapped start-up check of proxies and routes (ADR 0011 sections 6 and 11): every proxy host
 * must itself be on the allowlist, a catch-all route is refused, and every route (other than
 * `deny`) must stay inside the allowlist. Returns human-readable problems (empty = compliant).
 */
export function checkNetworkAirgap(net: CompiledNetwork, policy: EgressPolicy): string[] {
  if (!policy.airgapped) return [];
  const problems: string[] = [];
  for (const p of net.proxies.values())
    if (!policy.isAllowed(p.host, p.port))
      problems.push(`proxy "${p.name}": ${p.host}:${p.port} is not on OAX_AIRGAPPED_ALLOW`);
  for (const r of net.routes) {
    if (r.via === 'deny') continue;
    for (const pat of r.patterns) {
      if (isWildcardAll(pat)) {
        problems.push(
          `route "${r.name}": "${pat.raw}" matches every destination, refused in air-gapped mode`,
        );
      } else if (pat.kind !== 'any' && !policy.covers(pat)) {
        problems.push(`route "${r.name}": "${pat.raw}" is not covered by OAX_AIRGAPPED_ALLOW`);
      }
    }
  }
  return problems;
}

export type { AllowEntry };
