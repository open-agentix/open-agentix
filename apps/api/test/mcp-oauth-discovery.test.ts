import { OaxError } from '@openagentix/core';
import { createOutboundDispatcher } from '@openagentix/providers';
import { describe, expect, it } from 'vitest';
import {
  authServerMetadataUrls,
  discoverAuthorizationServer,
  discoverProtectedResource,
  parseChallenge,
  verifyIssuerParameter,
} from '../src/mcp-oauth/discovery.js';
import { OauthFetch } from '../src/mcp-oauth/oauth-fetch.js';
import { World, json } from './oauth-world.js';

/**
 * ADR 0016 section 7.3 and section 10 (SSRF, DNS rebinding): discovery as a malicious server, a
 * malicious metadata document and a malicious network would drive it. The dispatcher is the real
 * one (route rules, tenant destination checks); only the socket is replaced.
 */
const MCP = 'https://mcp.example.org/mcp';
const ISSUER = 'https://auth.example.org';
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof OaxError ? e.code : `other:${String(e)}`),
  );

function setup() {
  const w = new World();
  const http = new OauthFetch(() => w.dispatcher);
  return { w, http };
}

describe('challenge header', () => {
  it('reads resource_metadata, scope and error from Bearer challenges only', () => {
    expect(
      parseChallenge(
        'Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="a b"',
      ),
    ).toEqual({
      resourceMetadata: 'https://a.example/.well-known/oauth-protected-resource',
      scope: 'a b',
    });
    expect(parseChallenge('Basic realm="x", resource_metadata="https://evil.example/"')).toEqual(
      {},
    );
    expect(parseChallenge('Basic realm="x", Bearer error="insufficient_scope"').error).toBe(
      'insufficient_scope',
    );
    expect(parseChallenge(null)).toEqual({});
    expect(parseChallenge('Bearer ' + 'a="b",'.repeat(5000))).toEqual({});
  });
});

describe('well-known order', () => {
  it('without a challenge: path form, then root; authorization server: RFC 8414, OIDC insertion, OIDC appending', async () => {
    const { w, http } = setup();
    w.on('mcp.example.org', () => new Response('', { status: 404 }));
    expect(await code(discoverProtectedResource(http, MCP, 'tenant'))).toBe(
      'mcp_oauth_discovery_failed',
    );
    expect(w.reqs.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      'POST /mcp',
      'GET /.well-known/oauth-protected-resource/mcp',
      'GET /.well-known/oauth-protected-resource',
    ]);
    expect(authServerMetadataUrls('https://auth.example.org/tenant1')).toEqual([
      'https://auth.example.org/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.org/.well-known/openid-configuration/tenant1',
      'https://auth.example.org/tenant1/.well-known/openid-configuration',
    ]);
    expect(authServerMetadataUrls(ISSUER)).toEqual([
      `${ISSUER}/.well-known/oauth-authorization-server`,
      `${ISSUER}/.well-known/openid-configuration`,
    ]);
  });

  it('uses the challenge first and does not fall back when it fails', async () => {
    const { w, http } = setup();
    w.on('mcp.example.org', (r) =>
      r.method === 'POST'
        ? new Response('', {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer resource_metadata="https://mcp.example.org/meta/prm.json", scope="a"',
            },
          })
        : new Response('', { status: 500 }),
    );
    expect(await code(discoverProtectedResource(http, MCP, 'tenant'))).toBe(
      'mcp_oauth_discovery_failed',
    );
    expect(w.reqs.map((r) => r.url.pathname)).toEqual(['/mcp', '/meta/prm.json']);
  });
});

