import { describe, expect, it } from 'vitest';
import {
  OAX_CRITICAL_EXTENSIONS,
  knownExtensionNames,
  validateManifestSource,
  type ManifestFinding,
} from '../src/index.js';
import { AWP_SCHEMA } from '../src/awp/generated/awp-schema.js';
import { CRITICAL_EXTENSIONS as EXPORTER_CRITICAL } from '../src/awp/export-context.js';
import { definitionOf, exampleFiles, exportOf, readExample, walk } from './awp-fixtures.js';

type Obj = Record<string, unknown>;

/** A valid Workflow with one inline agent, one MCP grant and one step; patched per test. */
function manifest(
  patch: (m: Obj & { spec: Obj & { agents: Obj[]; workflow: Obj[] } }) => void = () => undefined,
) {
  const m = {
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
        {
          id: 'a',
          model: { provider: 'simulated', name: 'sim-1' },
          instructions: 'Do it.',
          tools: [{ type: 'mcp', server: 'srv', tools: ['do_it'] }],
          permissions: { default: 'deny', tools: { 'srv.do_it': { allow: true } } },
        },
      ] as Obj[],
      workflow: [{ id: 's', agent: 'a' }] as Obj[],
    },
  } as Obj & { spec: Obj & { agents: Obj[]; workflow: Obj[] } };
  patch(m);
  return m;
}
const toolPerm = (m: ReturnType<typeof manifest>) =>
  ((m.spec.agents[0]!.permissions as Obj).tools as Obj)['srv.do_it'] as Obj;

const run = (m: unknown, o: Parameters<typeof validateManifestSource>[1] = {}) =>
  validateManifestSource(JSON.stringify(m), { layout: 'document', ...o })!;
const errors = (r: { findings: ManifestFinding[] }) =>
  r.findings.filter((f) => f.severity === 'error');
const at = (r: { findings: ManifestFinding[] }) => errors(r).map((f) => `${f.code} ${f.path}`);

/** The pinned schema as it would look with AEP-0011 (metadata.requiredExtensions). */
function schemaWithRequiredExtensions(): Record<string, unknown> {
  const s = structuredClone(AWP_SCHEMA) as { $defs: { Metadata: { properties: Obj } } };
  s.$defs.Metadata.properties.requiredExtensions = { type: 'array', items: { type: 'string' } };
  return s;
}

