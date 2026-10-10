import { randomBytes, randomUUID } from 'node:crypto';
import { ContextGuard } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';
import {
  connections,
  DEFAULT_TENANT_ID,
  mcpOauthClients,
  mcpOauthTokens,
  tenantDataKeys,
} from '../src/db/schema.js';
import {
  McpCredentials,
  SecretRegistry,
  createMcpOauth,
  type McpOauthStores,
} from '../src/mcp-oauth/index.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0016 slice S5: the key service and the encrypted token store. Real database (PGlite), real
 * AES-GCM; nothing is mocked.
 */
const KEK = randomBytes(32).toString('base64');
const RESOURCE = 'https://mcp.example.org/mcp';
const ISSUER = 'https://auth.example.org';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000aa';
const ACCESS = 'Zk29xQ7mLp3Vw8Rn5TbY1uHsJd4Ge';
const REFRESH = 'Hb41yUe6Cd0Fs5AjXq8NmW2tKr7Pv';
const SECOND = 'Qw93kLm2Xz7Pa4RtYc6NhB1vSe8Df';

let n: TestNode;
let oauth: McpOauthStores;
let registry: SecretRegistry;
let now = new Date('2026-10-10T12:00:00Z');

async function connection(tenantId = DEFAULT_TENANT_ID): Promise<string> {
  const id = randomUUID();
  await n.ctx.db.insert(connections).values({
    id,
    tenantId,
    name: `c-${id.slice(0, 8)}`,
    kind: 'mcp',
    config: { transport: 'streamable-http', url: RESOURCE },
  });
  return id;
}
const write = (connectionId: string, over: Record<string, unknown> = {}) =>
  oauth.tokens.put({
    tenantId: DEFAULT_TENANT_ID,
    connectionId,
    credentialVersion: 1,
    issuer: ISSUER,
    resource: RESOURCE,
    clientRef: 'client-ref',
    scopes: ['read', 'write'],
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: new Date(now.getTime() + 3_600_000),
    ...over,
  });
const ref = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tenantId: DEFAULT_TENANT_ID,
  ...over,
});
const guardOf = () => new ContextGuard();

beforeAll(async () => {
  n = await testNode({ OAX_MCP_OAUTH_KEK: KEK }, { now: () => now });
  registry = new SecretRegistry();
  oauth = createMcpOauth(n.ctx, 'api', registry);
});
afterAll(async () => n.close());

