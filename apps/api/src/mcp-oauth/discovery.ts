import { OaxError } from '@openagentix/core';
import { canonicalResource } from '@openagentix/mcp';
import { assertOauthUrl, hostOf, type OauthFetch, type OauthOrigin } from './oauth-fetch.js';

/**
 * OAuth discovery for an MCP server (ADR 0016 section 7.3; MCP authorization specification, RFC
 * 9728 protected resource metadata, RFC 8414 / OpenID Connect discovery for the authorization
 * server). Every fetch goes through {@link OauthFetch}. Documents are untrusted: wrong types are
 * refused, unknown members ignored, and nothing a document says is believed before it has been
 * compared with what the connection already pins (resource, issuer, endpoints).
 */

export interface Challenge {
  resourceMetadata?: string;
  scope?: string;
  error?: string;
}

/** Parses the Bearer challenges of a `WWW-Authenticate` value (quoted strings, several challenges). */
export function parseChallenge(header: string | null | undefined): Challenge {
  const out: Challenge = {};
  if (!header || header.length > 8192) return out;
  const re = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g;
  // Only the parameters that follow a `Bearer` scheme; other schemes' parameters are ignored.
  const parts = header.split(
    /(?:^|,\s*)(?=[A-Za-z][A-Za-z0-9._~+/-]*\s+[A-Za-z][A-Za-z0-9_-]*\s*=)/,
  );
  for (const part of parts) {
    if (!/^\s*Bearer\s/i.test(part)) continue;
    for (const m of part.matchAll(re)) {
      const name = m[1]!.toLowerCase();
      const value = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
      if (name === 'resource_metadata' && out.resourceMetadata === undefined)
        out.resourceMetadata = value;
      else if (name === 'scope' && out.scope === undefined) out.scope = value;
      else if (name === 'error' && out.error === undefined) out.error = value;
    }
  }
  return out;
}

