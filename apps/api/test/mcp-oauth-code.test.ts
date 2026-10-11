import { randomBytes } from 'node:crypto';
import { ContextGuard, type SecretResolver } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  connections,
  mcpOauthClients,
  mcpOauthPending,
  mcpOauthTokens,
} from '../src/db/schema.js';
import { buildApp } from '../src/http/app.js';
import { FakeAs, FakeMcp, World, json, newToken } from './oauth-world.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0016 slice S7: the authorization-code flow end to end on the control node. The database, the
 * crypto and the HTTP app are real; the network is the real outbound dispatcher with a fake internet
 * (an authorization server that checks PKCE, the redirect URI and single use of codes, and an MCP
 * server) behind it. The "browser" is the test: it takes the authorization URL, lets the fake
 * server consent and visits the callback it names.
 */
const MCP = 'https://mcp.example.org/mcp';
const PUBLIC = 'https://oax.example.org';
const CALLBACK = `${PUBLIC}/v1/oauth/mcp/callback`;
const PW = 'a-long-test-password-1';

class Secrets implements SecretResolver {
  constructor(public values: Record<string, string>) {}
  async resolve(ref: string): Promise<string> {
    const v = this.values[ref];
    if (v === undefined) throw new Error(`no secret ${ref}`);
    return v;
  }
}

let n: TestNode;
let n2: TestNode; // CIMD and DCR on, a console URL set
let world: World;
let as: FakeAs;
let mcp: FakeMcp;
let clock = new Date('2026-10-10T12:00:00Z');
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

const codeMetadata = () => ({
  issuer: as.issuer,
  token_endpoint: `${as.issuer}/token`,
  revocation_endpoint: `${as.issuer}/revoke`,
  authorization_endpoint: `${as.issuer}/authorize`,
  registration_endpoint: `${as.issuer}/register`,
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'private_key_jwt'],
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: false,
  client_id_metadata_document_supported: true,
  scopes_supported: ['issues.read', 'issues.write', 'offline_access'],
});

const tools = {
  tools: {
    get_issue: { access: 'read', scopes: ['issues.read'] },
    create_issue: { access: 'write', scopes: ['issues.write'] },
  },
  profiles: { read: ['get_issue'] },
};
const publicAuth = {
  kind: 'oauth',
  grant: 'authorization_code',
  client: { clientIdSecret: 'oa-public-id', clientAuth: 'none' },
};
const confidentialAuth = {
  kind: 'oauth',
  grant: 'authorization_code',
  issuer: 'https://auth.example.org',
  client: {
    clientIdSecret: 'oa-client-id',
    clientAuth: 'client_secret_basic',
    clientSecretSecret: 'oa-client-secret',
  },
};
const cimdAuth = { kind: 'oauth', grant: 'authorization_code', client: { registration: 'cimd' } };
const dcrAuth = { kind: 'oauth', grant: 'authorization_code', client: { registration: 'dcr' } };

