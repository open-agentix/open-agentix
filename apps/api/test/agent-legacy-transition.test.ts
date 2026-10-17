import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  LEGACY_FORMAT_REMOVED_IN,
  loadAgentDefinition,
  type PublishedDefinition,
} from '@openagentix/core';
import { agentVersionAwp, agentVersions, agents } from '../src/db/schema.js';
import { convertLegacyVersions } from '../src/services/legacy-awp.js';
import { TICKET_UPDATER, agentSource, example } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';
import { randomUUID } from 'node:crypto';

const RELEASE_NOTES = example('awp/release-notes.agents.md');
const ticketUpdater = (name: string) =>
  TICKET_UPDATER.replace('name: ticket-updater', `name: ${name}`);
const AWP_FILE = example('awp/ticket-updater.awp.md');

let n: TestNode;

const get = (url: string, token?: string) =>
  n.req({ method: 'GET', url, ...(token ? { token } : {}) });

async function publish(
  source: string,
): Promise<{ id: string; res: Awaited<ReturnType<TestNode['req']>> }> {
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source } });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
  expect(pub.statusCode).toBe(201);
  return { id, res: pub };
}

const readAudits = async (target: string) =>
  (
    (await get('/v1/audit?action=agent.legacy_format_read&limit=200')).json().items as {
      target: string;
      payload: { surface: string; version?: string };
    }[]
  ).filter((e) => e.target === target);

beforeAll(async () => {
  n = await testNode();
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-docs', name: 'Docs' } });
});
afterAll(async () => n.close());

describe('publish stores the effective AWP manifest next to the version', () => {
  it('stores a converted manifest and reports it', async () => {
    const { id, res } = await publish(RELEASE_NOTES);
    expect(res.json().awp).toEqual({ status: 'converted' });
    expect(res.json().deprecations).toHaveLength(1);
    const detail = (await get(`/v1/agents/${id}/versions/1.0.0`)).json();
    expect(detail.awp).toMatchObject({
      status: 'converted',
      findings: [],
      converter: 'awp-export/1',
    });
    expect(detail.awp.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const manifest = JSON.parse((await get(`/v1/agents/${id}/versions/1.0.0/awp`)).body) as {
      metadata: { integrity: { digest: string } };
    };
    expect(manifest.metadata.integrity.digest).toBe(detail.awp.manifestDigest);
  });

  it('stores a refusal as legacy-unconvertible, with no manifest and the reasons by field', async () => {
    const { id } = await publish(ticketUpdater('tu-1'));
    const detail = (await get(`/v1/agents/${id}/versions/1.0.0`)).json();
    expect(detail.awp.status).toBe('legacy-unconvertible');
    expect(detail.awp.manifestDigest).toBeNull();
    expect(detail.awp.findings.map((f: { code: string }) => f.code)).toEqual(
      expect.arrayContaining(['critical_extension']),
    );
    const awp = await get(`/v1/agents/${id}/versions/1.0.0/awp`);
    expect(awp.statusCode).toBe(422);
    expect(awp.json().details.findings).toEqual(detail.awp.findings);
    const rows = await n.ctx.db
      .select()
      .from(agentVersionAwp)
      .where(sql`${agentVersionAwp.versionId} = ${detail.id}`);
    expect(rows[0]!.manifest).toBeNull();
  });

  it('serves what is stored, not a fresh mapping: the stored refusal and the stored bytes win', async () => {
    const source = agentSource('stored-wins', 'team-docs');
    const def = loadAgentDefinition(source);
    const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source } });
    const agentId = created.json().id as string;
    const insertVersion = async (version: string) => {
      const id = randomUUID();
      await n.ctx.db.insert(agentVersions).values({
        id,
        agentId,
        version,
        digest: def.digest,
        source,
        definition: def as unknown as PublishedDefinition,
      });
      return id;
    };
    const refused = await insertVersion('1.0.0');
    await n.ctx.db.insert(agentVersionAwp).values({
      versionId: refused,
      agentId,
      status: 'legacy-unconvertible',
      findings: [{ code: 'stored_reason', path: 'x', message: 'refused earlier' }],
      converter: 'awp-export/1',
    });
    const res = await get(`/v1/agents/${agentId}/versions/1.0.0/awp`);
    expect(res.statusCode).toBe(422);
    expect(res.json().details.findings.map((f: { code: string }) => f.code)).toEqual([
      'stored_reason',
    ]);
    const kept = await insertVersion('1.1.0');
    const live = JSON.parse((await get(`/v1/agents/${agentId}/versions/1.1.0/awp`)).body);
    const stored = { ...live, metadata: { ...live.metadata, description: 'stored earlier' } };
    await n.ctx.db.insert(agentVersionAwp).values({
      versionId: kept,
      agentId,
      status: 'converted',
      manifest: stored,
      manifestDigest: 'sha256:' + '0'.repeat(64),
      converter: 'awp-export/1',
    });
    const served = JSON.parse((await get(`/v1/agents/${agentId}/versions/1.1.0/awp`)).body);
    expect(served.metadata.description).toBe('stored earlier');
  });

  it('serves the stored bytes, the same on every call', async () => {
    const { id } = await publish(agentSource('stored-bytes', 'team-docs'));
    const a = await get(`/v1/agents/${id}/versions/1.0.0/awp`);
    const b = await get(`/v1/agents/${id}/versions/1.0.0/awp`);
    expect(a.statusCode).toBe(200);
    expect(b.body).toBe(a.body);
  });
});

