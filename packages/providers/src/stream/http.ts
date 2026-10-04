import { OaxError } from '@openagentix/core';
import { ProviderError, createGuardedFetch, type FetchLike } from '../http.js';
import {
  StreamGuard,
  createUpstreamStream,
  scrub,
  sseSource,
  type ProtocolHandler,
} from './engine.js';
import {
  DEFAULT_STREAM_LIMITS,
  StreamAbortedError,
  StreamError,
  type StreamCallOptions,
  type StreamLimits,
  type UpstreamStream,
} from './types.js';

export interface HttpTransportOptions {
  /** Endpoint origin(s) the transport may talk to (the configured base URL). */
  baseUrl: string;
  proxyUrl?: string | undefined;
  /** Injected fetch (tests); defaults to the proxy-aware global fetch behind the guarded fetch. */
  fetchImpl?: FetchLike | undefined;
  limits?: Partial<StreamLimits> | undefined;
  /** Retries (429, 5xx, network) happen only before the first response byte. Default 2. */
  maxRetries?: number | undefined;
  /** Base backoff in ms (doubles per attempt). Default 250. */
  backoffMs?: number | undefined;
  /** Additional values that must never appear in an error message. */
  secrets?: readonly string[] | undefined;
}

export function resolveLimits(p: Partial<StreamLimits> | undefined): StreamLimits {
  return { ...DEFAULT_STREAM_LIMITS, ...p };
}

const SENSITIVE_HEADER = /key|auth|token|secret|cookie/i;
const HEADER_VALUE = /^[\x20-\x7e]*$/;

/** Secret values of the configured credentials, for scrubbing. */
export function collectSecrets(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  extra: readonly string[] | undefined,
): string[] {
  const out = [...(extra ?? [])];
  if (apiKey) out.push(apiKey);
  for (const [k, v] of Object.entries(headers ?? {})) if (SENSITIVE_HEADER.test(k)) out.push(v);
  return out.filter((s) => s.length > 0);
}

/** Header names and values come from configuration only; refuse CR/LF and control characters. */
export function assertSafeHeaders(headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || !HEADER_VALUE.test(v)) {
      throw new OaxError('provider_error', 'invalid upstream header configuration');
    }
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** Reduces a provider error body to a short, scrubbed message (never the full body). */
export function summarizeErrorBody(text: string, secrets: readonly string[]): string {
  try {
    const parsed = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } | string };
    const err = parsed.error;
    if (typeof err === 'string') return scrub(err, secrets);
    const type = typeof err?.type === 'string' ? `${err.type}: ` : '';
    if (typeof err?.message === 'string') return scrub(`${type}${err.message}`, secrets);
  } catch {
    // not JSON
  }
  return scrub(text, secrets);
}

async function readBounded(res: Response, guard: StreamGuard, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  try {
    while (text.length < max) {
      const r = await guard.race(reader.read());
      if (r.done) break;
      text += dec.decode(r.value, { stream: true });
    }
  } catch {
    // an unreadable error body only shortens the message
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, max);
}

export interface OpenSseRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  handler: ProtocolHandler;
  call: StreamCallOptions;
}

/**
 * POSTs a streaming request and returns the upstream stream. Retries 429/5xx/network errors only
 * before the response started; the response must be an event stream; redirects are refused so a
 * key never follows a redirect to another origin.
 */
export async function openSseStream(
  opts: HttpTransportOptions,
  secrets: readonly string[],
  req: OpenSseRequest,
): Promise<UpstreamStream> {
  const limits = resolveLimits(opts.limits);
  const doFetch = createGuardedFetch({
    allowedOrigins: [opts.baseUrl],
    proxyUrl: opts.proxyUrl,
    fetchImpl: opts.fetchImpl,
  });
  const guard = new StreamGuard(limits, req.call.signal);
  const maxRetries = opts.maxRetries ?? 2;
  const fail = (e: unknown): never => {
    guard.dispose();
    throw e;
  };
  for (let attempt = 0; ; attempt++) {
    if (guard.cause) return fail(causeError(guard));
    let res: Response;
    try {
      res = await guard.race(
        doFetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: req.body,
          redirect: 'error',
          signal: guard.signal,
        }),
      );
    } catch (e) {
      if (guard.cause) return fail(causeError(guard));
      if (e instanceof OaxError && e.code === 'egress_denied') return fail(e);
      if (attempt < maxRetries) {
        await sleep((opts.backoffMs ?? 250) * 2 ** attempt, guard.signal);
        continue;
      }
      return fail(
        new ProviderError(
          `provider request failed: ${scrub(e instanceof Error ? e.message : 'network error', secrets)}`,
          null,
          true,
        ),
      );
    }
    if (!res.ok) {
      const text = await readBounded(res, guard, 4096);
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries && !guard.cause) {
        await sleep((opts.backoffMs ?? 250) * 2 ** attempt, guard.signal);
        continue;
      }
      if (guard.cause) return fail(causeError(guard));
      return fail(
        new ProviderError(
          `HTTP ${res.status} from provider: ${summarizeErrorBody(text, secrets)}`,
          res.status,
          retryable,
        ),
      );
    }
    const type = res.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith('text/event-stream') || !res.body) {
      void res.body?.cancel().catch(() => undefined);
      return fail(
        new StreamError(
          'bad_content_type',
          'upstream did not answer with an event stream',
          res.status,
        ),
      );
    }
    return createUpstreamStream({
      status: res.status,
      source: sseSource(res.body, limits, guard.controller),
      handler: req.handler,
      limits,
      guard,
      call: req.call,
      secrets,
    });
  }
}

function causeError(guard: StreamGuard): unknown {
  const c = guard.cause;
  return c?.kind === 'error' ? c.error : new StreamAbortedError(c?.reason ?? 'aborted');
}
