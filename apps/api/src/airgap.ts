import {
  EgressPolicy,
  OaxError,
  parseAllowlist,
  getEgressPolicy,
  setEgressPolicy,
  resetEgressPolicy,
  type AllowEntry,
  type NetworkSettings,
  checkNetworkAirgap,
  loadNetworkSettings,
} from '@openagentix/core';
import { installNetworkGuard, type NetworkGuard } from '@openagentix/providers';
import type { Config } from './config.js';

/**
 * Air-gapped mode (`OAX_AIRGAPPED=true`): fail-closed start-up self-check plus a process-wide
 * egress policy and network guard. See docs/airgapped.md.
 */
export interface AirgapEndpoint {
  purpose: string;
  url: string;
}

type Env = Record<string, string | undefined>;

/** Every outbound endpoint that the static configuration enables. */
/** Public endpoints of provider kinds that are used when no URL is configured. */
const DEFAULT_ENDPOINT: Record<string, (p: Record<string, unknown>) => string | null> = {
  openai: () => 'https://api.openai.com/v1',
  openrouter: () => 'https://openrouter.ai/api/v1',
  anthropic: () => 'https://api.anthropic.com',
  ollama: () => 'http://localhost:11434',
  lmstudio: () => 'http://localhost:1234/v1',
  bedrock: (p) =>
    typeof p.region === 'string' ? `https://bedrock-runtime.${p.region}.amazonaws.com` : null,
  simulated: () => null,
};

/**
 * Every endpoint an LLM provider setting (an `OAX_PROVIDERS` entry or the body of a `model`
 * connection) can contact: its base URL / endpoint (or the public default of that kind) and its proxy.
 */
export function providerEndpoints(settings: unknown, purpose: string): AirgapEndpoint[] {
  const p = settings as Record<string, unknown>;
  const kind = String(p.kind ?? '');
  const out: AirgapEndpoint[] = [];
  const explicit = [p.baseUrl, p.endpoint].find((u): u is string => typeof u === 'string');
  const url = explicit ?? DEFAULT_ENDPOINT[kind]?.(p) ?? null;
  if (url) out.push({ purpose, url });
  if (kind !== 'simulated' && typeof p.proxyUrl === 'string')
    out.push({ purpose: `${purpose} proxy`, url: p.proxyUrl });
  return out;
}

/** Every outbound endpoint that the static configuration enables. */
export function configuredEndpoints(config: Config, env: Env = process.env): AirgapEndpoint[] {
  const out: AirgapEndpoint[] = [];
  for (const p of config.providers) out.push(...providerEndpoints(p, `provider "${p.name}"`));
  const a = config.auth;
  if (a.oidc) out.push({ purpose: 'OIDC issuer', url: a.oidc.issuer });
  if (a.ldap) out.push({ purpose: 'LDAP', url: a.ldap.url });
  if (config.otel.endpoint)
    out.push({ purpose: 'OpenTelemetry exporter', url: config.otel.endpoint });
  if (config.airgap.catalogRefreshUrl)
    out.push({ purpose: 'model catalog refresh', url: config.airgap.catalogRefreshUrl });
  for (const url of config.airgap.webhookOutUrls) out.push({ purpose: 'outbound webhook', url });
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (env[k]) out.push({ purpose: `${k} proxy`, url: env[k]! });
  }
  return out;
}

function hostEntry(url: string | undefined): AllowEntry[] {
  if (!url) return [];
  try {
    const u = new URL(url);
    if (!u.hostname) return [];
    return [{ kind: 'host', host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ''), port: null }];
  } catch {
    return [];
  }
}

/** Infrastructure the process is configured to use anyway (database, cache) needs no listing. */
export function implicitEntries(config: Config): AllowEntry[] {
  const db = config.database.url;
  const dbUrl = /^(memory|pglite):/.test(db) ? undefined : db;
  return [...hostEntry(dbUrl), ...hostEntry(config.cache.url)];
}

export function buildPolicy(config: Config): EgressPolicy {
  return new EgressPolicy({
    airgapped: config.airgap.enabled,
    allow: parseAllowlist(config.airgap.allow),
    implicit: implicitEntries(config),
  });
}

