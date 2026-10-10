import { OaxError, normalizeTarget } from '@openagentix/core';

/**
 * Rules for streamable-HTTP MCP connections (ADR 0016 section 4, slice S1).
 *
 * The rules here are structural and need no DNS: they run when a connection is saved (API) and
 * again right before a transport is built, so a stored connection that predates them fails closed
 * instead of being repaired silently. The destination itself (metadata, private ranges, localhost,
 * numeric spellings, TLS) is judged by the ADR 0011 resolver and pinned by the outbound
 * dispatcher; this module only keeps tenants from smuggling anything past it through the URL, the
 * headers or the `egress` list.
 */

export type HttpIssueCode = 'mcp_header_forbidden' | 'mcp_url_invalid' | 'mcp_egress_invalid';

export interface HttpIssue {
  code: HttpIssueCode;
  /** Config path of the offending field (`headers.host`, `url`, `egress.0`, ...). */
  path: string;
  message: string;
}

/** The HTTP fields that the rules look at. */
export interface HttpFields {
  url: string;
  headers?: Readonly<Record<string, string>> | undefined;
  headerSecrets?: Readonly<Record<string, string>> | undefined;
  egress?: readonly string[] | undefined;
}

/**
 * Header names a connection may never set. They either steer the transport itself (framing, hop by
 * hop, session and protocol negotiation, content negotiation), redirect the request to another
 * virtual host or client address, or belong to the platform's own propagation (trace context and
 * `x-oax-*`), so a tenant cannot override what the platform or the MCP client library sets. Auth
 * headers of the MCP server (`authorization`, `x-api-key`, ...) stay allowed: they are the point of
 * `headerSecrets`.
 */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'host',
  ':authority',
  ':method',
  ':path',
  ':scheme',
  'connection',
  'keep-alive',
  'proxy-connection',
  'upgrade',
  'te',
  'trailer',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'content-type',
  'accept',
  'accept-encoding',
  'expect',
  'cookie',
  'set-cookie',
  'via',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'x-original-url',
  'x-rewrite-url',
  'x-http-method-override',
  'origin',
  'referer',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
  'traceparent',
  'tracestate',
  'baggage',
]);

const FORBIDDEN_PREFIXES = ['proxy-', 'sec-', 'x-oax-', 'x-openagentix-', 'x-envoy-'];
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const MAX_HEADERS = 32;
const MAX_HEADER_VALUE = 8192;
const MAX_EGRESS = 16;
const MAX_URL = 2048;

function headerIssues(
  field: 'headers' | 'headerSecrets',
  values: Readonly<Record<string, string>> | undefined,
  out: HttpIssue[],
  seen: Set<string>,
): void {
  const entries = Object.entries(values ?? {});
  if (entries.length > MAX_HEADERS)
    out.push({
      code: 'mcp_header_forbidden',
      path: field,
      message: `more than ${MAX_HEADERS} headers`,
    });
  for (const [name, value] of entries) {
    const path = `${field}.${name.slice(0, 64)}`;
    const lower = name.toLowerCase();
    if (!HEADER_TOKEN.test(name)) {
      out.push({ code: 'mcp_header_forbidden', path, message: 'invalid header name' });
      continue;
    }
    if (FORBIDDEN_HEADERS.has(lower) || FORBIDDEN_PREFIXES.some((p) => lower.startsWith(p)))
      out.push({
        code: 'mcp_header_forbidden',
        path,
        message: `header "${lower}" is set by the platform and cannot be configured`,
      });
    // The same header in `headers` and `headerSecrets` (or in two spellings) would let one entry
    // silently override the other.
    if (seen.has(lower))
      out.push({ code: 'mcp_header_forbidden', path, message: `header "${lower}" is set twice` });
    seen.add(lower);
    // A secret reference is a name, not a header value, so only plain values are scanned.
    if (
      field === 'headers' &&
      (typeof value !== 'string' ||
        value.length > MAX_HEADER_VALUE ||
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value))
    )
      out.push({
        code: 'mcp_header_forbidden',
        path,
        message: 'header values must be plain text without control characters',
      });
  }
}

/**
 * The origin entries a streamable-HTTP connection may list in `egress`: only its own host (and
 * port). The server is contacted at its URL, nothing else; wider lists belong to stdio servers.
 */
function egressIssues(cfg: HttpFields, out: HttpIssue[]): void {
  const list = cfg.egress ?? [];
  if (list.length === 0) return;
  let own: ReturnType<typeof normalizeTarget> = null;
  try {
    own = normalizeTarget(cfg.url);
  } catch {
    own = null;
  }
  if (list.length > MAX_EGRESS)
    out.push({ code: 'mcp_egress_invalid', path: 'egress', message: 'too many egress entries' });
  list.slice(0, MAX_EGRESS).forEach((raw, i) => {
    const path = `egress.${i}`;
    const entry = raw.trim().toLowerCase();
    // Only plain `host`, `host:port` and `[v6]:port`: no scheme, path, wildcard, CIDR or userinfo.
    if (!entry || /[/@*\s?#\\]/.test(entry)) {
      out.push({
        code: 'mcp_egress_invalid',
        path,
        message: 'an egress entry is a host or host:port',
      });
      return;
    }
    const t = normalizeTarget(`https://${entry}`);
    if (!t || !own || t.host !== own.host || (/(:\d+)$/.test(entry) && t.port !== own.port))
      out.push({
        code: 'mcp_egress_invalid',
        path,
        message: 'an HTTP MCP connection may only list the host of its own url',
      });
  });
}

/** Issues of an HTTP connection config (`[]` = fine). Pure: no DNS, no network. */
export function checkHttpConfig(cfg: HttpFields): HttpIssue[] {
  const out: HttpIssue[] = [];
  let url: URL | undefined;
  try {
    url = new URL(cfg.url);
  } catch {
    out.push({ code: 'mcp_url_invalid', path: 'url', message: 'the url is not valid' });
  }
  if (url) {
    if (cfg.url.length > MAX_URL)
      out.push({ code: 'mcp_url_invalid', path: 'url', message: 'the url is too long' });
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      out.push({ code: 'mcp_url_invalid', path: 'url', message: 'the url must be http(s)' });
    // Credentials in the URL would end up in audit entries, logs and error messages.
    if (url.username || url.password)
      out.push({
        code: 'mcp_url_invalid',
        path: 'url',
        message: 'the url must not contain credentials (use headerSecrets)',
      });
    if (url.hash)
      out.push({
        code: 'mcp_url_invalid',
        path: 'url',
        message: 'the url must not have a fragment',
      });
  }
  const seen = new Set<string>();
  headerIssues('headers', cfg.headers, out, seen);
  headerIssues('headerSecrets', cfg.headerSecrets, out, seen);
  egressIssues(cfg, out);
  return out;
}

/** The error for a set of issues; the message names paths only, never values. */
export function httpConfigError(name: string, issues: readonly HttpIssue[]): OaxError {
  const first = issues[0]!;
  return new OaxError(
    first.code,
    `MCP connection "${name}": ${first.message} (${first.path})`,
    issues,
  );
}

/** Throws when the config breaks a rule (see {@link checkHttpConfig}). */
export function assertHttpConfig(name: string, cfg: HttpFields): void {
  const issues = checkHttpConfig(cfg);
  if (issues.length > 0) throw httpConfigError(name, issues);
}
