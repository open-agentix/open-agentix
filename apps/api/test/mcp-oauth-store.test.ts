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
const ACCESS = 'canary-access-token-0123456789';
const REFRESH = 'canary-refresh-token-9876543210';

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
  credentialVersion: 1,
  resource: RESOURCE,
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
    const token = await creds.accessToken(ref(id), ['read'], { guard });
    expect(token).toBe(ACCESS);
    // registered with the run's guard and the log redactor
    expect(fresh.list()).toContain(ACCESS);
    expect(guard.text(`echo ${ACCESS}`).text).not.toContain(ACCESS);
    expect(fresh.scrub(`x ${ACCESS} y`)).toBe('x [REDACTED] y');
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
    await write(id, { accessToken: 'second-access-token-00000', refreshToken: undefined });
    const stored = await oauth.tokens.open(DEFAULT_TENANT_ID, id, 1);
    expect(stored).toMatchObject({ accessToken: 'second-access-token-00000', refreshToken: null });
    expect(await oauth.tokens.delete(DEFAULT_TENANT_ID, id)).toBe(1);
    expect(await oauth.tokens.open(DEFAULT_TENANT_ID, id, 1)).toBeNull();
  });

  it('crypto-shredding: after the tenant key is destroyed nothing opens, not even with the KEK', async () => {
    const id = await connection(OTHER_TENANT);
    await write(id, { tenantId: OTHER_TENANT });
    expect(await oauth.tokens.open(OTHER_TENANT, id, 1)).not.toBeNull();
    expect(await oauth.keys.destroyTenantKeys(OTHER_TENANT)).toBeGreaterThan(0);
    await expect(oauth.tokens.open(OTHER_TENANT, id, 1)).rejects.toMatchObject({
      code: 'key_unavailable',
    });
    const keys = await n.ctx.db
      .select()
      .from(tenantDataKeys)
      .where(eq(tenantDataKeys.tenantId, OTHER_TENANT));
    expect(keys.every((k) => k.wrappedKey === null && k.status === 'destroyed')).toBe(true);
  });

  it('seals dynamically registered client secrets per tenant and issuer', async () => {
    const secret = 'client-secret-canary-0000111';
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

  it('fails closed without tokens, for revoked or expired tokens, a changed resource and missing scopes', async () => {
    const guard = guardOf();
    const none = await connection();
    await expect(creds().accessToken(ref(none), [], { guard })).rejects.toMatchObject({
      code: 'mcp_auth_required',
    });

    const id = await connection();
    await write(id);
    await expect(
      creds().accessToken(ref(id, { resource: 'https://moved.example.org/mcp' }), [], { guard }),
    ).rejects.toMatchObject({
      code: 'mcp_resource_mismatch',
    });
    await expect(creds().accessToken(ref(id), ['admin'], { guard })).rejects.toMatchObject({
      code: 'mcp_insufficient_scope',
    });
    await expect(
      creds().accessToken(ref(id, { credentialVersion: 2 }), [], { guard }),
    ).rejects.toMatchObject({
      code: 'mcp_auth_required',
    });
    await oauth.tokens.setStatus(DEFAULT_TENANT_ID, id, 1, 'reauthorization_required');
    await expect(creds().accessToken(ref(id), [], { guard })).rejects.toMatchObject({
      code: 'mcp_auth_required',
    });
    await oauth.tokens.setStatus(DEFAULT_TENANT_ID, id, 1, 'active');
    expect(await creds().accessToken(ref(id), ['read', 'write'], { guard })).toBe(ACCESS);
    now = new Date(now.getTime() + 2 * 3_600_000);
    await expect(creds().accessToken(ref(id), [], { guard })).rejects.toMatchObject({
      code: 'mcp_auth_required',
    });
    now = new Date('2026-10-10T12:00:00Z');
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
});
