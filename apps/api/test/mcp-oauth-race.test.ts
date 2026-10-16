import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, connections, mcpOauthTokens, tenants } from '../src/db/schema.js';
import { OaxError } from '@openagentix/core';
import { createMcpOauth, SecretRegistry } from '../src/mcp-oauth/index.js';
import type { RenewalLimiter } from '../src/mcp-oauth/renewal-limiter.js';
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
    // after a re-authorization (the first answer) has stored new tokens; the one re-discovery that
    // follows invalid_client finds the fresh tokens under the lock and has nothing left to renew
    let answered = 0;
    as.nextToken = () => (++answered === 2 ? json({ error: 'invalid_client' }, 401) : undefined);
    as.latency = 3000;
    const renewing = n.services.mcpOauthFlows.refresh(ref).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await sleep(300); // the renewal holds the lock and waits for the server
    as.latency = 0;
    clock = new Date(clock.getTime() + 1_000);
    expect(
      (await n.req({ method: 'POST', url: `/v1/connections/${id}/oauth/authorize`, payload: {} }))
        .statusCode,
    ).toBe(200);
    const fresh = (await rows(id))[0]!;
    await renewing; // fine either way: the point is that the new tokens are not marked
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
    as.latency = 1500;
    const renewing = n.services.mcpOauthFlows.refresh(ref).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await sleep(300);
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
  /** An authorization-code connection: the first grant issues a refresh token, the row is switched. */
  async function authorizedCode() {
    as.issueRefresh = true;
    const c = await authorized();
    as.issueRefresh = false;
    await n.ctx.db
      .update(mcpOauthTokens)
      .set({ grantType: 'authorization_code' })
      .where(eq(mcpOauthTokens.connectionId, c.id));
    return c;
  }
  const tick = () => {
    clock = new Date(clock.getTime() + 1_000);
  };

  it('a disconnect behind a held credential lock fails with 503 and revokes nothing', async () => {
    const { id } = await authorized();
    const revokedBefore = as.revoked.length;
    const holder = await db.session!();
    await holder.query('begin');
    await holder.query('select pg_advisory_xact_lock($1::int, hashtext($2))', [
      CREDENTIAL_LOCK_NS,
      `${id}:1`,
    ]);
    try {
      const res = await n.req({ method: 'POST', url: `/v1/connections/${id}/oauth/disconnect` });
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json().error).toBe('mcp_credential_busy');
      expect(await rows(id)).toHaveLength(1);
      const audited = (await n.ctx.db.select().from(auditLog)).filter(
        (a) => a.target === id && a.action === 'mcp.oauth.revoked',
      );
      expect(audited).toHaveLength(0);
      expect(as.revoked).toHaveLength(revokedBefore);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    // once the lock is free, the same request goes through
    const again = await n.req({ method: 'POST', url: `/v1/connections/${id}/oauth/disconnect` });
    expect(again.statusCode, again.body).toBe(200);
    expect(await rows(id)).toHaveLength(0);
  }, 40_000);

  it('a renewal that lost the compare-and-swap to a step-up does not clear the requirement', async () => {
    const { id, ref } = await authorizedCode();
    const tokens = n.services.mcpOauth.tokens;
    const stored = (await tokens.open(ref.tenantId, id, 1))!;
    const revoked = as.revoked.length;
    as.latency = 1500;
    const renewing = n.services.mcpOauthFlows.refresh(ref).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await sleep(300);
    as.latency = 0;
    tick();
    // a 403 insufficient_scope: written without the credential lock
    expect(
      await tokens.requireStepUp(ref.tenantId, id, 1, stored.accessToken, ['issues.write']),
    ).toBe(true);
    expect(await renewing).toBe('mcp_auth_required');
    const [row] = await rows(id);
    expect(row!.status).toBe('reauthorization_required');
    expect(row!.lastError).toBe('insufficient_scope');
    expect(row!.requiredScopes).toBe('issues.write');
    // what the server issued for the failed attempt is revoked, the access token and the refresh token
    expect(as.revoked.length - revoked).toBeGreaterThanOrEqual(2);
    expect((await statusOf(id)).status).toBe('reauthorization_required');
  });

  it('a rotated refresh token survives a lost compare-and-swap (authorization code)', async () => {
    const { id, ref } = await authorizedCode();
    const tokens = n.services.mcpOauth.tokens;
    const before = as.tokenRequests.length;
    const revoked = as.revoked.length;
    const old = (await tokens.open(ref.tenantId, id, 1))!;
    as.latency = 1500;
    const renewing = n.services.mcpOauthFlows.refresh(ref).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    await sleep(300);
    as.latency = 0;
    tick();
    await tokens.setStatus(ref.tenantId, id, 1, 'active'); // a status-only writer, no lock
    expect(await renewing).toBe('ok');
    // one request only: the pair the server rotated is written by the retry, not requested again
    expect(as.tokenRequests.length - before).toBe(1);
    expect(as.revoked.length).toBe(revoked);
    const now = (await tokens.open(ref.tenantId, id, 1))!;
    expect(now.refreshToken).not.toBe(old.refreshToken);
    expect(as.validRefresh.has(now.refreshToken!)).toBe(true);
    expect(now.accessToken).not.toBe(old.accessToken);
    expect(now.meta.status).toBe('active');
    expect((await statusOf(id)).lastError).toBeNull();
  });

  it('invalid_client while the cached discovery is in use re-discovers once before giving up', async () => {
    const { id, ref } = await authorized();
    let answered = 0;
    as.nextToken = () => (++answered === 1 ? json({ error: 'invalid_client' }, 401) : undefined);
    const before = as.tokenRequests.length;
    await n.services.mcpOauthFlows.refresh(ref);
    as.nextToken = undefined;
    // the first request failed, the second (after forgetting the cache) renewed
    expect(as.tokenRequests.length - before).toBe(2);
    expect(await statusOf(id)).toMatchObject({ status: 'active', lastError: null });
  });

  it('a persistent invalid_client is retried once only, then the connection needs authorization', async () => {
    const { id, ref } = await authorized();
    as.nextToken = () => json({ error: 'invalid_client' }, 401);
    const before = as.tokenRequests.length;
    const code = await n.services.mcpOauthFlows.refresh(ref).then(
      () => 'ok',
      (e: { code: string }) => e.code,
    );
    as.nextToken = undefined;
    expect(code).toBe('mcp_auth_required');
    expect(as.tokenRequests.length - before).toBe(2);
    expect(await statusOf(id)).toMatchObject({ status: 'reauthorization_required' });
  });

  it('a denial is audited only when the failure was stored', async () => {
    const { id, ref } = await authorized();
    const svc = n.services.mcpOauthFlows as unknown as {
      failRefresh(row: unknown, e: unknown, seen: Date): Promise<boolean>;
    };
    const [row] = await n.ctx.db.select().from(connections).where(eq(connections.id, id));
    const denials = async () =>
      (await n.ctx.db.select().from(auditLog)).filter(
        (a) => a.action === 'mcp.oauth.denied' && a.target === id,
      ).length;
    const err = new OaxError('mcp_issuer_mismatch', 'issuer changed');
    // the row was rewritten since the renewal saw it: nothing is stored, nothing is audited
    expect(await svc.failRefresh(row, err, new Date('2000-01-01T00:00:00Z'))).toBe(false);
    expect(await denials()).toBe(0);
    expect(await statusOf(id)).toMatchObject({ status: 'active' });
    // the row is the one that was seen: stored, and audited
    const [stored] = await rows(id);
    expect(await svc.failRefresh(row, err, stored!.updatedAt)).toBe(true);
    expect(await denials()).toBe(1);
    expect(ref.id).toBe(id);
  });

  it('the renewal bound is keyed by the root organisation of a sub-tenant', async () => {
    const [root] = await n.ctx.db.select().from(tenants).limit(1);
    const rootId = root!.id;
    const childId = randomUUID();
    await n.ctx.db.insert(tenants).values({
      id: childId,
      slug: `sub-${childId.slice(0, 8)}`,
      name: 'sub',
      parentId: rootId,
      rootId,
      path: `${root!.path}${childId}/`,
      depth: root!.depth + 1,
    });
    const svc = n.services.mcpOauthFlows as unknown as {
      rootOf(tenantId: string): Promise<string>;
    };
    expect(await svc.rootOf(childId)).toBe(rootId);
    expect(await svc.rootOf(rootId)).toBe(rootId);
    await n.ctx.db.delete(tenants).where(eq(tenants.id, childId));
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
    // the refused ones are not asked again within the backoff, even though slots are free now
    const refused = conns.filter((_c, i) => out[i] === 'mcp_auth_refresh_failed');
    const requests = as.tokenRequests.length;
    for (const c of refused)
      expect(
        await svc.refresh(c.ref).then(
          () => 'ok',
          (e: { code: string }) => e.code,
        ),
      ).toBe('mcp_auth_refresh_failed');
    expect(as.tokenRequests.length).toBe(requests);
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

  it('the process bound counts every tenant: other tenants holding slots leave less for this one', async () => {
    as.expiresIn = 120;
    const conns = [];
    for (let i = 0; i < 3; i++) conns.push(await connect(300 + i));
    as.expiresIn = 3600;
    clock = new Date(clock.getTime() + 70_000);
    const svc = n.services.mcpOauthFlows;
    const limiter = (svc as unknown as { limiter: RenewalLimiter }).limiter;
    // two renewals of other tenants are in flight: 2 of 3 process slots are taken
    const others = [limiter.tryAcquire('other-tenant-a'), limiter.tryAcquire('other-tenant-b')];
    expect(others.every(Boolean)).toBe(true);
    try {
      as.latency = 600;
      const out = await Promise.all(
        conns.map((c) =>
          svc.refresh(c.ref).then(
            () => 'ok',
            (e: { code: string }) => e.code,
          ),
        ),
      );
      as.latency = 0;
      // this tenant may use 2, the process has 1 left
      expect(out.filter((x) => x === 'ok')).toHaveLength(1);
      expect(out.filter((x) => x === 'mcp_auth_refresh_failed')).toHaveLength(2);
    } finally {
      as.latency = 0;
      for (const release of others) release?.();
    }
    expect(limiter.inFlight).toBe(0);
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
      expect(shown).toBe('10s');
      expect(ref.id).toBe(id);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
  });
});