let seq = 0;
async function create(node: TestNode, auth: unknown, extra: Record<string, unknown> = {}) {
  const res = await node.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: `code-${++seq}`,
      config: { transport: 'streamable-http', url: MCP, auth, ...tools, ...extra },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const post = (node: TestNode, id: string, body: unknown = {}, token?: string | null) =>
  node.req({
    method: 'POST',
    url: `/v1/connections/${id}/oauth/authorize`,
    payload: body as never,
    ...(token !== undefined ? { token } : {}),
  });
/** Starts a consent and returns the authorization URL. */
async function start(node: TestNode, id: string, token?: string | null) {
  const res = await post(node, id, {}, token);
  expect(res.statusCode, res.body).toBe(200);
  const url = res.json().authorizationUrl as string;
  expect(url).toBeTruthy();
  return url;
}
/** The browser follows the redirect of the authorization server to the callback. */
const visit = (node: TestNode, url: URL | string) => {
  const u = new URL(url);
  return node.app.inject({ method: 'GET', url: u.pathname + u.search });
};
const status = async (node: TestNode, id: string) =>
  (await node.req({ method: 'GET', url: `/v1/connections/${id}/oauth` })).json();
const ref = async (node: TestNode, id: string) => {
  const [row] = await node.ctx.db.select().from(connections).where(eq(connections.id, id));
  return { id, tenantId: row!.tenantId };
};
const token = async (node: TestNode, id: string, scope: string[] = []) =>
  node.services.mcpOauth.credentials.accessToken(await ref(node, id), scope, {
    guard: new ContextGuard(),
  });
const actions = async (node: TestNode, id: string) =>
  (await node.ctx.db.select().from(auditLog)).filter((a) => a.target === id).map((a) => a.action);
/** Open consent requests of one connection (other tests leave theirs behind). */
const pendingCount = async (node: TestNode, id: string) =>
  (await node.ctx.db.select().from(mcpOauthPending)).filter((p) => p.connectionId === id).length;
const resultOf = (res: { headers: Record<string, unknown>; body: string }) =>
  /\((\w+)\)/.exec(res.body)?.[1] ?? (res.body.includes('completed') ? 'ok' : 'unknown');

beforeAll(async () => {
  world = new World();
  as = new FakeAs(world);
  as.metadata = codeMetadata();
  mcp = new FakeMcp(world, as);
  await mcp.start();
  const secrets = new Secrets({
    'oa-public-id': 'public-client-4711',
    'oa-client-id': 'confidential-client-4711',
    'oa-client-secret': 'CLIENT-SECRET-Qw93kLm2Xz7Pa4RtYc6NhB1v',
  });
  const env = {
    OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
    OAX_PUBLIC_URL: PUBLIC,
    ...(process.env.OAX_TEST_FLOW_DATABASE_URL
      ? { OAX_DATABASE_URL: process.env.OAX_TEST_FLOW_DATABASE_URL }
      : {}),
  };
  const overrides = {
    secrets,
    mcpOutbound: world.dispatcher,
    mcpProbeLimit: 10_000,
    now: () => clock,
  };
  n = await testNode(env, overrides);
  n2 = await testNode(
    {
      ...env,
      OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
      OAX_MCP_OAUTH_CIMD: 'true',
      OAX_MCP_OAUTH_DCR: 'true',
      OAX_UI_URL: 'https://console.example.org',
      // a real database is shared only by the first node
      OAX_DATABASE_URL: 'memory://',
    },
    overrides,
  );
  for (const node of [n, n2]) {
    node.services.mcpOauthFlows.rotationRetryMs = [5, 5, 5];
    const tenant = (await node.req({ method: 'GET', url: '/v1/tenants' })).json().items[0]
      .id as string;
    await node.req({
      method: 'PATCH',
      url: `/v1/tenants/${tenant}`,
      payload: { secretRefs: ['oa-public-id', 'oa-client-id', 'oa-client-secret'] },
    });
  }
});
afterEach(() => {
  as.metadata = codeMetadata();
  as.nextToken = undefined;
  as.nextRevoke = undefined;
  as.nextRegistration = undefined;
  as.registeredSecret = undefined;
  as.expiresIn = 3600;
  world.clear();
});
afterAll(async () => {
  await mcp.stop();
  await n.close();
  await n2.close();
});

describe('configuration', () => {
  it('accepts every registration of the authorization-code grant, with the flags on', async () => {
    for (const auth of [publicAuth, confidentialAuth, cimdAuth, dcrAuth]) await create(n2, auth);
  });

  it('refuses cimd and dcr while the operator has not enabled them', async () => {
    for (const [auth, code] of [
      [cimdAuth, 'mcp_oauth_cimd_disabled'],
      [dcrAuth, 'mcp_oauth_dcr_disabled'],
    ] as const) {
      const res = await n.req({
        method: 'POST',
        url: '/v1/connections',
        payload: {
          name: `off-${++seq}`,
          config: { transport: 'streamable-http', url: MCP, auth },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(code);
    }
  });

  it('refuses authorization_code on a central (platform) instance, at save and at authorize', async () => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: `central-${++seq}`,
        scope: 'platform',
        config: { transport: 'streamable-http', url: MCP, auth: publicAuth },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('central_user_delegation');
    // a row that got there another way (an older build, the database) is refused at authorize
    const id = await create(n, publicAuth);
    await n.ctx.db.update(connections).set({ scope: 'platform' }).where(eq(connections.id, id));
    const att = await post(n, id);
    expect(att.statusCode).toBe(400);
    expect(att.json().error).toBe('central_user_delegation');
    expect(await pendingCount(n, id)).toBe(0);
  });

  it('refuses a redirect URI that is not https (localhost excepted) or not an origin', async () => {
    const id = await create(n, publicAuth);
    const flows = n.services.mcpOauthFlows;
    const config = n.ctx.config as unknown as { publicUrl: string };
    const original = config.publicUrl;
    try {
      for (const [url, ok] of [
        ['http://oax.example.org', false],
        ['https://oax.example.org/app', false],
        ['http://localhost:8080', true],
        ['https://oax.example.org', true],
      ] as const) {
        config.publicUrl = url;
        if (ok) expect(flows.redirectUriOf()).toBe(`${url}/v1/oauth/mcp/callback`);
        else expect(() => flows.redirectUriOf(), url).toThrow();
      }
      config.publicUrl = 'http://oax.example.org';
      const res = await post(n, id);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('mcp_oauth_redirect_insecure');
    } finally {
      config.publicUrl = original;
    }
  });
});

describe('the consent', () => {
  it('sends PKCE S256, the exact redirect URI, a fresh state and the resource; stores the tokens on the instance', async () => {
    const id = await create(n, publicAuth);
    const res = await post(n, id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'not_authorized',
      grant: 'authorization_code',
      registration: 'preregistered',
      redirectUri: CALLBACK,
    });
    expect(body.pendingExpiresAt).toBeTruthy();
    const url = new URL(body.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${as.issuer}/authorize`);
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('public-client-4711');
    expect(q.get('redirect_uri')).toBe(CALLBACK);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('resource')).toBe(MCP);
    // profile scopes, plus offline_access because the server advertises it
    expect(q.get('scope')).toBe('issues.read offline_access');
    // the verifier and the state are not in the URL, nor stored in clear
    const [row] = await n.ctx.db.select().from(mcpOauthPending);
    expect(row!.stateHash).not.toBe(q.get('state'));
    expect(JSON.stringify(row)).not.toContain(q.get('state') as string);
    expect(row!.verifierEnc.startsWith('oaxe1.')).toBe(true);

    const back = as.consent(url.toString());
    expect(back.toString().startsWith(CALLBACK)).toBe(true);
    const done = await visit(n, back);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).toContain('Authorization completed');

    const st = await status(n, id);
    expect(st).toMatchObject({
      status: 'active',
      grant: 'authorization_code',
      issuer: as.issuer,
      scopes: ['issues.read', 'offline_access'],
      reauthorizationNeeded: false,
      pendingExpiresAt: null,
    });
    const me = (await n.req({ method: 'GET', url: '/v1/me' })).json().user.id as string;
    expect(st.authorizedBy).toBe(me);
    expect(st.authorizedAt).toBeTruthy();
    // the token request carried the verifier, the exact redirect URI and the resource; no scope
    const redeemed = as.tokenRequests.at(-1)!.form;
    expect(redeemed.get('grant_type')).toBe('authorization_code');
    expect(redeemed.get('redirect_uri')).toBe(CALLBACK);
    expect(redeemed.get('resource')).toBe(MCP);
    expect(redeemed.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redeemed.has('scope')).toBe(false);
    expect(redeemed.get('client_id')).toBe('public-client-4711');
    expect(redeemed.has('client_secret')).toBe(false);
    expect(as.redeemFailures).toEqual([]);
    // the pending request is gone and the token works for the MCP server
    expect(await pendingCount(n, id)).toBe(0);
    const t = await token(n, id, ['issues.read']);
    expect(t.resource).toBe(MCP);
    expect(as.tokens.has(t.token)).toBe(true);
    const acts = await actions(n, id);
    expect(acts).toEqual(
      expect.arrayContaining([
        'mcp.oauth.discovered',
        'mcp.oauth.authorization_requested',
        'mcp.oauth.authorized',
      ]),
    );
  });

  it('a confidential client authenticates the redemption and the renewal', async () => {
    const id = await create(n, confidentialAuth);
    const done = await visit(n, as.consent(await start(n, id)));
    expect(done.statusCode, done.body).toBe(200);
    const redeemed = as.tokenRequests.at(-1)!;
    expect(redeemed.headers.get('authorization')).toMatch(/^Basic /);
    expect(redeemed.form.get('client_id')).toBeNull();
  });

  it('keeps no audit payload, response or log with the code, the state, the verifier or a token', async () => {
    const id = await create(n, publicAuth);
    const sink: string[] = [];
    const logged = await buildApp({
      ctx: { ...n.ctx, config: { ...n.ctx.config, logLevel: 'info' } },
      services: n.services,
      logSink: { write: (line: string) => void sink.push(line) } as never,
    });
    const authUrl = await start(n, id);
    const state = new URL(authUrl).searchParams.get('state')!;
    const back = as.consent(authUrl);
    const code = back.searchParams.get('code')!;
    const res = await logged.inject({ method: 'GET', url: back.pathname + back.search });
    expect(res.statusCode).toBe(200);
    await logged.close();
    const verifier = as.tokenRequests.at(-1)!.form.get('code_verifier')!;
    const access = (await token(n, id)).token;
    const logs = sink.join('\n');
    expect(logs).toContain('/v1/oauth/mcp/callback');
    const audit = JSON.stringify(await n.ctx.db.select().from(auditLog));
    for (const secret of [code, state, verifier, access]) {
      expect(logs).not.toContain(secret);
      expect(audit).not.toContain(secret);
      expect(res.body).not.toContain(secret);
      expect(JSON.stringify(await status(n, id))).not.toContain(secret);
    }
  });
});

describe('PKCE', () => {
  it.each([
    ['without code_challenge_methods_supported', undefined],
    ['with only plain', ['plain']],
  ])('refuses an authorization server %s', async (_name, methods) => {
    const meta: Record<string, unknown> = codeMetadata();
    if (methods) meta.code_challenge_methods_supported = methods;
    else delete meta.code_challenge_methods_supported;
    as.metadata = meta;
    const id = await create(n, publicAuth);
    const res = await post(n, id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error).toBe('mcp_pkce_unsupported');
    expect(await pendingCount(n, id)).toBe(0);
    const [denied] = (await n.ctx.db.select().from(auditLog)).filter(
      (a) => a.target === id && a.action === 'mcp.oauth.denied',
    );
    expect(denied!.payload).toMatchObject({ connection: id, code: 'pkce_unsupported' });
  });

  it('a code injected into another request fails at the server (the verifier does not match)', async () => {
    const victim = await create(n, publicAuth);
    const attacker = await create(n, publicAuth);
    const victimUrl = await start(n, victim);
    const attackerUrl = await start(n, attacker);
    // the attacker consents at the server and keeps the code; the victim's state is used with it
    const stolen = as.consent(attackerUrl).searchParams.get('code')!;
    const forged = as.consent(victimUrl, { state: new URL(victimUrl).searchParams.get('state')! });
    forged.searchParams.set('code', stolen);
    const res = await visit(n, forged);
    expect(res.statusCode).toBe(400);
    expect(resultOf(res)).toBe('token_refused');
    expect(as.redeemFailures).toEqual(['pkce']);
    expect((await status(n, victim)).status).toBe('not_authorized');
    // the victim's state is spent: the real code cannot be used afterwards
    const real = as.consent(victimUrl);
    expect(resultOf(await visit(n, real))).toBe('state_invalid');
  });
});

describe('state', () => {
  it('works once: a replayed callback is refused and redeems nothing', async () => {
    const id = await create(n, publicAuth);
    const back = as.consent(await start(n, id));
    expect((await visit(n, back)).statusCode).toBe(200);
    world.clear();
    const again = await visit(n, back);
    expect(again.statusCode).toBe(400);
    expect(resultOf(again)).toBe('state_invalid');
    expect(world.to('auth.example.org')).toEqual([]);
  });

  it('works once even when two callbacks arrive at the same time', async () => {
    const id = await create(n, publicAuth);
    const back = as.consent(await start(n, id));
    const before = as.tokenRequests.length;
    const results = await Promise.all([visit(n, back), visit(n, back), visit(n, back)]);
    expect(results.map(resultOf).sort()).toEqual(['ok', 'state_invalid', 'state_invalid']);
    expect(as.tokenRequests.length - before).toBe(1);
  });

  it('expires after ten minutes, is removed, and redeems nothing', async () => {
    const id = await create(n, publicAuth);
    const back = as.consent(await start(n, id));
    advance(10 * 60_000 + 1000);
    world.clear();
    const res = await visit(n, back);
    expect(resultOf(res)).toBe('state_expired');
    expect(world.to('auth.example.org')).toEqual([]);
    expect(await pendingCount(n, id)).toBe(0);
    expect((await status(n, id)).status).toBe('not_authorized');
  });

  it.each([
    ['unknown', newToken().slice(0, 43).padEnd(43, 'a')],
    ['missing', undefined],
    ['of the wrong shape', '"><script>alert(1)</script>'],
    ['too long', 'a'.repeat(5000)],
  ])('refuses a %s state without touching the database or the server', async (_name, state) => {
    const u = new URL(`${CALLBACK}?code=abc`);
    if (state !== undefined) u.searchParams.set('state', state);
    world.clear();
    const res = await visit(n, u);
    expect(res.statusCode).toBe(400);
    expect(resultOf(res)).toBe('state_invalid');
    expect(world.reqs).toEqual([]);
  });

  it('a repeated parameter is treated as absent', async () => {
    const id = await create(n, publicAuth);
    const back = as.consent(await start(n, id));
    back.searchParams.append('state', 'x');
    expect(resultOf(await visit(n, back))).toBe('state_invalid');
  });

  it('is bound to the person, connection and tenant that started it, whoever visits the callback', async () => {
    const a = await create(n, publicAuth);
    const b = await create(n, publicAuth);
    const ua = await start(n, a);
    await start(n, b);
    // the callback carries no session: a visitor with someone else's bearer token changes nothing
    const back = as.consent(ua);
    const res = await n.app.inject({
      method: 'GET',
      url: back.pathname + back.search,
      headers: { authorization: `Bearer ${n.admin}` },
    });
    expect(res.statusCode).toBe(200);
    expect((await status(n, a)).status).toBe('active');
    expect((await status(n, b)).status).toBe('not_authorized');
    const me = (await n.req({ method: 'GET', url: '/v1/me' })).json().user.id as string;
    expect((await status(n, a)).authorizedBy).toBe(me);
  });

  it('the sealed verifier does not open when the row is moved to another connection', async () => {
    const a = await create(n, publicAuth);
    const b = await create(n, publicAuth);
    const ua = await start(n, a);
    await start(n, b);
    const rows = await n.ctx.db.select().from(mcpOauthPending);
    const rowA = rows.find((r) => r.connectionId === a)!;
    const rowB = rows.find((r) => r.connectionId === b)!;
    await n.ctx.db
      .update(mcpOauthPending)
      .set({ verifierEnc: rowB.verifierEnc, keyVersion: rowB.keyVersion })
      .where(eq(mcpOauthPending.id, rowA.id));
    world.clear();
    const res = await visit(n, as.consent(ua));
    expect(resultOf(res)).toBe('error');
    expect(world.to('auth.example.org')).toEqual([]);
  });

  it('a new request of the same person replaces the old one; the old state is dead', async () => {
    const id = await create(n, publicAuth);
    const first = as.consent(await start(n, id));
    const second = as.consent(await start(n, id));
    expect(await pendingCount(n, id)).toBe(1);
    expect(resultOf(await visit(n, first))).toBe('state_invalid');
    expect((await visit(n, second)).statusCode).toBe(200);
  });
});

describe('RFC 9207 issuer matrix', () => {
  const iss = async (advertised: boolean, received: string | null) => {
    as.metadata = { ...codeMetadata(), authorization_response_iss_parameter_supported: advertised };
    const id = await create(n, publicAuth);
    world.clear();
    const res = await visit(n, as.consent(await start(n, id), { iss: received }));
    return {
      id,
      result: resultOf(res),
      tokenRequests: world.to('auth.example.org').filter((r) => r.url.pathname === '/token').length,
    };
  };

  it('iss present and equal: accepted, whether advertised or not', async () => {
    expect((await iss(true, as.issuer)).result).toBe('ok');
    expect((await iss(false, as.issuer)).result).toBe('ok');
  });

  it('iss present and different (mix-up): refused before the code is used, audited', async () => {
    for (const advertised of [true, false]) {
      for (const other of ['https://evil.example.org', `${as.issuer}/`, as.issuer.toUpperCase()]) {
        const r = await iss(advertised, other);
        expect(r.result, other).toBe('iss_mismatch');
        expect(r.tokenRequests).toBe(0);
        expect((await status(n, r.id)).status).toBe('not_authorized');
        const denied = (await n.ctx.db.select().from(auditLog)).filter(
          (a) => a.target === r.id && a.action === 'mcp.oauth.denied',
        );
        expect(denied.at(-1)!.payload).toMatchObject({ code: 'iss_mismatch' });
      }
    }
  });

  it('iss absent and advertised: refused', async () => {
    const r = await iss(true, null);
    expect(r.result).toBe('iss_missing');
    expect(r.tokenRequests).toBe(0);
  });

  it('iss absent and not advertised: accepted', async () => {
    expect((await iss(false, null)).result).toBe('ok');
  });

  it('applies to error responses too', async () => {
    const id = await create(n, publicAuth);
    as.metadata = { ...codeMetadata(), authorization_response_iss_parameter_supported: true };
    const url = await start(n, id);
    const res = await visit(n, as.consent(url, { error: 'access_denied', iss: null }));
    expect(resultOf(res)).toBe('iss_missing');
  });

  it('redeems the code only at the endpoints pinned when the request started', async () => {
    const id = await create(n, publicAuth);
    const url = await start(n, id);
    // the server (or whoever answers its metadata) moves the token endpoint afterwards
    world.on('token.evil.example.org', () => json({ access_token: 'x' }));
    as.metadata = { ...codeMetadata(), token_endpoint: 'https://token.evil.example.org/token' };
    world.clear();
    expect(resultOf(await visit(n, as.consent(url)))).toBe('ok');
    expect(world.to('token.evil.example.org')).toEqual([]);
    expect(world.to('auth.example.org').some((r) => r.url.pathname === '/token')).toBe(true);
  });
});

describe('redirect URI, error responses and the callback page', () => {
  it('ignores a redirect_uri or any other parameter of the callback request', async () => {
    const id = await create(n, publicAuth);
    const back = as.consent(await start(n, id));
    back.searchParams.set('redirect_uri', 'https://evil.example.org/steal');
    back.searchParams.set('next', 'https://evil.example.org');
    expect((await visit(n, back)).statusCode).toBe(200);
    expect(as.tokenRequests.at(-1)!.form.get('redirect_uri')).toBe(CALLBACK);
  });

  it('a refusal at the server is a fixed text: the error and its description are never echoed', async () => {
    const id = await create(n, publicAuth);
    const res = await visit(n, as.consent(await start(n, id), { error: 'access_denied' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('ignore previous instructions');
    expect(res.body).not.toContain('<script>');
    expect(res.body).not.toContain('access_denied');
    expect(resultOf(res)).toBe('denied');
    expect((await status(n, id)).status).toBe('not_authorized');
  });

  it('serves a page of fixed text with a strict CSP and no caching', async () => {
    const u = new URL(`${CALLBACK}?state=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`);
    const res = await visit(n, u);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).not.toContain('onerror');
    expect(res.body).not.toContain('img');
    expect(res.body).toMatch(/^<!doctype html><html lang="en">/);
  });

  it('with a console URL it redirects there with a closed result and the stored connection id only', async () => {
    const id = await create(n2, publicAuth);
    const url = await start(n2, id);
    const ok = await visit(n2, as.consent(url));
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe(
      `https://console.example.org/connections?mcp_oauth=ok&connection=${id}`,
    );
    // errors: only a member of the closed set is in the URL, never the server's text
    const url2 = await start(n2, id);
    const bad = await visit(n2, as.consent(url2, { error: 'https://evil.example.org' }));
    expect(bad.headers.location).toBe(
      `https://console.example.org/connections?mcp_oauth=denied&connection=${id}`,
    );
    const unknown = await visit(
      n2,
      new URL(`${CALLBACK}?state=nope&redirect_uri=https://evil.example.org`),
    );
    expect(unknown.headers.location).toBe(
      'https://console.example.org/connections?mcp_oauth=state_invalid',
    );
  });
});

describe('who may consent', () => {
  let ops: string;
  let opsId: string;
  let viewer: string;
  beforeAll(async () => {
    const mk = async (email: string, role: string) => {
      const r = await n.req({
        method: 'POST',
        url: '/v1/users',
        payload: { email, displayName: email, password: PW, globalRoles: [role] },
      });
      expect(r.statusCode, r.body).toBe(201);
      return { id: r.json().id as string, token: await n.login(email, PW) };
    };
    const o = await mk('ops-code@example.org', 'admin');
    ops = o.token;
    opsId = o.id;
    viewer = (await mk('viewer-code@example.org', 'viewer')).token;
  });

  it('a viewer cannot start a consent, and not read a token', async () => {
    const id = await create(n, publicAuth);
    expect((await post(n, id, {}, viewer)).statusCode).toBe(403);
    expect(await pendingCount(n, id)).toBe(0);
  });

  it('the connection shows who authorized it', async () => {
    const id = await create(n, publicAuth);
    expect((await visit(n, as.consent(await start(n, id, ops)))).statusCode).toBe(200);
    expect((await status(n, id)).authorizedBy).toBe(opsId);
  });

  it('a person whose access was withdrawn meanwhile cannot complete the consent', async () => {
    const id = await create(n, publicAuth);
    const back = as.consent(await start(n, id, ops));
    const off = await n.req({
      method: 'PATCH',
      url: `/v1/users/${opsId}`,
      payload: { disabled: true },
    });
    expect(off.statusCode, off.body).toBe(200);
    world.clear();
    const res = await visit(n, back);
    expect(resultOf(res)).toBe('forbidden');
    expect(world.to('auth.example.org')).toEqual([]);
    expect((await status(n, id)).status).toBe('not_authorized');
    await n.req({ method: 'PATCH', url: `/v1/users/${opsId}`, payload: { disabled: false } });
  });

  it('another tenant can neither start, read nor complete a consent of this one', async () => {
    const r = await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: {
        slug: 'other-code',
        name: 'Other',
        admin: { email: 'admin@other-code.example.org', displayName: 'Other', password: PW },
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const other = await n.login('admin@other-code.example.org', PW);
    const id = await create(n, publicAuth);
    expect((await post(n, id, {}, other)).statusCode).toBe(404);
    expect(
      (await n.req({ method: 'GET', url: `/v1/connections/${id}/oauth`, token: other })).statusCode,
    ).toBe(404);
    expect(
      (
        await n.req({
          method: 'POST',
          url: `/v1/connections/${id}/oauth/disconnect`,
          token: other,
        })
      ).statusCode,
    ).toBe(404);
    expect(await pendingCount(n, id)).toBe(0);
  });
});

describe('what a hostile authorization server can make the platform store', () => {
  it('a token without the shape of a credential is refused and nothing is stored', async () => {
    const id = await create(n, publicAuth);
    as.nextToken = () => json({ access_token: 'short', token_type: 'Bearer', expires_in: 60 });
    const res = await visit(n, as.consent(await start(n, id)));
    expect(resultOf(res)).toBe('error');
    expect(
      await n.ctx.db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.connectionId, id)),
    ).toEqual([]);
  });

  it('a token that contains the connection id is refused', async () => {
    const id = await create(n, publicAuth);
    as.nextToken = () =>
      json({ access_token: `${newToken()}${id}`, token_type: 'Bearer', expires_in: 60 });
    expect(resultOf(await visit(n, as.consent(await start(n, id))))).toBe('error');
  });

  it('only a Bearer token is accepted', async () => {
    const id = await create(n, publicAuth);
    as.nextToken = () => json({ access_token: newToken(), token_type: 'DPoP', expires_in: 60 });
    expect(resultOf(await visit(n, as.consent(await start(n, id))))).toBe('error');
  });

  it('a server that grants fewer scopes than asked leaves the connection asking for a new consent', async () => {
    const id = await create(n, publicAuth, {
      auth: { ...publicAuth, scopes: ['issues.read', 'issues.write'] },
    });
    const res = await visit(n, as.consent(await start(n, id), { grantedScope: 'issues.read' }));
    expect(res.statusCode).toBe(200);
    const st = await status(n, id);
    expect(st.scopes).toEqual(['issues.read']);
    expect(st.scopesMissing).toEqual(['issues.write']);
    expect(st.reauthorizationNeeded).toBe(true);
    // runs that need the missing scope fail closed
    await expect(token(n, id, ['issues.write'])).rejects.toMatchObject({
      code: 'mcp_insufficient_scope',
    });
    expect((await token(n, id, ['issues.read'])).token).toBeTruthy();
  });

  it('a change of the connection during the consent leaves nothing behind and revokes the new tokens', async () => {
    const id = await create(n, publicAuth);
    const back = as.consent(await start(n, id));
    // the url changes: a new resource, a new credential version
    const upd = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: {
        config: {
          transport: 'streamable-http',
          url: 'https://mcp.example.org/other',
          auth: publicAuth,
          ...tools,
        },
      },
    });
    expect(upd.statusCode, upd.body).toBe(200);
    world.clear();
    const res = await visit(n, back);
    expect(resultOf(res)).toBe('conflict');
    expect(world.to('auth.example.org').filter((r) => r.url.pathname === '/token')).toEqual([]);
    expect(
      await n.ctx.db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.connectionId, id)),
    ).toEqual([]);
  });

  it('disconnect ends an open consent too', async () => {
    const id = await create(n, publicAuth);
    const back = as.consent(await start(n, id));
    const d = await n.req({ method: 'POST', url: `/v1/connections/${id}/oauth/disconnect` });
    expect(d.statusCode).toBe(200);
    expect(resultOf(await visit(n, back))).toBe('state_invalid');
  });
});

