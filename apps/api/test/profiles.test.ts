import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentVersions, agents, runs } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';

let n: TestNode;

const JIRA = {
  transport: 'in-memory',
  tools: {
    get_issue: { access: 'read' },
    search_issues: { access: 'read' },
    create_issue: { access: 'write' },
  },
  profiles: {
    read: ['get_issue', 'search_issues'],
    write: ['create_issue'],
    triage: ['get_issue', 'create_issue'],
  },
};

const source = (name: string, tools: string, access = 'read-only', version = '1.0.0') => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: ${version}
owner: team-security
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Work.
    ${access ? `access: ${access}` : ''}
    tools:
${tools}
    simulation:
      responses:
        - text: done
---
Work.
`;

const READ = '      - { server: jira, profile: read }';

async function create(name: string, tools: string, access?: string) {
  const res = await n.req({
    method: 'POST',
    url: '/v1/agents',
    payload: { source: source(name, tools, access) },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}
const publish = (id: string) => n.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
const audit = async (action: string) =>
  (await n.req({ method: 'GET', url: `/v1/audit?action=${action}` })).json().items as {
    payload: Record<string, unknown>;
  }[];

let jiraId: string;
beforeAll(async () => {
  n = await testNode();
  await n.req({
    method: 'POST',
    url: '/v1/teams',
    payload: { slug: 'team-security', name: 'Security' },
  });
  const res = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: { name: 'jira', config: JIRA },
  });
  expect(res.statusCode).toBe(201);
  jiraId = res.json().id;
});
afterAll(async () => n.close());

describe('connection profiles (storage)', () => {
  it('stores tool classes and profiles in the connection config', async () => {
    const c = (await n.req({ method: 'GET', url: `/v1/connections/${jiraId}` })).json();
    expect(c.config.tools.create_issue).toEqual({ access: 'write' });
    expect(c.config.profiles.read).toEqual(['get_issue', 'search_issues']);
  });

  it('refuses unknown tools in a profile on create and on update', async () => {
    const bad = {
      ...JIRA,
      profiles: { read: ['get_issue', 'ghost'] },
    };
    const created = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: { name: 'bad', config: bad },
    });
    expect(created.statusCode).toBe(400);
    expect(JSON.stringify(created.json())).toContain('unknown tool');
    const updated = await n.req({
      method: 'PUT',
      url: `/v1/connections/${jiraId}`,
      payload: { config: bad },
    });
    expect(updated.statusCode).toBe(400);
    const escalated = await n.req({
      method: 'PUT',
      url: `/v1/connections/${jiraId}`,
      payload: { config: { ...JIRA, profiles: { read: ['get_issue', 'create_issue'] } } },
    });
    expect(escalated.statusCode).toBe(400);
    expect(JSON.stringify(escalated.json())).toContain('must not contain write tool');
  });
});

describe('publish expansion', () => {
  it('expands a profile grant into the immutable version and audits it', async () => {
    const id = await create('expand-read', READ);
    const pub = await publish(id);
    expect(pub.statusCode).toBe(201);
    const v = (await n.req({ method: 'GET', url: `/v1/agents/${id}/versions/1.0.0` })).json();
    const tools = v.definition.agents[0].tools as { server: string; tool: string }[];
    expect(tools.map((t) => t.tool)).toEqual(['get_issue', 'search_issues']);
    expect(v.definition.expansion).toMatchObject([
      { agentId: 'a', server: 'jira', profile: 'read', tools: ['get_issue', 'search_issues'] },
    ]);
    expect(v.definition.expansionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(v.definition.toolAccess['jira/create_issue']).toBe('write');
    const entry = (await audit('agent.profiles.expanded')).find(
      (e) => (e.payload as { version?: string }).version === '1.0.0',
    );
    expect(entry?.payload.expansionDigest).toBe(v.definition.expansionDigest);
  });

  it('a later profile edit never changes a published version', async () => {
    const id = await create('expand-frozen', READ);
    await publish(id);
    const before = (await n.req({ method: 'GET', url: `/v1/agents/${id}/versions/1.0.0` })).json();
    const widened = {
      ...JIRA,
      tools: { ...JIRA.tools, delete_issue: { access: 'write' } },
      profiles: { ...JIRA.profiles, read: ['get_issue', 'search_issues'], extra: ['delete_issue'] },
    };
    expect(
      (
        await n.req({
          method: 'PUT',
          url: `/v1/connections/${jiraId}`,
          payload: { config: widened },
        })
      ).statusCode,
    ).toBe(200);
    expect((await publish(id)).statusCode).toBe(200); // idempotent: same content, nothing re-expanded
    const after = (await n.req({ method: 'GET', url: `/v1/agents/${id}/versions/1.0.0` })).json();
    expect(after.definition).toEqual(before.definition);
    // restore
    await n.req({ method: 'PUT', url: `/v1/connections/${jiraId}`, payload: { config: JIRA } });
  });

  it('refuses unknown profile and unknown connection at publish, with a clear error', async () => {
    const id = await create('unknown-profile', '      - { server: jira, profile: admin }', '');
    const res = await publish(id);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(
      'connection \\"jira\\" has no profile \\"admin\\"',
    );
    const id2 = await create('unknown-conn', '      - { server: nowhere, profile: read }', '');
    expect(JSON.stringify((await publish(id2)).json())).toContain(
      'connection \\"nowhere\\" is unknown',
    );
    const denied = await audit('agent.publish.denied');
    expect(denied.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses write tools for read-only steps (profile, direct, wildcard) at publish', async () => {
    for (const [name, tools] of [
      ['ro-profile-write', '      - { server: jira, profile: write }'],
      ['ro-profile-triage', '      - { server: jira, profile: triage }'],
      ['ro-direct', '      - { server: jira, tool: create_issue }'],
      ['ro-wildcard', '      - { server: jira, tool: "*" }'],
      ['ro-undeclared', '      - { server: jira, tool: made_up }'],
    ] as const) {
      const res = await publish(await create(name, tools));
      expect(res.statusCode, name).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }
    // write access (or none declared) may use write tools
    expect(
      (await publish(await create('w-ok', '      - { server: jira, profile: triage }', 'write')))
        .statusCode,
    ).toBe(201);
    expect(
      (await publish(await create('n-ok', '      - { server: jira, profile: triage }', '')))
        .statusCode,
    ).toBe(201);
  });

  it('reports the same errors from the validate endpoint', async () => {
    const res = (
      await n.req({
        method: 'POST',
        url: '/v1/agents/validate',
        payload: { source: source('v1', '      - { server: jira, profile: write }') },
      })
    ).json();
    expect(res.valid).toBe(false);
    expect(JSON.stringify(res.errors)).toContain('must not receive write tool');
    const ok = (
      await n.req({
        method: 'POST',
        url: '/v1/agents/validate',
        payload: { source: source('v2', READ) },
      })
    ).json();
    expect(ok.valid).toBe(true);
  });

  it('dry-runs a draft with the profile expanded and refuses bad grants', async () => {
    const id = await create('dry-ok', READ);
    const ok = await n.req({
      method: 'POST',
      url: `/v1/agents/${id}/dry-run`,
      payload: { data: {} },
    });
    expect(ok.statusCode).toBe(200);
    const bad = await create('dry-bad', '      - { server: jira, profile: write }');
    expect(
      (await n.req({ method: 'POST', url: `/v1/agents/${bad}/dry-run`, payload: { data: {} } }))
        .statusCode,
    ).toBe(400);
  });

  it('evaluates the gate dry-run against the expansion', async () => {
    const evalCall = (tool: string, src: string) =>
      n.req({
        method: 'POST',
        url: '/v1/policies/evaluate',
        payload: { source: src, agentId: 'a', call: { server: 'jira', tool, args: {} } },
      });
    expect((await evalCall('get_issue', source('e1', READ))).json().effect).toBe('allow');
    expect((await evalCall('create_issue', source('e1', READ))).json().effect).toBe('deny');
    expect(
      (await evalCall('x', source('e2', '      - { server: jira, profile: write }'))).statusCode,
    ).toBe(400);
  });
});

describe('run-time second wall', () => {
  it('denies a write tool for a read-only agent even if it got into the stored grants', async () => {
    const id = await create('wall', READ);
    await publish(id);
    const [ver] = await n.ctx.db.select().from(agentVersions).where(eq(agentVersions.agentId, id));
    const def = ver!.definition as { agents: { tools: object[] }[] };
    def.agents[0]!.tools.push({
      server: 'jira',
      tool: 'create_issue',
      args: {},
      allowAdditionalArgs: true,
      approval: 'none',
    });
    // Forge a newer version row (the table is append-only, so only an insert is possible).
    await n.ctx.db.insert(agentVersions).values({
      id: randomUUID(),
      agentId: id,
      version: '1.0.1',
      digest: 'f'.repeat(64),
      source: ver!.source,
      definition: def as unknown as object,
    });
    const [forged] = await n.ctx.db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.digest, 'f'.repeat(64)));
    await n.ctx.db
      .update(agents)
      .set({ latestVersionId: forged!.id, latestVersion: '1.0.1' })
      .where(eq(agents.id, id));
    await n.ctx.cache.delPrefix('agent-latest:');
    const run = (
      await n.req({ method: 'POST', url: `/v1/agents/${id}/runs`, payload: { data: {} } })
    ).json().id as string;
    await n.ctx.db
      .update(runs)
      .set({
        status: 'running',
        lockedBy: 'w1',
        startedAt: new Date(),
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(runs.id, run));
    const token = n.services.control.issueToken(run, 'w1');
    const gate = async (tool: string) =>
      (
        await n.req({
          method: 'POST',
          url: `/v1/worker/runs/${run}/gate`,
          token,
          payload: { agentId: 'a', call: { server: 'jira', tool, args: {} } },
        })
      ).json();
    expect((await gate('get_issue')).effect).toBe('allow');
    const denied = await gate('create_issue');
    expect(denied.effect).toBe('deny');
    expect(denied.reasons.map((r: { code: string }) => r.code)).toEqual(['profile_write_denied']);
    const decisions = await audit('policy.decision');
    expect(JSON.stringify(decisions)).toContain('profile_write_denied');
  });
});
