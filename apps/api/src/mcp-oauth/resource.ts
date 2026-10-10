import { OaxError } from '@openagentix/core';

export { canonicalResource } from '@openagentix/mcp';

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
