import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_AWP_PROFILES, validateManifestSource } from '../src/index.js';
import { AWP_SCHEMA } from '../src/awp/generated/awp-schema.js';
import { pinnedSchema } from './awp-pin.js';
import { schemaPropertyPaths } from './awp-schema-paths.js';

/**
 * Field coverage drift test (AWP-3, CI step 5). Every property of the pinned schema outside `^x-`
 * is either `handled` (validated structurally and by the semantic rules, carried in the result) or
 * listed under `rejected` with the profile that this validator does not support. A pin upgrade that
 * adds a property fails here until somebody decides which of the two it is.
 */
const DATA = fileURLToPath(new URL('./data/awp-field-coverage.json', import.meta.url));

interface Coverage {
  $comment: string;
  rejected: Record<string, string>;
  handled: string[];
}

/** Properties of the schema that the data file does not mention, and entries it lists in error. */
export function coverageDrift(
  paths: string[],
  data: Coverage,
): { missing: string[]; stale: string[] } {
  const rejected = Object.keys(data.rejected);
  const underRejected = (p: string) =>
    rejected.some(
      (r) => p === r || p.startsWith(`${r}.`) || p.startsWith(`${r}[`) || p.startsWith(`${r}{`),
    );
  const wanted = new Set(paths.filter((p) => !underRejected(p)));
  const listed = new Set(data.handled);
  const known = new Set(paths);
  return {
    missing: [...wanted].filter((p) => !listed.has(p)),
    stale: [...[...listed].filter((p) => !wanted.has(p)), ...rejected.filter((p) => !known.has(p))],
  };
}

const read = (): Coverage => JSON.parse(readFileSync(DATA, 'utf8')) as Coverage;
const PATHS = schemaPropertyPaths(pinnedSchema);

if (process.env.UPDATE_FIELD_COVERAGE === '1') {
  const data = read();
  const underRejected = (p: string) =>
    Object.keys(data.rejected).some(
      (r) => p === r || (/^[.[{]/.test(p.slice(r.length)) && p.startsWith(r)),
    );
  data.handled = PATHS.filter((p) => !underRejected(p));
  writeFileSync(DATA, `${JSON.stringify(data, null, 2)}\n`);
}

describe('field coverage', () => {
  it('the embedded schema is the vendored schema', () => {
    expect(AWP_SCHEMA).toEqual(pinnedSchema);
  });

  it('every property of the pinned schema is handled or knowingly rejected', () => {
    expect(coverageDrift(PATHS, read())).toEqual({ missing: [], stale: [] });
  });

  it('fails when the pinned schema gains a property that is neither handled nor listed', () => {
    const grown = structuredClone(pinnedSchema) as {
      $defs: Record<string, { properties: Record<string, unknown> }>;
    };
    grown.$defs.WorkflowSpec!.properties.somethingNew = { type: 'string' };
    grown.$defs.Step!.properties.alsoNew = { type: 'string' };
    const drift = coverageDrift(schemaPropertyPaths(grown), read());
    expect(drift.missing).toEqual([
      'Workflow.spec.somethingNew',
      'Workflow.spec.workflow[].alsoNew',
    ]);
    expect(drift.stale).toEqual([]);
  });

  it('fails when a handled field disappears from the schema or a rejected one is misspelled', () => {
    const data = read();
    data.handled.push('Workflow.spec.gone');
    data.rejected['Workflow.spec.auditt'] = 'audit';
    expect(coverageDrift(PATHS, data).stale).toEqual([
      'Workflow.spec.gone',
      'Workflow.spec.auditt',
    ]);
  });

  it('only rejects fields of profiles the validator does not support, and says so', () => {
    const data = read();
    const supported: readonly string[] = SUPPORTED_AWP_PROFILES;
    for (const profile of Object.values(data.rejected)) {
      expect(['audit', 'security', 'a2a', 'mcp', 'governance']).toContain(profile);
      expect(supported).not.toContain(profile);
    }
  });

  it('a manifest that uses a rejected field is rejected with profile.unsupported', () => {
    const base = {
      apiVersion: 'awp.agenticworkflowprotocol.org/v1alpha1',
      kind: 'Workflow',
      metadata: { name: 'cov', version: '1.0.0', owner: 'team-a', classification: 'internal' },
      spec: {
        agents: [{ id: 'a', model: { provider: 'p', name: 'm' }, instructions: 'x' }],
        workflow: [{ id: 's', agent: 'a' }],
      },
    };
    const cases: [string, (m: typeof base) => void, string][] = [
      ['audit', (m) => Object.assign(m.spec, { audit: { enabled: true } }), '/spec/audit'],
      [
        'security',
        (m) => Object.assign(m.metadata, { signature: { format: 'x', ref: 'y' } }),
        '/metadata/signature',
      ],
      [
        'a2a',
        (m) =>
          Object.assign(m.spec, {
            agents: [{ id: 'a', protocol: 'a2a', endpoint: 'https://example.org/a2a' }],
          }),
        '/spec/agents/0',
      ],
    ];
    for (const [profile, mutate, path] of cases) {
      const m = structuredClone(base);
      mutate(m);
      const r = validateManifestSource(JSON.stringify(m), { layout: 'document' })!;
      const hit = r.findings.find((f) => f.code === 'profile.unsupported');
      expect(hit, profile).toMatchObject({ path, severity: 'error' });
      expect(hit!.message).toContain(`"${profile}" profile`);
      expect(r.valid).toBe(false);
    }
  });
});
