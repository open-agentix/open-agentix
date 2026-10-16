import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  awpManifestDigest,
  validateManifestSource,
  type JsonObject,
  type ManifestFinding,
  type ManifestValidation,
} from '../src/index.js';
import { EXAMPLES_DIR, definitionOf, exampleFiles, exportOf, readExample } from './awp-fixtures.js';
import { referenceDigest } from './awp-pin.js';

/** The manifests as plain JSON documents (goldens written by the exporter, AWP-2). */
const GOLDENS = readdirSync(`${EXAMPLES_DIR}awp`)
  .filter((f) => f.endsWith('.awp.json'))
  .sort();

const asJson = (m: unknown) => JSON.stringify(m, null, 2);
const asYaml = (m: unknown) => stringify(m);
const errorsOf = (r: ManifestValidation | null) =>
  (r?.findings ?? []).filter((f) => f.severity === 'error');
const codes = (fs: ManifestFinding[]) => fs.map((f) => `${f.code} ${f.path}`);

/** `agents.md` form of a manifest: instructions move into `## Agent:` sections. */
function asMarkdown(manifest: JsonObject, extraBody = ''): string {
  const copy = structuredClone(manifest) as {
    spec: { agents: { id: string; instructions?: string }[] };
  };
  const sections = copy.spec.agents
    .map((a) => {
      const text = a.instructions;
      delete a.instructions;
      return `## Agent: ${a.id}\n\n${text}\n`;
    })
    .join('\n');
  return `---\n${asYaml(copy)}---\n\n# Title\n\nOverview.\n\n${sections}\n${extraBody}`;
}

describe('goldens and the exporter round trip', () => {
  it('has goldens', () => expect(GOLDENS.length).toBeGreaterThanOrEqual(3));

  describe.each(GOLDENS)('%s', (file) => {
    const manifest = JSON.parse(readFileSync(`${EXAMPLES_DIR}awp/${file}`, 'utf8')) as JsonObject;
    const declared = (manifest.metadata as { integrity: { digest: string } }).integrity.digest;

    it('validates, and the digest is the declared one and the reference digest', () => {
      const r = validateManifestSource(asJson(manifest), { layout: 'document' })!;
      expect(errorsOf(r)).toEqual([]);
      expect(r.valid).toBe(true);
      expect(r.digest).toBe(declared);
      expect(r.digest).toBe(referenceDigest(manifest));
      expect(r.kind).toBe('Workflow');
    });

    it('gives identical results and the same digest for the JSON and the YAML form', () => {
      const j = validateManifestSource(asJson(manifest), { layout: 'document' })!;
      const y = validateManifestSource(asYaml(manifest), { layout: 'document' })!;
      expect(y.findings).toEqual(j.findings);
      expect(y.digest).toBe(j.digest);
      expect(y.manifest).toEqual(j.manifest);
      const a = validateManifestSource(asJson(manifest), { layout: 'auto' })!;
      expect(a.digest).toBe(j.digest);
    });

    it('gives the same digest for the agents.md form (sections become instructions)', () => {
      const md = validateManifestSource(asMarkdown(manifest))!;
      expect(errorsOf(md)).toEqual([]);
      expect(md.layout).toBe('markdown');
      expect(md.digest).toBe(declared);
      expect(md.manifest).toEqual(manifest);
    });
  });

  it.each(exampleFiles().filter((f) => f.startsWith('awp/')))(
    'export of %s validates after a round trip through JSON, YAML and agents.md',
    (file) => {
      const r = exportOf(definitionOf(readExample(file)));
      if (!r.ok) throw new Error(JSON.stringify(r.findings));
      for (const text of [asJson(r.manifest), asYaml(r.manifest), asMarkdown(r.manifest)]) {
        const v = validateManifestSource(text)!;
        expect(errorsOf(v)).toEqual([]);
        expect(v.digest).toBe(r.digest);
        expect(v.name).toBe((r.manifest.metadata as { name: string }).name);
        expect(awpManifestDigest(v.manifest as unknown as JsonObject)).toBe(r.digest);
      }
    },
  );

  it('every agents.md example that exports validates (round trip over all examples)', () => {
    let exported = 0;
    for (const file of exampleFiles()) {
      const r = exportOf(definitionOf(readExample(file)));
      if (!r.ok) continue;
      exported += 1;
      expect(errorsOf(validateManifestSource(asYaml(r.manifest))), file).toEqual([]);
    }
    expect(exported).toBeGreaterThanOrEqual(3);
  });
});

