import { OaxError } from '@openagentix/core';
import { assertTokenShape } from './token-shape.js';
import type { OauthFetch, OauthOrigin } from './oauth-fetch.js';

/**
 * Client registration for the authorization-code flow (ADR 0016 section 7.2): the Client ID
 * Metadata Document the platform publishes (CIMD) and dynamic client registration (RFC 7591). Both
 * are off unless the operator enables them and both are refused in air-gapped mode.
 */

export const CIMD_PATH = '/v1/oauth/mcp-client.json';
export const CALLBACK_PATH = '/v1/oauth/mcp/callback';
export const CLIENT_NAME = 'openagentix';

export const callbackUrl = (publicUrl: string): string => `${publicUrl}${CALLBACK_PATH}`;
export const cimdUrl = (publicUrl: string): string => `${publicUrl}${CIMD_PATH}`;

/** The document served at {@link CIMD_PATH}: `client_id` is its own URL (draft-ietf-oauth-client-id-metadata-document). */
export function cimdDocument(publicUrl: string): Record<string, unknown> {
  return {
    client_id: cimdUrl(publicUrl),
    client_name: CLIENT_NAME,
    redirect_uris: [callbackUrl(publicUrl)],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
  };
}

export interface Registered {
  clientId: string;
  clientSecret?: string | undefined;
}

const bad = (what: string) =>
  new OaxError(
    'mcp_oauth_registration_failed',
    `the client registration response is invalid: ${what}`,
  );

/**
 * Registers the platform at `endpoint`. A public client is requested when the server lists `none`,
 * otherwise `client_secret_basic`. The response is untrusted: the redirect URI list, when stated,
 * must contain the exact callback; a secret must have the shape of a credential (it joins the
 * redactors); nothing of the server's text is kept.
 */
export async function registerClient(
  http: OauthFetch,
  endpoint: string,
  redirectUri: string,
  origin: OauthOrigin,
  authMethods: readonly string[],
): Promise<Registered & { method: 'none' | 'client_secret_basic' }> {
  const method = authMethods.includes('none')
    ? 'none'
    : authMethods.includes('client_secret_basic')
      ? 'client_secret_basic'
      : null;
  if (!method)
    throw new OaxError(
      'mcp_oauth_unsupported',
      'the authorization server supports neither a public client nor client_secret_basic',
    );
  const reply = await http.postJson(
    endpoint,
    {
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      application_type: 'web',
    },
    { purpose: 'identity', origin },
  );
  if (reply.status !== 201 && reply.status !== 200)
    throw new OaxError(
      'mcp_oauth_registration_failed',
      `the authorization server refused the registration (${reply.status})`,
    );
  const doc = reply.json;
  if (!doc) throw bad('no document');
  const id = doc.client_id;
  if (typeof id !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(id)) throw bad('client_id');
  const uris = doc.redirect_uris;
  if (uris !== undefined && (!Array.isArray(uris) || uris.length !== 1 || uris[0] !== redirectUri))
    throw bad('redirect_uris');
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== method)
    throw bad('token_endpoint_auth_method');
  let secret: string | undefined;
  if (doc.client_secret !== undefined) {
    if (typeof doc.client_secret !== 'string') throw bad('client_secret');
    secret = doc.client_secret;
    try {
      assertTokenShape(secret);
    } catch {
      throw bad('client_secret');
    }
  }
  if (method === 'client_secret_basic' && !secret) throw bad('client_secret');
  return { clientId: id, ...(secret ? { clientSecret: secret } : {}), method };
}
