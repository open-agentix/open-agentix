import { OaxError } from '@openagentix/core';
import type { McpServerConfig } from './config.js';
import { McpConnection, type ConnectDeps } from './connection.js';

/**
 * Connectivity test of an HTTP MCP connection (ADR 0016 section 4.3, ADR 0011 section 8).
 *
 * The test is a reference to a stored connection, never a free URL, and it answers with a category
 * only: no response body, no header, no address, no error text of the server, no tool name or
 * description and no exact timing. It runs `initialize` and `tools/list` through the same
 * transport (and so the same dispatcher, destination checks and pinning) as a run.
 */
export const MCP_TEST_CATEGORIES = [
  'ok',
  'config_invalid',
  'egress_denied',
  'dns_failed',
  'connect_failed',
  'proxy_refused',
  'tls_untrusted',
  'tls_hostname_mismatch',
  'auth_failed',
  'http_error',
  'protocol_error',
  'timeout',
  'error',
] as const;
export type McpTestCategory = (typeof MCP_TEST_CATEGORIES)[number];

export type LatencyBucket = '<100ms' | '<1s' | '>=1s';

export interface McpTestResult {
  ok: boolean;
  category: McpTestCategory;
  /** Status class of an HTTP error (`4xx`, `5xx`); never the exact status or any body. */
  httpClass?: '4xx' | '5xx';
  latency: LatencyBucket;
  /** Number of tools the server listed (a count, never names or descriptions). */
  toolCount?: number;
}

const bucket = (ms: number): LatencyBucket => (ms < 100 ? '<100ms' : ms < 1000 ? '<1s' : '>=1s');

const TLS_UNTRUSTED = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'ERR_TLS_CERT_ALTNAME_INVALID_ISSUER',
]);
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EADDRNOTAVAIL',
  'UND_ERR_SOCKET',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ABORT_ERR',
]);

/** Walks the `cause` chain (undici wraps everything in "fetch failed"). */
function chain(e: unknown): { code?: string | number | undefined; name?: string; msg: string }[] {
  const out: { code?: string | number | undefined; name?: string; msg: string }[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null; i++) {
    const c = cur as { code?: string | number; name?: string; message?: string; cause?: unknown };
    out.push({ code: c.code, ...(c.name ? { name: c.name } : {}), msg: String(c.message ?? '') });
    cur = c.cause;
  }
  return out;
}

/** Maps any failure of connecting or listing to a category. Looks at codes, never at server text. */
export function categorizeMcpError(e: unknown): Pick<McpTestResult, 'category' | 'httpClass'> {
  for (const link of chain(e)) {
    const code = link.code;
    if (typeof code === 'string') {
      if (code === 'egress_denied' || code === 'mcp_egress_denied')
        return { category: 'egress_denied' };
      if (code.startsWith('mcp_')) return { category: 'config_invalid' };
      if (code === 'proxy_connect_refused') return { category: 'proxy_refused' };
      if (code === 'connect_timeout') return { category: 'timeout' };
      if (code === 'response_too_large') return { category: 'protocol_error' };
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA')
        return { category: 'dns_failed' };
      if (TLS_UNTRUSTED.has(code)) return { category: 'tls_untrusted' };
      if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return { category: 'tls_hostname_mismatch' };
      if (TIMEOUT_CODES.has(code)) return { category: 'timeout' };
      if (CONNECT_CODES.has(code) || code === 'connect_failed')
        return { category: 'connect_failed' };
    }
    // The SDK's HTTP errors carry the numeric status as `code`.
    if (typeof code === 'number' && code >= 400 && code <= 599) {
      if (code === 401 || code === 403) return { category: 'auth_failed' };
      return { category: 'http_error', httpClass: code >= 500 ? '5xx' : '4xx' };
    }
    if (link.name === 'AbortError' || link.name === 'TimeoutError') return { category: 'timeout' };
    if (link.name === 'McpError' || link.name === 'SyntaxError' || link.name === 'ZodError')
      return { category: 'protocol_error' };
  }
  if (e instanceof OaxError && e.code === 'tool_timeout') return { category: 'timeout' };
  if (chain(e).some((l) => /timed? ?out|timeout/i.test(l.msg))) return { category: 'timeout' };
  return { category: 'error' };
}

/** Only an `streamable-http` connection can be tested; a stdio test would start a process. */
export function isTestableMcpConfig(
  cfg: McpServerConfig,
): cfg is Extract<McpServerConfig, { transport: 'streamable-http' }> {
  return cfg.transport === 'streamable-http';
}

const TEST_TIMEOUT_MS = 15_000;
/**
 * Upper bound of a whole test. `timeoutMs` bounds each request, but `initialize` plus up to 50
 * `tools/list` pages of a slow (tenant-chosen) server would otherwise hold the API request and its
 * connection for many minutes.
 */
export const MCP_TEST_TOTAL_MS = 30_000;

/** `initialize` + `tools/list` against a stored HTTP connection; returns a category only. */
export async function testMcpServer(
  cfg: Extract<McpServerConfig, { transport: 'streamable-http' }>,
  deps: ConnectDeps,
  now: () => number = Date.now,
  totalMs: number = MCP_TEST_TOTAL_MS,
): Promise<McpTestResult> {
  const started = now();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const bounded = { ...cfg, timeoutMs: Math.min(cfg.timeoutMs, TEST_TIMEOUT_MS, totalMs) };
  const connecting = McpConnection.connect(bounded, deps);
  const work = connecting.then((conn) => conn.listTools());
  // Neither may surface as an unhandled rejection once the deadline has won the race.
  connecting.catch(() => undefined);
  work.catch(() => undefined);
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new OaxError('tool_timeout', 'the connection test took too long'));
      }, totalMs);
    });
    const tools = await Promise.race([work, deadline]);
    return { ok: true, category: 'ok', latency: bucket(now() - started), toolCount: tools.length };
  } catch (e) {
    const failed = categorizeMcpError(e);
    // A tenant must not learn from the category which internal names exist (split-horizon DNS):
    // an unresolvable name and a name that resolves to a private address read the same.
    // Only the operator's own (platform) connections keep the finer answer.
    if (failed.category === 'dns_failed' && (deps.originFor?.(cfg.name) ?? 'tenant') !== 'platform')
      failed.category = 'egress_denied';
    return { ok: false, ...failed, latency: bucket(now() - started) };
  } finally {
    clearTimeout(timer);
    // Closes the connection whenever it exists, also one that completes after the deadline.
    const closing = connecting.then((conn) => conn.close()).catch(() => undefined);
    if (!timedOut) await closing;
  }
}
