import { randomBytes } from 'node:crypto';
import { ContextGuard } from '@openagentix/core';
import { ToolGateway } from '@openagentix/mcp';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../src/context.js';
import { connections } from '../src/db/schema.js';
import { processSecrets } from '../src/mcp-oauth/index.js';
import { testNode, type TestNode } from './helpers.js';
import { FakeAs, FakeMcp, World } from './oauth-world.js';

/**
 * The in-process path (trusted worker, connection tests): a ToolGateway whose HTTP server uses
 * OAuth. The token source attaches the token per request, registers it with the gateway's guard
 * and refuses to send it anywhere but the resource it was issued for.
 */
const CLIENT_SECRET = 'GATEWAY-CLIENT-SECRET-3Hk8Vn2Rt6Yp9Qa';
let n: TestNode;
let world: World;
let as: FakeAs;
let mcp: FakeMcp;
let id: string;
let services: TestNode['services'];

beforeAll(async () => {
  world = new World();
  as = new FakeAs(world);
  mcp = new FakeMcp(world, as);
  await mcp.start();
  n = await testNode(
    { OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64') },
    {
      secrets: {
        resolve: async (r: string) =>
          ({ 'gw-id': 'gateway-client', 'gw-secret': CLIENT_SECRET })[r] ??
          Promise.reject(new Error('x')),
      },
      mcpOutbound: world.dispatcher,
    },
  );
  services = n.services;
  const tenant = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id as string;
  await n.req({
    method: 'PATCH',
    url: `/v1/tenants/${tenant}`,
    payload: { secretRefs: ['gw-id', 'gw-secret'] },
  });
  const res = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'srv',
      config: {
        transport: 'streamable-http',
        url: 'https://mcp.example.org/mcp',
        auth: {
          kind: 'oauth',
          grant: 'client_credentials',
          issuer: 'https://auth.example.org',
          client: {
            clientIdSecret: 'gw-id',
            clientAuth: 'client_secret_basic',
            clientSecretSecret: 'gw-secret',
          },
        },
        tools: { echo_auth: { access: 'read', scopes: ['issues.read'] } },
        profiles: { read: ['echo_auth'] },
      },
    },
  });
  id = res.json().id;
});
afterAll(async () => {
  processSecrets.clear();
  await mcp.stop();
  await n.close();
});

async function gateway(guard = new ContextGuard()) {
  const { configs, oauth } = await services.catalog.mcpRunConfigs({
    tenantId: (await n.ctx.db.select().from(connections).where(eq(connections.id, id)))[0]!
      .tenantId,
    teamId: null,
    agentId: '',
  });
  return new ToolGateway(
    configs,
    {
      secrets: { resolve: async () => 'unused' },
      outbound: world.dispatcher,
      originFor: () => 'tenant',
      tokens: services.mcpOauthFlows.tokensFor(oauth, guard),
    },
    guard,
  );
}

describe('ToolGateway with an OAuth connection', () => {
  it('fails closed before the connection is authorized', async () => {
    const gw = await gateway();
    await expect(gw.serverTools('srv')).rejects.toMatchObject({ code: 'mcp_auth_required' });
    await gw.close();
  });

  it('sends the token, and a server that echoes it gets it redacted', async () => {
    expect(
      (await n.req({ method: 'POST', url: `/v1/connections/${id}/oauth/authorize`, payload: {} }))
        .statusCode,
    ).toBe(200);
    const guard = new ContextGuard();
    const gw = await gateway(guard);
    const tools = await gw.serverTools('srv');
    expect(tools.map((t) => t.name)).toContain('echo_auth');
    const out = await gw.execute({ server: 'srv', tool: 'echo_auth', args: {} });
    expect(out.result.text).toContain('the header was Bearer ');
    const token = mcp.lastAuth!.replace('Bearer ', '');
    expect(as.tokens.has(token)).toBe(true);
    expect(out.result.text).not.toContain(token);
    await gw.close();
  });

  it('refuses to send a token to a connection url it was not issued for', async () => {
    const guard = new ContextGuard();
    const { configs, oauth } = await services.catalog.mcpRunConfigs({
      tenantId: (await n.ctx.db.select().from(connections).where(eq(connections.id, id)))[0]!
        .tenantId,
      teamId: null,
      agentId: '',
    });
    const moved = configs.map((c) => ({ ...c, url: 'https://mcp.example.org/other' }) as typeof c);
    const gw = new ToolGateway(
      moved,
      {
        secrets: { resolve: async () => 'unused' },
        outbound: world.dispatcher,
        originFor: () => 'tenant',
        tokens: services.mcpOauthFlows.tokensFor(oauth, guard),
      },
      guard,
    );
    const before = world.reqs.length;
    await expect(gw.serverTools('srv')).rejects.toMatchObject({ code: 'mcp_resource_mismatch' });
    expect(world.reqs.slice(before).filter((r) => r.headers.get('authorization'))).toHaveLength(0);
    await gw.close();
  });

  it('a gateway without a credentials service fails closed instead of sending nothing', async () => {
    const { configs } = await services.catalog.mcpRunConfigs({
      tenantId: (await n.ctx.db.select().from(connections).where(eq(connections.id, id)))[0]!
        .tenantId,
      teamId: null,
      agentId: '',
    });
    const gw = new ToolGateway(configs, {
      secrets: { resolve: async () => 'unused' },
      outbound: world.dispatcher,
      originFor: () => 'tenant',
    });
    await expect(gw.serverTools('srv')).rejects.toMatchObject({ code: 'mcp_auth_required' });
    await gw.close();
  });
});

describe('logs', () => {
  it('a freshly issued token and the client secret are scrubbed from log lines before any use', async () => {
    processSecrets.clear();
    const authorize = await n.req({
      method: 'POST',
      url: `/v1/connections/${id}/oauth/authorize`,
      payload: {},
    });
    expect(authorize.statusCode).toBe(200);
    const issued = [...as.tokens].at(-1)!;
    const lines: string[] = [];
    const log = createLogger('info', 'canary', { write: (l: string) => void lines.push(l) });
    log.error(new Error(`token endpoint said ${issued} and ${CLIENT_SECRET}`));
    log.info({ header: `Bearer ${issued}`, secret: CLIENT_SECRET }, 'fields');
    const text = lines.join('');
    expect(text).not.toContain(issued);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).toContain('[REDACTED]');
  });
});