describe('renewal of an authorization-code grant', () => {
  const connect = async (node = n, auth: unknown = publicAuth) => {
    const id = await create(node, auth);
    as.expiresIn = 120;
    const done = await visit(node, as.consent(await start(node, id)));
    expect(done.statusCode, done.body).toBe(200);
    as.expiresIn = 3600;
    return id;
  };

  it('renews with the refresh token, rotates it, and sends client_id and the resource', async () => {
    const id = await connect();
    const r = await ref(n, id);
    const before = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!;
    expect(before.refreshToken).toBeTruthy();
    advance(70_000);
    const t = await token(n, id);
    const after = (await n.services.mcpOauth.tokens.open(r.tenantId, r.id, 1))!;
    expect(t.token).toBe(after.accessToken);
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    const req = as.tokenRequests.at(-1)!.form;
    expect(req.get('grant_type')).toBe('refresh_token');
    expect(req.get('client_id')).toBe('public-client-4711');
    expect(req.get('resource')).toBe(MCP);
    expect(after.meta.grantType).toBe('authorization_code');
  });

  it('retries the commit of a rotated pair: the new pair is stored after a failed write', async () => {
    const id = await connect();
    const r = await ref(n, id);
    advance(70_000);
    const tokens = n.services.mcpOauth.tokens;
    const real = tokens.write.bind(tokens);
    const baseline = as.tokenRequests.length;
    let failures = 1;
    tokens.write = (async (...args: Parameters<typeof real>) => {
      if (failures-- > 0) throw new Error('connection reset');
      return real(...args);
    }) as never;
    try {
      const t = await token(n, id);
      const stored = (await tokens.open(r.tenantId, r.id, 1))!;
      expect(stored.accessToken).toBe(t.token);
      expect(as.validRefresh.has(stored.refreshToken!)).toBe(true);
    } finally {
      tokens.write = real;
    }
    expect(
      as.tokenRequests.slice(baseline).filter((q) => q.form.get('grant_type') === 'refresh_token'),
    ).toHaveLength(1);
  });

  it('keeps the rotated pair in memory when the database stays away, and stores it without asking the server again', async () => {
    const id = await connect();
    const r = await ref(n, id);
    advance(70_000);
    const tokens = n.services.mcpOauth.tokens;
    const real = tokens.write.bind(tokens);
    tokens.write = (async () => {
      throw new Error('database down');
    }) as never;
    try {
      await expect(n.services.mcpOauthFlows.refresh(r)).rejects.toMatchObject({
        code: 'mcp_auth_refresh_failed',
      });
    } finally {
      tokens.write = real;
    }
    const stuck = (await tokens.open(r.tenantId, r.id, 1))!;
    // the server already rotated: the stored refresh token is dead at the server
    expect(as.validRefresh.has(stuck.refreshToken!)).toBe(false);
    advance(40_000);
    const asked = as.tokenRequests.length;
    const t = await token(n, id);
    expect(as.tokenRequests.length).toBe(asked); // no new request: the held pair was written
    const stored = (await tokens.open(r.tenantId, r.id, 1))!;
    expect(stored.accessToken).toBe(t.token);
    expect(as.validRefresh.has(stored.refreshToken!)).toBe(true);
  });

  it('a grant without a refresh token needs a new consent when the access token expires (never a client_credentials request)', async () => {
    const id = await create(n, publicAuth);
    as.expiresIn = 120;
    // a server that issues no refresh token: strip it from the response
    as.nextToken = () =>
      json({
        access_token: newToken(),
        token_type: 'Bearer',
        expires_in: 120,
        scope: 'issues.read',
      });
    expect((await visit(n, as.consent(await start(n, id)))).statusCode).toBe(200);
    as.expiresIn = 3600;
    advance(70_000);
    const before = as.tokenRequests.length;
    await expect(token(n, id)).rejects.toMatchObject({ code: 'mcp_auth_required' });
    expect(as.tokenRequests.length).toBe(before);
    expect(await status(n, id)).toMatchObject({
      status: 'reauthorization_required',
      reauthorizationNeeded: true,
    });
  });

  it('invalid_grant at renewal fails closed until the next consent', async () => {
    const id = await connect();
    advance(70_000);
    as.nextToken = () => json({ error: 'invalid_grant' }, 400);
    await expect(token(n, id)).rejects.toMatchObject({ code: 'mcp_auth_required' });
    expect((await status(n, id)).status).toBe('reauthorization_required');
    // consenting again restores it
    as.nextToken = undefined;
    expect((await visit(n, as.consent(await start(n, id)))).statusCode).toBe(200);
    expect((await status(n, id)).status).toBe('active');
  });
});

