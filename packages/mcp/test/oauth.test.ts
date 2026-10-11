import { describe, expect, it } from 'vitest';
import type { OutboundDispatcher } from '@openagentix/providers';
import {
  McpServerConfigSchema,
  authKindOf,
  canonicalResource,
  checkHttpConfig,
  createMcpFetch,
  relayConfigFor,
  requestedScopes,
  type McpServerConfig,
  type McpTokenSource,
} from '../src/index.js';

type Http = Extract<McpServerConfig, { transport: 'streamable-http' }>;
const oauth = {
  kind: 'oauth',
  grant: 'client_credentials',
  issuer: 'https://auth.example.org',
  client: {
    clientIdSecret: 'id',
    clientAuth: 'client_secret_basic',
    clientSecretSecret: 'secret',
  },
} as const;
const parse = (extra: Record<string, unknown> = {}) =>
  McpServerConfigSchema.parse({
    name: 'srv',
    transport: 'streamable-http',
    url: 'https://mcp.example.org/mcp',
    ...extra,
  }) as Http;

describe('auth in the connection config', () => {
  it('an absent auth is static', () => {
    expect(authKindOf(parse())).toBe('static');
    expect(authKindOf(parse({ auth: { kind: 'none' } }))).toBe('none');
    expect(authKindOf(parse({ auth: oauth }))).toBe('oauth');
  });

  it.each([
    ['unknown kind', { kind: 'basic' }],
    [
      'client_credentials with dynamic registration',
      { ...oauth, client: { ...oauth.client, registration: 'dcr' } },
    ],
    [
      'no client auth secret',
      { ...oauth, client: { clientIdSecret: 'id', clientAuth: 'client_secret_basic' } },
    ],
    ['both secrets', { ...oauth, client: { ...oauth.client, keySecret: 'k' } }],
    ['public client', { ...oauth, client: { clientIdSecret: 'id', clientAuth: 'none' } }],
    ['unknown member', { ...oauth, extra: 1 }],
    ['client_secret_basic without a pinned issuer', { ...oauth, issuer: undefined }],
    ['http issuer', { ...oauth, issuer: 'http://auth.example.org' }],
    ['issuer with a query', { ...oauth, issuer: 'https://auth.example.org?x=1' }],
    ['scope with a space', { ...oauth, scopes: ['a b'] }],
  ])('refuses %s', (_n, auth) => {
    expect(() => parse({ auth })).toThrow();
  });

  it('refuses oauth and none with an authorization header, any spelling, plain or secret', () => {
    for (const [field, name] of [
      ['headers', 'authorization'],
      ['headers', 'Authorization'],
      ['headerSecrets', 'AUTHORIZATION'],
    ] as const)
      for (const kind of [oauth, { kind: 'none' }])
        expect(
          checkHttpConfig({
            url: 'https://x.example/mcp',
            auth: kind,
            [field]: { [name]: 'v' },
          }).map((i) => i.code),
        ).toContain('auth_conflict');
    expect(
      checkHttpConfig({
        url: 'https://x.example/mcp',
        auth: { kind: 'static' },
        headerSecrets: { authorization: 'r' },
      }),
    ).toEqual([]);
    expect(
      checkHttpConfig({
        url: 'https://x.example/mcp',
        auth: oauth,
        headerSecrets: { 'x-api-key': 'r' },
      }),
    ).toEqual([]);
  });

  it('an oauth url must be https without a query', () => {
    expect(
      checkHttpConfig({ url: 'http://x.example/mcp', auth: oauth }).map((i) => i.path),
    ).toEqual(['url']);
    expect(
      checkHttpConfig({ url: 'https://x.example/mcp?k=v', auth: oauth }).map((i) => i.path),
    ).toEqual(['url']);
  });

  it('strips the auth block from what a run node is given', () => {
    const node = relayConfigFor(parse({ auth: oauth, headerSecrets: { 'x-api-key': 'r' } }));
    expect(node.auth).toBeUndefined();
    expect(JSON.stringify(node)).not.toContain('clientSecretSecret');
    expect(node.headerSecrets).toEqual({});
  });
});

describe('scopes from profiles', () => {
  const tools = {
    get: { access: 'read', scopes: ['r', 'shared'] },
    put: { access: 'write', scopes: ['w', 'shared'] },
  };
  it('is the union over the tools of the profiles; an explicit list wins', () => {
    expect(requestedScopes(parse({ auth: oauth, tools, profiles: { read: ['get'] } }))).toEqual([
      'r',
      'shared',
    ]);
    expect(
      requestedScopes(
        parse({ auth: oauth, tools, profiles: { read: ['get'], all: ['get', 'put'] } }),
      ),
    ).toEqual(['r', 'shared', 'w']);
    expect(requestedScopes(parse({ auth: { ...oauth, scopes: ['z', 'a'] }, tools }))).toEqual([
      'a',
      'z',
    ]);
    expect(requestedScopes(parse({ auth: oauth, tools }))).toEqual([]);
    expect(requestedScopes(parse())).toEqual([]);
  });
});

