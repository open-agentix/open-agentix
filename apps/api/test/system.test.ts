import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testNode, type TestNode } from './helpers.js';

let n: TestNode;
beforeAll(async () => {
  n = await testNode({
    OAX_METRICS_TOKEN: 'metrics-secret',
    OAX_CORS_ORIGINS: 'https://ui.example.com',
  });
});
afterAll(async () => n.close());

describe('system endpoints', () => {
  it('health, readiness, version and settings', async () => {
    expect((await n.req({ method: 'GET', url: '/healthz', token: null })).json()).toEqual({
      status: 'ok',
    });
    expect((await n.req({ method: 'GET', url: '/readyz', token: null })).json()).toEqual({
      status: 'ok',
      checks: { database: true, schema: true },
      schema: { expected: 15, applied: 15, ok: true },
      airgapped: { enabled: false, allowlist: 0, blockedAttempts: 0 },
    });
    expect((await n.req({ method: 'GET', url: '/v1/version', token: null })).json()).toMatchObject({
      name: 'openagentix',
    });
    const settings = (await n.req({ method: 'GET', url: '/v1/settings' })).json();
    expect(settings).toMatchObject({
      providers: [{ name: 'simulated', kind: 'simulated' }],
      auth: { local: true, ldap: false, oidc: false },
    });
    expect(settings.rolePermissions.viewer).toEqual([
      'agents:read',
      'runs:read',
      'events:read',
      'costs:read',
    ]);
    expect(settings.rolePermissions.admin).toContain('settings:write');
    expect((await n.req({ method: 'GET', url: '/v1/settings', token: null })).statusCode).toBe(401);
  });

  it('reports not ready when the database is down or the schema is behind', async () => {
    const ping = n.ctx.database.ping;
    const status = n.ctx.database.schemaStatus;
    n.ctx.database.schemaStatus = async () => ({ expected: 8, applied: 2, ok: false });
    const behind = await n.req({ method: 'GET', url: '/readyz', token: null });
    expect(behind.statusCode).toBe(503);
    expect(behind.json().checks).toEqual({ database: true, schema: false });
    n.ctx.database.ping = async () => {
      throw new Error('down');
    };
    expect((await n.req({ method: 'GET', url: '/readyz', token: null })).json().checks).toEqual({
      database: false,
      schema: false,
    });
    n.ctx.database.ping = ping;
    n.ctx.database.schemaStatus = status;
  });

  it('protects metrics with a token', async () => {
    expect((await n.req({ method: 'GET', url: '/metrics', token: null })).statusCode).toBe(401);
    const res = await n.req({ method: 'GET', url: '/metrics', token: 'metrics-secret' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('oax_http_request_duration_seconds');
  });

  it('serves the OpenAPI document', async () => {
    const doc = (await n.req({ method: 'GET', url: '/openapi.json', token: null })).json();
    expect(doc.openapi).toBe('3.1.0');
  });

  it('sets security headers, request ids and CORS', async () => {
    const res = await n.req({
      method: 'GET',
      url: '/v1/version',
      token: null,
      headers: { 'x-request-id': 'req-123', origin: 'https://ui.example.com' },
    });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['access-control-allow-origin']).toBe('https://ui.example.com');
    const other = await n.req({
      method: 'GET',
      url: '/v1/version',
      token: null,
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('supports ETag / If-None-Match and compression', async () => {
    const first = await n.req({ method: 'GET', url: '/v1/settings' });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    const second = await n.req({
      method: 'GET',
      url: '/v1/settings',
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
    const gz = await n.req({
      method: 'GET',
      url: '/openapi.json',
      token: null,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(gz.headers['content-encoding']).toBe('gzip');
  });

  it('maps errors: 404 for unknown routes, 400 for validation', async () => {
    expect((await n.req({ method: 'GET', url: '/v1/nope' })).statusCode).toBe(404);
    const bad = await n.req({ method: 'GET', url: '/v1/runs?limit=0' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('validation_failed');
  });
});

describe('model catalog endpoint', () => {
  it('lists the pinned snapshot with overrides', async () => {
    const node = await testNode({
      OAX_PRICE_TABLE: JSON.stringify([
        { provider: 'anthropic', model: 'claude-haiku-4-5', inputPerMTok: 0.5, outputPerMTok: 2 },
      ]),
    });
    const res = (await node.req({ method: 'GET', url: '/v1/models' })).json();
    expect(res.source).toBeTruthy();
    expect(res.items.find((m: { id: string }) => m.id === 'claude-haiku-4-5')).toMatchObject({
      inputPerMTok: 0.5,
      source: 'override',
    });
    expect(
      node.ctx.costModel.modelCall('anthropic', 'claude-opus-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
      }).totalMicros,
    ).toBe(4_000_000);
    await node.close();
  });
});