describe('step-up', () => {
  it('records the scopes a server asked for, fails closed, and asks for the union at the next consent', async () => {
    const id = await create(n, publicAuth);
    expect((await visit(n, as.consent(await start(n, id)))).statusCode).toBe(200);
    const r = await ref(n, id);
    const first = (await token(n, id)).token;
    const rows = await n.ctx.db.select().from(connections).where(eq(connections.id, id));
    const source = n.services.mcpOauthFlows.sourceFor(
      rows[0]!,
      rows[0]!.config as never,
      new ContextGuard(),
    );
    source.insufficientScope!(first, ['issues.write']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await status(n, id)).toMatchObject({
      status: 'reauthorization_required',
      requiredScopes: ['issues.write'],
      reauthorizationNeeded: true,
      lastError: 'insufficient_scope',
    });
    // fail closed: no run gets a token until an administrator consents again
    await expect(token(n, id)).rejects.toMatchObject({ code: 'mcp_auth_required' });
    expect(await actions(n, id)).toContain('mcp.oauth.step_up_required');
    // the new consent asks for the union of what was granted, what a server asked for and the profile
    const url = new URL(await start(n, id));
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual([
      'issues.read',
      'issues.write',
      'offline_access',
    ]);
    expect((await visit(n, as.consent(url.toString()))).statusCode).toBe(200);
    expect(await status(n, id)).toMatchObject({
      status: 'active',
      requiredScopes: [],
      scopes: ['issues.read', 'issues.write', 'offline_access'],
    });
    // the replaced token is revoked at the server
    expect(as.revoked).toContain(first);
    void r;
  });

  it('ignores a rejected token that is no longer the stored one', async () => {
    const id = await create(n, publicAuth);
    expect((await visit(n, as.consent(await start(n, id)))).statusCode).toBe(200);
    const rows = await n.ctx.db.select().from(connections).where(eq(connections.id, id));
    const source = n.services.mcpOauthFlows.sourceFor(
      rows[0]!,
      rows[0]!.config as never,
      new ContextGuard(),
    );
    source.insufficientScope!(newToken(), ['issues.write']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await status(n, id)).status).toBe('active');
  });
});

