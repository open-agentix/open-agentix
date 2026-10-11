import { randomBytes, randomUUID } from 'node:crypto';
import { ContextGuard, type SecretResolver } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, connections, mcpOauthTokens } from '../src/db/schema.js';
import { createMcpOauth, SecretRegistry } from '../src/mcp-oauth/index.js';
import { McpOauthService } from '../src/services/mcp-oauth.js';
import { FakeAs, FakeMcp, World, checkAssertion, json, newToken, rsaPem } from './oauth-world.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0016 slice S6: OAuth for HTTP MCP connections end to end on the control node. The database
 * and the crypto are real; the network is the real outbound dispatcher with a fake internet
 * (authorization server, MCP server) behind it.
 */
const CLIENT_ID = 'client-id-4711';
const CLIENT_SECRET = 'CLIENT-SECRET-Qw93kLm2Xz7Pa4RtYc6NhB1v';
const MCP = 'https://mcp.example.org/mcp';

class Secrets implements SecretResolver {
  constructor(public values: Record<string, string>) {}
  async resolve(ref: string): Promise<string> {
    const v = this.values[ref];
    if (v === undefined) throw new Error(`no secret ${ref}`);
    return v;
  }
}

let n: TestNode;
let world: World;
let as: FakeAs;
let mcp: FakeMcp;
let secrets: Secrets;
let clock = new Date('2026-10-10T12:00:00Z');
const rsa = rsaPem();

/** Rotation of refresh tokens belongs to the authorization-code grant; a stored row is turned into one. */
const asAuthorizationCode = async (id: string) =>
  n.ctx.db
    .update(mcpOauthTokens)
    .set({ grantType: 'authorization_code' })
    .where(eq(mcpOauthTokens.connectionId, id));

/** The discovery results are trusted for an hour; the sessions of the test node do not live that long. */
const expireDiscoveryCache = () =>
  (n.services.mcpOauthFlows as unknown as { verified: Map<string, number> }).verified.clear();

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

beforeAll(async () => {
  world = new World();
  as = new FakeAs(world);
  mcp = new FakeMcp(world, as);
  await mcp.start();
  secrets = new Secrets({
    'oa-client-id': CLIENT_ID,
    'oa-client-secret': CLIENT_SECRET,
    'oa-client-key': rsa.pem,
  });
  n = await testNode(
    {
      OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
      // OAX_TEST_FLOW_DATABASE_URL: a real PostgreSQL (empty database) instead of PGlite
      ...(process.env.OAX_TEST_FLOW_DATABASE_URL
        ? { OAX_DATABASE_URL: process.env.OAX_TEST_FLOW_DATABASE_URL }
        : {}),
    },
    { secrets, mcpOutbound: world.dispatcher, mcpProbeLimit: 10_000, now: () => clock },
  );
  const tenant = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id as string;
  await n.req({
    method: 'PATCH',
    url: `/v1/tenants/${tenant}`,
    payload: { secretRefs: ['oa-client-id', 'oa-client-secret', 'oa-client-key'] },
  });
});
afterEach(() => {
  as.nextToken = undefined;
  as.nextRevoke = undefined;
  as.latency = 0;
  as.expiresIn = 3600;
  as.issueRefresh = false;
});
afterAll(async () => {
  await mcp.stop();
  await n.close();
});

const basicAuth = {
  kind: 'oauth',
  grant: 'client_credentials',
  // client_secret_basic needs the issuer pinned: the secret goes to its token endpoint
  issuer: 'https://auth.example.org',
  client: {
    clientIdSecret: 'oa-client-id',
    clientAuth: 'client_secret_basic',
    clientSecretSecret: 'oa-client-secret',
  },
};
const jwtAuth = {
  kind: 'oauth',
  grant: 'client_credentials',
  client: {
    clientIdSecret: 'oa-client-id',
    clientAuth: 'private_key_jwt',
    keySecret: 'oa-client-key',
    keyId: 'k1',
  },
};
const tools = {
  tools: {
    get_issue: { access: 'read', scopes: ['issues.read'] },
    create_issue: { access: 'write', scopes: ['issues.write'] },
  },
  profiles: { read: ['get_issue'] },
};

