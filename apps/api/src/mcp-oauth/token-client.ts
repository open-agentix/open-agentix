import { OaxError } from '@openagentix/core';
import { OAUTH_SCOPE } from '@openagentix/mcp';
import { authenticateClient, type ClientCredentials } from './client-auth.js';
import type { OauthFetch, OauthOrigin } from './oauth-fetch.js';
import { assertTokenShape } from './token-shape.js';

/** Error codes of RFC 6749 section 5.2 and RFC 8707 that the platform tells apart (closed set). */
export const OAUTH_ERRORS = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'invalid_target',
  'temporarily_unavailable',
  'server_error',
  'other',
] as const;
export type OauthErrorCode = (typeof OAUTH_ERRORS)[number];

/** Codes after which the credentials will not work again without an administrator. */
const PERMANENT: ReadonlySet<OauthErrorCode> = new Set([
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_target',
]);

/**
 * The token endpoint refused a request. Carries the closed RFC error code only: the server's
 * `error_description` is dropped, because it is free text from a party that may be hostile and may
 * quote what it was sent (client assertion, secret).
 */
export class TokenRequestError extends OaxError {
  constructor(
    readonly oauth: OauthErrorCode,
    readonly status: number,
  ) {
    super('mcp_oauth_token_refused', `the token endpoint refused the request (${oauth})`);
  }
  /** True when the credentials are rejected for good (reauthorization is required). */
  get permanent(): boolean {
    return PERMANENT.has(this.oauth);
  }
}

export interface IssuedToken {
  accessToken: string;
  refreshToken?: string | undefined;
  /** Seconds, if the server stated them. */
  expiresIn?: number | undefined;
  /** Granted scopes if the server stated them. */
  scope?: string[] | undefined;
}

export interface TokenRequest {
  tokenEndpoint: string;
  grant: 'client_credentials' | 'refresh_token';
  client: ClientCredentials;
  scope: readonly string[];
  /** Canonical URI of the MCP server (RFC 8707): sent on EVERY token request. */
  resource: string;
  refreshToken?: string | undefined;
  origin: OauthOrigin;
  now: Date;
  algsSupported?: readonly string[] | undefined;
  /** Ids (tenant, connection) that a token must not contain (token shape rules). */
  ids?: readonly string[] | undefined;
}

const MAX_LIFETIME_S = 366 * 24 * 3600;

export async function requestToken(
  http: OauthFetch,
  r: TokenRequest,
): Promise<IssuedToken & { sensitive: string[] }> {
  const auth = authenticateClient(r.client, {
    audience: r.tokenEndpoint,
    now: r.now,
    algsSupported: r.algsSupported,
  });
  const form = new URLSearchParams({ grant_type: r.grant, resource: r.resource });
  if (r.scope.length > 0) form.set('scope', r.scope.join(' '));
  if (r.grant === 'refresh_token') {
    if (!r.refreshToken) throw new OaxError('mcp_auth_required', 'there is no refresh token');
    form.set('refresh_token', r.refreshToken);
  }
  for (const [k, v] of Object.entries(auth.form)) form.set(k, v);
  const reply = await http.postForm(r.tokenEndpoint, form, {
    purpose: 'identity',
    origin: r.origin,
    headers: auth.headers,
  });
  if (reply.status !== 200) {
    const code = reply.json?.error;
    const known = (OAUTH_ERRORS as readonly string[]).includes(String(code))
      ? (code as OauthErrorCode)
      : reply.status >= 500
        ? 'server_error'
        : 'other';
    throw new TokenRequestError(known, reply.status);
  }
  const doc = reply.json;
  const bad = () =>
    new OaxError('mcp_oauth_token_response_invalid', 'the token response is not valid');
  if (!doc || typeof doc.access_token !== 'string' || doc.access_token.length === 0) throw bad();
  // DPoP and MAC tokens need proof the client does not produce: only Bearer is accepted.
  if (typeof doc.token_type !== 'string' || doc.token_type.toLowerCase() !== 'bearer') throw bad();
  let expiresIn: number | undefined;
  if (doc.expires_in !== undefined) {
    if (
      typeof doc.expires_in !== 'number' ||
      !Number.isFinite(doc.expires_in) ||
      doc.expires_in <= 0
    )
      throw bad();
    expiresIn = Math.min(doc.expires_in, MAX_LIFETIME_S);
  }
  if (doc.refresh_token !== undefined && typeof doc.refresh_token !== 'string') throw bad();
  if (doc.scope !== undefined && typeof doc.scope !== 'string') throw bad();
  const scope = typeof doc.scope === 'string' ? doc.scope.split(' ').filter(Boolean) : undefined;
  if (scope && (scope.length > 64 || !scope.every((x) => OAUTH_SCOPE.test(x)))) throw bad();
  // The value is chosen by the server and, once accepted, is registered with the redactors: it
  // must have the shape of a credential BEFORE anything registers it, or a hostile server could
  // make the redactors blank ordinary text (a host name, an error code) of the tenant.
  try {
    assertTokenShape(doc.access_token, r.ids ?? []);
    if (doc.refresh_token) assertTokenShape(doc.refresh_token, r.ids ?? []);
  } catch {
    throw new OaxError(
      'mcp_oauth_token_rejected',
      'the token does not have the shape of a credential',
    );
  }
  return {
    accessToken: doc.access_token,
    ...(doc.refresh_token ? { refreshToken: doc.refresh_token } : {}),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
    ...(scope ? { scope } : {}),
    sensitive: auth.sensitive,
  };
}

/** RFC 7009. Resolves `ok` when the server accepted the request; never throws for a refusal. */
export async function revokeToken(
  http: OauthFetch,
  r: {
    endpoint: string;
    token: string;
    hint: 'access_token' | 'refresh_token';
    client: ClientCredentials;
    origin: OauthOrigin;
    now: Date;
    algsSupported?: readonly string[] | undefined;
  },
): Promise<'ok' | 'failed'> {
  try {
    const auth = authenticateClient(r.client, {
      audience: r.endpoint,
      now: r.now,
      algsSupported: r.algsSupported,
    });
    const form = new URLSearchParams({ token: r.token, token_type_hint: r.hint });
    for (const [k, v] of Object.entries(auth.form)) form.set(k, v);
    const reply = await http.postForm(r.endpoint, form, {
      purpose: 'identity',
      origin: r.origin,
      headers: auth.headers,
    });
    return reply.status === 200 ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}
