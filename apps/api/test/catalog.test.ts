import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CVE_TRIAGE } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

let n: TestNode;
beforeAll(async () => {
  n = await testNode();
});
afterAll(async () => n.close());

describe('connections', () => {
  it('manages MCP connections with secret references only', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'jira',
        config: {
          transport: 'streamable-http',
          url: 'https://mcp.example.com/jira',
          headerSecrets: { authorization: 'jira-token' },
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const c = created.json();
    expect(c.config).toMatchObject({
      name: 'jira',
      transport: 'streamable-http',
      timeoutMs: 30000,
    });
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/connections',
          payload: { name: 'jira', config: { transport: 'in-memory' } },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/connections',
          payload: { name: 'bad', config: { transport: 'stdio' } },
        })
      ).statusCode,
    ).toBe(400);
    const updated = await n.req({
      method: 'PUT',
      url: `/v1/connections/${c.id}`,
      payload: { config: { transport: 'in-memory', timeoutMs: 5000 } },
    });
    expect(updated.json().config).toMatchObject({
      transport: 'in-memory',
      timeoutMs: 5000,
      name: 'jira',
    });
    expect((await n.services.catalog.mcpConfigs()).map((m) => m.name)).toEqual(['jira']);
    expect((await n.req({ method: 'GET', url: '/v1/connections' })).json().items).toHaveLength(1);
    expect((await n.req({ method: 'GET', url: `/v1/connections/${c.id}` })).json().name).toBe(
      'jira',
    );
    expect((await n.req({ method: 'DELETE', url: `/v1/connections/${c.id}` })).statusCode).toBe(
      204,
    );
    expect((await n.req({ method: 'DELETE', url: `/v1/connections/${c.id}` })).statusCode).toBe(
      404,
    );
    expect((await n.req({ method: 'GET', url: `/v1/connections/${c.id}` })).statusCode).toBe(404);
  });
});

describe('policies', () => {
  it('creates, versions and evaluates policy bundles', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/policies',
      payload: { name: 'baseline', bundle: { forbiddenTools: ['*/delete_*'] } },
    });
    expect(created.statusCode).toBe(201);
    const p = created.json();
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/policies',
          payload: { name: 'baseline', bundle: {} },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/policies',
          payload: { name: 'broken', bundle: { forbiddenArgPatterns: [{ pattern: '(' }] } },
        })
      ).statusCode,
    ).toBe(400);
    const deny = await n.req({
      method: 'POST',
      url: '/v1/policies/evaluate',
      payload: {
        source: CVE_TRIAGE,
        agentId: 'notify',
        call: { server: 'tickets', tool: 'delete_ticket', args: {} },
      },
    });
    expect(deny.json()).toMatchObject({
      effect: 'deny',
      reasons: [{ code: 'tool_forbidden' }, { code: 'tool_not_granted' }],
    });
    const allow = await n.req({
      method: 'POST',
      url: '/v1/policies/evaluate',
      payload: {
        source: CVE_TRIAGE,
        agentId: 'triage',
        call: { server: 'cve-db', tool: 'lookup_cve', args: { cveId: 'CVE-2024-3094' } },
      },
    });
    expect(allow.json().effect).toBe('allow');
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/policies/evaluate',
          payload: { source: CVE_TRIAGE, agentId: 'nope', call: { server: 'a', tool: 'b' } },
        })
      ).statusCode,
    ).toBe(400);
    const updated = await n.req({
      method: 'PUT',
      url: `/v1/policies/${p.id}`,
      payload: { enabled: false, description: 'off' },
    });
    expect(updated.json()).toMatchObject({ version: 2, enabled: false, description: 'off' });
    const again = await n.req({
      method: 'PUT',
      url: `/v1/policies/${p.id}`,
      payload: { bundle: { requireApprovalTools: ['x/*'] } },
    });
    expect(again.json()).toMatchObject({ version: 3, bundle: { requireApprovalTools: ['x/*'] } });
    expect(await n.services.catalog.enabledBundles()).toEqual([]);
    expect((await n.req({ method: 'GET', url: '/v1/policies' })).json().items).toHaveLength(1);
    expect((await n.req({ method: 'GET', url: `/v1/policies/${p.id}` })).json().name).toBe(
      'baseline',
    );
    expect(
      (await n.req({ method: 'GET', url: '/v1/policies/00000000-0000-4000-8000-000000000000' }))
        .statusCode,
    ).toBe(404);
  });
});
