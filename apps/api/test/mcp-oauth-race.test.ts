import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connections, mcpOauthTokens } from '../src/db/schema.js';
import { createMcpOauth, SecretRegistry } from '../src/mcp-oauth/index.js';
import { McpOauthService } from '../src/services/mcp-oauth.js';
import { PG_URL, openPostgres, type Sql } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';
import { FakeAs, FakeMcp, World } from './oauth-world.js';

/**
 * Races between replicas and between a renewal and a deletion. They need REAL concurrency: PGlite
 * serialises every transaction, so the advisory lock would never be exercised. Runs only with
 * OAX_TEST_DATABASE_URL (a real PostgreSQL). Each test asserts what happens WITH the lock; the
 * first one fails when the lock is removed (two token requests instead of one).
 */
const MCP = 'https://mcp.example.org/mcp';
const secrets = {
  resolve: async (r: string) =>
    ({ 'rc-id': 'race-client', 'rc-secret': 'RACE-CLIENT-SECRET-5Tq8Zk2Wv7Lm3Xp' })[r] ??
    Promise.reject(new Error('x')),
};
const auth = {
  kind: 'oauth',
  grant: 'client_credentials',
  issuer: 'https://auth.example.org',
  client: {
    clientIdSecret: 'rc-id',
    clientAuth: 'client_secret_basic',
    clientSecretSecret: 'rc-secret',
  },
};

describe.skipIf(!PG_URL)('renewal races on a real PostgreSQL', () => {
  let db: Sql;
  let n: TestNode;
  let world: World;
  let as: FakeAs;
  let mcp: FakeMcp;
  let clock = new Date('2026-10-10T12:00:00Z');
  const other = () =>
    new McpOauthService(
      n.ctx,
      n.services.audit,
      n.services.catalog,
      n.services.runNodes,
      createMcpOauth(n.ctx, 'api', new SecretRegistry()),
    );

  beforeAll(async () => {
    db = await openPostgres();
    world = new World();
    as = new FakeAs(world);
    mcp = new FakeMcp(world, as);
    await mcp.start();
    n = await testNode(
      { OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'), OAX_DATABASE_URL: db.url },
      { secrets, mcpOutbound: world.dispatcher, mcpProbeLimit: 10_000, now: () => clock },
    );
    const t = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id as string;
    await n.req({
      method: 'PATCH',
      url: `/v1/tenants/${t}`,
      payload: { secretRefs: ['rc-id', 'rc-secret'] },
    });
  });
  afterAll(async () => {
    await mcp.stop();
    await n.close();
    await db.close();
  });

  let seq = 0;
  async function authorized() {
    const res = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: `race-${++seq}`,
        config: { transport: 'streamable-http', url: MCP, auth, tools: {}, profiles: {} },
      },
    });
    const id = res.json().id as string;
    as.expiresIn = 120;
    const a = await n.req({
      method: 'POST',
      url: `/v1/connections/${id}/oauth/authorize`,
      payload: {},
    });
    expect(a.statusCode, a.body).toBe(200);
    as.expiresIn = 3600;
    clock = new Date(clock.getTime() + 70_000); // inside the renewal window
    const [row] = await n.ctx.db.select().from(connections).where(eq(connections.id, id));
    return { id, ref: { id, tenantId: row!.tenantId } };
  }
  const rows = (id: string) =>
    n.ctx.db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.connectionId, id));

  it('two replicas renew once between them (fails without the advisory lock)', async () => {
    const { ref } = await authorized();
    const a = n.services.mcpOauthFlows;
    const b = other();
    const before = as.tokenRequests.length;
    as.latency = 300;
    await Promise.all([a.refresh(ref), b.refresh(ref)]);
    as.latency = 0;
    expect(as.tokenRequests.length - before).toBe(1);
  });

  it('a disconnect during a renewal wins: the token does not come back', async () => {
    const { id, ref } = await authorized();
    as.latency = 400;
    const renewing = n.services.mcpOauthFlows.refresh(ref).catch((e) => e.code);
    await new Promise((r) => setTimeout(r, 100)); // the renewal holds the lock and waits for the server
    const res = await n.req({ method: 'POST', url: `/v1/connections/${id}/oauth/disconnect` });
    as.latency = 0;
    expect(res.statusCode, res.body).toBe(200);
    await renewing;
    expect(await rows(id)).toHaveLength(0);
    expect((await n.req({ method: 'GET', url: `/v1/connections/${id}/oauth` })).json().status).toBe(
      'not_authorized',
    );
  });

  it('a url change during a renewal wins: no row of the old version survives', async () => {
    const { id, ref } = await authorized();
    const cfg = (await n.req({ method: 'GET', url: `/v1/connections/${id}` })).json().config;
    as.latency = 400;
    const renewing = n.services.mcpOauthFlows.refresh(ref).catch((e) => e.code);
    await new Promise((r) => setTimeout(r, 100));
    const res = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { config: { ...cfg, url: 'https://mcp.example.org/mcp2' } },
    });
    as.latency = 0;
    expect(res.statusCode, res.body).toBe(200);
    await renewing;
    expect(await rows(id)).toHaveLength(0);
  });

  it('a renewal never inserts: a row deleted under it stays deleted', async () => {
    const { id, ref } = await authorized();
    as.latency = 400;
    const renewing = n.services.mcpOauthFlows.refresh(ref).catch((e) => e.code);
    await new Promise((r) => setTimeout(r, 100));
    // a bare delete, as any code that does not know about the lock would issue it
    await n.ctx.db.delete(mcpOauthTokens).where(eq(mcpOauthTokens.connectionId, id));
    as.latency = 0;
    expect(await renewing).toBe('mcp_auth_required');
    expect(await rows(id)).toHaveLength(0);
  });
});