describe('Client ID Metadata Document', () => {
  it('is not served unless enabled', async () => {
    expect((await n.app.inject({ method: 'GET', url: '/oauth/mcp-client.json' })).statusCode).toBe(
      404,
    );
  });

  it('is served without a session and names the callback as the only redirect URI', async () => {
    const res = await n2.app.inject({ method: 'GET', url: '/oauth/mcp-client.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      client_id: `${PUBLIC}/oauth/mcp-client.json`,
      client_name: 'openagentix',
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    });
    expect(res.headers['cache-control']).toContain('max-age');
  });

  it('is the client id when the server advertises support; refused otherwise', async () => {
    const id = await create(n2, cimdAuth);
    const url = await start(n2, id);
    expect(new URL(url).searchParams.get('client_id')).toBe(`${PUBLIC}/oauth/mcp-client.json`);
    expect((await visit(n2, as.consent(url))).statusCode).toBe(302);
    expect((await status(n2, id)).status).toBe('active');
    as.metadata = { ...codeMetadata(), client_id_metadata_document_supported: false };
    const res = await post(n2, id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error).toBe('mcp_oauth_unsupported');
  });

  it('is refused at start-up in air-gapped mode and without a public https URL', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { NODE_ENV: 'test', OAX_DATABASE_URL: 'memory://' };
    expect(() =>
      loadConfig({
        ...base,
        OAX_MCP_OAUTH_CIMD: 'true',
        OAX_AIRGAPPED: 'true',
        OAX_PUBLIC_URL: PUBLIC,
      }),
    ).toThrow(/air-gapped/);
    expect(() => loadConfig({ ...base, OAX_MCP_OAUTH_DCR: 'true', OAX_AIRGAPPED: 'true' })).toThrow(
      /air-gapped/,
    );
    expect(() => loadConfig({ ...base, OAX_MCP_OAUTH_CIMD: 'true' })).toThrow(/public https/);
    expect(() =>
      loadConfig({ ...base, OAX_MCP_OAUTH_CIMD: 'true', OAX_PUBLIC_URL: 'http://oax.example.org' }),
    ).toThrow(/public https/);
    const ok = loadConfig({ ...base, OAX_MCP_OAUTH_CIMD: 'true', OAX_PUBLIC_URL: PUBLIC });
    expect(ok.mcp.oauth.cimd).toBe(true);
    expect(ok.mcp.oauth.dcr).toBe(false);
    expect(loadConfig(base).mcp.oauth).toMatchObject({ cimd: false, dcr: false });
  });
});

