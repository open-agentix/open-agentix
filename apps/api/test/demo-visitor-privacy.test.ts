import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_UNKNOWN_LOGIN_TARGET } from '../src/services/identity.js';
import { testNode, type TestNode } from './helpers.js';

const PW = 'demo-password-2026';
// What a visitor might type into the sign-in form by mistake: a real-looking address.
const TYPED = 'Jane.Visitor@real-company.test';

let demo: TestNode;
let plain: TestNode;
let owner: string;
beforeAll(async () => {
  demo = await testNode({ OAX_DEMO_MODE: 'true' });
  plain = await testNode();
  owner = await demo.login('owner@example.org', PW);
}, 300_000);
afterAll(async () => {
  await demo.close();
  await plain.close();
});

// Every attempt from its own address: the sign-in rate limit is per client address.
let attempt = 0;
const login = (node: TestNode, username: string, password: string) =>
  node.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { username, password },
    remoteAddress: `192.0.2.${++attempt}`,
  });

describe('failed demo sign-ins in the audit log', () => {
  it('never store what a visitor typed for an unknown account', async () => {
    expect((await login(demo, TYPED, 'my-real-password')).statusCode).toBe(401);
    expect((await login(demo, 'viewer@example.org', 'wrong-password')).statusCode).toBe(401);
    // The published platform admin reads the audit log of every tenant (list and export).
    const list = await demo.req({
      method: 'GET',
      url: '/v1/audit?allTenants=true&action=auth.failed&limit=100',
      token: owner,
    });
    expect(list.statusCode).toBe(200);
    const targets = (list.json().items as { target: string }[]).map((e) => e.target);
    expect(targets).toContain(DEMO_UNKNOWN_LOGIN_TARGET);
    expect(targets).toContain('viewer@example.org');
    const exported = await demo.req({
      method: 'GET',
      url: '/v1/audit/export?allTenants=true',
      token: owner,
    });
    expect(exported.statusCode).toBe(200);
    for (const body of [list.body, exported.body]) {
      expect(body.toLowerCase()).not.toContain('jane.visitor');
      expect(body).not.toContain('real-company');
      expect(body).not.toContain('my-real-password');
    }
  });

  it('keep the attempted name outside demo mode (operators need it)', async () => {
    expect((await login(plain, TYPED, 'wrong-password')).statusCode).toBe(401);
    const list = await plain.req({
      method: 'GET',
      url: '/v1/audit?allTenants=true&action=auth.failed&limit=100',
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().items as { target: string }[]).map((e) => e.target)).toContain(
      TYPED.toLowerCase(),
    );
  });
});

describe('the read-only hook cannot be talked around', () => {
  it('ignores method-override headers and URL spelling tricks', async () => {
    const attempts: { method: 'GET' | 'POST' | 'PATCH'; url: string; headers?: object }[] = [
      // A GET does not become a write through override headers (and a POST is not a GET).
      {
        method: 'POST',
        url: '/v1/tenants',
        headers: { 'x-http-method-override': 'GET', 'x-method-override': 'GET' },
      },
      { method: 'POST', url: '/v1/tenants/' },
      { method: 'POST', url: '/V1/Tenants' },
      { method: 'POST', url: '//v1/tenants' },
      { method: 'POST', url: '/v1/%74enants' },
      { method: 'POST', url: '/v1/tenants?x=/v1/auth/login' },
      { method: 'POST', url: '/v1/auth/login/../../tenants' },
      { method: 'PATCH', url: '/v1/tenants/default;/v1/auth/login' },
    ];
    for (const a of attempts) {
      const res = await demo.req({
        method: a.method,
        url: a.url,
        token: owner,
        headers: { 'x-oax-tenant': 'default', ...a.headers },
        payload: { slug: 'evil', name: 'Evil' },
      });
      expect([403, 404], `${a.method} ${a.url} -> ${res.statusCode}`).toContain(res.statusCode);
      if (res.statusCode === 403) expect(res.json().error).toBe('demo_read_only');
    }
    // Override headers on a GET do not turn it into a write either.
    const get = await demo.req({
      method: 'GET',
      url: '/v1/tenants',
      token: owner,
      headers: { 'x-http-method-override': 'POST' },
    });
    expect(get.statusCode).toBe(200);
    const slugs = (get.json().items as { slug: string }[]).map((t) => t.slug);
    expect(slugs).not.toContain('evil');
    expect(slugs).toHaveLength(4);
  });
});