describe('authorization_code configuration', () => {
  const code = (client: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    kind: 'oauth',
    grant: 'authorization_code',
    client,
    ...extra,
  });
  it.each([
    ['public pre-registered client', code({ clientIdSecret: 'id', clientAuth: 'none' })],
    [
      'confidential pre-registered client',
      code(
        { clientIdSecret: 'id', clientAuth: 'private_key_jwt', keySecret: 'key', keyId: 'k1' },
        {},
      ),
    ],
    ['client id metadata document', code({ registration: 'cimd' })],
    ['dynamic registration', code({ registration: 'dcr', clientAuth: 'none' })],
  ])('accepts %s', (_n, auth) => {
    expect(authKindOf(parse({ auth }))).toBe('oauth');
  });

  it.each([
    ['cimd with a client id secret', code({ registration: 'cimd', clientIdSecret: 'id' })],
    ['dcr with a secret', code({ registration: 'dcr', clientSecretSecret: 's' })],
    [
      'dcr with a confidential method',
      code({ registration: 'dcr', clientAuth: 'private_key_jwt' }),
    ],
    [
      'public client with a key',
      code({ clientIdSecret: 'id', clientAuth: 'none', keySecret: 'k' }),
    ],
    ['pre-registered without clientAuth', code({ clientIdSecret: 'id' })],
    ['pre-registered without a client id', code({ clientAuth: 'none' })],
  ])('refuses %s', (_n, auth) => {
    expect(() => parse({ auth })).toThrow();
  });
});

describe('step-up hook', () => {
  it('passes the scopes of an insufficient_scope challenge to the token source', async () => {
    const seen: { token: string; needed: readonly string[] }[] = [];
    const src: McpTokenSource = {
      accessToken: async () => ({
        token: 'TOKEN-VALUE-1',
        resource: 'https://mcp.example.org/mcp',
      }),
      insufficientScope: (token, needed) => void seen.push({ token, needed }),
    };
    const out = {
      fetch: async () =>
        new Response('', {
          status: 403,
          headers: {
            'www-authenticate':
              'Bearer error="insufficient_scope", scope="issues.write bad\u0001scope repo:admin"',
          },
        }),
      close: async () => undefined,
    } as unknown as OutboundDispatcher;
    await expect(
      createMcpFetch(parse({ auth: oauth }), {
        outbound: out,
        originFor: () => 'tenant',
        tokens: () => src,
      })('https://mcp.example.org/mcp'),
    ).rejects.toMatchObject({ code: 'mcp_insufficient_scope' });
    expect(seen).toEqual([{ token: 'TOKEN-VALUE-1', needed: ['issues.write', 'repo:admin'] }]);
  });
});

describe('canonical resource', () => {
  it.each([
    ['https://MCP.Example.org:443/mcp', 'https://mcp.example.org/mcp'],
    ['https://mcp.example.org/', 'https://mcp.example.org'],
    ['https://mcp.example.org/mcp/', 'https://mcp.example.org/mcp/'],
    ['https://mcp.example.org:8443/mcp#frag', 'https://mcp.example.org:8443/mcp'],
  ])('%s', (input, want) => expect(canonicalResource(input)).toBe(want));
});

describe('transport with a token source', () => {
  const calls: { url: string; auth: string | null }[] = [];
  const outbound = (status = 200, headers: Record<string, string> = {}) =>
    ({
      fetch: async (url: URL, init?: RequestInit) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
        return new Response('{}', { status, headers });
      },
      close: async () => undefined,
    }) as unknown as OutboundDispatcher;
  const source = (resource = 'https://mcp.example.org/mcp') => {
    const log = { rejected: 0 };
    return {
      log,
      src: {
        accessToken: async () => ({ token: 'TOKEN-VALUE-1', resource }),
        rejected: () => void log.rejected++,
      },
    };
  };
  const fetcher = (o: OutboundDispatcher, src?: McpTokenSource, cfg = parse({ auth: oauth })) =>
    createMcpFetch(cfg, {
      outbound: o,
      originFor: () => 'tenant',
      ...(src ? { tokens: () => src } : {}),
    });

  it('sets the bearer token itself and replaces any authorization header of the caller', async () => {
    calls.length = 0;
    const { src } = source();
    await fetcher(outbound(), src)('https://mcp.example.org/mcp', {
      headers: { authorization: 'Bearer other' },
    });
    expect(calls[0]!.auth).toBe('Bearer TOKEN-VALUE-1');
  });

  it('sends nothing for a token issued for another resource', async () => {
    calls.length = 0;
    const { src } = source('https://mcp.example.org/other');
    await expect(fetcher(outbound(), src)('https://mcp.example.org/mcp')).rejects.toMatchObject({
      code: 'mcp_resource_mismatch',
    });
    expect(calls).toHaveLength(0);
  });

  it('fails closed without a token source', async () => {
    calls.length = 0;
    await expect(fetcher(outbound())('https://mcp.example.org/mcp')).rejects.toMatchObject({
      code: 'mcp_auth_required',
    });
    expect(calls).toHaveLength(0);
  });

  it('a 401 marks the token rejected; insufficient_scope is its own error; other 403s pass', async () => {
    const a = source();
    await expect(
      fetcher(outbound(401), a.src)('https://mcp.example.org/mcp'),
    ).rejects.toMatchObject({
      code: 'mcp_auth_required',
    });
    expect(a.log.rejected).toBe(1);
    await expect(
      fetcher(
        outbound(403, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="w"' }),
        a.src,
      )('https://mcp.example.org/mcp'),
    ).rejects.toMatchObject({ code: 'mcp_insufficient_scope' });
    const plain = await fetcher(outbound(403), a.src)('https://mcp.example.org/mcp');
    expect(plain.status).toBe(403);
  });

  it('static and none connections never ask a token source', async () => {
    calls.length = 0;
    let asked = 0;
    const src = {
      accessToken: async () => {
        asked++;
        return { token: 'X'.repeat(30), resource: 'https://mcp.example.org/mcp' };
      },
    };
    for (const auth of [undefined, { kind: 'static' }, { kind: 'none' }])
      await fetcher(outbound(), src, parse(auth ? { auth } : {}))('https://mcp.example.org/mcp');
    expect(asked).toBe(0);
    expect(calls.every((c) => c.auth === null)).toBe(true);
  });
});
