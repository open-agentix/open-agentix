import { OaxError, getEgressPolicy } from '@openagentix/core';
import { createProxyAwareFetch, type Env } from './proxy.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ProviderError extends OaxError {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super('provider_error', message, { status });
  }
}

export interface GuardedFetchOptions {
  /** Endpoints the provider was configured with; requests to other origins are refused. */
  allowedOrigins: readonly string[];
  /** Optional explicit proxy; otherwise HTTPS_PROXY/HTTP_PROXY/NO_PROXY from `env` apply. */
  proxyUrl?: string | undefined;
  env?: Env;
  /** Injected fetch (tests). Defaults to global fetch, or undici fetch when a proxy is set. */
  fetchImpl?: FetchLike | undefined;
}

/**
 * fetch wrapper that enforces "network calls only to configured endpoints" and routes through an
 * optional proxy (undici ProxyAgent).
 */
export function createGuardedFetch(opts: GuardedFetchOptions): FetchLike {
  const allowed = new Set(opts.allowedOrigins.map((o) => new URL(o).origin));
  const base: FetchLike =
    opts.fetchImpl ??
    createProxyAwareFetch({ proxyUrl: opts.proxyUrl, ...(opts.env ? { env: opts.env } : {}) });
  return (input, init) => {
    const origin = new URL(input).origin;
    if (!allowed.has(origin)) {
      return Promise.reject(
        new OaxError('egress_denied', `outbound request to ${origin} is not a configured endpoint`),
      );
    }
    try {
      getEgressPolicy().assert(input, 'provider');
    } catch (e) {
      return Promise.reject(e);
    }
    return base(input, init);
  };
}

export interface PostJsonOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  maxRetries?: number;
  /** Base backoff in ms (doubles per attempt). */
  backoffMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      if (res.ok) return (await res.json()) as T;
      const text = (await res.text()).slice(0, 500);
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new ProviderError(
        `HTTP ${res.status} from provider: ${text}`,
        res.status,
        retryable,
      );
      if (!retryable) throw lastError;
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) throw e;
      if (e instanceof OaxError && e.code === 'egress_denied') throw e;
      if (opts.signal?.aborted) throw e;
      lastError =
        e instanceof ProviderError
          ? e
          : new ProviderError(`provider request failed: ${(e as Error).message}`, null, true);
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