describe('deprecations: exactly one entry and one audit event per legacy read', () => {
  it('on the agent, the version and the manifest export', async () => {
    const { id } = await publish(agentSource('read-twice', 'team-docs'));
    const agent = (await get(`/v1/agents/${id}`)).json();
    expect(agent.deprecations).toHaveLength(1);
    expect(agent.deprecations[0]).toMatchObject({
      code: 'legacy_format',
      removedIn: LEGACY_FORMAT_REMOVED_IN,
    });
    expect(agent.deprecations[0].message).toContain('oax awp convert');
    const version = (await get(`/v1/agents/${id}/versions/1.0.0`)).json();
    expect(version.deprecations).toHaveLength(1);
    const exported = await get(`/v1/agents/${id}/versions/1.0.0/awp`);
    expect(exported.headers['x-oax-deprecation']).toBe('legacy_format');
    const audits = (await readAudits(id)).reverse(); // newest first
    expect(audits.map((a) => a.payload.surface)).toEqual(['agent', 'version', 'awp-export']);
    expect(audits[1]!.payload.version).toBe('1.0.0');
  });

  it('a second read is a second entry and a second event, not more entries per read', async () => {
    const { id } = await publish(agentSource('read-again', 'team-docs'));
    await get(`/v1/agents/${id}`);
    const again = (await get(`/v1/agents/${id}`)).json();
    expect(again.deprecations).toHaveLength(1);
    expect((await readAudits(id)).filter((a) => a.payload.surface === 'agent')).toHaveLength(2);
  });

  it('a read that is denied or finds nothing writes no event', async () => {
    const before = (await get('/v1/audit?action=agent.legacy_format_read&limit=200')).json().items
      .length;
    expect((await get('/v1/agents/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    const { id } = await publish(agentSource('read-missing', 'team-docs'));
    expect((await get(`/v1/agents/${id}/versions/9.9.9`)).statusCode).toBe(404);
    const after = (await get('/v1/audit?action=agent.legacy_format_read&limit=200')).json().items
      .length;
    expect(after).toBe(before);
  });

  it('validate returns one deprecation for a legacy source and none for an AWP manifest', async () => {
    const legacy = await n.req({
      method: 'POST',
      url: '/v1/agents/validate',
      payload: { source: agentSource('v', 'team-docs') },
    });
    expect(legacy.json().valid).toBe(true);
    expect(legacy.json().deprecations).toHaveLength(1);
    const awp = await n.req({
      method: 'POST',
      url: '/v1/agents/validate',
      payload: { source: AWP_FILE },
    });
    expect(awp.json().format).toBe('awp');
    expect(awp.json().deprecations).toEqual([]);
  });

  it('create, draft update, publish and enable/disable carry the entry too', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: agentSource('writes', 'team-docs') },
    });
    expect(created.json().deprecations).toHaveLength(1);
    const id = created.json().id as string;
    const put = await n.req({
      method: 'PUT',
      url: `/v1/agents/${id}/draft`,
      payload: { source: agentSource('writes', 'team-docs', '1.0.1') },
    });
    expect(put.json().deprecations).toHaveLength(1);
    const pub = await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
    expect(pub.json().deprecations).toHaveLength(1);
  });
});

describe('existing agents keep working in release N', () => {
  it('a legacy agent still validates, publishes and runs', async () => {
    const { id } = await publish(agentSource('keeps-working', 'team-docs'));
    const run = await n.req({
      method: 'POST',
      url: `/v1/agents/${id}/runs`,
      payload: { data: { hello: 'world' } },
    });
    expect(run.statusCode).toBe(202);
  });

  it('runs a version that is legacy-unconvertible', async () => {
    const { id } = await publish(ticketUpdater('tu-2'));
    const version = (await get(`/v1/agents/${id}/versions/1.0.0`)).json();
    expect(version.awp.status).toBe('legacy-unconvertible');
    // The fixture needs an MCP connection to run; the point is that the refusal is not legacy_format_removed.
    const run = await n.req({
      method: 'POST',
      url: `/v1/agents/${id}/runs`,
      payload: { data: {} },
    });
    expect(run.json().error).not.toBe('legacy_format_removed');
  });
});

