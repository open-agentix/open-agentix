import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderOpenApi, routeIndex } from '../src/index.js';
import { testNode, type TestNode } from './helpers.js';

let n: TestNode;
beforeAll(async () => {
  n = await testNode();
});
afterAll(async () => n.close());

const ID = '00000000-0000-4000-8000-000000000000';
const concrete = (url: string) =>
  url
    .replace(':approvalId', ID)
    .replace(':sourceId', ID)
    .replace(':version', '1.0.0')
    .replace(':id', url.startsWith('/v1/tokens') ? '0123456789abcdef' : ID);

describe('route access declarations', () => {
  it('every route declares its permission or access scheme', () => {
    const routes = routeIndex(n.app);
    expect(routes.length).toBeGreaterThan(45);
    const allowed = new Set<string>([
      ...PERMISSIONS,
      'authenticated',
      'public',
      'run-token',
      'model-token',
      'webhook',
    ]);
    for (const r of routes)
      expect(allowed.has(String(r.access)), `${r.method} ${r.url}`).toBe(true);
    const publicRoutes = routes
      .filter((r) => r.access === 'public')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(publicRoutes).toEqual([
      'GET /healthz',
      'GET /metrics',
      'GET /openapi.json',
      'GET /readyz',
      'GET /v1/auth/methods',
      'GET /v1/auth/oidc/callback',
      'GET /v1/auth/oidc/login',
      'GET /v1/version',
      'POST /v1/auth/login',
    ]);
  });

  it('rejects unauthenticated access to every protected route', async () => {
    for (const r of routeIndex(n.app)) {
      if (r.access === 'public') continue;
      const res = await n.req({
        method: r.method as 'GET',
        url: concrete(r.url),
        token: null,
        payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
      });
      // Webhook routes authenticate by signature: unknown sources are 404, bad signatures 401.
      const expected = r.access === 'webhook' ? [401, 404] : [401];
      expect(expected, `${r.method} ${r.url} -> ${res.statusCode}`).toContain(res.statusCode);
    }
  });

  it('enforces route permissions for a viewer', async () => {
    await n.req({
      method: 'POST',
      url: '/v1/users',
      payload: {
        email: 'viewer@example.com',
        displayName: 'V',
        password: 'viewer-password-1',
        globalRoles: ['viewer'],
      },
    });
    const viewer = await n.login('viewer@example.com', 'viewer-password-1');
    const denied = routeIndex(n.app).filter(
      (r) =>
        r.access !== 'public' &&
        r.access !== 'authenticated' &&
        r.access !== 'run-token' &&
        r.access !== 'model-token' &&
        r.access !== 'webhook' &&
        !['agents:read', 'runs:read', 'events:read', 'costs:read'].includes(String(r.access)),
    );
    expect(denied.length).toBeGreaterThan(20);
    for (const r of denied) {
      const res = await n.req({
        method: r.method as 'GET',
        url: concrete(r.url),
        token: viewer,
        payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
  });
});

describe('OpenAPI document', () => {
  it('matches the committed openapi.yaml (run with UPDATE_OPENAPI=1 to regenerate)', () => {
    const path = fileURLToPath(new URL('../../../openapi.yaml', import.meta.url));
    const fresh = renderOpenApi(n.app);
    if (process.env.UPDATE_OPENAPI === '1') writeFileSync(path, fresh);
    expect(readFileSync(path, 'utf8')).toBe(fresh);
    expect(fresh).toContain('openapi: 3.1.0');
  });
});

describe('OpenAPI decorations', () => {
  it('declares error responses, media types and redirects', () => {
    const doc = n.app.swagger() as unknown as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>
      >;
    };
    expect(Object.keys(doc.paths['/v1/runs/{id}/stream']!.get!.responses['200']!.content!)).toEqual(
      ['text/event-stream'],
    );
    expect(Object.keys(doc.paths['/v1/audit/export']!.get!.responses['200']!.content!)).toEqual([
      'application/x-ndjson',
    ]);
    expect(Object.keys(doc.paths['/metrics']!.get!.responses['200']!.content!)).toEqual([
      'text/plain',
    ]);
    expect(doc.paths['/v1/runs/{id}']!.get!.responses).toHaveProperty('401');
    expect(doc.paths['/v1/runs/{id}']!.get!.responses).toHaveProperty('403');
    expect(doc.paths['/v1/runs/{id}']!.get!.responses).toHaveProperty('404');
    expect(doc.paths['/v1/auth/oidc/login']!.get!.responses).toHaveProperty('302');
    expect(doc.paths['/v1/auth/oidc/login']!.get!.responses).not.toHaveProperty('200');
    expect(doc.paths['/healthz']!.get!.responses).not.toHaveProperty('401');
  });
});
