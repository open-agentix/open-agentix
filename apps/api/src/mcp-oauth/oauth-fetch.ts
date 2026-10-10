import { OaxError } from '@openagentix/core';
import type { HostLookup, OutboundDispatcher } from '@openagentix/providers';

/** Limits of every discovery and token-endpoint exchange (ADR 0016 section 7.3). */
export const DISCOVERY_MAX_BYTES = 64 * 1024;
export const DISCOVERY_TIMEOUT_MS = 5_000;
export const TOKEN_TIMEOUT_MS = 10_000;
const MAX_URL = 2048;

export type OauthOrigin = 'platform' | 'tenant';

export interface OauthRequest {
  /** `mcp` for the resource server (challenge, protected resource metadata), `identity` otherwise. */
  purpose: 'mcp' | 'identity';
  origin: OauthOrigin;
  headers?: Record<string, string>;
}

export interface JsonReply {
  status: number;
  /** Parsed body of a JSON object answer; `undefined` for any other status. */
  json?: Record<string, unknown> | undefined;
  headers: Headers;
}

export interface OauthFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  tokenTimeoutMs?: number;
  lookup?: HostLookup | undefined;
}

const fail = (code: string, what: string) => new OaxError(code, what);

/** Host of a URL for messages: never the path or query (a tenant URL may carry both). */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid url';
  }
};

/**
 * Validates a URL that discovery or a token exchange is about to contact: https only, no user
 * info, no fragment, bounded length. Pure; the destination itself (private, metadata, loopback,
 * numeric spellings, air-gapped allowlist) is judged by the dispatcher on every request.
 */
export function assertOauthUrl(value: string, what: string): URL {
  let u: URL;
  try {
    if (value.length > MAX_URL) throw new Error('long');
    u = new URL(value);
  } catch {
    throw fail('mcp_oauth_url_invalid', `${what} is not a valid URL`);
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || !u.hostname)
    throw fail('mcp_oauth_url_invalid', `${what} must be an https URL without credentials`);
  return u;
}

async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw fail('mcp_oauth_response_too_large', 'the response is too large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // The total time limit also covers a body that trickles: do not rely on the transport to abort.
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => reject(fail('mcp_oauth_timeout', 'the response took too long'));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
  aborted.catch(() => undefined);
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), aborted]).catch(async (e) => {
      await reader.cancel().catch(() => undefined);
      throw e;
    });
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw fail('mcp_oauth_response_too_large', 'the response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The one HTTP client of OAuth discovery, token and revocation requests. Everything leaves through
 * the outbound dispatcher (ADR 0011: purpose, tenant destination rules, DNS pinning, no redirects),
 * with an own 64 KiB body cap, a total time limit, JSON answers only and error text that never
 * quotes a response, a header or a path.
 */
export class OauthFetch {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly tokenTimeoutMs: number;

  constructor(
    private readonly dispatcher: () => OutboundDispatcher,
    private readonly opts: OauthFetchOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? DISCOVERY_MAX_BYTES;
    this.timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
    this.tokenTimeoutMs = opts.tokenTimeoutMs ?? TOKEN_TIMEOUT_MS;
  }

  private async send(
    url: string,
    init: RequestInit,
    req: OauthRequest,
    timeoutMs: number,
    readBody: boolean,
  ): Promise<{ res: Response; text: string }> {
    const u = assertOauthUrl(url, 'the endpoint');
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await this.dispatcher().fetch(
        u,
        { ...init, redirect: 'error', signal },
        {
          purpose: req.purpose,
          scope: { origin: req.origin },
          timeoutMs,
          ...(this.opts.lookup ? { pin: { lookup: this.opts.lookup } } : {}),
        },
      );
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        throw fail('mcp_oauth_redirect', `${u.host} answered with a redirect`);
      }
      if (!readBody) {
        await res.body?.cancel().catch(() => undefined);
        return { res, text: '' };
      }
      return { res, text: await readCapped(res, this.maxBytes, signal) };
    } catch (e) {
      if (e instanceof OaxError) {
        // Denials keep their code (egress_denied); everything else of ours is already closed.
        throw e;
      }
      // A pinned lookup that refused an address surfaces as the cause of undici's "fetch failed".
      for (let c: unknown = (e as { cause?: unknown }).cause, i = 0; c && i < 4; i++) {
        if (c instanceof OaxError && c.code === 'egress_denied') throw c;
        c = (c as { cause?: unknown }).cause;
      }
      const cause = (e as { cause?: { message?: string } } | undefined)?.cause?.message ?? '';
      if (/redirect/i.test(cause))
        throw fail('mcp_oauth_redirect', `${u.host} answered with a redirect`);
      if (signal.aborted || (e as { name?: string }).name === 'TimeoutError')
        throw fail('mcp_oauth_timeout', `${u.host} did not answer in time`);
      throw fail('mcp_oauth_unreachable', `${u.host} could not be reached`);
    }
  }

  private jsonOf(res: Response, text: string): Record<string, unknown> | undefined {
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json')
      throw fail('mcp_oauth_not_json', 'the answer is not application/json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw fail('mcp_oauth_not_json', 'the answer is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw fail('mcp_oauth_not_json', 'the answer is not a JSON object');
    return parsed as Record<string, unknown>;
  }

  /** GET of a metadata document: JSON for 200, the bare status otherwise (404 is a normal answer). */
  async getJson(url: string, req: OauthRequest): Promise<JsonReply> {
    const { res, text } = await this.send(
      url,
      { method: 'GET', headers: { accept: 'application/json', ...req.headers } },
      req,
      this.timeoutMs,
      true,
    );
    if (res.status !== 200) return { status: res.status, headers: res.headers };
    return { status: 200, json: this.jsonOf(res, text), headers: res.headers };
  }

  /** POST of a form to a token or revocation endpoint. A non-JSON error body is just its status. */
  async postForm(url: string, form: URLSearchParams, req: OauthRequest): Promise<JsonReply> {
    const { res, text } = await this.send(
      url,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          ...req.headers,
        },
        body: form.toString(),
      },
      req,
      this.tokenTimeoutMs,
      true,
    );
    if (text === '') return { status: res.status, headers: res.headers };
    try {
      return { status: res.status, json: this.jsonOf(res, text), headers: res.headers };
    } catch (e) {
      // A revocation endpoint answers 200 with an empty or non-JSON body; keep the status.
      if (res.status !== 200) return { status: res.status, headers: res.headers };
      if (e instanceof OaxError && e.code === 'mcp_oauth_not_json')
        return { status: res.status, headers: res.headers };
      throw e;
    }
  }

  /**
   * The unauthenticated `initialize` that makes an MCP server name its protected resource metadata
   * (`WWW-Authenticate`, MCP authorization specification). Only the status and the header are used.
   */
  async challenge(
    mcpUrl: string,
    origin: OauthOrigin,
  ): Promise<{ status: number; wwwAuthenticate: string | null }> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'openagentix', version: '0' },
      },
    });
    const { res } = await this.send(
      mcpUrl,
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body,
      },
      { purpose: 'mcp', origin },
      this.timeoutMs,
      false,
    );
    return { status: res.status, wwwAuthenticate: res.headers.get('www-authenticate') };
  }
}

export { hostOf };