export interface ProtectedResource {
  /** The resource identifier the document states; equal to the connection's canonical URI. */
  resource: string;
  /** Issuers (https, no credentials) the resource accepts tokens from. */
  authorizationServers: string[];
  scopesSupported: string[];
  /** Scope of the 401 challenge, if the server sent one. */
  challengeScope?: string;
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 64 && v.every((x) => typeof x === 'string' && x.length <= 2048);

/** An issuer identifier: https, no credentials, query or fragment (RFC 8414 section 2). */
export function isIssuer(value: string): boolean {
  try {
    const u = assertOauthUrl(value, 'the issuer');
    return !u.search && !value.endsWith('?');
  } catch {
    return false;
  }
}

function resourceMetadataUrls(mcpUrl: URL): string[] {
  const path = mcpUrl.pathname === '/' ? '' : mcpUrl.pathname;
  // The query of the connection url is never sent to a well-known location (oauth connections
  // have none anyway).
  const base = `${mcpUrl.origin}/.well-known/oauth-protected-resource`;
  return path ? [`${base}${path}`, base] : [base];
}

/** Protected resource metadata of the MCP server at `mcpUrl`, in specification order. */
export async function discoverProtectedResource(
  http: OauthFetch,
  mcpUrl: string,
  origin: OauthOrigin,
): Promise<ProtectedResource> {
  const resource = assertOauthUrl(mcpUrl, 'the MCP server url');
  const probe = await http.challenge(mcpUrl, origin);
  const challenge = probe.status === 401 ? parseChallenge(probe.wwwAuthenticate) : {};
  let metadataUrls: string[];
  if (challenge.resourceMetadata !== undefined) {
    // The challenge may only point at the server's own origin: a hostile or hijacked response
    // must not make the platform fetch (and later trust) a document from elsewhere.
    let u: URL;
    try {
      u = assertOauthUrl(challenge.resourceMetadata, 'resource_metadata');
    } catch {
      throw new OaxError('mcp_resource_metadata_origin', 'resource_metadata is not a usable URL');
    }
    if (u.origin !== resource.origin)
      throw new OaxError(
        'mcp_resource_metadata_origin',
        'resource_metadata points to another origin than the MCP server',
      );
    metadataUrls = [u.toString()];
  } else metadataUrls = resourceMetadataUrls(resource);

  for (const url of metadataUrls) {
    const reply = await http.getJson(url, { purpose: 'mcp', origin });
    if (reply.status !== 200 || !reply.json) {
      if (reply.status === 404 || reply.status === 405 || reply.status === 410) continue;
      throw new OaxError(
        'mcp_oauth_discovery_failed',
        `the protected resource metadata of ${hostOf(url)} is not available (${reply.status})`,
      );
    }
    const doc = reply.json;
    if (typeof doc.resource !== 'string')
      throw new OaxError(
        'mcp_oauth_discovery_failed',
        'the protected resource metadata is invalid',
      );
    let stated: string;
    try {
      stated = canonicalResource(doc.resource);
    } catch {
      throw new OaxError('mcp_resource_mismatch', 'the stated resource is not a URL');
    }
    // RFC 9728 section 3.3: a metadata document whose resource differs from the one it was
    // fetched for must not be used (it could belong to another server).
    if (stated !== canonicalResource(mcpUrl))
      throw new OaxError(
        'mcp_resource_mismatch',
        'the protected resource metadata names another resource than the connection',
      );
    const servers = doc.authorization_servers;
    if (!isStrings(servers))
      throw new OaxError('mcp_oauth_discovery_failed', 'authorization_servers is invalid');
    const scopes = doc.scopes_supported;
    if (scopes !== undefined && !isStrings(scopes))
      throw new OaxError('mcp_oauth_discovery_failed', 'scopes_supported is invalid');
    const issuers = [...new Set(servers.filter(isIssuer))];
    if (issuers.length === 0)
      throw new OaxError('mcp_oauth_discovery_failed', 'no usable authorization server is named');
    return {
      resource: stated,
      authorizationServers: issuers,
      scopesSupported: scopes ?? [],
      ...(challenge.scope ? { challengeScope: challenge.scope } : {}),
    };
  }
  throw new OaxError(
    'mcp_oauth_discovery_failed',
    'the MCP server publishes no protected resource metadata',
  );
}

export interface AuthServerMetadata {
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  authorizationEndpoint?: string;
  registrationEndpoint?: string;
  jwksUri?: string;
  grantTypes?: string[];
  tokenAuthMethods: string[];
  signingAlgs?: string[];
  codeChallengeMethods?: string[];
  scopesSupported?: string[];
  issParameterSupported: boolean;
}

/** The metadata URLs of an issuer: RFC 8414 with path insertion, then the two OIDC forms. */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  if (!path)
    return [
      `${u.origin}/.well-known/oauth-authorization-server`,
      `${u.origin}/.well-known/openid-configuration`,
    ];
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

function optionalUrl(doc: Record<string, unknown>, key: string): string | undefined {
  const v = doc[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string')
    throw new OaxError('mcp_oauth_discovery_failed', `${key} of the metadata is invalid`);
  assertOauthUrl(v, key);
  return v;
}

/** Authorization server metadata of `issuer`; the document's own issuer must equal it exactly. */
export async function discoverAuthorizationServer(
  http: OauthFetch,
  issuer: string,
  origin: OauthOrigin,
): Promise<AuthServerMetadata> {
  if (!isIssuer(issuer))
    throw new OaxError('mcp_oauth_url_invalid', 'the issuer must be an https URL');
  for (const url of authServerMetadataUrls(issuer)) {
    const reply = await http.getJson(url, { purpose: 'identity', origin });
    if (reply.status !== 200 || !reply.json) {
      if (reply.status === 404 || reply.status === 405 || reply.status === 410) continue;
      throw new OaxError(
        'mcp_oauth_discovery_failed',
        `the authorization server metadata of ${hostOf(url)} is not available (${reply.status})`,
      );
    }
    const doc = reply.json;
    // RFC 8414 section 3.3: the issuer in the document MUST be identical to the one the URL was
    // built from; otherwise a server could present metadata of another issuer (mix-up).
    if (doc.issuer !== issuer)
      throw new OaxError('mcp_issuer_mismatch', 'the metadata names another issuer than requested');
    if (typeof doc.token_endpoint !== 'string')
      throw new OaxError('mcp_oauth_discovery_failed', 'token_endpoint is missing');
    assertOauthUrl(doc.token_endpoint, 'token_endpoint');
    const list = (k: string): string[] | undefined => {
      const v = doc[k];
      if (v === undefined) return undefined;
      if (!isStrings(v))
        throw new OaxError('mcp_oauth_discovery_failed', `${k} of the metadata is invalid`);
      return v;
    };
    const rev = optionalUrl(doc, 'revocation_endpoint');
    const auth = optionalUrl(doc, 'authorization_endpoint');
    const reg = optionalUrl(doc, 'registration_endpoint');
    const jwks = optionalUrl(doc, 'jwks_uri');
    const grants = list('grant_types_supported');
    const signing = list('token_endpoint_auth_signing_alg_values_supported');
    const pkce = list('code_challenge_methods_supported');
    const scopes = list('scopes_supported');
    return {
      issuer,
      tokenEndpoint: doc.token_endpoint,
      ...(rev ? { revocationEndpoint: rev } : {}),
      ...(auth ? { authorizationEndpoint: auth } : {}),
      ...(reg ? { registrationEndpoint: reg } : {}),
      ...(jwks ? { jwksUri: jwks } : {}),
      ...(grants ? { grantTypes: grants } : {}),
      // RFC 8414: absent means client_secret_basic.
      tokenAuthMethods: list('token_endpoint_auth_methods_supported') ?? ['client_secret_basic'],
      ...(signing ? { signingAlgs: signing } : {}),
      ...(pkce ? { codeChallengeMethods: pkce } : {}),
      ...(scopes ? { scopesSupported: scopes } : {}),
      issParameterSupported: doc.authorization_response_iss_parameter_supported === true,
    };
  }
  throw new OaxError(
    'mcp_oauth_discovery_failed',
    'the authorization server publishes no metadata',
  );
}

/** The endpoints pinned for a connection (URLs only). */
export interface PinnedEndpoints extends Record<string, string> {
  tokenEndpoint: string;
}

export function pinOf(m: AuthServerMetadata): PinnedEndpoints {
  return {
    tokenEndpoint: m.tokenEndpoint,
    ...(m.revocationEndpoint ? { revocationEndpoint: m.revocationEndpoint } : {}),
    ...(m.authorizationEndpoint ? { authorizationEndpoint: m.authorizationEndpoint } : {}),
    ...(m.registrationEndpoint ? { registrationEndpoint: m.registrationEndpoint } : {}),
    ...(m.jwksUri ? { jwksUri: m.jwksUri } : {}),
  };
}

export function samePin(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Host names of the pinned endpoints (they join the connection's effective egress, purpose identity). */
export function endpointHosts(pin: Record<string, string>): string[] {
  return [...new Set(Object.values(pin).map((u) => hostOf(u)))].sort();
}

/**
 * RFC 9207 on an authorization response (the four cases of section 2.4): `iss` present must equal
 * the expected issuer exactly; `iss` absent is an error when the server advertised
 * `authorization_response_iss_parameter_supported`. Used by the authorization-code callback; the
 * client-credentials flow has no authorization response, and its token responses are only ever
 * taken from the pinned token endpoint.
 */
export function verifyIssuerParameter(
  expected: string,
  received: string | undefined,
  advertised: boolean,
): 'ok' | 'iss_mismatch' | 'iss_missing' {
  if (received !== undefined) return received === expected ? 'ok' : 'iss_mismatch';
  return advertised ? 'iss_missing' : 'ok';
}