describe('dynamic client registration', () => {
  it('registers once per tenant and issuer, with the exact redirect URI, and reuses the client', async () => {
    const a = await create(n2, dcrAuth);
    const b = await create(n2, dcrAuth);
    const before = as.registrations.length;
    const url = await start(n2, a);
    expect(as.registrations.length).toBe(before + 1);
    expect(as.registrations.at(-1)).toMatchObject({
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    });
    expect(new URL(url).searchParams.get('client_id')).toMatch(/^dcr-client-/);
    expect((await visit(n2, as.consent(url))).statusCode).toBe(302);
    // the second connection of the tenant reuses the registration
    await start(n2, b);
    expect(as.registrations.length).toBe(before + 1);
    expect(await actions(n2, a)).toContain('mcp.oauth.client_registered');
    const clients = await n2.ctx.db.select().from(mcpOauthClients);
    expect(clients.filter((c) => c.issuer === as.issuer)).toHaveLength(1);
    // renewal authenticates as the registered client
    advance(2 * 3600_000);
    await token(n2, a);
    expect(as.tokenRequests.at(-1)!.form.get('client_id')).toMatch(/^dcr-client-/);
  });

  it('a changed public URL registers a new client', async () => {
    const id = await create(n2, dcrAuth);
    await start(n2, id);
    const before = as.registrations.length;
    const config = n2.ctx.config as unknown as { publicUrl: string };
    const original = config.publicUrl;
    config.publicUrl = 'https://oax2.example.org';
    try {
      await start(n2, id);
    } finally {
      config.publicUrl = original;
    }
    expect(as.registrations.length).toBe(before + 1);
    expect(as.registrations.at(-1)!.redirect_uris).toEqual([
      'https://oax2.example.org/v1/oauth/mcp/callback',
    ]);
  });

  it('keeps a secret the server issued sealed, and authenticates with it', async () => {
    as.metadata = {
      ...codeMetadata(),
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    };
    as.registeredSecret = 'REGISTERED-SECRET-Qw93kLm2Xz7Pa4RtYc6NhB1v';
    // another issuer so that the registration is new for this tenant
    const id = await create(n2, dcrAuth);
    await n2.ctx.db.delete(mcpOauthClients);
    const url = await start(n2, id);
    expect(as.registrations.at(-1)!.token_endpoint_auth_method).toBe('client_secret_basic');
    const rows = await n2.ctx.db.select().from(mcpOauthClients);
    expect(JSON.stringify(rows)).not.toContain(as.registeredSecret);
    expect((await visit(n2, as.consent(url))).statusCode).toBe(302);
    expect(as.tokenRequests.at(-1)!.headers.get('authorization')).toMatch(/^Basic /);
  });

  it.each([
    ['other redirect URIs', { client_id: 'x', redirect_uris: ['https://evil.example.org/cb'] }],
    ['no client id', { redirect_uris: [CALLBACK] }],
    ['a client id with control characters', { client_id: 'a\nb', redirect_uris: [CALLBACK] }],
  ])('refuses a registration response with %s', async (_name, doc) => {
    await n2.ctx.db.delete(mcpOauthClients);
    const id = await create(n2, dcrAuth);
    as.nextRegistration = () => json(doc, 201);
    const res = await post(n2, id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error).toBe('mcp_oauth_registration_failed');
    expect(await n2.ctx.db.select().from(mcpOauthClients)).toEqual([]);
    expect(await pendingCount(n2, id)).toBe(0);
  });

  it('never contacts a registration endpoint on an internal address', async () => {
    await n2.ctx.db.delete(mcpOauthClients);
    as.metadata = { ...codeMetadata(), registration_endpoint: 'https://169.254.169.254/register' };
    const id = await create(n2, dcrAuth);
    world.clear();
    const res = await post(n2, id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error).toBe('egress_denied');
    expect(world.reqs.filter((r) => r.url.host === '169.254.169.254')).toEqual([]);
    expect(as.registrations.length).toBeGreaterThan(0);
  });

  it('is refused while disabled, whatever the stored configuration says', async () => {
    const id = await create(n, publicAuth);
    await n.ctx.db
      .update(connections)
      .set({
        config: {
          transport: 'streamable-http',
          name: 'x',
          url: MCP,
          auth: dcrAuth,
          ...tools,
        } as never,
      })
      .where(eq(connections.id, id));
    const res = await post(n, id);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error).toBe('mcp_oauth_dcr_disabled');
  });

  it('keeps the clients of tenants apart', async () => {
    const r = await n2.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: {
        slug: 'dcr-other',
        name: 'Other',
        admin: { email: 'admin@dcr-other.example.org', displayName: 'Other', password: PW },
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const otherToken = await n2.login('admin@dcr-other.example.org', PW);
    const created = await n2.req({
      method: 'POST',
      url: '/v1/connections',
      token: otherToken,
      payload: {
        name: `dcr-other-${++seq}`,
        config: { transport: 'streamable-http', url: MCP, auth: dcrAuth, ...tools },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    await start(n2, await create(n2, dcrAuth)); // the first tenant has a client of its own
    const before = as.registrations.length;
    const res = await post(n2, created.json().id as string, {}, otherToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(as.registrations.length).toBe(before + 1);
    const clients = await n2.ctx.db.select().from(mcpOauthClients);
    expect(new Set(clients.map((c) => c.tenantId)).size).toBeGreaterThan(1);
  });
});

describe('metrics', () => {
  it('counts outcomes in a closed set without tenant or connection labels', async () => {
    const id = await create(n, publicAuth);
    await visit(n, as.consent(await start(n, id)));
    await visit(n, new URL(`${CALLBACK}?state=nope`));
    n.ctx.metrics.oauthAuthorize(`made-up-${id}`);
    const text = await n.ctx.metrics.registry.metrics();
    const lines = text.split('\n').filter((l) => l.startsWith('oax_mcp_oauth_authorize_total'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^oax_mcp_oauth_authorize_total\{outcome="[a-z_]+"\} \d+$/);
      expect(line).not.toContain(id);
    }
    expect(lines.join('\n')).toContain('outcome="ok"');
    expect(lines.join('\n')).toContain('outcome="state_invalid"');
    expect(lines.join('\n')).toContain('outcome="started"');
  });
});
