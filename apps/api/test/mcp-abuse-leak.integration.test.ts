import { randomBytes } from 'node:crypto';
import { ContextGuard, NetworkConfigSchema, compileNetwork } from '@openagentix/core';
import { ToolGateway } from '@openagentix/mcp';
import { createOutboundDispatcher, type OutboundDispatcher } from '@openagentix/providers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/context.js';
import { connections } from '../src/db/schema.js';
import { processSecrets } from '../src/mcp-oauth/index.js';
import { ENABLED, Lab, type LabServer, type Tls } from './engine-lab.js';
import { testNode, type TestNode } from './helpers.js';
import { newToken } from './oauth-world.js';

/**
 * Token leak canaries ACROSS A REAL NETWORK (ADR 0016 section 10; opt-in: OAX_TEST_DOCKER=1, see
 * engine-lab.ts). The authorization server and the MCP server are lab containers speaking TLS.
 * The control node (in process, real services, in-memory database) obtains a token from the
 * container by client credentials, sends it to the MCP container over TLS, and the MCP container
 * echoes the token back in a tool result and in an error. The canary values (access token and
 * client secret) must then be absent from everything the platform shows: tool results, errors,
 * log lines, the audit log, every connection endpoint, the OpenAPI document. The lab servers
 * record the request headers they receive, which proves the values really crossed the wire.
 *
 * The same properties are covered with an in-process fake network in mcp-oauth-canary.test.ts
 * (control node) and apps/worker/test/mcp-oauth-canary.test.ts (step records, model requests,
 * spans); this file repeats the control-node surfaces against real sockets and real TLS.
 */
const CLIENT_SECRET = `CLIENT-SECRET-${randomBytes(18).toString('base64url')}`;
const ACCESS = newToken();
const MCP_URL = 'https://mcp.leak.s8.test/mcp';
const ISSUER = 'https://auth.leak.s8.test';