describe('release N+1 behind the version constant', () => {
  let removed: TestNode;
  beforeAll(async () => {
    removed = await testNode();
    removed.services.agents.legacyPhase = 'removed';
  });
  afterAll(async () => removed.close());

  const post = (url: string, payload?: object) =>
    removed.req({ method: 'POST', url, ...(payload ? { payload } : {}) });

  it('rejects the legacy format on create, update, publish and validate, naming oax awp convert', async () => {
    const create = await post('/v1/agents', { source: agentSource('gone', 'team-docs') });
    expect(create.statusCode).toBe(400);
    expect(create.json().error).toBe('legacy_format_removed');
    expect(create.json().message).toContain('oax awp convert');
    const validate = await post('/v1/agents/validate', {
      source: agentSource('gone', 'team-docs'),
    });
    expect(validate.json()).toMatchObject({
      valid: false,
      errors: [{ code: 'legacy_format_removed' }],
      deprecations: [],
    });
    // update and publish of an agent that exists from release N
    removed.services.agents.legacyPhase = 'deprecated';
    const made = await post('/v1/agents', { source: agentSource('gone2', 'team-docs') });
    const id = made.json().id as string;
    removed.services.agents.legacyPhase = 'removed';
    const put = await removed.req({
      method: 'PUT',
      url: `/v1/agents/${id}/draft`,
      payload: { source: agentSource('gone2', 'team-docs', '1.0.1') },
    });
    expect(put.json().error).toBe('legacy_format_removed');
    expect((await post(`/v1/agents/${id}/publish`)).json().error).toBe('legacy_format_removed');
  });

  it('still validates an AWP manifest', async () => {
    const r = await post('/v1/agents/validate', { source: AWP_FILE });
    expect(r.json()).toMatchObject({ format: 'awp', valid: true });
  });

  it('still reads stored versions', async () => {
    removed.services.agents.legacyPhase = 'deprecated';
    const made = await post('/v1/agents', { source: agentSource('readable', 'team-docs') });
    const id = made.json().id as string;
    await post(`/v1/agents/${id}/publish`);
    removed.services.agents.legacyPhase = 'removed';
    expect(
      (await removed.req({ method: 'GET', url: `/v1/agents/${id}/versions/1.0.0` })).statusCode,
    ).toBe(200);
  });

  it('refuses to run a legacy-unconvertible version and runs a converted one', async () => {
    removed.services.agents.legacyPhase = 'deprecated';
    await post('/v1/teams', { slug: 'team-docs', name: 'Docs' });
    const bad = (await post('/v1/agents', { source: ticketUpdater('tu-3') })).json().id as string;
    await post(`/v1/agents/${bad}/publish`);
    const good = (
      await post('/v1/agents', { source: agentSource('runs-fine', 'team-docs') })
    ).json().id as string;
    await post(`/v1/agents/${good}/publish`);
    removed.services.agents.legacyPhase = 'removed';
    const refused = await post(`/v1/agents/${bad}/runs`, { data: {} });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('legacy_format_removed');
    expect(refused.json().message).toContain('oax awp convert');
    expect((await post(`/v1/agents/${good}/runs`, { data: {} })).statusCode).toBe(202);
  });
});