let seq = 0;
async function create(auth: unknown, extra: Record<string, unknown> = {}, url = MCP) {
  const res = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: `oa-${++seq}`,
      config: { transport: 'streamable-http', url, auth, ...tools, ...extra },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const authorize = (id: string, body: unknown = {}) =>
  n.req({ method: 'POST', url: `/v1/connections/${id}/oauth/authorize`, payload: body as never });
const status = async (id: string) =>
  (await n.req({ method: 'GET', url: `/v1/connections/${id}/oauth` })).json();
const ref = async (id: string) => {
  const [row] = await n.ctx.db.select().from(connections).where(eq(connections.id, id));
  return { id, tenantId: row!.tenantId };
};
const token = async (id: string, guard = new ContextGuard()) =>
  n.services.mcpOauth.credentials.accessToken(await ref(id), [], { guard });
const audits = async (id: string) =>
  (await n.ctx.db.select().from(auditLog)).filter((a) => a.target === id).map((a) => a.action);

describe('configuration', () => {
  it('refuses oauth or none together with an authorization header (auth_conflict)', async () => {
    for (const [auth, extra] of [
      [basicAuth, { headerSecrets: { Authorization: 'oa-client-id' } }],
      [basicAuth, { headers: { authorization: 'Bearer x' } }],
      [{ kind: 'none' }, { headerSecrets: { authorization: 'oa-client-id' } }],
    ] as const) {
      const res = await n.req({
        method: 'POST',
        url: '/v1/connections',
        payload: {
          name: `bad-${++seq}`,
          config: { transport: 'streamable-http', url: MCP, auth, ...extra },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('auth_conflict');
    }
  });

  it('static with an authorization secret stays valid, as an absent auth does', async () => {
    for (const auth of [{ kind: 'static' }, undefined]) {
      const res = await n.req({
        method: 'POST',
        url: '/v1/connections',
        payload: {
          name: `st-${++seq}`,
          config: {
            transport: 'streamable-http',
            url: MCP,
            headerSecrets: { authorization: 'oa-client-id' },
            ...(auth ? { auth } : {}),
          },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  it.each([
    ['http url', basicAuth, 'http://mcp.example.org/mcp'],
    ['a query', basicAuth, 'https://mcp.example.org/mcp?api_key=abc'],
  ])('refuses an oauth connection with %s', async (_n, auth, url) => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: { name: `u-${++seq}`, config: { transport: 'streamable-http', url, auth } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('validates the client block', async () => {
    for (const client of [
      { clientIdSecret: 'a', clientAuth: 'private_key_jwt' },
      { clientIdSecret: 'a', clientAuth: 'client_secret_basic' },
      {
        clientIdSecret: 'a',
        clientAuth: 'client_secret_basic',
        clientSecretSecret: 'b',
        keySecret: 'c',
      },
      { clientIdSecret: 'a', clientAuth: 'none' },
    ]) {
      const res = await n.req({
        method: 'POST',
        url: '/v1/connections',
        payload: {
          name: `c-${++seq}`,
          config: {
            transport: 'streamable-http',
            url: MCP,
            auth: { kind: 'oauth', grant: 'client_credentials', client },
          },
        },
      });
      expect(res.statusCode, JSON.stringify(client)).toBe(400);
    }
  });

  it('reports a connection that was never authorized', async () => {
    const id = await create(basicAuth);
    expect((await status(id)).status).toBe('not_authorized');
    await expect(token(id)).rejects.toMatchObject({ code: 'mcp_auth_required' });
  });
});

describe('authorization with client_secret_basic', () => {
  it('discovers, pins the issuer, requests the profile scopes and the resource, and stores the token', async () => {
    const id = await create(basicAuth);
    world.clear();
    const res = await authorize(id);
    expect(res.statusCode, res.body).toBe(200);
    const st = res.json();
    expect(st).toMatchObject({
      status: 'active',
      issuer: as.issuer,
      scopes: ['issues.read'],
      endpointHosts: ['auth.example.org'],
      grant: 'client_credentials',
    });
    // specification order: unauthenticated initialize, resource metadata, AS metadata, token
    expect(world.reqs.map((r) => `${r.method} ${r.url.host}${r.url.pathname}`)).toEqual([
      'POST mcp.example.org/mcp',
      'GET mcp.example.org/.well-known/oauth-protected-resource/mcp',
      'GET auth.example.org/.well-known/oauth-authorization-server',
      'POST auth.example.org/token',
    ]);
    const req = as.tokenRequests.at(-1)!;
    expect(req.form.get('grant_type')).toBe('client_credentials');
    expect(req.form.get('resource')).toBe(MCP);
    expect(req.form.get('scope')).toBe('issues.read');
    expect(req.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(req.form.has('client_secret')).toBe(false);
    // the unauthenticated probe carried no credential at all
    expect(world.reqs[0]!.headers.get('authorization')).toBeNull();
    const guard = new ContextGuard();
    const t = await token(id, guard);
    expect(as.tokens.has(t.token)).toBe(true);
    expect(t.resource).toBe(MCP);
    expect(guard.text(`x ${t.token}`).text).not.toContain(t.token);
    expect(await audits(id)).toEqual(
      expect.arrayContaining(['mcp.oauth.discovered', 'mcp.oauth.authorized']),
    );
  });

  it('never returns or records the token or the client secret', async () => {
    const id = await create(basicAuth);
    const res = await authorize(id);
    const t = (await token(id)).token;
    const everything = [
      res.body,
      JSON.stringify(await status(id)),
      JSON.stringify(await n.ctx.db.select().from(auditLog)),
      (await n.req({ method: 'GET', url: `/v1/connections/${id}` })).body,
      (await n.req({ method: 'GET', url: '/v1/audit?limit=200' })).body,
    ].join('\n');
    for (const secret of [
      t,
      CLIENT_SECRET,
      Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    ])
      expect(everything).not.toContain(secret);
  });

  it('rate limits authorizations per user', async () => {
    const id = await create(basicAuth);
    const saved = n.ctx.mcpProbeLimit;
    n.ctx.mcpProbeLimit = 3;
    try {
      advance(2 * 60_000); // a fresh window
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await authorize(id)).statusCode);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    } finally {
      n.ctx.mcpProbeLimit = saved;
      advance(2 * 60_000);
    }
  });
});

describe('authorization with private_key_jwt', () => {
  it('sends a signed assertion for the token endpoint and no secret', async () => {
    const id = await create(jwtAuth);
    const res = await authorize(id);
    expect(res.statusCode, res.body).toBe(200);
    const form = as.tokenRequests.at(-1)!.form;
    expect(form.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    const { ok, header, claims } = checkAssertion(form.get('client_assertion')!, rsa.key);
    expect(ok).toBe(true);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
    expect(claims).toMatchObject({
      iss: CLIENT_ID,
      sub: CLIENT_ID,
      aud: `${as.issuer}/token`,
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
    expect(typeof claims.jti).toBe('string');
    expect(form.get('resource')).toBe(MCP);
    expect(as.tokenRequests.at(-1)!.headers.get('authorization')).toBeNull();
    // no leak of the PEM or of the assertion
    const blob = JSON.stringify(await n.ctx.db.select().from(auditLog)) + res.body;
    expect(blob).not.toContain('PRIVATE KEY');
    expect(blob).not.toContain(form.get('client_assertion')!);
  });

  it('keeps signing with PS256 on a renewal inside the verified window (PS256-only server)', async () => {
    const saved = as.metadata.token_endpoint_auth_signing_alg_values_supported;
    as.metadata.token_endpoint_auth_signing_alg_values_supported = ['PS256'];
    const algOf = (form: URLSearchParams) =>
      JSON.parse(Buffer.from(form.get('client_assertion')!.split('.')[0]!, 'base64url').toString())
        .alg as string;
    try {
      const id = await create(jwtAuth);
      as.expiresIn = 120;
      expect((await authorize(id)).statusCode).toBe(200);
      expect(algOf(as.tokenRequests.at(-1)!.form)).toBe('PS256');
      as.expiresIn = 3600;
      advance(70_000); // inside the renewal window, still inside the one hour of the pin
      const before = as.tokenRequests.length;
      await token(id);
      expect(as.tokenRequests.length - before).toBe(1);
      // the pin is trusted for the hour, so the algorithms come from the cache next to it
      expect(algOf(as.tokenRequests.at(-1)!.form)).toBe('PS256');
      expect((await status(id)).status).toBe('active');
      // and again from a fresh document once the pin has to be verified anew
      expireDiscoveryCache();
      advance(10 * 60_000);
      as.expiresIn = 120;
      await token(id);
      expect(algOf(as.tokenRequests.at(-1)!.form)).toBe('PS256');
    } finally {
      as.metadata.token_endpoint_auth_signing_alg_values_supported = saved;
      as.expiresIn = 3600;
    }
  });

  it('refuses a key the PEM parser cannot read without quoting it', async () => {
    secrets.values['oa-client-key'] = 'not a pem SECRET-MATERIAL';
    try {
      const id = await create(jwtAuth);
      const res = await authorize(id);
      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain('SECRET-MATERIAL');
    } finally {
      secrets.values['oa-client-key'] = rsa.pem;
    }
  });

  it('fails clearly when the authorization server does not support the method', async () => {
    const saved = as.metadata.token_endpoint_auth_methods_supported;
    as.metadata.token_endpoint_auth_methods_supported = ['client_secret_post'];
    try {
      const id = await create(jwtAuth);
      const res = await authorize(id);
      expect(res.json().error).toBe('mcp_oauth_unsupported');
    } finally {
      as.metadata.token_endpoint_auth_methods_supported = saved;
    }
  });
});

describe('discovery refusals are audited', () => {
  const denied = async (id: string) =>
    (await n.ctx.db.select().from(auditLog))
      .filter((a) => a.target === id && a.action === 'mcp.oauth.denied')
      .map((a) => (a.payload as { code: string }).code);

  it('PRM naming another resource', async () => {
    const id = await create(basicAuth);
    const saved = mcp.prm.bind(mcp);
    mcp.prm = () => ({ ...saved(), resource: 'https://other.example.org/mcp' });
    try {
      expect((await authorize(id)).json().error).toBe('mcp_resource_mismatch');
      expect(await denied(id)).toEqual(['resource_mismatch']);
    } finally {
      mcp.prm = saved;
    }
  });

  it('AS metadata naming another issuer (mix-up)', async () => {
    const id = await create(basicAuth);
    const saved = as.metadata.issuer;
    as.metadata.issuer = 'https://evil.example.org';
    try {
      expect((await authorize(id)).json().error).toBe('mcp_issuer_mismatch');
      expect(await denied(id)).toEqual(['issuer_mismatch']);
      expect(as.tokenRequests.length).toBeGreaterThan(0); // earlier tests; none for this id below
    } finally {
      as.metadata.issuer = saved;
    }
  });

  it('a pinned issuer that the resource does not name', async () => {
    const id = await create({ ...basicAuth, issuer: 'https://other-as.example.org' });
    const before = as.tokenRequests.length;
    expect((await authorize(id)).json().error).toBe('mcp_issuer_mismatch');
    expect(as.tokenRequests.length).toBe(before);
    expect(await denied(id)).toEqual(['issuer_mismatch']);
  });

  it('token endpoint on an internal address', async () => {
    const id = await create(basicAuth);
    const saved = as.metadata.token_endpoint;
    as.metadata.token_endpoint = 'https://169.254.169.254/token';
    try {
      const before = world.reqs.length;
      const res = await authorize(id);
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('egress_denied');
      expect(world.reqs.slice(before).some((r) => r.url.host === '169.254.169.254')).toBe(false);
      expect(await denied(id)).toEqual(['egress_denied']);
    } finally {
      as.metadata.token_endpoint = saved;
    }
  });

  it('several authorization servers need an explicit choice', async () => {
    const id = await create(jwtAuth);
    const saved = mcp.prm.bind(mcp);
    mcp.prm = () => ({
      ...saved(),
      authorization_servers: ['https://auth.example.org', 'https://auth2.example.org'],
    });
    try {
      const res = await authorize(id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('mcp_oauth_issuer_required');
      expect((await authorize(id, { issuer: 'https://auth.example.org' })).statusCode).toBe(200);
      expect((await authorize(id, { issuer: 'https://unlisted.example.org' })).statusCode).toBe(
        422,
      );
    } finally {
      mcp.prm = saved;
    }
  });
});

describe('what a hostile authorization server can make the platform store or say', () => {
  it('an error_description that quotes the client secret never appears', async () => {
    const id = await create(basicAuth);
    as.nextToken = () =>
      json({ error: 'invalid_client', error_description: `bad secret ${CLIENT_SECRET}` }, 401);
    const res = await authorize(id);
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(await n.ctx.db.select().from(auditLog))).not.toContain(CLIENT_SECRET);
    expect((await status(id)).status).toBe('not_authorized');
  });

  it.each([
    ['a short token', { access_token: 'abc', token_type: 'Bearer' }],
    ['a uuid-shaped token', { access_token: randomUUID(), token_type: 'Bearer' }],
    [
      'a path-shaped token',
      { access_token: 'runs/finished/by/some/worker/node', token_type: 'Bearer' },
    ],
    ['a host-name-shaped token', { access_token: 'auth.example.org', token_type: 'Bearer' }],
    ['a word-like token', { access_token: 'invalidgrantexpiredtokenerror', token_type: 'Bearer' }],
    [
      'a hostile refresh token',
      {
        access_token: newToken(),
        token_type: 'Bearer',
        refresh_token: 'runs/finished/by/some/worker/node',
      },
    ],
    ['a scope with a quote', { access_token: newToken(), token_type: 'Bearer', scope: 'a"b' }],
    ['a DPoP token', { access_token: newToken(), token_type: 'DPoP' }],
    ['a token without a type', { access_token: newToken() }],
    ['a negative lifetime', { access_token: newToken(), token_type: 'Bearer', expires_in: -5 }],
    [
      'a refresh token of the wrong type',
      { access_token: newToken(), token_type: 'Bearer', refresh_token: 5 },
    ],
  ])('refuses %s and stores nothing', async (_n, body) => {
    const id = await create(basicAuth);
    as.nextToken = () => json(body);
    const auditBefore = JSON.stringify(await audits(id));
    const res = await authorize(id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    // A refused value is never a redaction target: it must not blank text of the tenant.
    for (const v of [body.access_token, (body as { refresh_token?: unknown }).refresh_token])
      if (typeof v === 'string') expect(n.services.mcpOauth.registry.has(v)).toBe(false);
    // the refusal is audited without the value (the discovery entry is the only new one)
    expect((await audits(id)).filter((a) => !auditBefore.includes(a)).join()).not.toMatch(/token/);
    expect((await status(id)).status).toBe('not_authorized');
    const rows = await n.ctx.db
      .select()
      .from(mcpOauthTokens)
      .where(eq(mcpOauthTokens.connectionId, id));
    expect(rows).toHaveLength(0);
  });

  it('a redirect from the token endpoint is not followed', async () => {
    const id = await create(basicAuth);
    as.nextToken = () =>
      new Response('', { status: 307, headers: { location: 'https://169.254.169.254/' } });
    const before = world.reqs.length;
    const res = await authorize(id);
    expect(res.json().error).toBe('mcp_oauth_redirect');
    expect(world.reqs.slice(before).some((r) => r.url.host === '169.254.169.254')).toBe(false);
  });
});

describe('renewal', () => {
  it('renews once for twenty parallel uses (single flight) and sends the resource again', async () => {
    const id = await create(basicAuth);
    as.expiresIn = 120;
    await authorize(id);
    as.expiresIn = 3600;
    advance(70_000); // inside the renewal window, still valid
    const before = as.tokenRequests.length;
    as.latency = 30;
    const guards = Array.from({ length: 20 }, () => new ContextGuard());
    const got = await Promise.all(guards.map((g) => token(id, g)));
    as.latency = 0;
    expect(as.tokenRequests.length - before).toBe(1);
    expect(new Set(got.map((g) => g.token)).size).toBe(1);
    expect(as.tokenRequests.at(-1)!.form.get('resource')).toBe(MCP);
  });

  it('two replicas renew once between them (advisory lock, re-read under the lock)', async () => {
    const id = await create(basicAuth);
    as.expiresIn = 120;
    await authorize(id);
    as.expiresIn = 3600;
    advance(70_000); // inside the renewal window, still valid
    const other = new McpOauthService(
      n.ctx,
      n.services.audit,
      n.services.catalog,
      n.services.runNodes,
      createMcpOauth(n.ctx, 'api', new SecretRegistry()),
    );
    // the constructor re-wired the catalog hooks to the second instance: put them back
    n.services.mcpOauthFlows['stores'].credentials.useRefresher({
      refresh: (c) => n.services.mcpOauthFlows.refresh(c),
    });
    n.services.catalog.oauth = { prepareRevoke: (r) => n.services.mcpOauthFlows.prepareRevoke(r) };
    const r = await ref(id);
    const before = as.tokenRequests.length;
    as.latency = 30;
    await Promise.all([n.services.mcpOauthFlows.refresh(r), other.refresh(r)]);
    as.latency = 0;
    expect(as.tokenRequests.length - before).toBe(1);
  });

  it('keeps the old pair when writing the rotated one fails, and persists the new pair otherwise', async () => {
    const id = await create(basicAuth);
    as.issueRefresh = true;
    as.expiresIn = 120;
    await authorize(id);
    as.expiresIn = 3600;
    advance(70_000); // inside the renewal window, still valid
    await asAuthorizationCode(id);
    const r = await ref(id);
    const old = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!;
    expect(old.refreshToken).toBeTruthy();
    const keys = n.services.mcpOauth.keys;
    const real = keys.sealAll.bind(keys);
    keys.sealAll = (async () => {
      throw new Error('disk full');
    }) as never;
    try {
      await expect(n.services.mcpOauthFlows.refresh(r)).rejects.toMatchObject({
        code: 'mcp_auth_refresh_failed',
      });
    } finally {
      keys.sealAll = real;
    }
    const after = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!;
    expect(after.accessToken).toBe(old.accessToken);
    expect(after.refreshToken).toBe(old.refreshToken);
    // the server rotated its refresh token for the failed attempt, as real servers do; the platform
    // keeps the old pair, which the server now refuses: the next renewal reports invalid_grant
    advance(10 * 60_000);
    const failing = await n.services.mcpOauthFlows.refresh(r).then(
      () => 'ok',
      (e) => e.code,
    );
    expect(['ok', 'mcp_auth_required']).toContain(failing);
    as.issueRefresh = false;
  });

  it('stores a rotated refresh token together with the new access token', async () => {
    const id = await create(basicAuth);
    as.issueRefresh = true;
    as.expiresIn = 120;
    await authorize(id);
    as.expiresIn = 3600;
    advance(70_000); // inside the renewal window, still valid
    await asAuthorizationCode(id);
    const r = await ref(id);
    const old = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!;
    advance(10_000);
    const t = await token(id);
    const now = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!;
    expect(t.token).toBe(now.accessToken);
    expect(now.accessToken).not.toBe(old.accessToken);
    expect(now.refreshToken).not.toBe(old.refreshToken);
    expect(as.tokenRequests.at(-1)!.form.get('grant_type')).toBe('refresh_token');
    expect(as.tokenRequests.at(-1)!.form.get('resource')).toBe(MCP);
    as.issueRefresh = false;
  });

  it('invalid_grant: reauthorization_required, closed, audited, and no more requests', async () => {
    const id = await create(basicAuth);
    as.expiresIn = 120;
    await authorize(id);
    as.expiresIn = 3600;
    advance(70_000); // inside the renewal window, still valid
    as.nextToken = () => json({ error: 'invalid_grant', error_description: 'gone' }, 400);
    advance(10_000);
    await expect(token(id)).rejects.toMatchObject({ code: 'mcp_auth_required' });
    expect(await status(id)).toMatchObject({
      status: 'reauthorization_required',
      lastError: 'invalid_grant',
    });
    const before = as.tokenRequests.length;
    await expect(token(id)).rejects.toMatchObject({ code: 'mcp_auth_required' });
    expect(as.tokenRequests.length).toBe(before);
    expect(await audits(id)).toContain('mcp.oauth.refresh_failed');
    // an administrator can recover with a new authorization
    as.nextToken = undefined;
    const again = await authorize(id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().status).toBe('active');
    expect(as.tokens.has((await token(id)).token)).toBe(true);
  });

  it('a transient failure keeps using a token that has not expired, then retries after 30 s', async () => {
    const id = await create(basicAuth);
    as.expiresIn = 100;
    await authorize(id);
    as.expiresIn = 3600;
    advance(50_000); // inside the renewal window (half of the lifetime), but still valid
    const r = await ref(id);
    const first = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!.accessToken;
    as.nextToken = () => new Response('busy', { status: 503 });
    expect((await token(id)).token).toBe(first);
    expect((await status(id)).lastError).toBe('server_error');
    const calls = as.tokenRequests.length;
    expect((await token(id)).token).toBe(first); // inside the retry pause: no new request
    expect(as.tokenRequests.length).toBe(calls);
    as.nextToken = undefined;
    advance(31_000);
    advance(30_000); // the old token has expired by now
    const renewed = (await token(id)).token;
    expect(renewed).not.toBe(first);
    expect((await status(id)).lastError).toBeNull();
  });

  it('a failed renewal of an expired token marks refresh_failed and recovers', async () => {
    const id = await create(basicAuth);
    as.expiresIn = 10;
    await authorize(id);
    as.expiresIn = 3600;
    advance(60_000);
    as.nextToken = () => new Response('busy', { status: 503 });
    await expect(token(id)).rejects.toMatchObject({ code: 'mcp_auth_refresh_failed' });
    expect((await status(id)).status).toBe('refresh_failed');
    as.nextToken = undefined;
    advance(31_000);
    expect(as.tokens.has((await token(id)).token)).toBe(true);
    expect((await status(id)).status).toBe('active');
  });
});

describe('issuer and endpoint pinning', () => {
  it('a resource that later names another issuer needs a new authorization, without a request to it', async () => {
    const id = await create(basicAuth);
    as.expiresIn = 120;
    await authorize(id);
    as.expiresIn = 3600;
    advance(70_000); // inside the renewal window, still valid
    const evil = new FakeAs(world, { issuer: 'https://evil.example.org' });
    const saved = mcp.prm.bind(mcp);
    mcp.prm = () => ({ ...saved(), authorization_servers: [evil.issuer] });
    expireDiscoveryCache();
    try {
      await expect(token(id)).rejects.toMatchObject({ code: 'mcp_auth_required' });
    } finally {
      mcp.prm = saved;
    }
    expect(evil.tokenRequests).toHaveLength(0);
    expect(world.to('evil.example.org').filter((r) => r.url.pathname === '/token')).toHaveLength(0);
    expect((await status(id)).status).toBe('reauthorization_required');
    const denied = (await n.ctx.db.select().from(auditLog)).filter(
      (a) => a.target === id && a.action === 'mcp.oauth.denied',
    );
    expect(denied.map((a) => (a.payload as { code: string }).code)).toContain('issuer_mismatch');
  });

  it('a moved token endpoint needs a new authorization and receives nothing', async () => {
    const id = await create(basicAuth);
    as.expiresIn = 120;
    await authorize(id);
    as.expiresIn = 3600;
    advance(70_000); // inside the renewal window, still valid
    const saved = as.metadata.token_endpoint;
    as.metadata.token_endpoint = 'https://auth.example.org/token-v2';
    expireDiscoveryCache();
    const before = as.tokenRequests.length;
    try {
      await expect(token(id)).rejects.toMatchObject({ code: 'mcp_auth_required' });
    } finally {
      as.metadata.token_endpoint = saved;
    }
    expect(as.tokenRequests.length).toBe(before);
    expect((await status(id)).status).toBe('reauthorization_required');
  });
});

describe('revocation', () => {
  it('disconnect revokes at the issuer with client authentication and deletes the row', async () => {
    const id = await create(basicAuth);
    await authorize(id);
    const t = (await token(id)).token;
    const res = await n.req({ method: 'POST', url: `/v1/connections/${id}/oauth/disconnect` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('not_authorized');
    expect(as.revoked).toContain(t);
    const rq = as.revokeRequests.at(-1)!;
    expect(rq.form.get('token_type_hint')).toBe('access_token');
    expect(rq.headers.get('authorization')).toMatch(/^Basic /);
    expect(await audits(id)).toContain('mcp.oauth.revoked');
    await expect(token(id)).rejects.toMatchObject({ code: 'mcp_auth_required' });
  });

  it('a failing revocation endpoint does not keep the tokens', async () => {
    const id = await create(basicAuth);
    await authorize(id);
    as.nextRevoke = () => new Response('boom', { status: 500 });
    const res = await n.req({ method: 'POST', url: `/v1/connections/${id}/oauth/disconnect` });
    expect(res.json().status).toBe('not_authorized');
    const rev = (await n.ctx.db.select().from(auditLog)).find(
      (a) => a.target === id && a.action === 'mcp.oauth.revoked',
    );
    expect((rev!.payload as { remote: string }).remote).toBe('failed');
    as.nextRevoke = undefined;
  });

  it('changing the url revokes the old token, bumps the credential version and drops the row', async () => {
    const id = await create(basicAuth);
    await authorize(id);
    const t = (await token(id)).token;
    const cfg = (await n.req({ method: 'GET', url: `/v1/connections/${id}` })).json().config;
    const res = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { config: { ...cfg, url: 'https://mcp.example.org/mcp2' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(as.revoked).toContain(t);
    const rows = await n.ctx.db
      .select()
      .from(mcpOauthTokens)
      .where(eq(mcpOauthTokens.connectionId, id));
    expect(rows).toHaveLength(0);
    expect((await status(id)).status).toBe('not_authorized');
  });

  it('changing the client or the pinned issuer is a change of the relationship too', async () => {
    const id = await create(jwtAuth);
    await authorize(id);
    const t = (await token(id)).token;
    const cfg = (await n.req({ method: 'GET', url: `/v1/connections/${id}` })).json().config;
    const res = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { config: { ...cfg, auth: { ...cfg.auth, issuer: 'https://auth.example.org' } } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(as.revoked).toContain(t);
    expect((await status(id)).status).toBe('not_authorized');
  });

  it('a scope-only change keeps the authorization', async () => {
    const id = await create(basicAuth);
    await authorize(id);
    const cfg = (await n.req({ method: 'GET', url: `/v1/connections/${id}` })).json().config;
    const res = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { config: { ...cfg, auth: { ...cfg.auth, scopes: ['issues.read'] } } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await status(id)).status).toBe('active');
  });

  it('deleting the connection revokes its tokens', async () => {
    const id = await create(basicAuth);
    await authorize(id);
    const t = (await token(id)).token;
    expect((await n.req({ method: 'DELETE', url: `/v1/connections/${id}` })).statusCode).toBe(204);
    expect(as.revoked).toContain(t);
  });
});

describe('use by the control node', () => {
  it('the connection test sends the token, answers a category only and keeps the token out of snapshots', async () => {
    const id = await create(basicAuth, { tools: { echo_auth: { access: 'read' } }, profiles: {} });
    // before authorization the test says auth_failed, not config_invalid
    const pre = await n.req({ method: 'POST', url: `/v1/connections/${id}/test`, payload: {} });
    expect(pre.json()).toMatchObject({ ok: false, category: 'auth_failed' });
    await authorize(id);
    const res = await n.req({ method: 'POST', url: `/v1/connections/${id}/test`, payload: {} });
    expect(res.json()).toMatchObject({ ok: true, category: 'ok' });
    const t = (await token(id)).token;
    expect(mcp.seenAuth).toContain(`Bearer ${t}`);
    expect(res.body).not.toContain(t);
  });

  it('a 401 from the server expires the stored token and the connection recovers on the next use', async () => {
    const id = await create(basicAuth, { tools: { echo_auth: { access: 'read' } }, profiles: {} });
    await authorize(id);
    const t1 = (await token(id)).token;
    as.tokens.delete(t1); // the server revokes it behind our back
    const res = await n.req({ method: 'POST', url: `/v1/connections/${id}/test`, payload: {} });
    expect(res.json().category).toBe('auth_failed');
    advance(6_000);
    const res2 = await n.req({ method: 'POST', url: `/v1/connections/${id}/test`, payload: {} });
    expect(res2.json()).toMatchObject({ ok: true });
    expect((await token(id)).token).not.toBe(t1);
  });
});

describe('tenancy', () => {
  it('another tenant sees neither the connection nor its state', async () => {
    const id = await create(basicAuth);
    await authorize(id);
    const stranger = {
      userId: randomUUID(),
      tenantId: randomUUID(),
      platformAdmin: false,
    };
    await expect(n.services.mcpOauthFlows.status(stranger as never, id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(n.services.mcpOauthFlows.authorize(stranger as never, id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(n.services.mcpOauthFlows.disconnect(stranger as never, id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      n.services.mcpOauth.credentials.accessToken({ id, tenantId: stranger.tenantId }, [], {
        guard: new ContextGuard(),
      }),
    ).rejects.toMatchObject({ code: 'mcp_auth_required' });
  });
});

describe('issuer pinning protects the client secret', () => {
  it('a resource that names only another token server never receives the client secret', async () => {
    const evil = new FakeAs(world, { issuer: 'https://evil-as.example.net' });
    const id = await create(basicAuth); // pinned to auth.example.org
    const saved = mcp.prm.bind(mcp);
    mcp.prm = () => ({ ...saved(), authorization_servers: [evil.issuer] });
    try {
      const res = await authorize(id);
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('mcp_issuer_mismatch');
      // naming the evil server in the body does not override the pin of the configuration either
      expect((await authorize(id, { issuer: evil.issuer })).json().error).toBe(
        'mcp_issuer_mismatch',
      );
    } finally {
      mcp.prm = saved;
    }
    expect(world.to('evil-as.example.net')).toHaveLength(0);
    expect(evil.tokenRequests).toHaveLength(0);
  });

  it('after a reauthorization is required, a new server needs the administrator to name it', async () => {
    const id = await create(jwtAuth); // no issuer pin in the configuration
    as.expiresIn = 120;
    await authorize(id);
    as.expiresIn = 3600;
    advance(70_000);
    const other = new FakeAs(world, { issuer: 'https://other-as.example.net' });
    const saved = mcp.prm.bind(mcp);
    mcp.prm = () => ({ ...saved(), authorization_servers: [other.issuer] });
    expireDiscoveryCache();
    try {
      await expect(token(id)).rejects.toMatchObject({ code: 'mcp_auth_required' });
      expect((await status(id)).status).toBe('reauthorization_required');
      const silent = await authorize(id);
      expect(silent.statusCode).toBe(409);
      expect(silent.json().error).toBe('mcp_oauth_issuer_required');
      expect(
        world.to('other-as.example.net').filter((r) => r.url.pathname === '/token'),
      ).toHaveLength(0);
      const confirmed = await authorize(id, { issuer: other.issuer });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect((await status(id)).issuer).toBe(other.issuer);
    } finally {
      mcp.prm = saved;
    }
  });
});

describe('client credentials renewal', () => {
  it('never uses a stored refresh token: a fresh grant is requested (RFC 6749 section 4.4.3)', async () => {
    const id = await create(basicAuth);
    as.issueRefresh = true;
    as.expiresIn = 120;
    await authorize(id);
    as.expiresIn = 3600;
    advance(70_000);
    const r = await ref(id);
    expect((await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!.refreshToken).toBeTruthy();
    // a server that lost or rotated the refresh token cannot lock the connection out
    as.validRefresh.clear();
    const before = as.tokenRequests.length;
    expect(as.tokens.has((await token(id)).token)).toBe(true);
    expect(as.tokenRequests.length - before).toBe(1);
    expect(as.tokenRequests.at(-1)!.form.get('grant_type')).toBe('client_credentials');
    expect((await status(id)).status).toBe('active');
  });

  it('renews a short-lived token at half of its lifetime, not on every use', async () => {
    const id = await create(basicAuth);
    as.expiresIn = 30;
    await authorize(id);
    as.expiresIn = 3600;
    const before = as.tokenRequests.length;
    await token(id);
    await token(id);
    expect(as.tokenRequests.length).toBe(before);
    advance(16_000); // 14 s left, less than half of 30 s
    await token(id);
    expect(as.tokenRequests.length - before).toBe(1);
  });

  it('only the endpoints the platform calls are compared with the pin', async () => {
    const id = await create(basicAuth);
    as.expiresIn = 120;
    await authorize(id);
    as.expiresIn = 3600;
    advance(70_000);
    const saved = { ...as.metadata };
    as.metadata.jwks_uri = 'https://auth.example.org/jwks-new';
    as.metadata.authorization_endpoint = 'https://auth.example.org/authorize-v2';
    expireDiscoveryCache();
    try {
      expect(as.tokens.has((await token(id)).token)).toBe(true);
      expect((await status(id)).status).toBe('active');
    } finally {
      as.metadata = saved;
    }
  });

  it('a 401 for an old token does not expire the token another replica just renewed', async () => {
    const id = await create(basicAuth);
    await authorize(id);
    const r = await ref(id);
    const current = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!;
    await n.services.mcpOauth.tokens.expireIfCurrent(
      r.tenantId,
      r.id,
      1,
      'an-older-token-value-0000000000',
    );
    const after = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!;
    expect(after.meta.expiresAt).toEqual(current.meta.expiresAt);
    await n.services.mcpOauth.tokens.expireIfCurrent(r.tenantId, r.id, 1, current.accessToken);
    const expired = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!;
    expect(expired.meta.expiresAt!.getTime()).toBeLessThanOrEqual(clock.getTime());
  });
});