describe('encrypted token store', () => {
  it('stores no plaintext: only ciphertext reaches the tables', async () => {
    const id = await connection();
    await write(id);
    const rows = await n.ctx.db
      .select()
      .from(mcpOauthTokens)
      .where(eq(mcpOauthTokens.connectionId, id));
    const dump = JSON.stringify([
      rows,
      await n.ctx.db.select().from(tenantDataKeys),
      await n.ctx.db.select().from(mcpOauthClients),
    ]);
    for (const secret of [ACCESS, REFRESH, KEK, Buffer.from(ACCESS).toString('base64')])
      expect(dump).not.toContain(secret);
    expect(rows[0]!.accessTokenEnc).toMatch(/^oaxe1\./);
    expect(rows[0]!.refreshTokenEnc).toMatch(/^oaxe1\./);
    // the wrapped data key is sealed too: it is not a bare 32-byte key
    const [key] = await n.ctx.db.select().from(tenantDataKeys);
    expect(key!.wrappedKey).toMatch(/^oaxe1\./);
  });

  it('returns the values only through McpCredentials, and registers them before returning', async () => {
    const id = await connection();
    await write(id);
    const guard = guardOf();
    const fresh = new SecretRegistry();
    const creds = new McpCredentials(oauth.tokens, fresh, () => now, 'api');
    expect(fresh.size).toBe(0);
    const granted = await creds.accessToken(ref(id), ['read'], { guard });
    expect(granted).toEqual({ token: ACCESS, resource: RESOURCE });
    // registered with the run's guard and the log redactor
    expect(fresh.has(ACCESS)).toBe(true);
    expect(guard.text(`echo ${ACCESS}`).text).not.toContain(ACCESS);
    expect(fresh.scrub(`x ${ACCESS} y`)).toBe('x [REDACTED] y');
    // scoped to the connection's tenant: another tenant's text is left alone
    expect(fresh.scrub(`x ${ACCESS}`, DEFAULT_TENANT_ID)).toBe('x [REDACTED]');
    expect(fresh.scrub(`x ${ACCESS}`, OTHER_TENANT)).toBe(`x ${ACCESS}`);
    // metadata never carries a value
    expect(JSON.stringify(await oauth.tokens.meta(DEFAULT_TENANT_ID, id, 1))).not.toContain(
      'canary',
    );
  });

  it('uses one data key per tenant and separate keys for separate tenants', async () => {
    const a = await connection();
    const b = await connection(OTHER_TENANT);
    await write(a);
    await write(b, { tenantId: OTHER_TENANT });
    const keys = await n.ctx.db.select().from(tenantDataKeys);
    const byTenant = new Map<string, string[]>();
    for (const k of keys)
      byTenant.set(k.tenantId, [...(byTenant.get(k.tenantId) ?? []), k.wrappedKey!]);
    expect(byTenant.get(DEFAULT_TENANT_ID)).toHaveLength(1);
    expect(byTenant.get(OTHER_TENANT)).toHaveLength(1);
    expect(byTenant.get(DEFAULT_TENANT_ID)![0]).not.toBe(byTenant.get(OTHER_TENANT)![0]);
  });

  it('does not decrypt a ciphertext copied to another connection, issuer, resource, version or tenant', async () => {
    const source = await connection();
    await write(source);
    const [row] = await n.ctx.db
      .select()
      .from(mcpOauthTokens)
      .where(eq(mcpOauthTokens.connectionId, source));
    const copy = async (
      over: Partial<typeof mcpOauthTokens.$inferInsert>,
      tenant = DEFAULT_TENANT_ID,
    ) => {
      const target = await connection(tenant);
      await n.ctx.db.insert(mcpOauthTokens).values({
        ...row!,
        id: randomUUID(),
        connectionId: target,
        tenantId: tenant,
        credentialVersion: 1,
        ...over,
      });
      return n.ctx.db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.connectionId, target));
    };
    // a copy into another connection (same tenant)
    const sameTenant = await copy({});
    await expect(
      oauth.tokens.open(DEFAULT_TENANT_ID, sameTenant[0]!.connectionId, 1),
    ).rejects.toMatchObject({ code: 'mcp_oauth_decrypt_failed' });
    // the same connection, but the row claims another issuer / resource / version
    for (const [label, over] of [
      ['issuer', { issuer: 'https://evil.example.org' }],
      ['resource', { resource: 'https://evil.example.org/mcp' }],
    ] as const) {
      const id = await connection();
      await n.ctx.db
        .insert(mcpOauthTokens)
        .values({ ...row!, id: randomUUID(), connectionId: id, ...over });
      await expect(oauth.tokens.open(DEFAULT_TENANT_ID, id, 1), label).rejects.toMatchObject({
        code: 'mcp_oauth_decrypt_failed',
      });
    }
    const versioned = await connection();
    await n.ctx.db
      .insert(mcpOauthTokens)
      .values({ ...row!, id: randomUUID(), connectionId: versioned, credentialVersion: 2 });
    await expect(oauth.tokens.open(DEFAULT_TENANT_ID, versioned, 2)).rejects.toMatchObject({
      code: 'mcp_oauth_decrypt_failed',
    });
    // a row of another tenant: the data key of that tenant differs, and the lookup is tenant scoped
    const foreign = await copy({}, OTHER_TENANT);
    expect(await oauth.tokens.open(DEFAULT_TENANT_ID, foreign[0]!.connectionId, 1)).toBeNull();
    await expect(oauth.tokens.open(OTHER_TENANT, foreign[0]!.connectionId, 1)).rejects.toThrow(
      /cannot be decrypted/,
    );
  });

  it('refuses to store a token for a connection of another tenant, and tokens too short to redact', async () => {
    const id = await connection(OTHER_TENANT);
    await expect(write(id)).rejects.toMatchObject({ code: 'not_found' });
    const own = await connection();
    await expect(write(own, { accessToken: 'short' })).rejects.toMatchObject({
      code: 'token_invalid',
    });
    await expect(write(randomUUID())).rejects.toMatchObject({ code: 'not_found' });
  });

  it('replaces the tokens of a connection on re-authorization and deletes them on disconnect', async () => {
    const id = await connection();
    await write(id);
    await write(id, { accessToken: SECOND, refreshToken: undefined });
    const stored = await oauth.tokens.open(DEFAULT_TENANT_ID, id, 1);
    expect(stored).toMatchObject({ accessToken: SECOND, refreshToken: null });
    expect(await oauth.tokens.delete(DEFAULT_TENANT_ID, id)).toBe(1);
    expect(await oauth.tokens.open(DEFAULT_TENANT_ID, id, 1)).toBeNull();
  });

  it('crypto-shredding: after the tenant key is destroyed nothing opens, not even with the KEK', async () => {
    const id = await connection(OTHER_TENANT);
    await write(id, { tenantId: OTHER_TENANT });
    expect(await oauth.tokens.open(OTHER_TENANT, id, 1)).not.toBeNull();
    expect(await oauth.keys.destroyTenantKeys(OTHER_TENANT)).toBeGreaterThan(0);
    await expect(oauth.tokens.open(OTHER_TENANT, id, 1)).rejects.toMatchObject({
      code: 'key_destroyed',
    });
    const keys = await n.ctx.db
      .select()
      .from(tenantDataKeys)
      .where(eq(tenantDataKeys.tenantId, OTHER_TENANT));
    expect(keys.every((k) => k.wrappedKey === null && k.status === 'destroyed')).toBe(true);
  });

  it('seals dynamically registered client secrets per tenant and issuer', async () => {
    const secret = 'Xq72LmZk9PaRt4YcWe8NhB1v';
    const id = await oauth.clients.put({
      tenantId: DEFAULT_TENANT_ID,
      issuer: 'https://dcr.example.org',
      clientId: 'cid',
      clientSecret: secret,
    });
    const [row] = await n.ctx.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, id));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(await oauth.clients.clientSecret(DEFAULT_TENANT_ID, 'https://dcr.example.org')).toBe(
      secret,
    );
    expect(await oauth.clients.clientSecret(OTHER_TENANT, 'https://dcr.example.org')).toBeNull();
    // moving the row to another tenant breaks the binding
    await n.ctx.db
      .update(mcpOauthClients)
      .set({ tenantId: OTHER_TENANT })
      .where(eq(mcpOauthClients.id, id));
    await expect(
      oauth.clients.clientSecret(OTHER_TENANT, 'https://dcr.example.org'),
    ).rejects.toThrow();
  });
});

