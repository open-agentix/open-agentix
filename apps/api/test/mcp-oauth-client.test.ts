import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authenticateClient } from '../src/mcp-oauth/client-auth.js';
import { OauthFetch } from '../src/mcp-oauth/oauth-fetch.js';
import { TokenRequestError, requestToken, revokeToken } from '../src/mcp-oauth/token-client.js';
import { World, checkAssertion, json, newToken } from './oauth-world.js';

/** Client authentication and the token client in isolation (ADR 0016 section 7.2). */
const NOW = new Date('2026-10-10T12:00:00Z');
const pem = (k: KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }) as string;
const ctx = { audience: 'https://auth.example.org/token', now: NOW };

describe('client_secret_basic', () => {
  it('form-encodes id and secret before base64 (RFC 6749 section 2.3.1)', () => {
    const a = authenticateClient(
      { clientId: 'a b:c', method: 'client_secret_basic', secret: 's+/ é' },
      ctx,
    );
    const decoded = Buffer.from(a.headers.authorization!.slice(6), 'base64').toString();
    expect(decoded).toBe('a+b%3Ac:s%2B%2F+%C3%A9');
    expect(a.form).toEqual({});
  });
  it('refuses an empty secret', () => {
    expect(() => authenticateClient({ clientId: 'a', method: 'client_secret_basic' }, ctx)).toThrow(
      /secret/,
    );
  });
});

describe('private_key_jwt', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const ed = generateKeyPairSync('ed25519').privateKey;
  it.each([
    ['RS256', rsa],
    ['ES256', ec],
    ['EdDSA', ed],
  ])('signs with %s and the assertion verifies', (alg, key) => {
    const a = authenticateClient(
      { clientId: 'cid', method: 'private_key_jwt', privateKeyPem: pem(key), keyId: 'kid-1' },
      ctx,
    );
    const { ok, header, claims } = checkAssertion(a.form.client_assertion!, key);
    expect(ok).toBe(true);
    expect(header).toEqual({ alg, typ: 'JWT', kid: 'kid-1' });
    expect(claims).toMatchObject({
      iss: 'cid',
      sub: 'cid',
      aud: ctx.audience,
      iat: NOW.getTime() / 1000,
    });
    expect(claims.exp).toBe(claims.iat + 60);
    expect(a.sensitive).toEqual([a.form.client_assertion]);
  });
  it('uses PS256 for an RSA key when the server only lists PS256', () => {
    const a = authenticateClient(
      { clientId: 'cid', method: 'private_key_jwt', privateKeyPem: pem(rsa) },
      { ...ctx, algsSupported: ['PS256'] },
    );
    expect(
      JSON.parse(Buffer.from(a.form.client_assertion!.split('.')[0]!, 'base64url').toString()).alg,
    ).toBe('PS256');
  });
  it('refuses an algorithm the server does not list and unsupported keys', () => {
    expect(() =>
      authenticateClient(
        { clientId: 'c', method: 'private_key_jwt', privateKeyPem: pem(ec) },
        { ...ctx, algsSupported: ['RS256'] },
      ),
    ).toThrow(/algorithm/);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
    expect(() =>
      authenticateClient(
        { clientId: 'c', method: 'private_key_jwt', privateKeyPem: pem(p384) },
        ctx,
      ),
    ).toThrow(/P-256/);
  });
  it('does not quote key material when the PEM is broken', () => {
    try {
      authenticateClient(
        {
          clientId: 'c',
          method: 'private_key_jwt',
          privateKeyPem: '-----BEGIN PRIVATE KEY-----\nSECRET-MATERIAL\n-----END PRIVATE KEY-----',
        },
        ctx,
      );
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('SECRET-MATERIAL');
    }
  });
});

describe('token endpoint', () => {
  const setup = () => {
    const w = new World();
    const http = new OauthFetch(() => w.dispatcher);
    return { w, http };
  };
  const req = (http: OauthFetch) =>
    requestToken(http, {
      tokenEndpoint: 'https://auth.example.org/token',
      grant: 'client_credentials',
      client: { clientId: 'c', method: 'client_secret_basic', secret: 's' },
      scope: ['a', 'b'],
      resource: 'https://mcp.example.org/mcp',
      origin: 'tenant',
      now: NOW,
    });

  it('sends grant, scope and resource, and parses a Bearer response', async () => {
    const { w, http } = setup();
    const access = newToken();
    w.on('auth.example.org', () =>
      json({ access_token: access, token_type: 'bearer', expires_in: 60, scope: 'a b' }),
    );
    const t = await req(http);
    expect(t).toMatchObject({ accessToken: access, expiresIn: 60, scope: ['a', 'b'] });
    const body = new URLSearchParams(w.reqs[0]!.body);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('resource')).toBe('https://mcp.example.org/mcp');
    expect(body.get('scope')).toBe('a b');
    expect(w.reqs[0]!.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
  });

  it('keeps only the closed error code and flags permanent ones', async () => {
    for (const [status, error, permanent] of [
      [400, 'invalid_grant', true],
      [401, 'invalid_client', true],
      [400, 'invalid_scope', false],
      [503, 'temporarily_unavailable', false],
      [400, 'made_up_by_the_server SECRET', false],
    ] as const) {
      const { w, http } = setup();
      w.on('auth.example.org', () =>
        json({ error, error_description: 'leak SECRET-TEXT' }, status),
      );
      const e = (await req(http).catch((x) => x)) as TokenRequestError;
      expect(e).toBeInstanceOf(TokenRequestError);
      expect(e.permanent).toBe(permanent);
      expect(e.message).not.toContain('SECRET');
    }
  });

  it('treats a non-json error page as a transient server error', async () => {
    const { w, http } = setup();
    w.on('auth.example.org', () => new Response('<html>SECRET</html>', { status: 502 }));
    const e = (await req(http).catch((x) => x)) as TokenRequestError;
    expect(e.oauth).toBe('server_error');
    expect(e.permanent).toBe(false);
  });

  it('revocation reports ok or failed and never throws', async () => {
    const { w, http } = setup();
    w.on('auth.example.org', () => new Response('', { status: 200 }));
    const base = {
      endpoint: 'https://auth.example.org/revoke',
      token: 'x'.repeat(30),
      hint: 'access_token' as const,
      client: { clientId: 'c', method: 'client_secret_basic' as const, secret: 's' },
      origin: 'tenant' as const,
      now: NOW,
    };
    expect(await revokeToken(http, base)).toBe('ok');
    w.on('auth.example.org', () => new Response('', { status: 500 }));
    expect(await revokeToken(http, base)).toBe('failed');
    expect(await revokeToken(http, { ...base, endpoint: 'https://127.0.0.1/revoke' })).toBe(
      'failed',
    );
  });
});
