import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jcs } from '@openagentix/core';
import { createReference, type Reference } from '../../../scripts/awp/conformance.mjs';
import { example } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * Real published agents: each example is created and published through the API, its AWP export is
 * fetched from the endpoint and checked offline by the vendored reference checker (`--verify-digest`),
 * and by the validator endpoint. The AWP-native examples must equal their golden files byte for byte.
 * This is a measurement of this build, not a conformance claim.
 */
const NATIVE = ['manual-summarizer', 'nightly-digest', 'webhook-intake', 'release-notes'];
const golden = (name: string) =>
  readFileSync(new URL(`../../../examples/awp/${name}.awp.json`, import.meta.url), 'utf8');

let n: TestNode;
let reference: Reference;

beforeAll(async () => {
  n = await testNode();
  reference = createReference();
  for (const slug of ['team-docs', 'team-support']) {
    const team = await n.req({ method: 'POST', url: '/v1/teams', payload: { slug, name: slug } });
    expect(team.statusCode).toBe(201);
  }
});
afterAll(async () => {
  reference?.close();
  await n.close();
});

async function publish(source: string): Promise<string> {
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source } });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
  expect(pub.statusCode).toBe(201);
  return id;
}

describe('exports of published agents against the vendored reference checker', () => {
  it.each(NATIVE)(
    '%s: reference checker and validator accept the export, golden matches',
    async (name) => {
      const id = await publish(example(`awp/${name}.agents.md`));
      const res = await n.req({ method: 'GET', url: `/v1/agents/${id}/versions/1.0.0/awp` });
      expect(res.statusCode).toBe(200);
      const manifest = JSON.parse(res.body) as { spec: { agents: unknown[] } };

      const checked = await reference.check(manifest, ['core', 'governance', 'mcp']);
      expect(checked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(checked.valid).toBe(true);

      const validated = await n.req({
        method: 'POST',
        url: '/v1/agents/validate',
        payload: { source: res.body },
      });
      expect(validated.json()).toMatchObject({ format: 'awp', valid: true });

      expect(res.body).toBe(jcs(JSON.parse(golden(name))));
    },
  );
});