describe('McpCredentials.accessToken', () => {
  const creds = () => new McpCredentials(oauth.tokens, registry, () => now, 'worker');

  it('is only constructible for the api and the trusted worker', () => {
    for (const role of ['node', 'harness', 'model', ''])
      expect(() => new McpCredentials(oauth.tokens, registry, () => now, role as 'api')).toThrow(
        /only available/,
      );
    expect(() => new McpCredentials(oauth.tokens, registry, () => now, 'api')).not.toThrow();
  });

  it('fails closed without tokens, for revoked or expired tokens, a moved server and missing scopes', async () => {
    const guard = guardOf();
    const none = await connection();
    await expect(creds().accessToken(ref(none), [], { guard })).rejects.toMatchObject({
      code: 'mcp_auth_required',
    });

    const id = await connection();
    await write(id);
    await expect(creds().accessToken(ref(id), ['admin'], { guard })).rejects.toMatchObject({
      code: 'mcp_insufficient_scope',
    });
    // The URL is read from the database: a connection that moved no longer matches its token.
    await n.ctx.db
      .update(connections)
      .set({ config: { transport: 'streamable-http', url: 'https://moved.example.org/mcp' } })
      .where(eq(connections.id, id));
    await expect(creds().accessToken(ref(id), [], { guard })).rejects.toMatchObject({
      code: 'mcp_resource_mismatch',
    });
    await n.ctx.db
      .update(connections)
      .set({ config: { transport: 'streamable-http', url: RESOURCE } })
      .where(eq(connections.id, id));
    // A bumped credential version has no token of its own yet.
    await n.ctx.db.update(connections).set({ credentialVersion: 2 }).where(eq(connections.id, id));
    await expect(creds().accessToken(ref(id), [], { guard })).rejects.toMatchObject({
      code: 'mcp_auth_required',
    });
    await n.ctx.db.update(connections).set({ credentialVersion: 1 }).where(eq(connections.id, id));
    await oauth.tokens.setStatus(DEFAULT_TENANT_ID, id, 1, 'reauthorization_required');
    await expect(creds().accessToken(ref(id), [], { guard })).rejects.toMatchObject({
      code: 'mcp_auth_required',
    });
    await write(id);
    expect((await creds().accessToken(ref(id), ['read', 'write'], { guard })).token).toBe(ACCESS);
    now = new Date(now.getTime() + 2 * 3_600_000);
    await expect(creds().accessToken(ref(id), [], { guard })).rejects.toMatchObject({
      code: 'mcp_auth_required',
    });
    now = new Date('2026-10-10T12:00:00Z');
  });

  it('forgets a token in the redactor when its connection is disconnected or revoked', async () => {
    const id = await connection();
    await write(id, { accessToken: SECOND });
    await creds().accessToken(ref(id), [], { guard: guardOf() });
    expect(registry.has(SECOND)).toBe(true);
    await oauth.tokens.setStatus(DEFAULT_TENANT_ID, id, 1, 'revoked');
    expect(registry.has(SECOND)).toBe(false);
    await write(id, { accessToken: SECOND });
    await creds().accessToken(ref(id), [], { guard: guardOf() });
    await oauth.tokens.delete(DEFAULT_TENANT_ID, id);
    expect(registry.has(SECOND)).toBe(false);
  });

  it('does not hand out the token of another tenant', async () => {
    const id = await connection();
    await write(id);
    await expect(
      creds().accessToken(ref(id, { tenantId: OTHER_TENANT }), [], { guard: guardOf() }),
    ).rejects.toMatchObject({ code: 'mcp_auth_required' });
  });
});

