import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connections, mcpOauthTokens } from '../src/db/schema.js';
import { createMcpOauth, SecretRegistry } from '../src/mcp-oauth/index.js';
import { CREDENTIAL_LOCK_NS, lockCredential } from '../src/mcp-oauth/token-store.js';
import { McpOauthService } from '../src/services/mcp-oauth.js';
import { PG_URL, openPostgres, type Sql } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';
import { FakeAs, FakeMcp, World, json } from './oauth-world.js';

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

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const statusOf = async (id: string) =>
    (await n.req({ method: 'GET', url: `/v1/connections/${id}/oauth` })).json();

  it('a permanent failure of the old tokens does not mark tokens written meanwhile', async () => {
    const { id, ref } = await authorized();
    // the renewal's request is the second one the server answers: rejected for good, but only
    // after a re-authorization (the first answer) has stored new tokens
    let answered = 0;
    as.nextToken = () => (++answered === 2 ? json({ error: 'invalid_client' }, 401) : undefined);
    as.latency = 500;
    const renewing = n.services.mcpOauthFlows.refresh(ref).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await sleep(150); // the renewal holds the lock and waits for the server
    as.latency = 0;
    clock = new Date(clock.getTime() + 1_000);
    expect(
      (await n.req({ method: 'POST', url: `/v1/connections/${id}/oauth/authorize`, payload: {} }))
        .statusCode,
    ).toBe(200);
    const fresh = (await rows(id))[0]!;
    expect(await renewing).not.toBe('ok');
    as.nextToken = undefined;
    expect(await statusOf(id)).toMatchObject({ status: 'active', lastError: null });
    const after = (await rows(id))[0]!;
    expect(after.accessTokenEnc).toBe(fresh.accessTokenEnc);
    expect(after.status).toBe('active');
  });

  it('a lost compare-and-swap is retried: the renewal does not report that authorization is needed', async () => {
    const { id, ref } = await authorized();
    const before = as.tokenRequests.length;
    const revoked = as.revoked.length;
    const stale = (await rows(id))[0]!;
    as.latency = 400;
    const renewing = n.services.mcpOauthFlows.refresh(ref).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await sleep(150);
    as.latency = 0;
    // a writer that does not take the credential lock (a status write) rewrites the row
    clock = new Date(clock.getTime() + 1_000);
    await n.services.mcpOauth.tokens.setStatus(ref.tenantId, id, 1, 'active');
    expect(await renewing).toBe('ok');
    expect(as.tokenRequests.length - before).toBeGreaterThanOrEqual(1);
    // the token that could not be stored is revoked at the server, the stored one stays usable
    expect(as.revoked.length - revoked).toBeGreaterThan(0);
    expect((await rows(id))[0]!.accessTokenEnc).toBeTruthy();
    expect(stale.accessTokenEnc).toBeTruthy();
    expect((await statusOf(id)).status).toBe('active');
  });
});

/**
 * Renewals hold a transaction (a pooled connection) across the call to the authorization server.
 * With a small pool and servers that never answer in time, the bound keeps connections free.
 */
describe.skipIf(!PG_URL)('bounded renewals on a real PostgreSQL', () => {
  let db: Sql;
  let n: TestNode;
  let world: World;
  let as: FakeAs;
  let mcp: FakeMcp;
  let clock = new Date('2026-10-10T12:00:00Z');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    db = await openPostgres();
    world = new World();
    as = new FakeAs(world);
    mcp = new FakeMcp(world, as);
    await mcp.start();
    n = await testNode(
      {
        OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
        OAX_DATABASE_URL: db.url,
        OAX_DB_POOL_MAX: '6',
        OAX_MCP_OAUTH_RENEWALS: '3',
        OAX_MCP_OAUTH_RENEWALS_PER_TENANT: '2',
      },
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
    as.latency = 0;
    await mcp.stop();
    await n.close();
    await db.close();
  });

  async function connect(i: number) {
    const res = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: `bound-${i}`,
        config: { transport: 'streamable-http', url: MCP, auth, tools: {}, profiles: {} },
      },
    });
    const id = res.json().id as string;
    const a = await n.req({
      method: 'POST',
      url: `/v1/connections/${id}/oauth/authorize`,
      payload: {},
    });
    expect(a.statusCode, a.body).toBe(200);
    const [row] = await n.ctx.db.select().from(connections).where(eq(connections.id, id));
    return { id, ref: { id, tenantId: row!.tenantId } };
  }

  it('stalled token servers do not drain the pool; surplus renewals fail fast and are not recorded', async () => {
    as.expiresIn = 120;
    const conns = [];
    for (let i = 0; i < 8; i++) conns.push(await connect(i));
    as.expiresIn = 3600;
    clock = new Date(clock.getTime() + 70_000); // all eight are inside the renewal window
    const before = as.tokenRequests.length;
    as.latency = 2500; // every token server stalls
    const svc = n.services.mcpOauthFlows;
    const started = Date.now();
    const results = conns.map((c) =>
      svc.refresh(c.ref).then(
        () => 'ok',
        (e: { code: string }) => e.code,
      ),
    );
    await sleep(500);
    // the pool has 6 connections and eight renewals are running or refused: other work still goes through
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 12 }, () => n.ctx.db.execute(sql`select 1`)));
    const roundTrip = Date.now() - t0;
    expect(roundTrip).toBeLessThan(1000);
    expect((await n.req({ method: 'GET', url: '/v1/tenants' })).statusCode).toBe(200);
    as.latency = 0;
    const out = await Promise.all(results);
    expect(Date.now() - started).toBeGreaterThan(2000); // the two admitted ones really stalled
    expect(out.filter((x) => x === 'ok')).toHaveLength(2); // per tenant bound
    expect(out.filter((x) => x === 'mcp_auth_refresh_failed')).toHaveLength(6);
    expect(as.tokenRequests.length - before).toBe(2);
    // a refused renewal is not a failure of the credentials: nothing is recorded
    for (const c of conns) {
      const [row] = await n.ctx.db
        .select()
        .from(mcpOauthTokens)
        .where(eq(mcpOauthTokens.connectionId, c.id));
      expect(row!.status).toBe('active');
      expect(row!.lastError).toBeNull();
    }
    // the refused ones renew at the next request once the short backoff has passed
    clock = new Date(clock.getTime() + 6_000);
    for (const c of conns)
      expect(
        await svc.refresh(c.ref).then(
          () => 'ok',
          (e: { code: string }) => e.code,
        ),
      ).toBe('ok');
  }, 30_000);

  it('a delete or update behind a held credential lock gives up with 503 instead of waiting', async () => {
    const { id, ref } = await connect(100);
    const holder = await db.session!();
    await holder.query('begin');
    await holder.query('select pg_advisory_xact_lock($1::int, hashtext($2))', [
      CREDENTIAL_LOCK_NS,
      `${id}:1`,
    ]);
    try {
      const t0 = Date.now();
      await expect(
        n.ctx.db.transaction(async (tx) => lockCredential(tx as never, id, 1, 300)),
      ).rejects.toMatchObject({ code: 'mcp_credential_busy', statusCode: 503 });
      expect(Date.now() - t0).toBeLessThan(3000);
      // the default bound applies to the rest of the transaction as well
      await holder.query('rollback');
      const shown = await n.ctx.db.transaction(async (tx) => {
        await lockCredential(tx as never, id, 1);
        const res = (await tx.execute(sql`show lock_timeout`)) as unknown as {
          rows: { lock_timeout: string }[];
        };
        return res.rows[0]!.lock_timeout;
      });
      expect(shown).toBe('15s');
      expect(ref.id).toBe(id);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
  });
});
