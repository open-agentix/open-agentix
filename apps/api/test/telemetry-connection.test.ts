import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { StaticSecretResolver } from '@openagentix/core';
import { deactivateAirgap } from '../src/index.js';
import { auditLog, connections } from '../src/db/schema.js';
import { CVE_TRIAGE } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0015 S10: the connection type `telemetry` (a tenant-owned OTLP exporter). Who may manage it,
 * what a stored config can say, and which destinations are refused. Every URL, name and secret
 * below is an example.
 */
const PW = 'long-password-123';
const HEADERS_VALUE = 'Authorization=Bearer-SECRET-VALUE-0123456789';
const secrets = new StaticSecretResolver({ 'tenant-b.otlp': HEADERS_VALUE, otlp: HEADERS_VALUE });
const ENV = { OAX_OTEL_TENANT_EXPORTERS: 'allow', OAX_OTEL_CONTENT: 'redacted' };

let n: TestNode;
let tenantB: string;
let bob: string;
let integrator: string;
beforeAll(async () => {
  n = await testNode(ENV, { secrets });
  const t = await n.req({
    method: 'POST',
    url: '/v1/tenants',
    payload: {
      slug: 'tenant-b',
      name: 'Tenant B',
      admin: { email: 'admin@tenant-b.example.org', displayName: 'B', password: PW },
    },
  });
  expect(t.statusCode).toBe(201);
  tenantB = t.json().id as string;
  bob = await n.login('admin@tenant-b.example.org', PW);
  await n.req({
    method: 'POST',
    url: '/v1/users',
    payload: {
      email: 'integ@example.com',
      displayName: 'Integrator',
      password: PW,
      globalRoles: ['integrator'],
    },
  });
  integrator = await n.login('integ@example.com', PW);
});
afterAll(async () => n.close());

let seq = 0;
const cfg = (over: Record<string, unknown> = {}) => ({
  endpoint: 'https://otel.tenant.example',
  ...over,
});
const create = (
  token: string | undefined,
  config: Record<string, unknown> = cfg(),
  extra: Record<string, unknown> = {},
) =>
  n.req({
    method: 'POST',
    url: '/v1/connections',
    ...(token ? { token } : {}),
    payload: { name: `tel-${++seq}`, kind: 'telemetry', config, ...extra },
  });