describe('key service configuration', () => {
  it('fails closed without a key-encryption key', async () => {
    const bare = createMcpOauth(
      {
        db: n.ctx.db,
        config: loadConfig({ NODE_ENV: 'test', OAX_DATABASE_URL: 'memory://' }),
        now: () => now,
      },
      'api',
      new SecretRegistry(),
    );
    expect(bare.keys.configured).toBe(false);
    const id = await connection();
    await expect(
      bare.tokens.put({
        tenantId: DEFAULT_TENANT_ID,
        connectionId: id,
        credentialVersion: 1,
        issuer: ISSUER,
        resource: RESOURCE,
        clientRef: 'c',
        scopes: [],
        accessToken: ACCESS,
      }),
    ).rejects.toMatchObject({ code: 'key_service_unconfigured' });
  });

  it('refuses data keys wrapped with another key-encryption key', async () => {
    const other = createMcpOauth(
      {
        db: n.ctx.db,
        config: loadConfig({
          NODE_ENV: 'test',
          OAX_DATABASE_URL: 'memory://',
          OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
          OAX_MCP_OAUTH_KEK_ID: 'kek-2',
        }),
        now: () => now,
      },
      'api',
      new SecretRegistry(),
    );
    const id = await connection();
    await expect(
      other.tokens.put({
        tenantId: DEFAULT_TENANT_ID,
        connectionId: id,
        credentialVersion: 1,
        issuer: ISSUER,
        resource: RESOURCE,
        clientRef: 'c',
        scopes: [],
        accessToken: ACCESS,
      }),
    ).rejects.toMatchObject({ code: 'key_unavailable' });
  });

  it('validates the configured key without ever quoting it', () => {
    const base = { NODE_ENV: 'test', OAX_DATABASE_URL: 'memory://' };
    const bad = 'not-a-valid-key-but-secret-looking!!';
    let message = '';
    try {
      loadConfig({ ...base, OAX_MCP_OAUTH_KEK: bad });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/32 random bytes/);
    expect(message).not.toContain(bad);
    expect(() =>
      loadConfig({ ...base, OAX_MCP_OAUTH_KEK: randomBytes(16).toString('base64') }),
    ).toThrow(/32 random bytes/);
    expect(() =>
      loadConfig({ ...base, OAX_MCP_OAUTH_KEK: KEK, OAX_MCP_OAUTH_KEK_FILE: '/nope' }),
    ).toThrow(/only one/);
    expect(() => loadConfig({ ...base, OAX_MCP_OAUTH_KEK_FILE: '/nonexistent/kek' })).toThrow(
      /cannot be read/,
    );
    expect(loadConfig({ ...base, OAX_MCP_OAUTH_KEK: KEK }).mcp.oauth.kek.key).toHaveLength(32);
    expect(loadConfig(base).mcp.oauth.kek.key).toBeNull();
  });

  it('reports a replaced key-encryption key under the same id as unavailable, not as corruption', async () => {
    const id = await connection();
    await write(id);
    const replaced = createMcpOauth(
      {
        db: n.ctx.db,
        config: loadConfig({
          NODE_ENV: 'test',
          OAX_DATABASE_URL: 'memory://',
          OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
        }),
        now: () => now,
      },
      'api',
      new SecretRegistry(),
    );
    await expect(replaced.tokens.open(DEFAULT_TENANT_ID, id, 1)).rejects.toMatchObject({
      code: 'key_unavailable',
    });
  });

  it('keeps the key out of the config object (non-enumerable) and removes it from the environment', () => {
    const base = { NODE_ENV: 'test', OAX_DATABASE_URL: 'memory://' };
    const config = loadConfig({ ...base, OAX_MCP_OAUTH_KEK: KEK });
    expect(JSON.stringify(config)).not.toContain(KEK);
    expect(JSON.stringify(config.mcp.oauth.kek)).toBe('{"id":"kek-1"}');
    expect(config.mcp.oauth.source).toBe('env');
  });

  it('refuses a key file inside the secrets directory (its files are served as secrets)', () => {
    const base = { NODE_ENV: 'test', OAX_DATABASE_URL: 'memory://' };
    expect(() =>
      loadConfig({
        ...base,
        OAX_SECRETS_DIR: '/run/secrets',
        OAX_MCP_OAUTH_KEK_FILE: '/run/secrets/kek',
      }),
    ).toThrow(/inside OAX_SECRETS_DIR/);
    expect(() =>
      loadConfig({
        ...base,
        OAX_SECRETS_DIR: '/run/secrets',
        OAX_MCP_OAUTH_KEK_FILE: '/run/secrets-kek/kek',
      }),
    ).toThrow(/cannot be read/); // a sibling path is outside; it fails only because it does not exist
  });

  it('removes the key from process.env once it is loaded', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        NODE_ENV: 'test',
        OAX_DATABASE_URL: 'memory://',
        OAX_MCP_OAUTH_KEK: KEK,
      });
      expect(loadConfig().mcp.oauth.kek.key).toHaveLength(32);
      expect(process.env.OAX_MCP_OAUTH_KEK).toBeUndefined();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      delete process.env.OAX_MCP_OAUTH_KEK;
    }
  });
});