describe('the same findings as any AWP validator for a document, JSON or YAML', () => {
  const dir = `${new URL('../../awp/vendor/awp-v1alpha1/conformance/invalid/', import.meta.url).pathname}`;
  const index = JSON.parse(readFileSync(`${dir}../index.json`, 'utf8')) as {
    defaults: { profiles: string[]; verifyDigest: boolean };
    tests: { file: string; expect: string; profiles?: string[]; verifyDigest?: boolean }[];
  };
  const cases = index.tests.filter((t) => t.expect === 'invalid' && !t.file.includes('/3.1-'));

  it.each(cases.map((t) => [t.file, t] as const))(
    '%s: YAML and JSON give equal findings',
    (_file, t) => {
      const text = readFileSync(`${dir}../${t.file}`, 'utf8');
      const options = {
        layout: 'document' as const,
        profiles: t.profiles ?? index.defaults.profiles,
        verifyDigest: t.verifyDigest ?? index.defaults.verifyDigest,
      };
      const yaml = validateManifestSource(text, options)!;
      const json = validateManifestSource(JSON.stringify(parse(text)), options)!;
      expect(json.findings).toEqual(yaml.findings);
      expect(json.digest).toBe(yaml.digest);
      expect(yaml.valid).toBe(false);
    },
  );
});

describe('unknown fields, profiles and digests', () => {
  const base = (): JsonObject => ({
    apiVersion: 'awp.agenticworkflowprotocol.org/v1alpha1',
    kind: 'Workflow',
    metadata: {
      name: 'probe',
      version: '1.0.0',
      owner: { team: 'team-a' },
      classification: 'internal',
    },
    spec: {
      agents: [
        { id: 'a', model: { provider: 'simulated', name: 'sim-1' }, instructions: 'Do it.' },
      ],
      workflow: [{ id: 's', agent: 'a' }],
    },
  });
  const run = (m: JsonObject, o = {}) =>
    validateManifestSource(asJson(m), { layout: 'document', ...o })!;

  it('accepts the minimal manifest', () => {
    const r = run(base());
    expect(r).toMatchObject({ valid: true, name: 'probe', version: '1.0.0', kind: 'Workflow' });
    expect(r.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.documents).toHaveLength(1);
  });

  it('rejects an unknown field and names it', () => {
    const m = base();
    (m.spec as JsonObject).surprise = 1;
    ((m.spec as { agents: JsonObject[] }).agents[0] as JsonObject).temperature = 0.2;
    const r = run(m);
    expect(codes(errorsOf(r))).toEqual([
      'schema.additionalProperties /spec/surprise',
      'schema.additionalProperties /spec/agents/0/temperature',
    ]);
    expect(r.valid).toBe(false);
    expect(r.manifest).toBeNull();
    expect(r.digest).toBeNull();
  });

  it('rejects a field of an unsupported profile, naming field and profile', () => {
    const m = base();
    (m.metadata as JsonObject).signature = { format: 'x' };
    const r = run(m);
    expect(errorsOf(r)).toEqual([
      expect.objectContaining({
        code: 'profile.unsupported',
        path: '/metadata/signature',
        message: expect.stringContaining('metadata.signature belongs to the "security" profile'),
      }),
    ]);
  });

  it('supports the profiles the exporter writes and no others', () => {
    const m = base();
    Object.assign(m.spec as JsonObject, { audit: { enabled: true } });
    expect(codes(errorsOf(run(m)))).toEqual(['profile.unsupported /spec/audit']);
    expect(run(m, { profiles: ['core', 'governance', 'mcp', 'audit'] }).valid).toBe(true);
  });

  it('verifies a declared digest by default and can be told not to', () => {
    const m = base();
    (m.metadata as JsonObject).integrity = { digest: `sha256:${'0'.repeat(64)}` };
    const r = run(m);
    expect(codes(errorsOf(r))).toEqual(['digest.mismatch /metadata/integrity/digest']);
    expect(run(m, { verifyDigest: false }).valid).toBe(true);
    (m.metadata as JsonObject).integrity = { digest: awpManifestDigest(m) };
    expect(run(m).valid).toBe(true);
    (m.metadata as JsonObject).integrity = { digest: `sha512:${'0'.repeat(128)}` };
    expect(codes(errorsOf(run(m)))).toEqual(['digest.mismatch /metadata/integrity/digest']);
  });

  it('the digest changes with any value, including extensions, and not with key order', () => {
    const a = run(base()).digest;
    const m = base();
    (m.spec as JsonObject)['x-openagentix-mode'] = 'dark-factory';
    const b = run(m).digest;
    expect(b).not.toBe(a);
    const reordered = JSON.parse(asJson(m)) as JsonObject;
    const { spec, ...rest } = reordered;
    expect(run({ spec, ...rest } as JsonObject).digest).toBe(b);
  });

  it('reports a semantic error with the AWP code and path', () => {
    const m = base();
    (m.spec as { workflow: JsonObject[] }).workflow.push({
      id: 't',
      agent: 'ghost',
      dependsOn: ['nope'],
    });
    expect(codes(errorsOf(run(m)))).toEqual([
      'dependsOn.unknown-step /spec/workflow/1/dependsOn/0',
      'step.unknown-agent /spec/workflow/1/agent',
    ]);
  });
});