describe('the x-openagentix-* namespace', () => {
  it('accepts every extension of the registry in its place', () => {
    const r = run(
      manifest((m) => {
        m.spec['x-openagentix-mode'] = 'dark-factory';
        m.spec['x-openagentix-guidelines'] = ['secure-coding@1.0.0'];
        m.spec['x-openagentix-schemas'] = { Ticket: { type: 'object' } };
        m.spec['x-openagentix-runtime'] = { runner: 'container', toolbox: 'git+node' };
        Object.assign(m.spec.agents[0]!, {
          'x-openagentix-description': 'Does it.',
          'x-openagentix-model': { temperature: 0.2, maxTokensPerCall: 1000 },
          'x-openagentix-outputs': [{ format: 'json', target: 'chat/post' }],
          'x-openagentix-simulation': { responses: [{ text: 'ok' }] },
          'x-openagentix-credentialEnv': { token: 'MY_TOKEN' },
          'x-openagentix-runtime': { harness: 'claude-code' },
        });
        Object.assign(m.spec.workflow[0]!, {
          'x-openagentix-when': 'event.priority == "high"',
          'x-openagentix-input': { from: ['event'] },
          'x-openagentix-output': { schema: { type: 'object' }, onInvalid: 'retry' },
          'x-openagentix-access': 'read-only',
        });
        Object.assign(toolPerm(m), {
          'x-openagentix-args': {
            key: { type: 'string', required: true, pattern: '^A-\\d+$', maxLength: 16 },
          },
          'x-openagentix-allowAdditionalArgs': false,
          'x-openagentix-maxCallsPerRun': 2,
          'x-openagentix-classification': 'internal',
        });
      }),
    );
    expect(errors(r)).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('rejects a name in the namespace that does not exist (a typo would drop a limit silently)', () => {
    const r = run(manifest((m) => (toolPerm(m)['x-openagentix-maxCallPerRun'] = 1)));
    expect(at(r)).toEqual([
      'extension.unknown /spec/agents/0/permissions/tools/srv.do_it/x-openagentix-maxCallPerRun',
    ]);
    expect(r.valid).toBe(false);
    expect(errors(r)[0]!.message).toContain('x-openagentix-maxCallPerRun');
  });

  it('rejects a known name on an object it is not defined for', () => {
    const r = run(
      manifest((m) => {
        m.spec.agents[0]!['x-openagentix-when'] = 'true';
        m.spec.workflow[0]!['x-openagentix-mode'] = 'standard';
        (m.metadata as Obj)['x-openagentix-description'] = 'x';
        m.spec['triggers'] = [{ type: 'manual', 'x-openagentix-args': {} }];
        toolPerm(m)['x-openagentix-access'] = 'write';
      }),
    );
    expect(at(r).sort()).toEqual(
      [
        'extension.misplaced /metadata/x-openagentix-description',
        'extension.misplaced /spec/agents/0/permissions/tools/srv.do_it/x-openagentix-access',
        'extension.misplaced /spec/agents/0/x-openagentix-when',
        'extension.misplaced /spec/triggers/0/x-openagentix-args',
        'extension.misplaced /spec/workflow/0/x-openagentix-mode',
      ].sort(),
    );
  });

  it('rejects an extension on a reference or remote agent, a policy and the document root', () => {
    const ref = run(
      manifest((m) => {
        m.spec.agents.push({
          id: 'b',
          ref: { name: 'other', version: '1.0.0' },
          'x-openagentix-description': 'x',
        });
        m['x-openagentix-mode'] = 'standard';
      }),
    );
    expect(at(ref).sort()).toEqual([
      'extension.misplaced /spec/agents/1/x-openagentix-description',
      'extension.misplaced /x-openagentix-mode',
    ]);
    const policy = run({
      apiVersion: 'awp.agenticworkflowprotocol.org/v1alpha1',
      kind: 'Policy',
      metadata: { name: 'p', version: '1.0.0', owner: 'team-a', classification: 'internal' },
      spec: {
        rules: [{ id: 'r', when: { action: 'a.b' }, effect: 'deny', 'x-openagentix-args': {} }],
      },
    });
    expect(at(policy)).toEqual(['extension.misplaced /spec/rules/0/x-openagentix-args']);
  });

  it('validates the values and reports the path inside the value', () => {
    const r = run(
      manifest((m) => {
        Object.assign(m.spec.agents[0]!, { 'x-openagentix-model': { temperature: 5, extra: 1 } });
        Object.assign(m.spec.workflow[0]!, { 'x-openagentix-access': 'rw' });
        Object.assign(toolPerm(m), {
          'x-openagentix-maxCallsPerRun': 0,
          'x-openagentix-args': { key: { type: 'string', surprise: true } },
          'x-openagentix-classification': 'top-secret',
        });
        m.spec['x-openagentix-runtime'] = { runner: 'docker' };
      }),
    );
    expect(at(r).sort()).toEqual(
      [
        'extension.invalid /spec/agents/0/x-openagentix-model/temperature',
        'extension.invalid /spec/agents/0/x-openagentix-model/extra',
        'extension.invalid /spec/workflow/0/x-openagentix-access',
        'extension.invalid /spec/agents/0/permissions/tools/srv.do_it/x-openagentix-maxCallsPerRun',
        'extension.invalid /spec/agents/0/permissions/tools/srv.do_it/x-openagentix-args/key/surprise',
        'extension.invalid /spec/agents/0/permissions/tools/srv.do_it/x-openagentix-classification',
        'extension.invalid /spec/x-openagentix-runtime/runner',
      ].sort(),
    );
  });

  it('ignores x- fields of other vendors and treats data maps as data', () => {
    const r = run(
      manifest((m) => {
        m.spec['x-acme-thing'] = { 'x-openagentix-anything': 1 };
        (m.metadata as Obj).labels = { 'x-openagentix-label': 'v' };
        m.spec.agents[0]!['x-acme-flag'] = true;
        (m.spec.agents[0]!.permissions as Obj).tools = {
          'srv.do_it': { allow: true },
          'x-openagentix-fake.tool': { allow: true, 'x-openagentix-maxCallsPerRun': 1 },
        };
      }),
    );
    expect(errors(r)).toEqual([]);
  });

  it('works for kind Agent: the spec is the agent', () => {
    const base = {
      apiVersion: 'awp.agenticworkflowprotocol.org/v1alpha1',
      kind: 'Agent',
      metadata: { name: 'solo', version: '1.0.0', owner: 'team-a', classification: 'internal' },
      spec: {
        model: { provider: 'simulated', name: 'sim-1' },
        instructions: 'x',
        'x-openagentix-description': 'solo',
        permissions: { tools: { 'srv.do_it': { allow: true, 'x-openagentix-maxCallsPerRun': 1 } } },
      },
    };
    expect(errors(run(base))).toEqual([]);
    (base.spec as Obj)['x-openagentix-mode'] = 'standard';
    expect(at(run(base))).toEqual(['extension.misplaced /spec/x-openagentix-mode']);
  });

  it('rejects credential-shaped literals inside extension values (AWP does not look there)', () => {
    const r = run(
      manifest((m) => {
        Object.assign(m.spec.agents[0]!, {
          'x-openagentix-simulation': {
            responses: [
              {
                text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
                toolCalls: [{ server: 's', tool: 't', args: { apiKey: 'plain' } }],
              },
            ],
          },
        });
      }),
    );
    expect(at(r)).toEqual([
      'extension.secret /spec/agents/0/x-openagentix-simulation/responses/0/toolCalls/0/args/apiKey',
      'extension.secret /spec/agents/0/x-openagentix-simulation/responses/0/text',
    ]);
  });

  it('the registry knows exactly what the exporter can write', () => {
    const known = new Set(knownExtensionNames());
    const written = new Set<string>();
    for (const file of exampleFiles()) {
      const r = exportOf(definitionOf(readExample(file)));
      if (!r.ok) continue;
      walk(r.manifest, (key) => key.startsWith('x-') && written.add(key));
    }
    expect(written.size).toBeGreaterThan(0);
    for (const name of written) expect(known.has(name), name).toBe(true);
    for (const name of Object.values(EXPORTER_CRITICAL)) expect(known.has(name), name).toBe(true);
    // every critical extension of the exporter is critical here, and the other way round
    const mine = new Set(
      Object.values(OAX_CRITICAL_EXTENSIONS).flat().concat('x-openagentix-runtime'),
    );
    expect(mine).toEqual(new Set(Object.values(EXPORTER_CRITICAL)));
  });
});

describe('critical extensions and metadata.requiredExtensions', () => {
  const withCritical = () =>
    manifest((m) => {
      toolPerm(m)['x-openagentix-maxCallsPerRun'] = 1;
    });

  it('the pinned schema has no requiredExtensions: a manifest cannot declare it (field named), and it warns', () => {
    const m = withCritical();
    const r = run(m);
    expect(r.valid).toBe(true);
    expect(
      r.findings.filter((f) => f.code === 'extension.critical-not-declared').map((f) => f.path),
    ).toEqual(['/spec/agents/0/permissions/tools/srv.do_it/x-openagentix-maxCallsPerRun']);
    (m.metadata as Obj).requiredExtensions = ['x-openagentix-maxCallsPerRun'];
    const bad = run(m);
    expect(at(bad)).toEqual(['schema.additionalProperties /metadata/requiredExtensions']);
  });

  it('only the restricting member of x-openagentix-runtime is critical', () => {
    const harness = run(
      manifest((m) => (m.spec.agents[0]!['x-openagentix-runtime'] = { harness: 'opencode' })),
    );
    expect(harness.findings.some((f) => f.code === 'extension.critical-not-declared')).toBe(false);
    const runner = run(
      manifest((m) => (m.spec.agents[0]!['x-openagentix-runtime'] = { runner: 'container' })),
    );
    expect(
      runner.findings.filter((f) => f.code === 'extension.critical-not-declared'),
    ).toHaveLength(1);
  });

  it('with requiredExtensions in the pin: unknown names are refused, critical ones must be listed', () => {
    const schemas = { awp: schemaWithRequiredExtensions() };
    const m = withCritical();
    expect(at(run(m, { schemas }))).toEqual([
      'extension.required-missing /spec/agents/0/permissions/tools/srv.do_it/x-openagentix-maxCallsPerRun',
    ]);
    (m.metadata as Obj).requiredExtensions = ['x-openagentix-maxCallsPerRun'];
    expect(errors(run(m, { schemas }))).toEqual([]);
    expect(
      run(m, { schemas }).findings.some((f) => f.code === 'extension.critical-not-declared'),
    ).toBe(false);
    (m.metadata as Obj).requiredExtensions = [
      'x-openagentix-maxCallsPerRun',
      'x-openagentix-teleport',
      'x-acme-thing',
    ];
    const r = run(m, { schemas });
    expect(at(r)).toEqual([
      'extension.required-unknown /metadata/requiredExtensions/1',
      'extension.required-unknown /metadata/requiredExtensions/2',
    ]);
    expect(errors(r)[0]!.message).toContain('x-openagentix-teleport');
    expect(r.valid).toBe(false);
  });

  it('refuses a manifest that requires an unknown extension even when nothing else is wrong', () => {
    const schemas = { awp: schemaWithRequiredExtensions() };
    const m = manifest((x) => ((x.metadata as Obj).requiredExtensions = ['x-future-thing']));
    expect(at(run(m, { schemas }))).toEqual([
      'extension.required-unknown /metadata/requiredExtensions/0',
    ]);
  });

  it('an optional extension needs no listing', () => {
    const schemas = { awp: schemaWithRequiredExtensions() };
    const m = manifest((x) => (x.spec.agents[0]!['x-openagentix-description'] = 'd'));
    expect(errors(run(m, { schemas }))).toEqual([]);
  });
});
