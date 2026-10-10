/**
 * Canonical URI of an MCP server (RFC 8707, ADR 0016 section 7.4): lower-case scheme and host,
 * no fragment, no trailing slash on an empty path, default port dropped. An access token is only
 * ever used for this exact value, and the connection url, the protected resource metadata
 * (RFC 9728) and the stored resource are all compared through it. Throws on a string that is not
 * a URL.
 */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  u.hash = '';
  const path = u.pathname === '/' ? '' : u.pathname;
  return `${u.protocol}//${u.host}${path}${u.search}`;
}
