import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CVE_TRIAGE, JIRA_EVENT, TICKET_UPDATER, TRIVY_EVENT, agentSource } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

let n: TestNode;
let teamSec: string;
let engineer: string;
let otherEngineer: string;

beforeAll(async () => {
  n = await testNode();
  teamSec = (
    await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-security', name: 'Security' },
    })
  ).json().id;
  const teamOps = (
    await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } })
  ).json().id;
  const mk = async (email: string) =>
    (
      await n.req({
        method: 'POST',
        url: '/v1/users',
        payload: { email, displayName: email, password: 'long-password-1' },
      })
    ).json().id as string;
  const e1 = await mk('sec-eng@example.com');
  const e2 = await mk('ops-eng@example.com');
  await n.req({
    method: 'PUT',
    url: `/v1/teams/${teamSec}/members`,
    payload: { members: [{ userId: e1, role: 'agent-engineer' }] },
  });
  await n.req({
    method: 'PUT',
    url: `/v1/teams/${teamOps}/members`,
    payload: { members: [{ userId: e2, role: 'agent-engineer' }] },
  });
  engineer = await n.login('sec-eng@example.com', 'long-password-1');
  otherEngineer = await n.login('ops-eng@example.com', 'long-password-1');
});
afterAll(async () => n.close());

