import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/demo/seed.js';
import { testNode, type TestNode } from './helpers.js';

let n: TestNode;
const PW = 'demo-password-2026';

beforeAll(async () => {
  n = await testNode({ OAX_DEMO_MODE: 'true' });
});
afterAll(async () => n.close());

describe('demo seed', () => {
  it('loads tenants, users for all roles, agents, runs, approvals and costs with a valid audit chain', async () => {
    const agentsIn = async (tenant: string) =>
      (await n.req({ method: 'GET', url: '/v1/agents', headers: { 'x-oax-tenant': tenant } }))
        .json()
        .items.map((a: { name: string }) => a.name)
        .sort();
    expect(await agentsIn('default')).toEqual(['release-watch']);
    expect(await agentsIn('security')).toEqual([
      'cve-triage',
      'hardening-review',
      'ticket-updater',
    ]);
    expect(await agentsIn('platform')).toEqual(['feature-builder']);
    expect(await agentsIn('acme-labs')).toEqual(['log-summary']);
    const usersIn = async (tenant: string) =>
      (await n.req({ method: 'GET', url: '/v1/users', headers: { 'x-oax-tenant': tenant } })).json()
        .items as { email: string }[];
    const demoUsers = (
      await Promise.all(['default', 'security', 'platform', 'acme-labs'].map(usersIn))
    )
      .flat()
      .filter((u) => u.email.endsWith('@example.org'));
    expect(demoUsers).toHaveLength(8);
    const stats = (await n.req({ method: 'GET', url: '/v1/stats/runs' })).json();
    expect(stats.byStatus.succeeded).toBeGreaterThanOrEqual(1);
    const inSecurity = { 'x-oax-tenant': 'security' };
    expect(
      (await n.req({ method: 'GET', url: '/v1/approvals', headers: inSecurity })).json().items,
    ).toHaveLength(1);
    expect(
      (
        await n.req({ method: 'GET', url: '/v1/approvals?status=approved', headers: inSecurity })
      ).json().items,
    ).toHaveLength(1);
    const tenantsWithCosts = (
      await n.req({ method: 'GET', url: '/v1/costs/summary?groupBy=tenant&allTenants=true' })
    ).json().items;
    expect(tenantsWithCosts).toHaveLength(4);
    const useCases = (
      await n.req({ method: 'GET', url: '/v1/costs/summary?groupBy=use_case&allTenants=true' })
    )
      .json()
      .items.map((i: { key: string }) => i.key);
    expect(useCases).toEqual(
      expect.arrayContaining(['vulnerability-management', 'software-factory', 'operations']),
    );
    expect(
      (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json(),
    ).toMatchObject({ valid: true });
    const audit = (
      await n.req({ method: 'GET', url: '/v1/audit?limit=200&action=change_check.unchanged' })
    ).json().items;
    expect(audit).toHaveLength(1);
    const settings = (await n.req({ method: 'GET', url: '/v1/settings' })).json();
    expect(settings.demo).toBe(true);
  });

  it('enforces the agent-scoped demo user and the read-only demo mode', async () => {
    const contractor = await n.login('contractor@example.org', PW);
    const admin = await n.login('admin@example.org', PW);
    expect(
      (await n.req({ method: 'GET', url: '/v1/agents', token: admin }))
        .json()
        .items.map((a: { name: string }) => a.name)
        .sort(),
    ).toEqual(['cve-triage', 'hardening-review', 'ticket-updater']);
    expect(
      (await n.req({ method: 'GET', url: '/v1/agents', token: contractor }))
        .json()
        .items.map((a: { name: string }) => a.name),
    ).toEqual(['feature-builder']);
    const viewer = await n.login('viewer@example.org', PW);
    expect(
      (await n.req({ method: 'GET', url: '/v1/agents', token: viewer }))
        .json()
        .items.map((a: { name: string }) => a.name),
    ).toEqual(['log-summary']);
    // The second tenant is invisible to the first one's users.
    expect(
      (await n.req({ method: 'GET', url: '/v1/agents', token: contractor })).json().items,
    ).toHaveLength(1);
    const write = await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'x', name: 'X' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe('demo_read_only');
    expect(write.headers['x-oax-demo']).toBe('true');
    const [fb] = (await n.req({ method: 'GET', url: '/v1/agents', token: contractor })).json()
      .items;
    const dry = await n.req({
      method: 'POST',
      url: `/v1/agents/${fb.id}/dry-run`,
      token: contractor,
      payload: { data: { ticket: 'DEV-1', slug: 's', title: 'T' } },
    });
    expect(dry.json().status).toBe('succeeded');
  });

  it('is idempotent', async () => {
    const r = await seedDemo(n.ctx, n.services, { password: PW });
    expect(r).toMatchObject({ seeded: false, agents: 6, auditValid: true });
  });
});
