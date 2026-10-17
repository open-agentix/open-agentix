import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { awpManifestDigest, type JsonObject } from '@openagentix/core';
import { agentSource, example } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

const RELEASE_NOTES = example('awp/release-notes.agents.md');
const UPDATER_MD = readFileSync(
  new URL('../../../examples/awp/ticket-updater.awp.md', import.meta.url),
  'utf8',
);
const GOLDEN = readFileSync(
  new URL('../../../examples/awp/ticket-commenter.awp.json', import.meta.url),
  'utf8',
);

let n: TestNode;
beforeAll(async () => {
  n = await testNode();
  const team = await n.req({
    method: 'POST',
    url: '/v1/teams',
    payload: { slug: 'team-docs', name: 'docs' },
  });
  expect(team.statusCode).toBe(201);
});
afterAll(async () => n.close());

const validate = async (source: string, token?: string) => {
  const res = await n.req({
    method: 'POST',
    url: '/v1/agents/validate',
    payload: { source },
    ...(token ? { token } : {}),
  });
  expect(res.statusCode).toBe(200);
  return res.json();
};

describe('POST /v1/agents/validate with AWP manifests', () => {
  it('reads the legacy format as before and says so', async () => {
    const r = await validate(agentSource('legacy-one', 'team-docs'));
    expect(r).toMatchObject({
      format: 'agents-md',
      valid: true,
      name: 'legacy-one',
      manifest: null,
    });
    expect(r.definition).not.toBeNull();
  });

  it('accepts AWP front matter and reports the AWP codes, paths and digest', async () => {
    const r = await validate(UPDATER_MD);
    expect(r).toMatchObject({
      format: 'awp',
      valid: true,
      name: 'ticket-updater',
      version: '2.0.0',
    });
    expect(r.errors).toEqual([]);
    expect(r.definition).toBeNull();
    expect(r.digest).toBe(awpManifestDigest(r.manifest as JsonObject));
    const codes = r.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain('extension.critical-not-declared');
    expect(codes).toContain('mcp.server-unresolved');
    expect(r.warnings[0]).toMatchObject({ path: expect.stringMatching(/^\/spec\//) });
    // the effective manifest carries the section text as instructions
    expect(
      (r.manifest as { spec: { agents: { instructions: string }[] } }).spec.agents[0]!.instructions,
    ).toMatch(/^Read the ticket from the event/);
  });

  it('gives the same result and digest for the JSON and the YAML form', async () => {
    const json = await validate(GOLDEN);
    const yaml = await validate(stringify(JSON.parse(GOLDEN)));
    expect(json.valid).toBe(true);
    expect(yaml).toEqual(json);
    expect(json.digest).toBe(
      (JSON.parse(GOLDEN) as { metadata: { integrity: { digest: string } } }).metadata.integrity
        .digest,
    );
  });

  it('round trip: the exported manifest of a published version validates with the same digest', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: RELEASE_NOTES },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` })).statusCode).toBe(201);
    const exported = await n.req({ method: 'GET', url: `/v1/agents/${id}/versions/1.0.0/awp` });
    expect(exported.statusCode).toBe(200);
    const r = await validate(exported.body);
    expect(r).toMatchObject({ format: 'awp', valid: true, errors: [] });
    expect(r.digest).toBe(
      (JSON.parse(exported.body) as { metadata: { integrity: { digest: string } } }).metadata
        .integrity.digest,
    );
  });

  it('rejects with field-level findings: unknown field, unsupported profile, unknown required extension', async () => {
    const m = JSON.parse(GOLDEN) as JsonObject & { metadata: JsonObject; spec: JsonObject };
    delete m.metadata.integrity;
    m.spec.surprise = 1;
    m.spec.audit = { enabled: true };
    m.metadata.requiredExtensions = ['x-future-thing'];
    const r = await validate(JSON.stringify(m));
    expect(r).toMatchObject({
      format: 'awp',
      valid: false,
      digest: null,
      manifest: null,
      name: null,
    });
    const found = r.errors.map((e: { code: string; path: string }) => `${e.code} ${e.path}`);
    expect(found).toContain('schema.additionalProperties /spec/surprise');
    expect(found).toContain('schema.additionalProperties /metadata/requiredExtensions');
    // structure first, like any AWP validator: semantic rules (profiles) need a valid structure
    delete m.spec.surprise;
    delete m.metadata.requiredExtensions;
    const r2 = await validate(JSON.stringify(m));
    expect(r2.errors.map((e: { code: string; path: string }) => `${e.code} ${e.path}`)).toContain(
      'profile.unsupported /spec/audit',
    );
    const unknownExt = JSON.stringify(m).replace('"audit"', '"x-openagentix-teleport":1,"audit"');
    expect((await validate(unknownExt)).errors.map((e: { code: string }) => e.code)).toContain(
      'extension.unknown',
    );
  });

  it('answers a broken or hostile source with findings, never an error status', async () => {
    const hostile = [
      'apiVersion: awp.agenticworkflowprotocol.org/v1alpha1\nx: !custom 1\n',
      `{"apiVersion":"awp.x",${'"a":['.repeat(200)}`,
      `apiVersion: awp.x\na: &a [*a]\n`,
    ];
    for (const source of hostile) {
      const r = await validate(source);
      expect(r).toMatchObject({ format: 'awp', valid: false, manifest: null, digest: null });
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('cannot be used to store or run an AWP manifest yet: create refuses it with a clear code', async () => {
    const res = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: UPDATER_MD } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
    expect(res.json().details[0]).toMatchObject({ path: 'apiVersion', code: 'awp_not_runnable' });
    const list = (await n.req({ method: 'GET', url: '/v1/agents' })).json().items as {
      name: string;
    }[];
    expect(list.map((a) => a.name)).not.toContain('ticket-updater');
  });

  it('also refuses an AWP manifest as a draft update and as a dry-run source; publish keeps the stored draft', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: agentSource('wip-agent', 'team-docs') },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const put = await n.req({
      method: 'PUT',
      url: `/v1/agents/${id}/draft`,
      payload: { source: UPDATER_MD.replace('ticket-updater', 'wip-agent') },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().details[0]).toMatchObject({ code: 'awp_not_runnable' });
    const dry = await n.req({
      method: 'POST',
      url: `/v1/agents/${id}/dry-run`,
      payload: { source: UPDATER_MD, data: {} },
    });
    expect(dry.statusCode).toBe(400);
    // the stored draft is still the legacy source, so publishing works and never sees AWP text
    const draft = (await n.req({ method: 'GET', url: `/v1/agents/${id}` })).json();
    expect(draft.draftSource).not.toContain('awp.agenticworkflowprotocol.org');
    expect((await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` })).statusCode).toBe(201);
  });

  it('limits the rate of validation per token (tighter than the global limit)', async () => {
    const strict = await testNode({ OAX_RATE_LIMIT_VALIDATE_MAX: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++)
        statuses.push(
          (
            await strict.req({
              method: 'POST',
              url: '/v1/agents/validate',
              payload: { source: UPDATER_MD },
            })
          ).statusCode,
        );
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await strict.close();
    }
  });
});