describe('agent registry', () => {
  it('validates sources without storing them', async () => {
    const ok = (
      await n.req({ method: 'POST', url: '/v1/agents/validate', payload: { source: CVE_TRIAGE } })
    ).json();
    expect(ok).toMatchObject({ valid: true, name: 'cve-triage', version: '1.0.0' });
    expect(ok.definition.pipeline).toEqual(['triage', 'notify']);
    const bad = (
      await n.req({
        method: 'POST',
        url: '/v1/agents/validate',
        payload: { source: 'no front matter' },
      })
    ).json();
    expect(bad).toMatchObject({ valid: false, name: null, definition: null });
  });

  it('creates, drafts, publishes immutable versions and lists them', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      token: engineer,
      payload: { source: CVE_TRIAGE },
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    expect(agent).toMatchObject({ name: 'cve-triage', teamId: teamSec, latestVersion: null });
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/agents',
          token: engineer,
          payload: { source: CVE_TRIAGE },
        })
      ).statusCode,
    ).toBe(409);

    const pub = await n.req({
      method: 'POST',
      url: `/v1/agents/${agent.id}/publish`,
      token: engineer,
    });
    expect(pub.statusCode).toBe(201);
    expect(pub.json().version.version).toBe('1.0.0');
    const again = await n.req({
      method: 'POST',
      url: `/v1/agents/${agent.id}/publish`,
      token: engineer,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);

    const changed = CVE_TRIAGE.replace(
      'Triage a container image CVE finding',
      'Triage CVE findings',
    );
    expect(
      (
        await n.req({
          method: 'PUT',
          url: `/v1/agents/${agent.id}/draft`,
          token: engineer,
          payload: { source: changed },
        })
      ).statusCode,
    ).toBe(200);
    const conflict = await n.req({
      method: 'POST',
      url: `/v1/agents/${agent.id}/publish`,
      token: engineer,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('version_immutable');

    await n.req({
      method: 'PUT',
      url: `/v1/agents/${agent.id}/draft`,
      token: engineer,
      payload: { source: changed.replace('version: 1.0.0', 'version: 1.1.0') },
    });
    expect(
      (await n.req({ method: 'POST', url: `/v1/agents/${agent.id}/publish`, token: engineer }))
        .statusCode,
    ).toBe(201);
    await n.req({
      method: 'PUT',
      url: `/v1/agents/${agent.id}/draft`,
      token: engineer,
      payload: { source: changed.replace('version: 1.0.0', 'version: 0.9.0') },
    });
    expect(
      (
        await n.req({ method: 'POST', url: `/v1/agents/${agent.id}/publish`, token: engineer })
      ).json().error,
    ).toBe('version_not_increasing');

    const versions = (await n.req({ method: 'GET', url: `/v1/agents/${agent.id}/versions` })).json()
      .items;
    expect(versions.map((v: { version: string }) => v.version)).toEqual(['1.1.0', '1.0.0']);
    const v1 = (
      await n.req({ method: 'GET', url: `/v1/agents/${agent.id}/versions/1.0.0` })
    ).json();
    expect(v1.source).toBe(CVE_TRIAGE);
    expect(v1.definition.name).toBe('cve-triage');
    expect(
      (await n.req({ method: 'GET', url: `/v1/agents/${agent.id}/versions/9.9.9` })).statusCode,
    ).toBe(404);
    const detail = (await n.req({ method: 'GET', url: `/v1/agents/${agent.id}` })).json();
    expect(detail).toMatchObject({ latestVersion: '1.1.0' });
  });

  it('rejects renames and invalid drafts', async () => {
    const [agent] = (await n.req({ method: 'GET', url: '/v1/agents' })).json().items;
    const renamed = await n.req({
      method: 'PUT',
      url: `/v1/agents/${agent.id}/draft`,
      token: engineer,
      payload: { source: CVE_TRIAGE.replace('name: cve-triage', 'name: other') },
    });
    expect(renamed.statusCode).toBe(400);
    const invalid = await n.req({
      method: 'PUT',
      url: `/v1/agents/${agent.id}/draft`,
      token: engineer,
      payload: { source: 'x' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('validation_failed');
  });

  it('scopes agents by team', async () => {
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/agents',
          token: otherEngineer,
          payload: { source: agentSource('sec-only') },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/agents',
          token: otherEngineer,
          payload: { source: agentSource('ops-agent', 'team-ops') },
        })
      ).statusCode,
    ).toBe(201);
    const opsView = (await n.req({ method: 'GET', url: '/v1/agents', token: otherEngineer }))
      .json()
      .items.map((a: { name: string }) => a.name);
    expect(opsView).toEqual(['ops-agent']);
    const [secAgent] = (await n.req({ method: 'GET', url: '/v1/agents', token: engineer })).json()
      .items;
    expect(
      (await n.req({ method: 'GET', url: `/v1/agents/${secAgent.id}`, token: otherEngineer }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await n.req({
          method: 'POST',
          url: `/v1/agents/${secAgent.id}/publish`,
          token: otherEngineer,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await n.req({ method: 'GET', url: '/v1/agents/00000000-0000-4000-8000-000000000000' }))
        .statusCode,
    ).toBe(404);
  });

  it('paginates with keyset cursors', async () => {
    for (let i = 0; i < 3; i++)
      await n.req({
        method: 'POST',
        url: '/v1/agents',
        payload: { source: agentSource(`bulk-${i}`, 'team-ops') },
      });
    const first = (await n.req({ method: 'GET', url: '/v1/agents?limit=2' })).json();
    expect(first.items).toHaveLength(2);
    const second = (
      await n.req({ method: 'GET', url: `/v1/agents?limit=2&cursor=${first.nextCursor}` })
    ).json();
    expect(second.items).toHaveLength(2);
    expect(second.items[0].id).not.toBe(first.items[1].id);
    expect((await n.req({ method: 'GET', url: '/v1/agents?cursor=bogus' })).statusCode).toBe(400);
    const found = (await n.req({ method: 'GET', url: '/v1/agents?q=bulk-1' }))
      .json()
      .items.map((a: { name: string }) => a.name);
    expect(found).toEqual(['bulk-1']);
    expect((await n.req({ method: 'GET', url: '/v1/agents?q=%25' })).json().items).toEqual([]);
  });

  it('triggers manual runs only for published agents', async () => {
    const draftOnly = (
      await n.req({
        method: 'POST',
        url: '/v1/agents',
        payload: { source: agentSource('draft-only', 'team-ops') },
      })
    ).json();
    expect(
      (
        await n.req({
          method: 'POST',
          url: `/v1/agents/${draftOnly.id}/runs`,
          payload: { data: {} },
        })
      ).statusCode,
    ).toBe(409);
    const [secAgent] = (await n.req({ method: 'GET', url: '/v1/agents', token: engineer })).json()
      .items;
    const run = await n.req({
      method: 'POST',
      url: `/v1/agents/${secAgent.id}/runs`,
      token: engineer,
      payload: { data: { image: 'x' }, version: '1.0.0' },
    });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({
      status: 'queued',
      triggeredBy: expect.stringMatching(/^manual:/),
    });
    const ce = await n.req({
      method: 'POST',
      url: `/v1/agents/${secAgent.id}/runs`,
      token: engineer,
      payload: { data: { specversion: '1.0', id: 'e1', source: '/x', type: 't' } },
    });
    expect(ce.statusCode).toBe(202);
  });
});

describe('runtime constraints at publish', () => {
  it('rejects disabled runners and toolboxes outside the allowlist', async () => {
    const strict = await testNode({ OAX_TOOLBOX_ALLOWLIST: 'git+node' });
    await strict.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-ops', name: 'Ops' },
    });
    const mk = async (name: string, runtime: string) =>
      (
        await strict.req({
          method: 'POST',
          url: '/v1/agents',
          payload: { source: agentSource(name, 'team-ops', '1.0.0', runtime) },
        })
      ).json().id as string;
    const toolbox = await mk('tb', 'runtime: { toolbox: trivy }');
    const res = await strict.req({ method: 'POST', url: `/v1/agents/${toolbox}/publish` });
    expect(res.statusCode).toBe(400);
    expect(res.json().details[0].message).toMatch(/OAX_TOOLBOX_ALLOWLIST/);
    const runner = await mk('rn', 'runtime: { runner: kubernetes-job, toolbox: git+node }');
    expect(
      (await strict.req({ method: 'POST', url: `/v1/agents/${runner}/publish` })).json().details[0]
        .message,
    ).toMatch(/not enabled/);
    const ok = await mk('ok', 'runtime: { toolbox: git+node }');
    expect((await strict.req({ method: 'POST', url: `/v1/agents/${ok}/publish` })).statusCode).toBe(
      201,
    );
    await strict.close();
  });
});