describe('applicability', () => {
  it('leaves a legacy agents.md and ordinary text to the legacy parser', () => {
    expect(validateManifestSource(readExample('cve-triage.agents.md'))).toBeNull();
    expect(validateManifestSource('# just text\n')).toBeNull();
    expect(validateManifestSource('apiVersion: openagentix.io/v1alpha1\nkind: Agent\n')).toBeNull();
    expect(validateManifestSource('{"apiVersion":"other"}')).toBeNull();
    expect(validateManifestSource('')).toBeNull();
  });

  it('treats a broken text that claims to be AWP as AWP (the error is a finding)', () => {
    const r = validateManifestSource(
      'apiVersion: awp.agenticworkflowprotocol.org/v1alpha1\nkind: [unclosed\n',
    )!;
    expect(r.valid).toBe(false);
    expect(r.findings[0]).toMatchObject({ code: 'yaml.parse-error', severity: 'error' });
  });

  it('an explicit layout validates anything as AWP', () => {
    const r = validateManifestSource('kind: Workflow\n', { layout: 'document' })!;
    expect(codes(errorsOf(r))).toContain('schema.required ');
    const md = validateManifestSource('no front matter\n', { layout: 'markdown' })!;
    expect(md.findings[0]).toMatchObject({ code: 'wrapper.no-front-matter' });
  });

  it('accepts several YAML documents in a plain file, each on its own', () => {
    const one = parse(readFileSync(`${EXAMPLES_DIR}awp/log-reader.awp.json`, 'utf8')) as JsonObject;
    const two = structuredClone(one);
    (two.metadata as JsonObject).name = 'second';
    delete (two.metadata as JsonObject).integrity;
    const r = validateManifestSource(`${asYaml(one)}---\n${asYaml(two)}`, { layout: 'document' })!;
    expect(r.valid).toBe(true);
    expect(r.documents.map((d) => d.name)).toEqual(['log-reader', 'second']);
    expect(r.digest).toBeNull(); // no single document
    expect(r.documents[1]!.digest).toBe(awpManifestDigest(two));
    const bad = structuredClone(two);
    (bad.spec as JsonObject).nope = 1;
    const r2 = validateManifestSource(`${asYaml(one)}---\n${asYaml(bad)}`, { layout: 'document' })!;
    expect(r2.valid).toBe(false);
    expect(errorsOf(r2).map((f) => `${f.document} ${f.code} ${f.path}`)).toEqual([
      '1 schema.additionalProperties /spec/nope',
    ]);
  });
});