describe.skipIf(!ENABLED)('token leaks across a real network (OAX_TEST_DOCKER=1)', () => {
  const lab = new Lab();
  let tls: Tls;
  let front: LabServer;
  let dispatcher: OutboundDispatcher;
  let n: TestNode;
  let id = '';
  const gateway = async (guard = new ContextGuard()) => {
    const row = (await n.ctx.db.select().from(connections).where(eq(connections.id, id)))[0]!;
    const { configs, oauth } = await n.services.catalog.mcpRunConfigs({
      tenantId: row.tenantId,
      teamId: null,
      agentId: '',
    });
    return new ToolGateway(
      configs,
      {
        secrets: { resolve: async () => 'unused' },
        outbound: dispatcher,
        originFor: () => 'tenant',
        tokens: n.services.mcpOauthFlows.tokensFor(oauth, guard),
      },
      guard,
    );
  };

  beforeAll(async () => {
    tls = lab.tls(['mcp.leak.s8.test', 'auth.leak.s8.test']);
    const net = lab.network('lab');
    front = await lab.server('front', net.name, { tls });
    lab.addHost(front.ip, 'mcp.leak.s8.test', 'auth.leak.s8.test');
    dispatcher = createOutboundDispatcher({
      network: compileNetwork(
        NetworkConfigSchema.parse({
          trust: { bundles: [{ name: 'lab', secret: 'lab.ca' }] },
          privateAllow: [`${front.ip}/32`],
        }),
      ),
      secrets: (ref: string) => (ref === 'lab.ca' ? tls.ca : undefined),
    });
    // The authorization server and the protected resource, as served by the container.
    const as = {
      issuer: ISSUER,
      token_endpoint: `${ISSUER}/token`,
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    };
    await front.control('/set', { path: '/.well-known/oauth-authorization-server', json: as });
    await front.control('/set', { path: '/.well-known/openid-configuration', json: as });
    await front.control('/set', {
      path: '/.well-known/oauth-protected-resource/mcp',
      json: { resource: MCP_URL, authorization_servers: [ISSUER] },
    });
    await front.control('/set', {
      path: '/token',
      json: { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600 },
    });
    await front.control('/tools', {
      whoami: true,
      expectToken: ACCESS,
      resourceMetadata: 'https://mcp.leak.s8.test/.well-known/oauth-protected-resource/mcp',
    });

    n = await testNode(
      { OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64') },
      {
        secrets: {
          resolve: async (r: string) =>
            ({ 'leak-id': 'leak-client', 'leak-secret': CLIENT_SECRET })[r] ??
            Promise.reject(new Error('no such secret')),
        },
        mcpOutbound: dispatcher,
      },
    );
    const tenant = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0]
      .id as string;
    await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${tenant}`,
      payload: { secretRefs: ['leak-id', 'leak-secret'] },
    });
    const created = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'srv',
        config: {
          transport: 'streamable-http',
          url: MCP_URL,
          auth: {
            kind: 'oauth',
            grant: 'client_credentials',
            issuer: ISSUER,
            client: {
              clientIdSecret: 'leak-id',
              clientAuth: 'client_secret_basic',
              clientSecretSecret: 'leak-secret',
            },
          },
          tools: {
            whoami: { access: 'read', scopes: ['issues.read'] },
            fail_echo: { access: 'read', scopes: ['issues.read'] },
          },
          profiles: { read: ['whoami', 'fail_echo'] },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    id = created.json().id;
    const authorized = await n.req({
      method: 'POST',
      url: `/v1/connections/${id}/oauth/authorize`,
      payload: {},
    });
    expect(authorized.statusCode, authorized.body).toBe(200);
  }, 180_000);

  afterAll(async () => {
    processSecrets.clear();
    await n?.close();
    await dispatcher?.close();
    lab.cleanup();
  });

  it('the values really crossed the wire: the lab servers saw the client secret and the token', async () => {
    const hits = await front.hits();
    const tokenCall = hits.find((h) => h.url === '/token');
    expect(tokenCall?.authorization).toBe(
      `Basic ${Buffer.from(`leak-client:${CLIENT_SECRET}`).toString('base64')}`,
    );
    const gw = await gateway();
    await gw.serverTools('srv');
    await gw.close();
    expect((await front.hits()).some((h) => h.authorization === `Bearer ${ACCESS}`)).toBe(true);
  });

  it('a server that echoes the token in a result or in an error gets it redacted', async () => {
    const guard = new ContextGuard();
    const gw = await gateway(guard);
    await gw.serverTools('srv');
    const out = await gw.execute({ server: 'srv', tool: 'whoami', args: {} });
    expect(out.result.text).toContain('header was Bearer [redacted');
    expect(out.result.text).not.toContain(ACCESS);
    const failed = await gw.execute({ server: 'srv', tool: 'fail_echo', args: {} }).then(
      (r) => JSON.stringify(r),
      (e: unknown) => `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ''}`,
    );
    expect(failed).not.toContain(ACCESS);
    expect(failed).not.toContain(CLIENT_SECRET);
    await gw.close();
  });

  it('log lines carry neither the token nor the client secret', () => {
    const lines: string[] = [];
    const log = createLogger('info', 'canary', { write: (l: string) => void lines.push(l) });
    log.error(new Error(`upstream said ${ACCESS} / ${CLIENT_SECRET}`));
    log.info({ header: `Bearer ${ACCESS}`, auth: `Basic ${CLIENT_SECRET}` }, 'fields');
    const text = lines.join('');
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).toContain('[REDACTED]');
  });

  it('no endpoint of the control node exposes either value, with the redactor emptied', async () => {
    // Empty redactor: a structural leak (a handler returning the value) must show in the body.
    processSecrets.clear();
    const urls = [
      '/v1/connections',
      `/v1/connections/${id}`,
      `/v1/connections/${id}/tool-snapshots`,
      '/v1/connections/stdio-violations',
      '/v1/tenants',
      '/v1/audit?limit=500',
      '/openapi.json',
    ];
    for (const url of urls) {
      const res = await n.req({ method: 'GET', url });
      expect(res.body, url).not.toContain(ACCESS);
      expect(res.body, url).not.toContain(CLIENT_SECRET);
      expect(res.body, url).not.toContain('oaxe1.');
      expect(res.body, url).not.toMatch(/access_token_enc|accessTokenEnc|wrapped_?key/i);
    }
    const verify = await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} });
    expect(verify.json().valid).toBe(true);
  });

  it('an error answer of a connection endpoint does not echo the values either', async () => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: { name: ACCESS, config: { transport: 'streamable-http', url: MCP_URL } },
    });
    expect(res.body).not.toContain(ACCESS);
  });
});

describe('opt-in marker (token leaks)', () => {
  it(`is ${ENABLED ? 'enabled' : 'skipped (set OAX_TEST_DOCKER=1 and OAX_TEST_IMAGE)'}`, () => {
    expect(typeof ENABLED).toBe('boolean');
  });
});