describe('the one-time conversion of existing versions', () => {
  it('converts versions without a row once, keeps source and digest, and is idempotent', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: agentSource('old-version', 'team-docs') },
    });
    const agentId = created.json().id as string;
    const source = agentSource('old-version', 'team-docs');
    const def = loadAgentDefinition(source);
    // A version published before this release: no conversion row.
    const versionId = randomUUID();
    await n.ctx.db.insert(agentVersions).values({
      id: versionId,
      agentId,
      version: def.version,
      digest: def.digest,
      source,
      definition: def as unknown as PublishedDefinition,
    });
    const before = (
      await n.ctx.db
        .select()
        .from(agentVersions)
        .where(sql`id = ${versionId}`)
    )[0]!;
    const first = await convertLegacyVersions(n.ctx.db);
    expect(first.converted).toBeGreaterThanOrEqual(1);
    const [row] = await n.ctx.db
      .select()
      .from(agentVersionAwp)
      .where(sql`version_id = ${versionId}`);
    expect(row).toMatchObject({ status: 'converted', converter: 'awp-export/1' });
    const after = (
      await n.ctx.db
        .select()
        .from(agentVersions)
        .where(sql`id = ${versionId}`)
    )[0]!;
    expect(after).toEqual(before);
    const second = await convertLegacyVersions(n.ctx.db);
    expect(second).toEqual({ agents: 0, converted: 0, unconvertible: 0 });
    const [again] = await n.ctx.db
      .select()
      .from(agentVersionAwp)
      .where(sql`version_id = ${versionId}`);
    expect(again).toEqual(row);
  });

  it('marks an unconvertible version and never stores a manifest for it', async () => {
    const source = ticketUpdater('tu-4');
    const def = loadAgentDefinition(source);
    const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source } });
    const agentId = created.json().id as string;
    const versionId = randomUUID();
    await n.ctx.db.insert(agentVersions).values({
      id: versionId,
      agentId,
      version: def.version,
      digest: def.digest,
      source,
      definition: def as unknown as PublishedDefinition,
    });
    await convertLegacyVersions(n.ctx.db);
    const [row] = await n.ctx.db
      .select()
      .from(agentVersionAwp)
      .where(sql`version_id = ${versionId}`);
    expect(row!.status).toBe('legacy-unconvertible');
    expect(row!.manifest).toBeNull();
    expect((row!.findings as unknown[]).length).toBeGreaterThan(0);
  });

  it('a version whose definition the exporter cannot read is unconvertible, not an error', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: agentSource('broken-def', 'team-docs') },
    });
    const agentId = created.json().id as string;
    const versionId = randomUUID();
    await n.ctx.db.insert(agentVersions).values({
      id: versionId,
      agentId,
      version: '9.0.0',
      digest: 'x',
      source: 'x',
      definition: { owner: 'team-docs', agents: 'not-a-list' },
    });
    const r = await convertLegacyVersions(n.ctx.db);
    expect(r.unconvertible).toBeGreaterThanOrEqual(1);
    const [row] = await n.ctx.db
      .select()
      .from(agentVersionAwp)
      .where(sql`version_id = ${versionId}`);
    expect(row!.status).toBe('legacy-unconvertible');
    expect((row!.findings as { code: string }[])[0]!.code).toBe('conversion_error');
  });

  it('the stored conversion rows are append-only', async () => {
    const { id } = await publish(agentSource('append-only', 'team-docs'));
    const v = (await get(`/v1/agents/${id}/versions/1.0.0`)).json();
    await expect(
      n.ctx.db.execute(
        sql`update agent_version_awp set status = 'converted' where version_id = ${v.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      n.ctx.db.execute(sql`delete from agent_version_awp where version_id = ${v.id}`),
    ).rejects.toThrow();
    await expect(
      n.ctx.db.execute(sql`update agent_versions set source = 'x' where id = ${v.id}`),
    ).rejects.toThrow();
  });
});

describe('GET /v1/agents/legacy-report', () => {
  it('counts and lists the unconvertible versions with their reasons', async () => {
    const res = await get('/v1/agents/legacy-report?limit=200');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts.converted).toBeGreaterThan(0);
    expect(body.counts.unconvertible).toBeGreaterThan(0);
    expect(body.items.length).toBe(body.counts.unconvertible);
    for (const item of body.items) {
      expect(item.findings.length).toBeGreaterThan(0);
      expect(item.findings[0]).toHaveProperty('path');
    }
  });

  it('pages with a cursor', async () => {
    const first = (await get('/v1/agents/legacy-report?limit=1')).json();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await get(`/v1/agents/legacy-report?limit=1&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items[0].versionId).not.toBe(first.items[0].versionId);
  });

  it('shows nothing of other tenants or unreadable agents', async () => {
    const team = (
      await n.req({
        method: 'POST',
        url: '/v1/teams',
        payload: { slug: 'team-empty', name: 'Empty' },
      })
    ).json().id as string;
    const user = (
      await n.req({
        method: 'POST',
        url: '/v1/users',
        payload: { email: 'nobody@example.com', displayName: 'n', password: 'long-password-1' },
      })
    ).json().id as string;
    await n.req({
      method: 'PUT',
      url: `/v1/teams/${team}/members`,
      payload: { members: [{ userId: user, role: 'agent-maintainer' }] },
    });
    const token = await n.login('nobody@example.com', 'long-password-1');
    const body = (await get('/v1/agents/legacy-report', token)).json();
    expect(body.items).toEqual([]);
    expect(body.counts).toEqual({ converted: 0, unconvertible: 0, pending: 0 });
  });

  it('needs a login', async () => {
    expect(
      (await n.req({ method: 'GET', url: '/v1/agents/legacy-report', token: null })).statusCode,
    ).toBe(401);
  });
});

describe('OpenAPI', () => {
  it('documents the deprecations, the stored conversion and the report', async () => {
    const doc = (await n.req({ method: 'GET', url: '/openapi.json', token: null })).json();
    expect(doc.paths['/v1/agents/legacy-report'].get.description).toContain(
      'not a conformance claim',
    );
    const schemas = JSON.stringify(doc);
    expect(schemas).toContain('legacy_format');
    expect(schemas).toContain('legacy-unconvertible');
  });
});

void agents;
