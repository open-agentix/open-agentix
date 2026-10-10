import { OaxError } from '@openagentix/core';

/**
 * Canonical URI of an MCP server (RFC 8707, ADR 0016 section 7.4): lower-case scheme and host,
 * no fragment, no trailing slash on an empty path, default port dropped. A token is only ever used
 * for this exact value, and the connection URL and the stored resource are compared through it.
 */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  u.hash = '';
  const path = u.pathname === '/' ? '' : u.pathname;
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/** Parses an https URL (issuer or resource) or throws `token_invalid`; no credentials in the URL. */
export function assertHttpsUrl(value: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new OaxError('token_invalid', `${what} must be an https URL`);
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash)
    throw new OaxError('token_invalid', `${what} must be an https URL without credentials`);
  return u;
}