/** Human-readable violations of the static configuration (empty = compliant). */
export function checkAirgapConfig(
  config: Config,
  policy: EgressPolicy = buildPolicy(config),
  env: Env = process.env,
): string[] {
  if (!policy.airgapped) return [];
  const problems: string[] = [];
  for (const ep of configuredEndpoints(config, env)) {
    let url: URL;
    try {
      url = new URL(ep.url);
    } catch {
      problems.push(`${ep.purpose}: "${ep.url}" is not a valid URL`);
      continue;
    }
    if (!policy.isAllowed(url.hostname, portOf(url)))
      problems.push(`${ep.purpose}: ${url.host} is not on OAX_AIRGAPPED_ALLOW`);
  }
  if (config.airgap.catalogRefreshUrl)
    problems.push(
      'model catalog refresh is not available in air-gapped mode (vendored snapshot only)',
    );
  return problems;
}

function portOf(u: URL): number | null {
  if (u.port) return Number(u.port);
  return (
    ({ 'https:': 443, 'http:': 80, 'ldaps:': 636, 'ldap:': 389 } as Record<string, number>)[
      u.protocol
    ] ?? null
  );
}

/** Endpoints a stored connection (`mcp` streamable HTTP server or `model` provider) contacts. */
export function connectionEndpoints(kind: string, name: string, config: unknown): AirgapEndpoint[] {
  const cfg = (config ?? {}) as { transport?: string; url?: string };
  if (kind === 'mcp')
    return cfg.transport === 'streamable-http' && cfg.url
      ? [{ purpose: `MCP connection "${name}"`, url: cfg.url }]
      : [];
  if (kind === 'model') return providerEndpoints(config, `model connection "${name}"`);
  return [];
}

/** Violations among stored connections (MCP servers and BYOK model connections). */
export function checkStoredConnections(
  rows: ReadonlyArray<{ name: string; kind: string; config: unknown }>,
  policy: EgressPolicy,
): string[] {
  if (!policy.airgapped) return [];
  const problems: string[] = [];
  for (const r of rows) {
    for (const ep of connectionEndpoints(r.kind, r.name, r.config)) {
      try {
        const u = new URL(ep.url);
        if (!policy.isAllowed(u.hostname, portOf(u)))
          problems.push(`${ep.purpose}: ${u.host} is not on OAX_AIRGAPPED_ALLOW`);
      } catch {
        problems.push(`${ep.purpose}: invalid URL`);
      }
    }
  }
  return problems;
}

export function failClosed(problems: string[]): never {
  throw new OaxError(
    'airgap_violation',
    `air-gapped start-up check failed (refusing to start): ${problems.join('; ')}`,
    problems,
  );
}

let guard: NetworkGuard | null = null;
let networkSettings: NetworkSettings | null = null;

/** The validated network configuration (ADR 0011), available after `activateAirgap`. */
export function getNetworkSettings(): NetworkSettings | null {
  return networkSettings;
}

/**
 * Loads and validates the outbound network configuration (file/env only, no write API). Plain
 * `http://` proxies in the configuration are refused in production; an invalid file, an insecure
 * TLS environment or (air-gapped) a proxy/route outside the allowlist aborts start-up.
 */
export function loadNetwork(config: Config, policy: EgressPolicy, env: Env): NetworkSettings {
  const settings = loadNetworkSettings(env, {
    production: config.env === 'production',
    egress: policy,
  });
  const problems = checkNetworkAirgap(settings.net, policy);
  if (problems.length > 0) failClosed(problems);
  return settings;
}

/** Installs the policy and network guard (idempotent). Call before any outbound client exists. */
export function activateAirgap(config: Config, env: Env = process.env): EgressPolicy {
  deactivateAirgap();
  const policy = buildPolicy(config);
  networkSettings = loadNetwork(config, policy, env);
  if (!policy.airgapped) return policy;
  const problems = checkAirgapConfig(config, policy, env);
  if (problems.length > 0) failClosed(problems);
  setEgressPolicy(policy);
  guard = installNetworkGuard(policy);
  return policy;
}

export function deactivateAirgap(): void {
  guard?.uninstall();
  guard = null;
  networkSettings = null;
  resetEgressPolicy();
}

/** Refuses a new/changed connection whose endpoint is outside the allowlist (air-gapped only). */
export function assertConnectionAllowed(kind: string, name: string, config: unknown): void {
  for (const ep of connectionEndpoints(kind, name, config))
    getEgressPolicy().assert(ep.url, ep.purpose);
}