describe('the agents.md wrapper (## Agent: sections)', () => {
  const manifest = (): JsonObject => ({
    apiVersion: 'awp.agenticworkflowprotocol.org/v1alpha1',
    kind: 'Workflow',
    metadata: {
      name: 'probe',
      version: '1.0.0',
      owner: { team: 'team-a' },
      classification: 'internal',
    },
    spec: {
      agents: [{ id: 'a', model: { provider: 'simulated', name: 'sim-1' } }],
      workflow: [{ id: 's', agent: 'a' }],
    },
  });
  const file = (m: JsonObject, body: string) => `---\n${asYaml(m)}---\n\n${body}`;

  it('injects the section text as instructions, trimmed, with normalised line endings', () => {
    const r = validateManifestSource(
      file(manifest(), '# T\n\n## Agent: a\r\n\r\n  Line one.\r\nLine two.\r\n\r\n'),
    )!;
    expect(errorsOf(r)).toEqual([]);
    const agents = (r.manifest!.spec as unknown as { agents: { instructions: string }[] }).agents;
    expect(agents[0]!.instructions).toBe('Line one.\nLine two.');
  });

  it('title, overview and other sections are documentation: they do not change the digest', () => {
    const a = validateManifestSource(file(manifest(), '## Agent: a\n\nGo.\n'))!;
    const b = validateManifestSource(
      file(manifest(), '# Big title\n\nLong overview.\n\n## Notes\n\nx\n\n## Agent: a\n\nGo.\n'),
    )!;
    expect(a.digest).toBe(b.digest);
  });

  it('refuses instructions in the front matter next to a section', () => {
    const m = manifest();
    ((m.spec as { agents: JsonObject[] }).agents[0] as JsonObject).instructions = 'front matter';
    const r = validateManifestSource(file(m, '## Agent: a\n\nsection\n'))!;
    expect(codes(errorsOf(r))).toEqual([
      'wrapper.instructions-conflict /spec/agents/0/instructions',
    ]);
    ((m.spec as { agents: JsonObject[] }).agents[0] as JsonObject).promptRef = {
      name: 'p',
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
    };
    delete ((m.spec as { agents: JsonObject[] }).agents[0] as JsonObject).instructions;
    expect(codes(errorsOf(validateManifestSource(file(m, '## Agent: a\n\nsection\n'))))).toEqual([
      'wrapper.instructions-conflict /spec/agents/0/promptRef',
    ]);
  });

  it('refuses a section without agent, a duplicate and an empty section; ids match exactly', () => {
    expect(
      codes(
        errorsOf(
          validateManifestSource(file(manifest(), '## Agent: a\n\nx\n\n## Agent: ghost\n\ny\n')),
        ),
      ),
    ).toEqual(['wrapper.section-orphan /spec/agents']);
    expect(
      codes(
        errorsOf(
          validateManifestSource(file(manifest(), '## Agent: a\n\nx\n\n## Agent: a\n\ny\n')),
        ),
      ),
    ).toEqual(['wrapper.duplicate-section /spec/agents']);
    expect(codes(errorsOf(validateManifestSource(file(manifest(), '## Agent: a\n\n'))))).toEqual([
      'wrapper.empty-section /spec/agents/0/instructions',
    ]);
    // the heading keyword is case-insensitive, the id is not: "A" is not the agent "a"
    expect(codes(errorsOf(validateManifestSource(file(manifest(), '## agent: A\n\nx\n'))))).toEqual(
      ['wrapper.section-orphan /spec/agents'],
    );
  });

  it('a section for a reference or remote agent is refused, not injected', () => {
    const m = manifest();
    (m.spec as { agents: JsonObject[] }).agents[0] = {
      id: 'a',
      ref: { name: 'other', version: '1.0.0' },
    };
    const r = validateManifestSource(file(m, '## Agent: a\n\nx\n'))!;
    expect(codes(errorsOf(r))).toContain('wrapper.section-not-inline /spec/agents/0');
  });

  it('sections are only for kind Workflow', () => {
    const m: JsonObject = {
      apiVersion: 'awp.agenticworkflowprotocol.org/v1alpha1',
      kind: 'Agent',
      metadata: {
        name: 'solo',
        version: '1.0.0',
        owner: { team: 'team-a' },
        classification: 'internal',
      },
      spec: { model: { provider: 'simulated', name: 'sim-1' }, instructions: 'x' },
    };
    const r = validateManifestSource(file(m, '## Agent: solo\n\nx\n'))!;
    expect(codes(errorsOf(r))).toEqual(['wrapper.section-orphan /spec/agents']);
    expect(validateManifestSource(file(m, 'only docs\n'))!.valid).toBe(true);
  });

  it('the shipped example validates with warnings about its critical extensions', () => {
    const r = validateManifestSource(
      readFileSync(`${EXAMPLES_DIR}awp/ticket-updater.awp.md`, 'utf8'),
    )!;
    expect(errorsOf(r)).toEqual([]);
    expect(r.layout).toBe('markdown');
    const warnings = r.findings.filter((f) => f.code === 'extension.critical-not-declared');
    expect(warnings.map((w) => w.path)).toEqual([
      '/spec/agents/0/permissions/tools/tickets.get_ticket/x-openagentix-args',
      '/spec/agents/0/permissions/tools/tickets.get_ticket/x-openagentix-allowAdditionalArgs',
      '/spec/agents/0/permissions/tools/tickets.update_ticket/x-openagentix-maxCallsPerRun',
      '/spec/agents/0/permissions/tools/tickets.update_ticket/x-openagentix-args',
      '/spec/agents/0/permissions/tools/tickets.update_ticket/x-openagentix-allowAdditionalArgs',
    ]);
    expect(
      r.findings.filter(
        (f) => f.severity === 'warning' && f.code !== 'extension.critical-not-declared',
      ),
    ).toEqual([expect.objectContaining({ code: 'mcp.server-unresolved' })]);
  });
});
