import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CVE_TRIAGE, agentSource } from './fixtures.js';
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
    ).toBe(403);
    expect(
      (
        await n.req({
          method: 'POST',
          url: `/v1/agents/${secAgent.id}/publish`,
          token: otherEngineer,
        })
      ).statusCode,
    ).toBe(403);
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
