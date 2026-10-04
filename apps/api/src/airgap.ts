import {
  EgressPolicy,
  OaxError,
  parseAllowlist,
  getEgressPolicy,
  setEgressPolicy,
  resetEgressPolicy,
  type AllowEntry,
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
export function configuredEndpoints(config: Config, env: Env = process.env): AirgapEndpoint[] {
  const out: AirgapEndpoint[] = [];
  for (const p of config.providers) {
    const name = `provider "${p.name}"`;
    if (p.kind === 'openai') out.push({ purpose: name, url: p.baseUrl });
    if (p.kind === 'ollama')
      out.push({ purpose: name, url: p.baseUrl ?? 'http://localhost:11434' });
    if (p.kind === 'anthropic')
      out.push({ purpose: name, url: p.baseUrl ?? 'https://api.anthropic.com' });
    if (p.kind === 'bedrock')
      out.push({
        purpose: name,
        url: p.endpoint ?? `https://bedrock-runtime.${p.region}.amazonaws.com`,
      });
    if (p.kind !== 'simulated' && p.proxyUrl)
      out.push({ purpose: `${name} proxy`, url: p.proxyUrl });
  }
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

/** Violations among stored MCP connections (streamable HTTP servers). */
export function checkMcpConnections(
  rows: ReadonlyArray<{ name: string; config: unknown }>,
  policy: EgressPolicy,
): string[] {
  if (!policy.airgapped) return [];
  const problems: string[] = [];
  for (const r of rows) {
    const cfg = r.config as { transport?: string; url?: string };
    if (cfg.transport !== 'streamable-http' || !cfg.url) continue;
    try {
      const u = new URL(cfg.url);
      if (!policy.isAllowed(u.hostname, portOf(u)))
        problems.push(`MCP connection "${r.name}": ${u.host} is not on OAX_AIRGAPPED_ALLOW`);
    } catch {
      problems.push(`MCP connection "${r.name}": invalid URL`);
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

/** Installs the policy and network guard (idempotent). Call before any outbound client exists. */
export function activateAirgap(config: Config, env: Env = process.env): EgressPolicy {
  deactivateAirgap();
  const policy = buildPolicy(config);
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
  resetEgressPolicy();
}

/** Refuses a new/changed MCP connection whose endpoint is outside the allowlist (air-gapped only). */
export function assertConnectionAllowed(config: unknown): void {
  const cfg = config as { transport?: string; url?: string };
  if (cfg.transport === 'streamable-http' && cfg.url)
    getEgressPolicy().assert(cfg.url, 'MCP connection');
}