describe('who may manage telemetry connections', () => {
  it('a tenant admin can; the stored config is the closed schema with defaults', async () => {
    const res = await create(undefined, cfg({ headersSecret: 'otlp' }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      kind: 'telemetry',
      scope: 'tenant',
      config: {
        endpoint: 'https://otel.tenant.example',
        protocol: 'http/protobuf',
        headersSecret: 'otlp',
        clearance: 'internal',
        content: 'off',
        enabled: true,
      },
    });
    // The reference is stored, never a value.
    expect(res.body).not.toContain('SECRET-VALUE');
  });

  it('an integrator (connections:write) cannot create, change or delete one', async () => {
    expect((await create(integrator)).statusCode).toBe(403);
    const id = (await create(undefined)).json().id as string;
    const put = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      token: integrator,
      payload: { config: cfg({ endpoint: 'https://other.example' }) },
    });
    expect(put.statusCode).toBe(403);
    expect(
      (await n.req({ method: 'DELETE', url: `/v1/connections/${id}`, token: integrator }))
        .statusCode,
    ).toBe(403);
    // Control: the same user may create an MCP connection, so the 403 is about the type.
    const mcp = await n.req({
      method: 'POST',
      url: '/v1/connections',
      token: integrator,
      payload: { name: `mcp-${++seq}`, config: { transport: 'in-memory' } },
    });
    expect(mcp.statusCode).toBe(201);
    // And it can read the connection (no secret in it).
    const get = await n.req({ method: 'GET', url: '/v1/connections', token: integrator });
    expect(get.statusCode).toBe(200);
  });

  it('a token needs settings:write besides connections:write', async () => {
    const mk = async (scopes: string[]) =>
      (
        await n.req({
          method: 'POST',
          url: '/v1/tokens',
          payload: { name: `t${++seq}`, scopes },
        })
      ).json().token as string;
    const connOnly = await mk(['connections:read', 'connections:write']);
    expect((await create(connOnly)).statusCode).toBe(403);
    const full = await mk(['connections:read', 'connections:write', 'settings:write']);
    expect((await create(full)).statusCode).toBe(201);
  });

  it('only the tenant scope exists: platform, team and agent are refused', async () => {
    const team = (
      await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-t', name: 'T' } })
    ).json().id as string;
    const agent = (
      await n.req({ method: 'POST', url: '/v1/agents', payload: { source: CVE_TRIAGE } })
    ).json().id as string;
    expect((await create(undefined, cfg(), { scope: 'platform' })).statusCode).toBe(400);
    expect((await create(undefined, cfg(), { scope: 'team', scopeId: team })).statusCode).toBe(400);
    expect((await create(undefined, cfg(), { scope: 'agent', scopeId: agent })).statusCode).toBe(
      400,
    );
  });

  it("tenant B's admin manages B's own and cannot see, change or delete A's", async () => {
    const a = (await create(undefined)).json().id as string;
    const mineB = await create(bob, cfg({ headersSecret: 'tenant-b.otlp' }));
    expect(mineB.statusCode, mineB.body).toBe(201);
    expect(mineB.json().tenantId).toBe(tenantB);
    const listB = (await n.req({ method: 'GET', url: '/v1/connections', token: bob })).json()
      .items as { id: string; kind: string }[];
    expect(listB.every((c) => c.id !== a)).toBe(true);
    const put = await n.req({
      method: 'PUT',
      url: `/v1/connections/${a}`,
      token: bob,
      payload: { config: cfg({ endpoint: 'https://evil.example' }) },
    });
    expect(put.statusCode).toBe(404);
    expect(
      (await n.req({ method: 'DELETE', url: `/v1/connections/${a}`, token: bob })).statusCode,
    ).toBe(404);
    // A can neither see nor change B's.
    const b = mineB.json().id as string;
    const listA = (await n.req({ method: 'GET', url: '/v1/connections' })).json().items as {
      id: string;
    }[];
    expect(listA.every((c) => c.id !== b)).toBe(true);
    expect(
      (
        await n.req({
          method: 'PUT',
          url: `/v1/connections/${b}`,
          payload: { config: cfg() },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("a tenant's secret reference must live in its own namespace", async () => {
    const res = await create(bob, cfg({ headersSecret: 'otlp' }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('tenant-b.');
  });

  it('has no test endpoint', async () => {
    const id = (await create(undefined)).json().id as string;
    const res = await n.req({ method: 'POST', url: `/v1/connections/${id}/test`, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('what a config may contain', () => {
  it.each([
    ['unknown key', { headers: { Authorization: 'Bearer x' } }],
    ['plain header value as a key', { Authorization: 'Bearer x' }],
    ['bad protocol', { protocol: 'grpc' }],
    ['bad clearance', { clearance: 'secret' }],
    ['bad content mode', { content: 'full' }],
    ['uppercase region', { region: 'EU' }],
    ['empty secret reference', { headersSecret: '' }],
  ])('refuses %s', async (_name, over) => {
    expect((await create(undefined, cfg(over))).statusCode).toBe(400);
  });

  it.each([
    ['http scheme', 'http://otel.tenant.example'],
    ['credentials', 'https://user:pw@otel.tenant.example'],
    ['query', 'https://otel.tenant.example/?x=1'],
    ['fragment', 'https://otel.tenant.example/#x'],
    ['empty query marker', 'https://otel.tenant.example/?'],
    ['not a url', 'otel.tenant.example'],
  ])('refuses an endpoint with %s', async (_name, endpoint) => {
    expect((await create(undefined, { endpoint })).statusCode).toBe(400);
  });

  it.each([
    'https://127.0.0.1',
    'https://localhost',
    'https://[::1]',
    'https://169.254.169.254',
    'https://metadata.google.internal',
    'https://2130706433',
    'https://0x7f.0.0.1',
    'https://0177.0.0.1',
    'https://10.1.2.3',
    'https://192.168.1.10:4318',
    'https://[fd00::1]',
  ])('refuses the non-public destination %s (422 egress_denied)', async (endpoint) => {
    const res = await create(undefined, { endpoint });
    expect(res.statusCode, endpoint).toBe(422);
    expect(res.json().error).toBe('egress_denied');
  });

  it('accepts a public name, a public IP literal and a port', async () => {
    for (const endpoint of [
      'https://otel.tenant.example:4318',
      'https://8.8.4.4',
      'https://otel.tenant.example/some/prefix',
    ])
      expect((await create(undefined, { endpoint })).statusCode, endpoint).toBe(201);
  });
});

describe('operator switches', () => {
  it('tenant exporters are denied by default', async () => {
    const off = await testNode({}, { secrets });
    try {
      const res = await off.req({
        method: 'POST',
        url: '/v1/connections',
        payload: { name: 'tel', kind: 'telemetry', config: cfg() },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('telemetry_exporters_disabled');
    } finally {
      await off.close();
    }
  });

  it('content needs the operator allow: stored off is fine, redacted is refused', async () => {
    const noContent = await testNode({ OAX_OTEL_TENANT_EXPORTERS: 'allow' }, { secrets });
    try {
      const post = (config: unknown) =>
        noContent.req({
          method: 'POST',
          url: '/v1/connections',
          payload: { name: `tel-${++seq}`, kind: 'telemetry', config },
        });
      expect((await post(cfg())).statusCode).toBe(201);
      const res = await post(cfg({ content: 'redacted' }));
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('telemetry_content_disabled');
    } finally {
      await noContent.close();
    }
  });

  it('the platform refuses to start with content on and no tenant exporters', async () => {
    await expect(testNode({ OAX_OTEL_CONTENT: 'redacted' })).rejects.toThrow(
      /OAX_OTEL_TENANT_EXPORTERS=allow/,
    );
  });

  it('regions: a list restricts the exporters, an empty list does not', async () => {
    const eu = await testNode({ ...ENV, OAX_OTEL_ALLOWED_REGIONS: 'eu,on-prem' }, { secrets });
    try {
      const post = (config: unknown) =>
        eu.req({
          method: 'POST',
          url: '/v1/connections',
          payload: { name: `tel-${++seq}`, kind: 'telemetry', config },
        });
      for (const bad of [cfg(), cfg({ region: 'us' })]) {
        const res = await post(bad);
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toBe('region_not_allowed');
      }
      expect((await post(cfg({ region: 'eu' }))).statusCode).toBe(201);
      expect((await post(cfg({ region: 'on-prem', content: 'redacted' }))).statusCode).toBe(201);
    } finally {
      await eu.close();
    }
  });
});

describe('air-gapped mode', () => {
  // The air-gap policy is process-wide: switch it off again for the tests that follow.
  afterEach(() => deactivateAirgap());

  it('refuses an endpoint outside OAX_AIRGAPPED_ALLOW and accepts one on it', async () => {
    const air = await testNode(
      { ...ENV, OAX_AIRGAPPED: 'true', OAX_AIRGAPPED_ALLOW: 'otel.internal.example' },
      { secrets },
    );
    try {
      const post = (endpoint: string) =>
        air.req({
          method: 'POST',
          url: '/v1/connections',
          payload: { name: `tel-${++seq}`, kind: 'telemetry', config: { endpoint } },
        });
      const bad = await post('https://otel.vendor.example');
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error).toBe('egress_denied');
      expect((await post('https://otel.internal.example')).statusCode).toBe(201);
    } finally {
      await air.close();
    }
  }, 120_000);
});

describe('audit', () => {
  const audits = async (action: string) =>
    (await n.ctx.db.select().from(auditLog).where(eq(auditLog.action, action))).map((r) => ({
      ...r,
      payload: r.payload as Record<string, unknown>,
    }));

  it('records every content opt-in and opt-out, with names and classes only', async () => {
    const before = (await audits('telemetry.content_enabled')).length;
    const beforeOff = (await audits('telemetry.content_disabled')).length;
    const on = cfg({
      endpoint: 'https://otel.tenant.example/secret-path',
      headersSecret: 'otlp',
      content: 'redacted',
      region: 'eu',
      clearance: 'confidential',
    });
    const res = await create(undefined, on);
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    let enabled = await audits('telemetry.content_enabled');
    expect(enabled).toHaveLength(before + 1);
    const entry = enabled.at(-1)!;
    expect(entry.target).toBe(id);
    expect(entry.payload).toMatchObject({
      clearance: 'confidential',
      region: 'eu',
      host: 'otel.tenant.example',
    });
    const text = JSON.stringify(entry.payload);
    for (const never of ['secret-path', 'otlp', 'SECRET-VALUE', 'Authorization'])
      expect(text).not.toContain(never);

    const put = (config: unknown) =>
      n.req({ method: 'PUT', url: `/v1/connections/${id}`, payload: { config } });
    // Saved unchanged: no new opt-in.
    expect((await put(on)).statusCode).toBe(200);
    expect(await audits('telemetry.content_enabled')).toHaveLength(before + 1);
    // Another destination or clearance is a new opt-in.
    expect((await put({ ...on, endpoint: 'https://other.tenant.example' })).statusCode).toBe(200);
    expect(
      (await put({ ...on, endpoint: 'https://other.tenant.example', clearance: 'internal' }))
        .statusCode,
    ).toBe(200);
    enabled = await audits('telemetry.content_enabled');
    expect(enabled).toHaveLength(before + 3);
    // Off, then on again, then disabled as a whole.
    expect((await put({ ...on, content: 'off' })).statusCode).toBe(200);
    expect((await audits('telemetry.content_disabled')).length).toBe(beforeOff + 1);
    expect((await put(on)).statusCode).toBe(200);
    expect((await put({ ...on, enabled: false })).statusCode).toBe(200);
    expect((await audits('telemetry.content_disabled')).length).toBe(beforeOff + 2);
    expect((await put(on)).statusCode).toBe(200);
    // Delete while on is an opt-out too.
    expect((await n.req({ method: 'DELETE', url: `/v1/connections/${id}` })).statusCode).toBe(204);
    expect((await audits('telemetry.content_disabled')).length).toBe(beforeOff + 3);
  });

  it('a connection without content opt-in writes no content event', async () => {
    const before = (await audits('telemetry.content_enabled')).length;
    expect((await create(undefined)).statusCode).toBe(201);
    expect(await audits('telemetry.content_enabled')).toHaveLength(before);
  });

  it('a refused change (CAS or rules) writes no opt-in entry', async () => {
    const id = (await create(undefined)).json().id as string;
    const before = (await audits('telemetry.content_enabled')).length;
    const res = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: { config: cfg({ endpoint: 'https://127.0.0.1', content: 'redacted' }) },
    });
    expect(res.statusCode).toBe(422);
    expect(await audits('telemetry.content_enabled')).toHaveLength(before);
    const [row] = await n.ctx.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id)));
    expect((row!.config as { content: string }).content).toBe('off');
  });
});