describe('dry run', () => {
  it('runs a draft with the simulated provider and policy gate without side effects', async () => {
    const node = await testNode();
    await node.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-security', name: 'Security' },
    });
    await node.req({
      method: 'POST',
      url: '/v1/policies',
      payload: { name: 'p', bundle: { forbiddenTools: ['*/delete_*'] } },
    });
    const id = (
      await node.req({ method: 'POST', url: '/v1/agents', payload: { source: CVE_TRIAGE } })
    ).json().id;
    const res = await node.req({
      method: 'POST',
      url: `/v1/agents/${id}/dry-run`,
      payload: { data: TRIVY_EVENT },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'succeeded', auditValid: true, error: null });
    expect(
      body.steps
        .filter((s: { kind: string }) => s.kind === 'tool_call')
        .every((s: { output: { text: string } }) => s.output.text.includes('"dryRun":true')),
    ).toBe(true);
    expect((await node.req({ method: 'GET', url: '/v1/runs' })).json().items).toEqual([]);
    const denied = await node.req({
      method: 'POST',
      url: `/v1/agents/${id}/dry-run`,
      payload: { approve: 'none', source: TICKET_UPDATER, data: JIRA_EVENT },
    });
    expect(denied.json().status).toBe('succeeded');
    expect(
      denied.json().steps.map((s: { kind: string; status: string }) => `${s.kind}:${s.status}`),
    ).toContain('approval:rejected');
    await node.close();
  });
});

describe('agent-scoped role bindings', () => {
  it('limits a user to the agents bound to them (lists filter, direct access 404, denial audited)', async () => {
    const node = await testNode();
    await node.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-ops', name: 'Ops' },
    });
    const ids: string[] = [];
    for (const name of ['one', 'two', 'three']) {
      const id = (
        await node.req({
          method: 'POST',
          url: '/v1/agents',
          payload: { source: agentSource(name, 'team-ops') },
        })
      ).json().id as string;
      await node.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
      await node.req({ method: 'POST', url: `/v1/agents/${id}/runs`, payload: { data: {} } });
      ids.push(id);
    }
    const userId = (
      await node.req({
        method: 'POST',
        url: '/v1/users',
        payload: { email: 'a@example.org', displayName: 'A', password: 'agent-scoped-pw' },
      })
    ).json().id;
    expect(
      (
        await node.req({
          method: 'PUT',
          url: `/v1/agents/${ids[0]}/members`,
          payload: { members: [{ userId, role: 'agent-engineer' }] },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await node.req({ method: 'GET', url: `/v1/agents/${ids[0]}/members` })).json().items,
    ).toEqual([{ userId, email: 'a@example.org', displayName: 'A', role: 'agent-engineer' }]);
    const a = await node.login('a@example.org', 'agent-scoped-pw');
    expect(
      (await node.req({ method: 'GET', url: '/v1/agents', token: a }))
        .json()
        .items.map((x: { name: string }) => x.name),
    ).toEqual(['one']);
    expect(
      (await node.req({ method: 'GET', url: `/v1/agents/${ids[0]}`, token: a })).statusCode,
    ).toBe(200);
    expect(
      (await node.req({ method: 'GET', url: `/v1/agents/${ids[2]}`, token: a })).statusCode,
    ).toBe(404);
    expect(
      (await node.req({ method: 'POST', url: `/v1/agents/${ids[2]}/publish`, token: a }))
        .statusCode,
    ).toBe(404);
    expect(
      (await node.req({ method: 'POST', url: `/v1/agents/${ids[0]}/publish`, token: a }))
        .statusCode,
    ).toBe(200);
    const runs = (await node.req({ method: 'GET', url: '/v1/runs', token: a })).json().items;
    expect(runs.map((r: { agentId: string }) => r.agentId)).toEqual([ids[0]]);
    const other = (await node.req({ method: 'GET', url: `/v1/runs?agentId=${ids[1]}` })).json()
      .items[0];
    expect(
      (await node.req({ method: 'GET', url: `/v1/runs/${other.id}`, token: a })).statusCode,
    ).toBe(404);
    expect((await node.req({ method: 'GET', url: '/v1/stats/runs', token: a })).json().total).toBe(
      1,
    );
    expect(
      (await node.req({ method: 'GET', url: '/v1/approvals', token: a })).json().items,
    ).toEqual([]);
    expect((await node.req({ method: 'GET', url: '/v1/costs/summary', token: a })).statusCode).toBe(
      200,
    );
    const denied = (await node.req({ method: 'GET', url: '/v1/audit?action=access.denied' })).json()
      .items;
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(
      (await node.req({ method: 'GET', url: `/v1/agents/${ids[2]}/members`, token: a })).statusCode,
    ).toBe(404);
    await node.close();
  });
});
