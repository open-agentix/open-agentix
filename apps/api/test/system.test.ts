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
      checks: { database: true },
    });
    expect((await n.req({ method: 'GET', url: '/v1/version', token: null })).json()).toMatchObject({
      name: 'openagentix',
    });
    const settings = (await n.req({ method: 'GET', url: '/v1/settings' })).json();
    expect(settings).toMatchObject({
      providers: [{ name: 'simulated', kind: 'simulated' }],
      auth: { local: true, ldap: false, oidc: false },
    });
    expect((await n.req({ method: 'GET', url: '/v1/settings', token: null })).statusCode).toBe(401);
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
