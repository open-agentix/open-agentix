import { OaxError, getEgressPolicy, type NetworkPurpose, type RouteScope } from '@openagentix/core';
import { findOaxError, sharedOutboundDispatcher, type OutboundDispatcher } from './outbound.js';
import type { Env } from './proxy.js';
import { assertPublicDestination, type HostLookup } from './ssrf.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ProviderError extends OaxError {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    /** The failure happened before any request byte could have reached the provider (DNS, refused). */
    readonly preSend: boolean = false,
  ) {
    super('provider_error', message, { status });
  }
}

const PRE_SEND_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/** True for connection failures that provably happened before the request was sent. */
export function isPreSendFailure(e: unknown): boolean {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && PRE_SEND_CODES.has(code);
}

export interface GuardedFetchOptions {
  /** Endpoints the provider was configured with; requests to other origins are refused. */
  allowedOrigins: readonly string[];
  /** Optional explicit proxy; otherwise HTTPS_PROXY/HTTP_PROXY/NO_PROXY from `env` apply. */
  proxyUrl?: string | undefined;
  env?: Env;
  /**
   * Refuse destinations that resolve to loopback, private, link-local or metadata addresses (SSRF
   * through tenant-controlled base URLs). Checked right before each request and pinned at connect
   * time. `allow` lists operator-approved entries (`OAX_MODEL_PROXY_PRIVATE_ALLOW`).
   */
  blockPrivateDestinations?: { allow?: readonly string[]; lookup?: HostLookup } | undefined;
  /** Injected fetch (tests). Bypasses the outbound dispatcher factory entirely. */
  fetchImpl?: FetchLike | undefined;
  /**
   * The outbound dispatcher (ADR 0011). Default: a factory over the legacy proxy environment, which
   * keeps the behaviour of installs without a network configuration. Pass the factory built from
   * the configured network (and a `scope`) to use named proxies, trust bundles and certificates.
   */
  outbound?:
    { dispatcher: OutboundDispatcher; purpose?: NetworkPurpose; scope?: RouteScope } | undefined;
}

/**
 * fetch wrapper that enforces "network calls only to configured endpoints" and sends every request
 * through the outbound dispatcher factory (routing, proxy, DNS pinning, no redirects, limits).
 */
export function createGuardedFetch(opts: GuardedFetchOptions): FetchLike {
  const allowed = new Set(opts.allowedOrigins.map((o) => new URL(o).origin));
  const dispatcher = (): OutboundDispatcher =>
    opts.outbound?.dispatcher ?? sharedOutboundDispatcher(opts.env);
  return async (input, init) => {
    const origin = new URL(input).origin;
    if (!allowed.has(origin)) {
      return Promise.reject(
        new OaxError('egress_denied', `outbound request to ${origin} is not a configured endpoint`),
      );
    }
    getEgressPolicy().assert(input, 'provider');
    if (opts.blockPrivateDestinations)
      await assertPublicDestination(new URL(input).hostname, opts.blockPrivateDestinations);
    if (opts.fetchImpl) return opts.fetchImpl(input, { ...init, redirect: 'error' });
    getEgressPolicy().assert(input, 'http');
    const scope: RouteScope = {
      ...opts.outbound?.scope,
      ...(opts.proxyUrl && !opts.outbound?.scope?.proxyUrl ? { proxyUrl: opts.proxyUrl } : {}),
    };
    return dispatcher().fetch(input, init, {
      purpose: opts.outbound?.purpose ?? 'model',
      scope,
      ...(opts.blockPrivateDestinations ? { pin: opts.blockPrivateDestinations } : {}),
    });
  };
}

export interface PostJsonOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  maxRetries?: number;
  /** Largest response body read (default 16 MiB); more is a provider error. */
  maxResponseBytes?: number;
  /** Base backoff in ms (doubles per attempt). */
  backoffMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads at most `max` bytes of a response body (`truncate`: stop quietly there), else throws. */
export async function readBounded(res: Response, max: number, truncate = false): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.byteLength;
      if (bytes > max) {
        if (truncate) break;
        throw new ProviderError('provider response is too large', res.status, false);
      }
      text += dec.decode(r.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/** POSTs JSON with timeout and retries on 429/5xx/network errors. */
export async function postJson<T>(
  fetchFn: FetchLike,
  url: string,
  body: unknown,
  opts: PostJsonOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep((opts.backoffMs ?? 250) * 2 ** (attempt - 1));
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 120_000)];
    if (opts.signal) signals.push(opts.signal);
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
      if (res.ok)
        return JSON.parse(await readBounded(res, opts.maxResponseBytes ?? 16 * 1024 * 1024)) as T;
      const text = (await readBounded(res, 500, true)).slice(0, 500);
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new ProviderError(
        `HTTP ${res.status} from provider: ${text}`,
        res.status,
        retryable,
      );
      if (!retryable) throw lastError;
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) throw e;
      // Policy and configuration errors (also behind undici's "fetch failed") are final.
      const policy = findOaxError(e);
      if (policy) throw policy;
      if (opts.signal?.aborted) throw e;
      lastError =
        e instanceof ProviderError
          ? e
          : new ProviderError(
              `provider request failed: ${(e as Error).message}`,
              null,
              true,
              isPreSendFailure(e),
            );
    }
  }
  throw lastError;
}

/** Rough, deterministic token estimate (4 chars per token) for providers without usage data. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      return { _raw: raw };
    }
  }
  return {};
}
