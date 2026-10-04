import { getEgressPolicy } from '@openagentix/core';
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

/**
 * Explicit HTTP(S) proxy support. Node's built-in fetch and the AWS SDK do not honour
 * HTTPS_PROXY/HTTP_PROXY/NO_PROXY on their own, so every outbound client in openagentix resolves
 * the proxy with these helpers.
 */
export type Env = Record<string, string | undefined>;

function envValue(env: Env, name: string): string | undefined {
  return env[name] ?? env[name.toLowerCase()];
}

/** True when `NO_PROXY` matches the host (exact, domain suffix, `*`, optional port, CIDR-less). */
export function bypassesProxy(target: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const m = /^([^:]+|\[[^\]]+\]):(\d+)$/.exec(entry);
    const pattern = (m?.[1] ?? entry).replace(/^\[|\]$/g, '');
    if (m?.[2] && m[2] !== port) continue;
    const p = pattern.replace(/^\*?\./, '');
    if (host === p || host.endsWith(`.${p}`)) return true;
  }
  return false;
}

/** Proxy URL for a target according to HTTPS_PROXY / HTTP_PROXY / NO_PROXY (or an explicit override). */
export function proxyFor(
  target: string | URL,
  env: Env = process.env,
  explicit?: string,
): string | undefined {
  const url = typeof target === 'string' ? new URL(target) : target;
  if (bypassesProxy(url, envValue(env, 'NO_PROXY'))) return undefined;
  if (explicit) return explicit;
  return url.protocol === 'https:'
    ? (envValue(env, 'HTTPS_PROXY') ?? envValue(env, 'HTTP_PROXY'))
    : envValue(env, 'HTTP_PROXY');
}

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ProxyAwareFetchOptions {
  env?: Env;
  /** Explicit proxy for all targets (still subject to NO_PROXY). */
  proxyUrl?: string | undefined;
  /** Injected for tests: fetch used when no proxy applies. */
  directFetch?: FetchFn;
  /** Injected for tests: fetch used with a proxy dispatcher. */
  proxiedFetch?: (
    input: string | URL,
    init: Omit<RequestInit, 'dispatcher'> & { dispatcher: Dispatcher },
  ) => Promise<Response>;
}

/** A fetch that routes each request through the proxy that applies to its target. */
export function createProxyAwareFetch(opts: ProxyAwareFetchOptions = {}): FetchFn {
  const agents = new Map<string, ProxyAgent>();
  const direct: FetchFn = opts.directFetch ?? ((i, init) => fetch(i, init));
  const proxied =
    opts.proxiedFetch ??
    ((i: string | URL, init: Omit<RequestInit, 'dispatcher'> & { dispatcher: Dispatcher }) =>
      undiciFetch(i, init as never) as unknown as Promise<Response>);
  return (input, init) => {
    // Air-gapped mode: the TARGET must be allowlisted, whether or not a proxy is used.
    try {
      getEgressPolicy().assert(input, 'http');
    } catch (e) {
      return Promise.reject(e);
    }
    const proxy = proxyFor(input, opts.env ?? process.env, opts.proxyUrl);
    if (!proxy) return direct(input, init);
    let agent = agents.get(proxy);
    if (!agent) {
      agent = new ProxyAgent(proxy);
      agents.set(proxy, agent);
    }
    return proxied(input, { ...(init ?? {}), dispatcher: agent as unknown as Dispatcher });
  };
}