describe('what put() accepts', () => {
  it('refuses a resource that is not the canonical URI of the connection, an old credential version and non-https issuers', async () => {
    const id = await connection();
    await expect(write(id, { resource: 'https://other.example.org/mcp' })).rejects.toMatchObject({
      code: 'mcp_resource_mismatch',
    });
    await expect(write(id, { credentialVersion: 7 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(write(id, { issuer: 'http://auth.example.org' })).rejects.toMatchObject({
      code: 'token_invalid',
    });
    await expect(write(id, { issuer: 'https://user:pw@auth.example.org' })).rejects.toMatchObject({
      code: 'token_invalid',
    });
  });

  it('refuses token values that could damage the redactors or collide with identifiers', async () => {
    const id = await connection();
    const hostile = [
      '1","b":"2-padding-padding-padding',
      'a"b\\c-padding-padding-padding1',
      randomUUID(),
      `runs/${randomUUID()}`,
      `prefix-${DEFAULT_TENANT_ID}-suffix`,
      `x${id}x-padding-more`,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '0123456789012345678901234567890',
      'has space in the token value 1234',
      'x'.repeat(5000),
      'short-one',
      'new\nline-token-value-12345678',
      // text that would blank ordinary log lines, paths and error codes of other tenants
      '/api/v1/connections/',
      'github.com/open-agentix/open-agentix',
      'api.anthropic.com/v1/messages',
      'node_modules/fastify/lib',
      'ERR_STREAM_PREMATURE_CLOSE',
      // long and periodic: slow to match, not random
      `${'abcdefghij'.repeat(40)}Zq8`,
    ];
    for (const accessToken of hostile)
      await expect(write(id, { accessToken }), accessToken.slice(0, 30)).rejects.toMatchObject({
        code: 'token_invalid',
      });
    // a refresh token is held to the same standard
    await expect(
      write(id, { refreshToken: '{"a":1}-padding-padding-padding' }),
    ).rejects.toMatchObject({
      code: 'token_invalid',
    });
    // realistic shapes pass: opaque, base64, base64url, hex of 20 and 32 characters, JWT
    for (const accessToken of [
      'ya29.a0AfH6SMBx9-Qk2Lr7pVwT3zYc8Nd5Fg1HjKm',
      randomBytes(32).toString('base64'),
      randomBytes(32).toString('base64url'),
      randomBytes(16).toString('hex'),
      randomBytes(10).toString('hex'),
      `${randomBytes(18).toString('base64url')}.${randomBytes(40).toString('base64url')}.${randomBytes(48).toString('base64url')}`,
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTQyIiwiYXVkIjoiaHR0cHM6Ly9tY3AifQ.c2lnbmF0dXJlLWJ5dGVzLWhlcmUtMTIzNDU2',
    ])
      await write(id, { accessToken });
  });
});

describe('connection changes', () => {
  it('a new server URL bumps the credential version and deletes the stored tokens', async () => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: { name: 'moving', config: { transport: 'streamable-http', url: RESOURCE } },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    await write(id);
    expect(await oauth.tokens.meta(DEFAULT_TENANT_ID, id, 1)).not.toBeNull();
    // same canonical URI (case, default port): nothing changes
    const same = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: {
        config: { transport: 'streamable-http', url: 'HTTPS://MCP.example.org:443/mcp' },
      },
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(await oauth.tokens.meta(DEFAULT_TENANT_ID, id, 1)).not.toBeNull();
    const moved = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { config: { transport: 'streamable-http', url: 'https://other.example.org/mcp' } },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await oauth.tokens.meta(DEFAULT_TENANT_ID, id, 1)).toBeNull();
    const [row] = await n.ctx.db.select().from(connections).where(eq(connections.id, id));
    expect(row!.credentialVersion).toBe(2);
  });
});
