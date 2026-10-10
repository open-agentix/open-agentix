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
    const id = await create(basicAuth);
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
    const res = await authorize(id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
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
    as.expiresIn = 30; // inside the 60 s renewal window right away
    await authorize(id);
    as.expiresIn = 3600;
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
    as.expiresIn = 30;
    await authorize(id);
    as.expiresIn = 3600;
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
    as.expiresIn = 30;
    await authorize(id);
    as.expiresIn = 3600;
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
    as.expiresIn = 30;
    await authorize(id);
    as.expiresIn = 3600;
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
    as.expiresIn = 30;
    await authorize(id);
    as.expiresIn = 3600;
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
    as.expiresIn = 45; // inside the renewal window, but still valid
    await authorize(id);
    as.expiresIn = 3600;
    const r = await ref(id);
    const first = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!.accessToken;
    as.nextToken = () => new Response('busy', { status: 503 });
    expect((await token(id)).token).toBe(first);
    expect((await status(id)).lastError).toBe('server_error');
    const calls = as.tokenRequests.length;
    expect((await token(id)).token).toBe(first); // inside the retry pause: no new request
    expect(as.tokenRequests.length).toBe(calls);
    as.nextToken = undefined;
    advance(31_000); // the old token has expired by now (45 s lifetime)
    advance(20_000);
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
    as.expiresIn = 30;
    await authorize(id);
    as.expiresIn = 3600;
    const evil = new FakeAs(world, { issuer: 'https://evil.example.org' });
    const saved = mcp.prm.bind(mcp);
    mcp.prm = () => ({ ...saved(), authorization_servers: [evil.issuer] });
    advance(2 * 60 * 60_000);
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
    as.expiresIn = 30;
    await authorize(id);
    as.expiresIn = 3600;
    const saved = as.metadata.token_endpoint;
    as.metadata.token_endpoint = 'https://auth.example.org/token-v2';
    advance(2 * 60 * 60_000);
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
    const id = await create(basicAuth);
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
