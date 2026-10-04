import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID } from '../src/db/schema.js';
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
    expect(
      (
        await n.services.catalog.mcpConfigs({
          tenantId: DEFAULT_TENANT_ID,
          teamId: null,
          agentId: 'a',
        })
      ).map((m) => m.name),
    ).toEqual(['jira']);
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
    expect(await n.services.catalog.enabledBundles(DEFAULT_TENANT_ID)).toEqual([]);
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

describe('guidelines and hardening agent', () => {
  it('stores immutable versions, reviews changes and tightens the policy gate', async () => {
    const g = await n.req({
      method: 'POST',
      url: '/v1/guidelines',
      payload: {
        scope: 'global',
        name: 'company',
        version: '1.0.0',
        content: '# Rules',
        rules: {
          minCoverage: 80,
          conventionalCommits: true,
          requireApprovalTools: ['tickets/update_*'],
        },
      },
    });
    expect(g.statusCode).toBe(201);
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/guidelines',
          payload: { scope: 'global', name: 'company', version: '1.0.0', rules: {} },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/guidelines',
          payload: { scope: 'global', name: 'bad', version: 'one', rules: {} },
        })
      ).statusCode,
    ).toBe(400);
    await n.req({
      method: 'POST',
      url: '/v1/guidelines',
      payload: {
        scope: 'agent',
        name: 'secure-coding',
        version: '1.2.0',
        rules: { forbiddenDependencies: ['left-pad'] },
      },
    });
    await n.req({
      method: 'POST',
      url: '/v1/guidelines',
      payload: {
        scope: 'agent',
        name: 'unused',
        version: '1.0.0',
        rules: { forbiddenDependencies: ['zod'] },
      },
    });
    expect((await n.req({ method: 'GET', url: '/v1/guidelines' })).json().items).toHaveLength(3);
    await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-security', name: 'Security' },
    });
    const src = CVE_TRIAGE.replace(
      'owner: team-security',
      'owner: team-security\nguidelines: [secure-coding@1.2.0]',
    );
    const agent = (
      await n.req({ method: 'POST', url: '/v1/agents', payload: { source: src } })
    ).json();
    const review = await n.req({
      method: 'POST',
      url: '/v1/guidelines/review',
      payload: {
        agentId: agent.id,
        change: {
          addedDependencies: ['left-pad', 'zod'],
          coveragePercent: 60,
          commitMessages: ['update stuff'],
        },
      },
    });
    expect(review.json()).toMatchObject({
      passed: false,
      applied: ['global:company@1.0.0', 'agent:secure-coding@1.2.0'],
    });
    expect(review.json().findings.map((f: { rule: string }) => f.rule)).toEqual([
      'forbidden_dependency',
      'coverage',
      'conventional_commits',
    ]);
    await n.req({ method: 'POST', url: `/v1/agents/${agent.id}/publish` });
    const ok = await n.req({
      method: 'POST',
      url: '/v1/guidelines/review',
      payload: { agentId: agent.id, change: { coveragePercent: 95, commitMessages: ['fix: x'] } },
    });
    expect(ok.json().passed).toBe(true);
    const bundle = await n.services.guidelines.bundleFor({ guidelines: [] }, DEFAULT_TENANT_ID);
    expect(bundle?.requireApprovalTools).toEqual(['tickets/update_*']);
    const audit = (await n.req({ method: 'GET', url: '/v1/audit?limit=50' }))
      .json()
      .items.map((e: { action: string }) => e.action);
    expect(audit).toContain('hardening.blocked');
    expect(audit).toContain('hardening.passed');
  });
});
