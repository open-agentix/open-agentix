import { describe, expect, it } from 'vitest';
import {
  expandProfiles,
  exportAwpManifest,
  type AccessCatalog,
  type ExportFinding,
  type ExportResult,
  type JsonObject,
  type PublishedDefinition,
} from '../src/index.js';
import { CRITICAL_EXTENSIONS } from '../src/awp/export-context.js';
import { pinErrors } from './awp-pin.js';
import { exportOf, probe, readExample, parsedOf, walk } from './awp-fixtures.js';

type Obj = Record<string, unknown>;

const refused = (r: ExportResult): ExportFinding[] => {
  if (r.ok) throw new Error('expected a refusal');
  return r.findings;
};
const exported = (r: ExportResult) => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.findings)}`);
  return r;
};
const agent0 = (o: { agents: Obj[] }) => o.agents[0]!;
const tool0 = (o: { agents: Obj[] }) => (agent0(o).tools as Obj[])[0]!;
const at = (manifest: JsonObject, path: (string | number)[]): unknown =>
  path.reduce<unknown>((v, k) => (v as Obj | undefined)?.[k as string], manifest);

interface Row {
  field: keyof typeof CRITICAL_EXTENSIONS;
  patch: (o: { agents: Obj[] } & Obj) => void;
  path: string;
  /** Where the value lands in the manifest once the pin offers `requiredExtensions`. */
  home: (string | number)[];
  value: unknown;
  /** A second field the same patch makes critical (an explicit allowAdditionalArgs). */
  also?: keyof typeof CRITICAL_EXTENSIONS;
}

const PERMISSION = ['spec', 'agents', 0, 'permissions', 'tools', 'srv.do_it'];
const TABLE: Row[] = [
  {
    field: 'when',
    patch: (o) => (agent0(o).when = 'steps.x.output.ok == true'),
    path: 'agents.0.when',
    home: ['spec', 'workflow', 0, 'x-openagentix-when'],
    value: 'steps.x.outputs.result.ok == true',
  },
  {
    field: 'input',
    patch: (o) => (agent0(o).input = { from: ['event'] }),
    path: 'agents.0.input',
    home: ['spec', 'workflow', 0, 'x-openagentix-input'],
    value: { from: ['event'] },
  },
  {
    field: 'output',
    patch: (o) => (agent0(o).output = { schema: { type: 'object' }, onInvalid: 'retry' }),
    path: 'agents.0.output',
    home: ['spec', 'workflow', 0, 'x-openagentix-output'],
    value: { schema: { type: 'object' }, onInvalid: 'retry' },
  },
  {
    field: 'schemas',
    patch: (o) => (o.schemas = { Found: { type: 'object' } }),
    path: 'schemas',
    home: ['spec', 'x-openagentix-schemas'],
    value: { Found: { type: 'object' } },
  },
  {
    field: 'access',
    patch: (o) => (agent0(o).access = 'read-only'),
    path: 'agents.0.access',
    home: ['spec', 'workflow', 0, 'x-openagentix-access'],
    value: 'read-only',
  },
  {
    field: 'args',
    patch: (o) => (tool0(o).args = { key: { type: 'string' } }),
    path: 'agents.0.tools.0.args',
    also: 'allowAdditionalArgs',
    home: [...PERMISSION, 'x-openagentix-args'],
    value: { key: { type: 'string', required: false } },
  },
  {
    field: 'allowAdditionalArgs',
    patch: (o) => (tool0(o).allowAdditionalArgs = false),
    path: 'agents.0.tools.0.allowAdditionalArgs',
    home: [...PERMISSION, 'x-openagentix-allowAdditionalArgs'],
    value: false,
  },
  {
    field: 'maxCallsPerRun',
    patch: (o) => (tool0(o).maxCallsPerRun = 2),
    path: 'agents.0.tools.0.maxCallsPerRun',
    home: [...PERMISSION, 'x-openagentix-maxCallsPerRun'],
    value: 2,
  },
  {
    field: 'classification',
    patch: (o) => (tool0(o).classification = 'restricted'),
    path: 'agents.0.tools.0.classification',
    home: [...PERMISSION, 'x-openagentix-classification'],
    value: 'restricted',
  },
  {
    field: 'runtime.runner',
    patch: (o) => (o.runtime = { runner: 'container' }),
    path: 'runtime.runner',
    home: ['spec', 'x-openagentix-runtime', 'runner'],
    value: 'container',
  },
  {
    field: 'runtime.runner',
    patch: (o) => (agent0(o).runtime = { runner: 'container' }),
    path: 'agents.0.runtime.runner',
    home: ['spec', 'agents', 0, 'x-openagentix-runtime', 'runner'],
    value: 'container',
  },
  {
    field: 'runtime.toolbox',
    patch: (o) => (o.runtime = { toolbox: 'trivy' }),
    path: 'runtime.toolbox',
    home: ['spec', 'x-openagentix-runtime', 'toolbox'],
    value: 'trivy',
  },
  {
    field: 'runtime.toolbox',
    patch: (o) => (agent0(o).toolbox = 'trivy'),
    path: 'agents.0.toolbox',
    home: ['spec', 'agents', 0, 'x-openagentix-runtime', 'toolbox'],
    value: 'trivy',
  },
  {
    field: 'guidelines',
    patch: (o) => (o.guidelines = ['secure-coding@1.0.0']),
    path: 'guidelines',
    home: ['spec', 'x-openagentix-guidelines'],
    value: ['secure-coding@1.0.0'],
  },
];

describe('critical fields (decision D3)', () => {
  it('exports the probe without any extension or requirement', () => {
    const r = exported(exportOf(probe()));
    expect(pinErrors(r.manifest, r.profiles)).toEqual([]);
    expect(JSON.stringify(r.manifest)).not.toContain('x-openagentix-');
    expect(at(r.manifest, ['metadata', 'requiredExtensions'])).toBeUndefined();
  });

  it.each(TABLE)('refuses $field at $path with exactly one finding', (row) => {
    const findings = refused(exportOf(probe(row.patch)));
    expect(findings[0]).toEqual(
      expect.objectContaining({
        code: 'critical_extension',
        field: row.field,
        extension: CRITICAL_EXTENSIONS[row.field],
        path: row.path,
      }),
    );
    // constraints on a grant that allows more arguments say so explicitly: one more field
    expect(findings.map((f) => f.field)).toEqual([row.field, ...(row.also ? [row.also] : [])]);
  });

  it.each(TABLE)('lists $field in requiredExtensions once the pin offers them', (row) => {
    const r = exported(exportOf(probe(row.patch), { requiredExtensionsSupported: true }));
    expect(at(r.manifest, row.home)).toEqual(row.value);
    expect(at(r.manifest, ['metadata', 'requiredExtensions'])).toEqual(
      [CRITICAL_EXTENSIONS[row.field], ...(row.also ? [CRITICAL_EXTENSIONS[row.also]] : [])].sort(),
    );
  });

  it('lists every critical extension a manifest carries, and no operational one', () => {
    const r = exported(
      exportOf(parsedOf(readExample('agents/bug-fix-agent.md')), {
        requiredExtensionsSupported: true,
      }),
    );
    const required = new Set(at(r.manifest, ['metadata', 'requiredExtensions']) as string[]);
    const critical = new Set<string>(Object.values(CRITICAL_EXTENSIONS));
    const present = new Set<string>();
    walk(r.manifest, (key) => {
      if (key.startsWith('x-openagentix-')) present.add(key);
    });
    for (const name of present) expect(required.has(name), name).toBe(critical.has(name));
    expect([...required]).toEqual([...required].sort());
    // Without the requirement list the manifest is structurally a valid v1alpha1 document.
    const stripped = structuredClone(r.manifest) as { metadata: Obj };
    delete stripped.metadata.requiredExtensions;
    delete stripped.metadata.integrity;
    expect(
      pinErrors({ ...stripped, metadata: { ...stripped.metadata } }, [
        'core',
        'mcp',
        'governance',
      ]).filter((e) => !e.startsWith('digest')),
    ).toEqual([]);
  });

  it('writes the default allowAdditionalArgs as an explicit restriction', () => {
    const def = probe((o) => delete tool0(o).allowAdditionalArgs);
    const findings = refused(exportOf(def));
    expect(findings.map((f) => f.field)).toEqual(['allowAdditionalArgs']);
  });

  it('treats a stored grant without allowAdditionalArgs or args as restricted', () => {
    // A definition stored by another build may lack the defaults the parser fills in.
    const def = probe();
    const grant = def.agents[0]!.tools[0] as Partial<(typeof def.agents)[0]['tools'][0]>;
    delete grant.allowAdditionalArgs;
    delete grant.args;
    expect(refused(exportOf(def)).map((f) => f.field)).toEqual(['allowAdditionalArgs']);
  });

  it('reports every restricted field of every grant, not only the first', () => {
    const def = probe((o) => {
      Object.assign(tool0(o), { allowAdditionalArgs: false, maxCallsPerRun: 1, args: { k: {} } });
      agent0(o).when = 'true';
    });
    expect(
      refused(exportOf(def))
        .map((f) => f.field)
        .sort(),
    ).toEqual(['allowAdditionalArgs', 'args', 'maxCallsPerRun', 'when'].sort());
  });

  it('keeps pipeline runtime in-process free of an extension', () => {
    const r = exported(
      exportOf(probe((o) => (o.runtime = { runner: 'in-process', egress: ['a.example.org'] }))),
    );
    expect(at(r.manifest, ['spec', 'agents', 0, 'permissions', 'network'])).toEqual({
      egress: 'deny',
      allowHosts: ['a.example.org'],
    });
    expect(JSON.stringify(r.manifest)).not.toContain('x-openagentix-runtime');
  });
});

describe('owner (decision D15)', () => {
  it.each([null, undefined, ''])('refuses an agent without a team (%j)', (team) => {
    const r = exportAwpManifest(probe(), { ownerTeam: team });
    expect(refused(r).map((f) => f.code)).toEqual(['owner_team_required']);
  });

  it('writes the team as metadata.owner.team', () => {
    const r = exported(exportAwpManifest(probe(), { ownerTeam: 'team-x' }));
    expect(at(r.manifest, ['metadata', 'owner'])).toEqual({ team: 'team-x' });
  });
});

const CATALOG: AccessCatalog = {
  logs: {
    tools: { get_a: 'read', get_b: 'read', put_c: 'write' },
    profiles: { read: ['get_a', 'get_b'] },
    version: 'v1',
    pin: {
      connectionId: 'c0',
      snapshot: {
        digest: 'e'.repeat(64),
        tools: ['get_a', 'get_b', 'put_c'].map((name) => ({ name, inputSchema: {} })),
      },
    },
  },
  /** Declared tools, but no pin: nothing bounds a prefix grant, so it is never enumerated. */
  unpinned: { tools: { get_a: 'read' }, profiles: {}, version: 'v1' },
  pinned: {
    tools: { get_declared: 'read' },
    profiles: {},
    version: 'v1',
    pin: {
      connectionId: 'c1',
      snapshot: {
        digest: 'd'.repeat(64),
        tools: [
          { name: 'get_x', inputSchema: {} },
          { name: 'get_y', inputSchema: {} },
          { name: 'set_z', inputSchema: {} },
        ],
      },
    },
  },
};

const wildcard = (server: string, tool: string) =>
  probe((o) => (o.agents[0]!.tools = [{ server, tool, allowAdditionalArgs: true }]));

/**
 * The stored form of a version published by an older build: the wildcard grant is still in the
 * definition, next to the list recorded at publish. Publish no longer stores this form (it expands a
 * wildcard into explicit grants), but such versions exist and must keep exporting or being refused
 * exactly as before.
 */
const legacyStored = (
  parsed: PublishedDefinition,
  catalog: AccessCatalog = CATALOG,
): PublishedDefinition => {
  const e = expandProfiles(parsed, catalog).definition;
  return {
    ...parsed,
    expansion: e.expansion ?? [],
    toolAccess: e.toolAccess ?? {},
    expansionDigest: e.expansionDigest ?? '',
    ...(e.wildcardExpansion ? { wildcardExpansion: e.wildcardExpansion } : {}),
  };
};

const keysOf = (r: ExportResult): string[] => {
  const tools = at(exported(r).manifest, ['spec', 'agents', 0, 'permissions', 'tools']);
  return Object.keys(tools as Obj);
};

describe('wildcard grants (decision D4)', () => {
  it('enumerates a prefix from the approved snapshot of a pinned connection', () => {
    const def = expandProfiles(wildcard('logs', 'get_*'), CATALOG).definition;
    expect(keysOf(exportOf(def))).toEqual(['logs.get_a', 'logs.get_b']);
  });

  it('prefers the approved snapshot of a pinned connection', () => {
    const def = expandProfiles(wildcard('pinned', 'get_*'), CATALOG).definition;
    expect(keysOf(exportOf(def))).toEqual(['pinned.get_x', 'pinned.get_y']);
    expect(def.wildcardExpansion?.['pinned/get_*']?.source).toBe('pinned-snapshot');
  });

  it('enumerates a bare * as the whole list', () => {
    const def = expandProfiles(wildcard('logs', '*'), CATALOG).definition;
    expect(keysOf(exportOf(def))).toEqual(['logs.get_a', 'logs.get_b', 'logs.put_c']);
  });

  it('never writes a * anywhere in a permission key or tool list', () => {
    for (const tool of ['get_*', '*', 'put_*']) {
      const def = expandProfiles(wildcard('logs', tool), CATALOG).definition;
      const r = exported(exportOf(def));
      const stars: string[] = [];
      walk(r.manifest, (key, value) => {
        if (key.includes('*')) stars.push(key);
        if (key === 'tools' && Array.isArray(value))
          stars.push(
            ...value
              .flatMap((v) => (typeof v === 'string' ? [v] : []))
              .filter((v) => v.includes('*')),
          );
      });
      expect(stars).toEqual([]);
    }
  });

  it('refuses without a recorded tool list (parsed only, unknown connection, no match)', () => {
    const codes = (d: Parameters<typeof exportOf>[0]) => refused(exportOf(d)).map((f) => f.code);
    expect(codes(wildcard('logs', 'get_*'))).toEqual(['wildcard_expansion_missing']);
    expect(codes(legacyStored(wildcard('nowhere', 'get_*')))).toEqual([
      'wildcard_expansion_missing',
    ]);
    expect(codes(legacyStored(wildcard('unpinned', 'get_*')))).toEqual([
      'wildcard_expansion_missing',
    ]);
    expect(codes(legacyStored(wildcard('logs', 'zzz_*')))).toEqual(['wildcard_expansion_missing']);
  });

  it('refuses a published version of an older build (no wildcardExpansion field)', () => {
    const def = legacyStored(wildcard('logs', 'get_*'));
    const old = JSON.parse(JSON.stringify(def)) as typeof def;
    delete old.wildcardExpansion;
    expect(refused(exportOf(old)).map((f) => f.path)).toEqual(['agents.0.tools.0.tool']);
  });

  it('refuses an empty recorded list instead of exporting a grant of nothing', () => {
    const def = legacyStored(wildcard('logs', 'get_*'));
    def.wildcardExpansion = { 'logs/get_*': { source: 'pinned-snapshot', tools: [] } };
    expect(refused(exportOf(def)).map((f) => f.code)).toEqual(['wildcard_expansion_missing']);
  });

  it('re-filters a recorded list by the pattern and refuses a list that is all foreign', () => {
    const def = legacyStored(wildcard('logs', 'get_*'));
    def.wildcardExpansion = {
      'logs/get_*': { source: 'pinned-snapshot', tools: ['get_a', 'put_c', 'purge'] },
    };
    expect(keysOf(exportOf(def))).toEqual(['logs.get_a']);
    def.wildcardExpansion = { 'logs/get_*': { source: 'pinned-snapshot', tools: ['put_c'] } };
    expect(refused(exportOf(def)).map((f) => f.code)).toEqual(['wildcard_expansion_missing']);
  });

  it('refuses an enumerated name that is not an AWP action identifier', () => {
    const catalog: AccessCatalog = {
      logs: {
        tools: {},
        profiles: {},
        version: 'v1',
        pin: {
          connectionId: 'c',
          snapshot: {
            digest: 'f'.repeat(64),
            tools: ['get_a*b', 'get_ok'].map((name) => ({ name, inputSchema: {} })),
          },
        },
      },
    };
    const def = legacyStored(wildcard('logs', 'get_*'), catalog);
    expect(refused(exportOf(def)).map((f) => f.code)).toEqual(['tool_name_not_representable']);
  });

  it('does not record the enumeration in the expansion digest', () => {
    const plain = expandProfiles(wildcard('logs', 'get_a'), CATALOG).definition;
    const wild = expandProfiles(wildcard('logs', 'get_*'), CATALOG).definition;
    expect(plain.wildcardExpansion).toBeUndefined();
    expect(wild.wildcardExpansion).toEqual({
      'logs/get_*': { source: 'pinned-snapshot', tools: ['get_a', 'get_b'] },
    });
    const sameShape = expandProfiles(wildcard('logs', 'get_*'), { ...CATALOG }).definition;
    expect(sameShape.expansionDigest).toBe(wild.expansionDigest);
  });
});

describe('profile grants', () => {
  const profiled = (o: { agents: Obj[] }) =>
    (o.agents[0]!.tools = [{ server: 'logs', profile: 'read' }]);

  it('exports the grants expanded at publish', () => {
    const def = expandProfiles(probe(profiled), CATALOG).definition;
    expect(keysOf(exportOf(def))).toEqual(['logs.get_a', 'logs.get_b']);
  });

  it('refuses a profile grant that was never expanded', () => {
    expect(refused(exportOf(probe(profiled))).map((f) => f.code)).toEqual([
      'profile_expansion_missing',
    ]);
  });
});

describe('other refusals', () => {
  const code = (r: ExportResult) => refused(r).map((f) => f.code);

  it('refuses a field it does not know instead of dropping it', () => {
    // A stored definition may come from a newer build; the strict parser would not see it.
    const stored = (add: (d: ReturnType<typeof probe>) => void) => {
      const def = probe();
      add(def);
      return exportOf(def);
    };
    expect(
      refused(stored((d) => Object.assign(d, { futureLimit: 3 }))).map(
        (f) => `${f.code} ${f.path}`,
      ),
    ).toEqual(['unknown_field futureLimit']);
    expect(
      refused(stored((d) => Object.assign(d.agents[0]!, { quota: 1 }))).map((f) => f.path),
    ).toEqual(['agents.0.quota']);
    expect(
      refused(stored((d) => Object.assign(d.agents[0]!.tools[0]!, { rate: 1 }))).map((f) => f.path),
    ).toEqual(['agents.0.tools.0.rate']);
  });

  it('refuses a cron schedule with a seconds field or without an explicit time zone', () => {
    const six = probe(
      (o) => (o.triggers = [{ type: 'cron', schedule: '0 0 8 * * 1', timezone: 'UTC' }]),
    );
    expect(code(exportOf(six))).toEqual(['trigger_not_representable']);
    const noZone = probe((o) => (o.triggers = [{ type: 'cron', schedule: '0 8 * * 1' }]));
    expect(refused(exportOf(noZone)).map((f) => `${f.code} ${f.path}`)).toEqual([
      'trigger_not_representable triggers.0.timezone',
    ]);
    const five = probe(
      (o) => (o.triggers = [{ type: 'cron', schedule: '0 8 * * 1', timezone: 'Europe/Berlin' }]),
    );
    const r = exported(exportOf(five));
    expect(at(r.manifest, ['spec', 'triggers', 0])).toEqual({
      type: 'schedule',
      cron: '0 8 * * 1',
      timezone: 'Europe/Berlin',
    });
  });

  it('writes network only for plain egress hosts and refuses what AWP cannot express', () => {
    const none = exported(exportOf(probe()));
    expect(at(none.manifest, ['spec', 'agents', 0, 'permissions', 'network'])).toBeUndefined();
    for (const host of ['10.0.0.0/8', '*.example.org', 'api.example.org:443', 'a b']) {
      const def = probe((o) => (o.runtime = { egress: [host] }));
      expect(
        refused(exportOf(def)).map((f) => f.code),
        host,
      ).toEqual(['egress_not_representable']);
    }
    const step = probe((o) => (agent0(o).runtime = { egress: ['*.bad'] }));
    expect(refused(exportOf(step)).map((f) => f.path)).toEqual(['agents.0.runtime.egress']);
  });

  it('maps webhook, mail and kafka triggers to events and hands the payload to the first step', () => {
    const def = probe((o) => {
      o.triggers = [
        { type: 'webhook', source: 'jira' },
        { type: 'mail', source: 'inbox' },
        { type: 'kafka', topic: 'alerts' },
      ];
    });
    const r = exported(exportOf(def));
    expect(at(r.manifest, ['spec', 'triggers'])).toEqual([
      { type: 'event', source: 'jira', eventType: 'webhook.received' },
      { type: 'event', source: 'inbox', eventType: 'mail.received' },
      { type: 'event', source: 'kafka', eventType: 'message', filter: { topic: 'alerts' } },
    ]);
    expect(at(r.manifest, ['spec', 'workflow', 0, 'task'])).toBe('${{ inputs.event }}');
  });

  it('refuses a label key AWP does not allow', () => {
    expect(code(exportOf(probe((o) => (o.labels = { '-bad': 'x' }))))).toEqual([
      'label_not_representable',
    ]);
  });

  it('refuses two secrets that map to one AWP name, and maps others with a key', () => {
    const two = probe((o) => (agent0(o).credentials = [{ secret: 'a.b' }, { secret: 'a-b' }]));
    expect(code(exportOf(two))).toEqual(['secret_not_representable']);
    const one = probe((o) => (agent0(o).credentials = [{ secret: '9.token', env: 'TOKEN' }]));
    const r = exported(exportOf(one));
    expect(at(r.manifest, ['spec', 'secrets'])).toEqual([
      { name: 's-9-token', source: 'openagentix', scope: ['a'], key: '9.token' },
    ]);
    expect(at(r.manifest, ['spec', 'agents', 0, 'x-openagentix-credentialEnv'])).toEqual({
      's-9-token': 'TOKEN',
    });
  });

  it('refuses a pipeline the workflow cannot express', () => {
    expect(code(exportOf(probe((o) => (o.pipeline = ['a', 'a']))))).toEqual([
      'pipeline_not_representable',
    ]);
    expect(code(exportOf(probe((o) => (o.pipeline = ['a', 'ghost']))))).toEqual([
      'pipeline_not_representable',
    ]);
  });

  it('refuses a tool name that is not an AWP action identifier', () => {
    expect(code(exportOf(probe((o) => (tool0(o).tool = 'a..b'))))).toEqual([
      'tool_name_not_representable',
    ]);
  });

  it('refuses a tool granted twice with different limits', () => {
    const def = probe((o) => {
      const first = tool0(o);
      (agent0(o).tools as Obj[]).push({ ...first, maxCallsPerRun: 3 });
    });
    expect(code(exportOf(def))).toContain('duplicate_grant_conflict');
  });

  it('refuses overlapping grants that differ in approval (the exact grant wins at run time)', () => {
    const def = probe((o) => {
      const first = tool0(o);
      (agent0(o).tools as Obj[]).push({ ...first, approval: 'required' });
    });
    expect(code(exportOf(def))).toEqual(['duplicate_grant_conflict']);
    const overlapping = probe((o) => {
      agent0(o).tools = [
        { server: 'logs', tool: 'get_a', allowAdditionalArgs: true, approval: 'required' },
        { server: 'logs', tool: 'get_*', allowAdditionalArgs: true },
      ];
    });
    expect(code(exportOf(legacyStored(overlapping)))).toEqual(['duplicate_grant_conflict']);
    // Published today the wildcard is replaced by explicit tools and the exact grant keeps its own
    // approval: no conflict, and nothing is looser than at run time.
    const published = expandProfiles(overlapping, CATALOG).definition;
    expect(keysOf(exportOf(published))).toEqual(['logs.get_a', 'logs.get_b']);
  });

  it('merges identical duplicate grants into one entry', () => {
    const def = probe((o) => {
      const first = tool0(o);
      (agent0(o).tools as Obj[]).push({ ...first });
    });
    const r = exported(exportOf(def));
    expect(at(r.manifest, ['spec', 'agents', 0, 'tools'])).toEqual([
      { type: 'mcp', server: 'srv', tools: ['do_it'] },
    ]);
  });

  it('refuses a value outside the JSON data model instead of hashing a lossy form', () => {
    const def = probe();
    def.description = 'broken \uD800 text';
    expect(code(exportOf(def))).toEqual(['not_canonicalizable']);
  });

  it('writes dark-factory mode and model parameters as operational extensions', () => {
    const def = probe((o) => {
      o.mode = 'dark-factory';
      Object.assign(agent0(o), {
        temperature: 0.5,
        maxTokensPerCall: 100,
        description: 'x',
        toolbox: undefined,
      });
    });
    const r = exported(exportOf(def));
    expect(at(r.manifest, ['spec', 'x-openagentix-mode'])).toBe('dark-factory');
    expect(at(r.manifest, ['spec', 'agents', 0, 'x-openagentix-model'])).toEqual({
      temperature: 0.5,
      maxTokensPerCall: 100,
    });
    expect(at(r.manifest, ['spec', 'agents', 0, 'x-openagentix-description'])).toBe('x');
    expect(at(r.manifest, ['metadata', 'requiredExtensions'])).toBeUndefined();
  });

  it('keeps a harness as an operational extension of the runtime', () => {
    const def = probe((o) => (agent0(o).runtime = { harness: 'claude-code' }));
    const r = exported(exportOf(def));
    expect(at(r.manifest, ['spec', 'agents', 0, 'x-openagentix-runtime'])).toEqual({
      harness: 'claude-code',
    });
  });
});
