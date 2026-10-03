import { createProxyAwareFetch } from '@openagentix/providers';
import * as oidc from 'openid-client';
import type { Config } from '../config.js';

/** The OIDC operations we need (wrapping openid-client; injectable for tests). */
export interface OidcClient {
  authorizationUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<string>;
  exchange(
    currentUrl: URL,
    check: { state: string; nonce: string; codeVerifier: string },
  ): Promise<Record<string, unknown>>;
}

export function randomOidcValues(): { state: string; nonce: string; codeVerifier: string } {
  return {
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    codeVerifier: oidc.randomPKCECodeVerifier(),
  };
}

export function pkceChallenge(verifier: string): Promise<string> {
  return oidc.calculatePKCECodeChallenge(verifier);
}

export function openidClient(cfg: NonNullable<Config['auth']['oidc']>): OidcClient {
  let configuration: Promise<oidc.Configuration> | null = null;
  const conf = () =>
    (configuration ??= oidc.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret));
  return {
    async authorizationUrl({ state, nonce, codeChallenge }) {
      return oidc
        .buildAuthorizationUrl(await conf(), {
          redirect_uri: cfg.redirectUri,
          scope: cfg.scopes,
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        })
        .toString();
    },
    async exchange(currentUrl, check) {
      const tokens = await oidc.authorizationCodeGrant(await conf(), currentUrl, {
        pkceCodeVerifier: check.codeVerifier,
        expectedState: check.state,
        expectedNonce: check.nonce,
      });
      return (tokens.claims() ?? {}) as Record<string, unknown>;
    },
  };
}
