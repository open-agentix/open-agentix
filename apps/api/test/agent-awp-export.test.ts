import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jcs } from '@openagentix/core';
import { pinErrors } from '../../../packages/core/test/awp-pin.js';
import { CVE_TRIAGE, TICKET_UPDATER, agentSource, example } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

const RELEASE_NOTES = example('awp/release-notes.agents.md');
const LOG_READER = example('awp/log-reader.agents.md');

let n: TestNode;
let reader: string;
let outsider: string;

const awp = (id: string, version: string, token?: string) =>
  n.req({
    method: 'GET',
    url: `/v1/agents/${id}/versions/${version}/awp`,
    ...(token ? { token } : {}),
  });

async function publish(source: string): Promise<string> {
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source } });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
  expect(pub.statusCode).toBe(201);
  return id;
}

beforeAll(async () => {
  n = await testNode();
  const team = async (slug: string) =>
    (await n.req({ method: 'POST', url: '/v1/teams', payload: { slug, name: slug } })).json()
      .id as string;
  const [docs, , other] = [
    await team('team-docs'),
    await team('team-ops'),
    await team('team-other'),
  ];
  await team('team-security');
  const user = async (email: string, teamId: string) => {
    const id = (
      await n.req({
        method: 'POST',
        url: '/v1/users',
        payload: { email, displayName: email, password: 'long-password-1' },
      })
    ).json().id as string;
    await n.req({
      method: 'PUT',
      url: `/v1/teams/${teamId}/members`,
      payload: { members: [{ userId: id, role: 'agent-maintainer' }] },
    });
    return n.login(email, 'long-password-1');
  };
  reader = await user('docs-eng@example.com', docs);
  outsider = await user('other-eng@example.com', other);
});
afterAll(async () => n.close());

describe('GET /v1/agents/{id}/versions/{v}/awp', () => {
  it('exports a published version as an AWP manifest that the pinned schema accepts', async () => {
    const id = await publish(RELEASE_NOTES);
    const res = await awp(id, '1.0.0');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const manifest = JSON.parse(res.body) as { kind: string; metadata: { owner: unknown } };
    expect(manifest).toMatchObject({
      kind: 'Workflow',
      metadata: { owner: { team: 'team-docs' } },
    });
    expect(pinErrors(manifest, ['core'])).toEqual([]);
    expect(res.body).toBe(jcs(manifest));
    const detail = (await n.req({ method: 'GET', url: `/v1/agents/${id}/versions/1.0.0` })).json();
    expect(res.headers['x-oax-source-digest']).toBe(detail.digest);
    expect(res.headers['x-oax-export-warnings']).toBeUndefined();
  });

  it('returns the same bytes on every call', async () => {
    const id = await publish(agentSource('stable-agent', 'team-docs'));
    const first = await awp(id, '1.0.0');
    const second = await awp(id, '1.0.0');
    expect(second.body).toBe(first.body);
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it('refuses a version with restrictions AWP v1alpha1 cannot express, one finding per field', async () => {
    const id = await publish(TICKET_UPDATER);
    const res = await awp(id, '1.0.0');
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('awp_export_refused');
    expect(
      body.details.findings.map((f: { field: string; path: string }) => `${f.field} ${f.path}`),
    ).toEqual([
      'args agents.0.tools.0.args',
      'allowAdditionalArgs agents.0.tools.0.allowAdditionalArgs',
      'args agents.0.tools.1.args',
      'allowAdditionalArgs agents.0.tools.1.allowAdditionalArgs',
      'maxCallsPerRun agents.0.tools.1.maxCallsPerRun',
    ]);
    expect(body.spec).toBeUndefined();
  });

  it('refuses an agent that belongs to no team (owner_team_required)', async () => {
    const id = await publish(agentSource('no-team-agent', 'not-a-team'));
    const res = await awp(id, '1.0.0');
    expect(res.statusCode).toBe(422);
    expect(res.json().details.findings.map((f: { code: string }) => f.code)).toEqual([
      'owner_team_required',
    ]);
  });

  it('enumerates a wildcard grant from the reviewed tool list recorded at publish', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'logs',
        config: {
          transport: 'in-memory',
          tools: {
            get_lines: { access: 'read' },
            get_errors: { access: 'read' },
            purge: { access: 'write' },
          },
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = await publish(LOG_READER);
    const before = await awp(id, '1.0.0');
    expect(before.statusCode).toBe(200);
    const tools = Object.keys(
      (JSON.parse(before.body) as { spec: { agents: { permissions: { tools: object } }[] } }).spec
        .agents[0]!.permissions.tools,
    );
    expect(tools).toEqual(['logs.get_errors', 'logs.get_lines']);
    expect(before.body).not.toContain('*');

    // The connection changes after publish: the published export must not.
    const updated = await n.req({
      method: 'PUT',
      url: `/v1/connections/${created.json().id}`,
      payload: {
        config: {
          transport: 'in-memory',
          tools: { get_lines: { access: 'read' }, get_more: { access: 'read' } },
        },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect((await awp(id, '1.0.0')).body).toBe(before.body);
  });

  it('answers 404 for an unknown agent or version and hides agents of other teams', async () => {
    const id = await publish(agentSource('team-hidden-agent', 'team-docs', '1.0.0'));
    expect((await awp(id, '9.9.9')).statusCode).toBe(404);
    expect((await awp('00000000-0000-4000-8000-000000000000', '1.0.0')).statusCode).toBe(404);
    expect((await awp(id, '1.0.0', outsider)).statusCode).toBe(404);
    expect((await awp(id, '1.0.0', reader)).statusCode).toBe(200);
  });

  it('needs a login', async () => {
    const id = await publish(agentSource('login-needed-agent', 'team-docs'));
    const res = await n.req({
      method: 'GET',
      url: `/v1/agents/${id}/versions/1.0.0/awp`,
      token: null,
    });
    expect(res.statusCode).toBe(401);
  });

  it('is part of the OpenAPI document with the refusal response', async () => {
    const doc = (await n.req({ method: 'GET', url: '/openapi.json', token: null })).json();
    const op = doc.paths['/v1/agents/{id}/versions/{version}/awp'].get;
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '404', '422']));
    expect(op.description).toContain('not a conformance claim');
  });

  it('keeps an unrelated example exportable-or-refused without throwing', async () => {
    const id = await publish(CVE_TRIAGE.replace('name: cve-triage', 'name: cve-triage-awp'));
    expect([200, 422]).toContain((await awp(id, '1.0.0')).statusCode);
  });
});