describe('protected resource metadata', () => {
  const serve = (doc: unknown, extra: Partial<Parameters<typeof json>> = []) => {
    const { w, http } = setup();
    w.on('mcp.example.org', (r) =>
      r.method === 'POST' ? new Response('', { status: 404 }) : json(doc, ...(extra as [])),
    );
    return { w, http };
  };
  const doc = { resource: MCP, authorization_servers: [ISSUER], scopes_supported: ['a'] };

  it('accepts a matching document', async () => {
    const { http } = serve(doc);
    expect(await discoverProtectedResource(http, MCP, 'tenant')).toMatchObject({
      authorizationServers: [ISSUER],
      scopesSupported: ['a'],
    });
  });

  it('keeps only valid scope tokens from scopes_supported and caps them at 32', async () => {
    const many = Array.from({ length: 50 }, (_v, i) => `s${i}`);
    const { http } = serve({
      ...doc,
      scopes_supported: ['ok', 'has space', 'ctl\u0001', 'x'.repeat(129), 'dq"', '', 'ok', ...many],
    });
    const prm = await discoverProtectedResource(http, MCP, 'tenant');
    expect(prm.scopesSupported).toHaveLength(32);
    expect(prm.scopesSupported.slice(0, 3)).toEqual(['ok', 's0', 's1']);
    expect(prm.scopesSupported.every((x) => /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(x))).toBe(
      true,
    );
  });

  it('filters and caps the scope of the challenge in the same way', async () => {
    const { w, http } = setup();
    const scope = [
      'a',
      'b\u0001',
      'x'.repeat(200),
      ...Array.from({ length: 50 }, (_v, i) => `c${i}`),
    ];
    w.on('mcp.example.org', (r) =>
      r.method === 'POST'
        ? new Response('', {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="https://mcp.example.org/meta/prm.json", scope="${scope.join(' ')}"`,
            },
          })
        : json(doc),
    );
    const prm = await discoverProtectedResource(http, MCP, 'tenant');
    const got = prm.challengeScope?.split(' ') ?? [];
    expect(got).toHaveLength(32);
    expect(got.slice(0, 2)).toEqual(['a', 'c0']);
  });

  it.each([
    ['another host', 'https://other.example.org/mcp'],
    ['another path', 'https://mcp.example.org/other'],
    ['trailing slash', 'https://mcp.example.org/mcp/'],
    ['another scheme', 'http://mcp.example.org/mcp'],
    ['another port', 'https://mcp.example.org:8443/mcp'],
    ['not a url', 'mcp'],
  ])('refuses a document whose resource is %s', async (_n, resource) => {
    const { http } = serve({ ...doc, resource });
    expect(await code(discoverProtectedResource(http, MCP, 'tenant'))).toMatch(
      /^mcp_resource_mismatch$/,
    );
  });

  it('treats host case and the default port as the same resource', async () => {
    const { http } = serve({ ...doc, resource: 'https://MCP.example.org:443/mcp' });
    expect(await code(discoverProtectedResource(http, MCP, 'tenant'))).toBe('ok');
  });

  it.each([
    ['servers not an array', { ...doc, authorization_servers: 'x' }],
    ['servers with a number', { ...doc, authorization_servers: [1] }],
    ['no usable server', { ...doc, authorization_servers: ['http://auth.example.org'] }],
    ['scopes wrong type', { ...doc, scopes_supported: 'a' }],
    ['resource missing', { authorization_servers: [ISSUER] }],
  ])('refuses a malformed document (%s)', async (_n, d) => {
    const { http } = serve(d);
    expect(await code(discoverProtectedResource(http, MCP, 'tenant'))).toBe(
      'mcp_oauth_discovery_failed',
    );
  });

  it('drops issuers that are not https, carry credentials, a query or a fragment', async () => {
    const { http } = serve({
      ...doc,
      authorization_servers: [
        'http://a.example.org',
        'https://u:p@b.example.org',
        'https://c.example.org?x=1',
        'https://d.example.org#f',
        'https://good.example.org/t1',
      ],
    });
    expect((await discoverProtectedResource(http, MCP, 'tenant')).authorizationServers).toEqual([
      'https://good.example.org/t1',
    ]);
  });

  it.each([
    ['another origin', 'https://evil.example.org/.well-known/oauth-protected-resource'],
    ['another port', 'https://mcp.example.org:8443/prm'],
    ['plain http', 'http://mcp.example.org/prm'],
    ['user info', 'https://x@mcp.example.org/prm'],
    ['a fragment', 'https://mcp.example.org/prm#x'],
    ['a relative path', '/prm'],
  ])('refuses a resource_metadata URL with %s without fetching it', async (_n, url) => {
    const { w, http } = setup();
    w.on(
      'mcp.example.org',
      () =>
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': `Bearer resource_metadata="${url}"` },
        }),
    );
    expect(await code(discoverProtectedResource(http, MCP, 'tenant'))).toBe(
      'mcp_resource_metadata_origin',
    );
    expect(w.reqs).toHaveLength(1); // only the unauthenticated initialize
  });
});

describe('authorization server metadata', () => {
  const meta = (over: Record<string, unknown> = {}) => ({
    issuer: ISSUER,
    token_endpoint: `${ISSUER}/token`,
    ...over,
  });
  const serve = (doc: unknown) => {
    const { w, http } = setup();
    w.on('auth.example.org', () => json(doc));
    return { w, http };
  };

  it('requires the document issuer to equal the requested one exactly (mix-up)', async () => {
    for (const issuer of [
      'https://evil.example.org',
      `${ISSUER}/`,
      'https://AUTH.example.org',
      undefined,
    ]) {
      const { http } = serve(meta({ issuer }));
      expect(await code(discoverAuthorizationServer(http, ISSUER, 'tenant'))).toBe(
        'mcp_issuer_mismatch',
      );
    }
  });

  it('defaults the client authentication method to client_secret_basic (RFC 8414)', async () => {
    const { http } = serve(meta());
    expect((await discoverAuthorizationServer(http, ISSUER, 'tenant')).tokenAuthMethods).toEqual([
      'client_secret_basic',
    ]);
  });

  it.each([
    ['token endpoint over http', meta({ token_endpoint: 'http://auth.example.org/token' })],
    ['token endpoint with user info', meta({ token_endpoint: 'https://u:p@auth.example.org/t' })],
    ['revocation over http', meta({ revocation_endpoint: 'http://auth.example.org/r' })],
    ['jwks over http', meta({ jwks_uri: 'http://auth.example.org/jwks' })],
    ['token endpoint missing', { issuer: ISSUER }],
    ['token endpoint a number', meta({ token_endpoint: 5 })],
    ['methods wrong type', meta({ token_endpoint_auth_methods_supported: 'x' })],
  ])('refuses %s (mixed-content downgrade, wrong types)', async (_n, d) => {
    const { http } = serve(d);
    expect(await code(discoverAuthorizationServer(http, ISSUER, 'tenant'))).toMatch(
      /^mcp_oauth_(url_invalid|discovery_failed)$/,
    );
  });

  it('refuses an issuer that is not https', async () => {
    const { w, http } = setup();
    expect(await code(discoverAuthorizationServer(http, 'http://auth.example.org', 'tenant'))).toBe(
      'mcp_oauth_url_invalid',
    );
    expect(w.reqs).toHaveLength(0);
  });
});

describe('SSRF: the endpoints a document names never receive a request', () => {
  const HOSTILE = [
    // IP literals in every spelling
    'https://127.0.0.1/t',
    'https://127.1/t',
    'https://2130706433/t',
    'https://0x7f000001/t',
    'https://0177.0.0.1/t',
    'https://[::1]/t',
    'https://[::ffff:127.0.0.1]/t',
    'https://[::ffff:7f00:1]/t',
    'https://0.0.0.0/t',
    'https://10.0.0.5/t',
    'https://192.168.1.1/t',
    'https://172.16.0.1/t',
    // metadata services
    'https://169.254.169.254/latest/meta-data',
    'https://[fd00:ec2::254]/t',
    'https://metadata.google.internal/t',
    'https://100.100.100.200/t',
    // local and internal names
    'https://localhost/t',
    'https://a.localhost/t',
    'https://localhost./t',
    // port and user-info tricks: the host is what the URL parser says it is
    'https://auth.example.org:443@127.0.0.1/t',
    'https://auth.example.org%2f@127.0.0.1/t',
    'https://127.0.0.1:443/t',
    'https://127.0.0.1:99999/t',
  ];

  it.each(HOSTILE)('token endpoint %s is refused by the tenant destination rules', async (url) => {
    const { w, http } = setup();
    w.on('auth.example.org', () => json({ issuer: ISSUER, token_endpoint: url }));
    const doc = await discoverAuthorizationServer(http, ISSUER, 'tenant').then(
      (m) => m,
      () => undefined,
    );
    w.clear();
    if (doc) {
      // The document is only parsed; the request to the endpoint must be refused by the dispatcher.
      expect(
        await code(
          http.postForm(doc.tokenEndpoint, new URLSearchParams(), {
            purpose: 'identity',
            origin: 'tenant',
          }),
        ),
      ).toBe('egress_denied');
    }
    expect(w.reqs).toHaveLength(0);
  });

  it.each(HOSTILE)('metadata fetched from %s as an issuer is never requested', async (url) => {
    const { w, http } = setup();
    const c = await code(discoverAuthorizationServer(http, url.replace(/\/t$/, ''), 'tenant'));
    expect(c).not.toBe('ok');
    expect(w.reqs).toHaveLength(0);
  });

  it('resource_metadata with an internal host is refused before any request to it', async () => {
    const { w, http } = setup();
    w.on(
      'mcp.example.org',
      () =>
        new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer resource_metadata="https://169.254.169.254/x"' },
        }),
    );
    expect(await code(discoverProtectedResource(http, MCP, 'tenant'))).toBe(
      'mcp_resource_metadata_origin',
    );
    expect(w.to('169.254.169.254')).toHaveLength(0);
  });

  it('an MCP url on an internal host is refused by the dispatcher', async () => {
    const { w, http } = setup();
    for (const url of ['https://127.0.0.1/mcp', 'https://localhost/mcp', 'https://[::1]/mcp'])
      expect(await code(discoverProtectedResource(http, url, 'tenant'))).toBe('egress_denied');
    expect(w.reqs).toHaveLength(0);
  });
});

describe('redirects, size, time and content type', () => {
  it('never follows a redirect (the dispatcher asks for redirect: error)', async () => {
    const { w, http } = setup();
    w.on(
      'auth.example.org',
      () => new Response('', { status: 302, headers: { location: 'https://169.254.169.254/' } }),
    );
    expect(await code(discoverAuthorizationServer(http, ISSUER, 'tenant'))).toBe(
      'mcp_oauth_redirect',
    );
    expect(w.redirects.every((r) => r === 'error')).toBe(true);
    expect(w.to('169.254.169.254')).toHaveLength(0);
  });

  it('cuts a body of more than 64 KiB, declared or streamed', async () => {
    for (const mode of ['declared', 'streamed']) {
      const { w, http } = setup();
      w.on('auth.example.org', () => {
        const big = JSON.stringify({ issuer: ISSUER, pad: 'x'.repeat(70 * 1024) });
        if (mode === 'declared')
          return new Response(big, {
            headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
          });
        return new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new TextEncoder().encode('x'.repeat(8192)));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      expect(await code(discoverAuthorizationServer(http, ISSUER, 'tenant'))).toBe(
        'mcp_oauth_response_too_large',
      );
    }
  });

  it('gives up on a slow body', async () => {
    const w = new World();
    const http = new OauthFetch(() => w.dispatcher, { timeoutMs: 150 });
    w.on(
      'auth.example.org',
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"issuer":'));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const started = Date.now();
    expect(await code(discoverAuthorizationServer(http, ISSUER, 'tenant'))).toBe(
      'mcp_oauth_timeout',
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each([
    ['html', 'text/html', '<html></html>'],
    ['json without the type', 'text/plain', '{"issuer":"x"}'],
    ['a json array', 'application/json', '[]'],
    ['a json scalar', 'application/json', '"x"'],
    ['invalid json', 'application/json', '{'],
    ['an xml type', 'application/xml', '{}'],
  ])('refuses %s', async (_n, type, body) => {
    const { w, http } = setup();
    w.on('auth.example.org', () => new Response(body, { headers: { 'content-type': type } }));
    expect(await code(discoverAuthorizationServer(http, ISSUER, 'tenant'))).toBe(
      'mcp_oauth_not_json',
    );
  });

  it('accepts application/json with a charset', async () => {
    const { w, http } = setup();
    w.on(
      'auth.example.org',
      () =>
        new Response(JSON.stringify({ issuer: ISSUER, token_endpoint: `${ISSUER}/t` }), {
          headers: { 'content-type': 'Application/JSON; charset=utf-8' },
        }),
    );
    expect(await code(discoverAuthorizationServer(http, ISSUER, 'tenant'))).toBe('ok');
  });

  it('error text names a host, never a path, a query or a response body', async () => {
    const { w, http } = setup();
    w.on('auth.example.org', () => new Response('SECRET-BODY-123', { status: 500 }));
    try {
      await discoverAuthorizationServer(http, ISSUER, 'tenant');
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('SECRET-BODY-123');
    }
  });
});

describe('DNS rebinding', () => {
  it('a name that resolves to a private address is refused at connect time, on the real dispatcher', async () => {
    const lookups: string[] = [];
    const real = createOutboundDispatcher({});
    const http = new OauthFetch(() => real, {
      lookup: async (host: string) => {
        lookups.push(host);
        return [{ address: '10.0.0.5', family: 4 }];
      },
    } as never);
    const c = await code(discoverAuthorizationServer(http, 'https://rebind.example.org', 'tenant'));
    expect(c).not.toBe('ok');
    expect(lookups).toContain('rebind.example.org');
    await real.close();
  });
});

describe('RFC 9207 issuer parameter', () => {
  it.each([
    ['iss equals expected', 'https://a', 'https://a', false, 'ok'],
    ['iss equals expected, advertised', 'https://a', 'https://a', true, 'ok'],
    ['iss differs', 'https://a', 'https://evil', false, 'iss_mismatch'],
    ['iss differs, advertised', 'https://a', 'https://evil', true, 'iss_mismatch'],
    ['iss differs by a slash', 'https://a', 'https://a/', false, 'iss_mismatch'],
    ['iss missing, not advertised', 'https://a', undefined, false, 'ok'],
    ['iss missing, advertised', 'https://a', undefined, true, 'iss_missing'],
  ])('%s', (_n, expected, received, advertised, want) => {
    expect(verifyIssuerParameter(expected, received, advertised)).toBe(want);
  });
});
