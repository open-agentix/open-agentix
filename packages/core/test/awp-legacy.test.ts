import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AWP_MANIFESTS_STORABLE,
  LEGACY_CONVERT_COMMAND,
  LEGACY_FORMAT_REMOVED_IN,
  exportAwpManifest,
  isLegacyApiVersion,
  legacyDeprecation,
  legacyFormatPhase,
  legacyRemovedMessage,
  verifyNoWidening,
  type JsonObject,
  type PublishedDefinition,
} from '../src/index.js';
import { definitionOf, probe, readExample } from './awp-fixtures.js';

type Obj = Record<string, unknown>;

describe('legacy format phase (constant tied to the version)', () => {
  it('is deprecated below N+1 and removed from it', () => {
    expect(LEGACY_FORMAT_REMOVED_IN).toBe('0.4.0');
    expect(legacyFormatPhase('0.2.0-alpha.1')).toBe('deprecated');
    expect(legacyFormatPhase('0.3.0')).toBe('deprecated');
    expect(legacyFormatPhase('0.3.99')).toBe('deprecated');
    expect(legacyFormatPhase('0.4.0')).toBe('removed');
    expect(legacyFormatPhase('0.4.1')).toBe('removed');
    expect(legacyFormatPhase('1.0.0')).toBe('removed');
  });

  it('treats a pre-release of N+1 as N+1', () => {
    expect(legacyFormatPhase('0.4.0-alpha.1')).toBe('removed');
  });

  it('never switches a write path off for a version it cannot read', () => {
    for (const v of ['', 'unknown', '0.0.0-unknown', 'v0.4.0', '0.4', '9'.repeat(40)])
      expect(legacyFormatPhase(v === '0.0.0-unknown' ? v : v)).toBe('deprecated');
  });

  it('takes the removal version as a parameter (tests of N+1 need no runtime flag)', () => {
    expect(legacyFormatPhase('0.3.0', '0.3.0')).toBe('removed');
    expect(legacyFormatPhase('0.2.9', '0.3.0')).toBe('deprecated');
  });
});

describe('the removal cannot ship before AWP manifests can be stored', () => {
  it.each(['package.json', 'apps/api/package.json', 'packages/runners/package.json'])(
    'the version in %s is below N+1 while AWP_MANIFESTS_STORABLE is false',
    (file) => {
      const { version } = JSON.parse(
        readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8'),
      ) as { version: string };
      if (legacyFormatPhase(version) === 'removed') expect(AWP_MANIFESTS_STORABLE).toBe(true);
      else expect(legacyFormatPhase(version)).toBe('deprecated');
    },
  );
});

describe('deprecation entry and removal error', () => {
  it('names the code, the removal release and the command', () => {
    const d = legacyDeprecation();
    expect(d).toMatchObject({ code: 'legacy_format', removedIn: LEGACY_FORMAT_REMOVED_IN });
    expect(d.message).toContain(LEGACY_CONVERT_COMMAND);
    expect(d.message).toContain(LEGACY_FORMAT_REMOVED_IN);
    expect(legacyRemovedMessage('x')).toContain(LEGACY_CONVERT_COMMAND);
  });

  it('recognises only the legacy apiVersion', () => {
    expect(isLegacyApiVersion('openagentix.io/v1alpha1')).toBe(true);
    expect(isLegacyApiVersion('awp.agenticworkflowprotocol.org/v1alpha1')).toBe(false);
    expect(isLegacyApiVersion(undefined)).toBe(false);
  });
});

describe('conversion golden files', () => {
  it.each([
    'awp/release-notes.agents.md',
    'awp/log-reader.agents.md',
    'awp/ticket-commenter.agents.md',
  ])('%s converts, and nothing is widened', (file) => {
    const def = definitionOf(readExample(file));
    const r = exportAwpManifest(def, { ownerTeam: def.owner });
    expect(r.ok).toBe(true);
    if (r.ok) expect(verifyNoWidening(def, r.manifest)).toEqual([]);
  });

  it('ticket-updater (argument constraints, call limits) is refused, never converted lossy', () => {
    const def = definitionOf(readExample('ticket-updater.agents.md'));
    const r = exportAwpManifest(def, { ownerTeam: def.owner });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.findings.some((f) => f.code === 'critical_extension')).toBe(true);
  });
});

/** A converted manifest and its source, with an approval-required grant, for the tamper checks. */
function converted(): { def: PublishedDefinition; manifest: JsonObject } {
  const def = probe((o) => {
    (o.agents[0]!.tools as Obj[])[0]!.approval = 'required';
    (o.agents[0]!.tools as Obj[]).push({ server: 'srv', tool: 'other', allowAdditionalArgs: true });
  });
  const r = exportAwpManifest(def, { ownerTeam: 'team-a' });
  if (!r.ok) throw new Error(JSON.stringify(r.findings));
  return { def, manifest: structuredClone(r.manifest) as JsonObject };
}
const agent = (m: JsonObject) => ((m.spec as Obj).agents as Obj[])[0]!;

describe('verifyNoWidening catches a manifest that grants more than the source', () => {
  it('passes the faithful conversion', () => {
    const { def, manifest } = converted();
    expect(verifyNoWidening(def, manifest)).toEqual([]);
    expect((manifest.spec as Obj).approval).toMatchObject({ requiredFor: ['srv.do_it'] });
  });

  it('flags an extra tool permission', () => {
    const { def, manifest } = converted();
    ((agent(manifest).permissions as Obj).tools as Obj)['srv.purge'] = { allow: true };
    expect(verifyNoWidening(def, manifest).map((f) => f.path)).toContain(
      'spec.agents.0.permissions.tools.srv.purge',
    );
  });

  it('flags an extra tool in an MCP source', () => {
    const { def, manifest } = converted();
    ((agent(manifest).tools as Obj[])[0]!.tools as string[]).push('purge');
    expect(verifyNoWidening(def, manifest)).toHaveLength(1);
  });

  it('flags a dropped approval', () => {
    const { def, manifest } = converted();
    delete (manifest.spec as Obj).approval;
    expect(verifyNoWidening(def, manifest)[0]).toMatchObject({
      code: 'grant_widened',
      path: 'spec.approval.requiredFor',
    });
  });

  it('flags a default other than deny, an extra host, an extra secret and a foreign agent', () => {
    const { def, manifest } = converted();
    (agent(manifest).permissions as Obj).default = 'allow';
    (agent(manifest).permissions as Obj).network = { egress: 'deny', allowHosts: ['evil.example'] };
    (agent(manifest).permissions as Obj).secrets = ['stolen'];
    ((manifest.spec as Obj).workflow as Obj[]).push({ id: 'x', type: 'agent', agent: 'ghost' });
    ((manifest.spec as Obj).agents as Obj[]).push({
      id: 'ghost',
      permissions: { default: 'deny' },
    });
    const paths = verifyNoWidening(def, manifest).map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'spec.agents.0.permissions.default',
        'spec.agents.0.permissions.network',
        'spec.agents.0.permissions.secrets',
        'spec.workflow.1',
        'spec.agents.1',
      ]),
    );
  });

  it('flags an approval entry for a tool the source never granted', () => {
    const { def, manifest } = converted();
    ((manifest.spec as Obj).approval as Obj).requiredFor = ['srv.do_it', 'nope.nothing'];
    expect(
      verifyNoWidening(def, manifest)
        .map((f) => f.message)
        .join(),
    ).toContain('nope.nothing');
  });

  it('does not trust a wildcard expansion record that the pattern does not match', () => {
    const def = probe((o) => {
      (o.agents[0]!.tools as Obj[])[0] = {
        server: 'srv',
        tool: 'get_*',
        allowAdditionalArgs: true,
      };
    });
    // Recorded at publish, never part of the file; here it also lists a tool the pattern excludes.
    (def as { wildcardExpansion?: unknown }).wildcardExpansion = {
      'srv/get_*': { tools: ['get_a', 'purge'], connectionVersion: 'v1' },
    };
    const manifest: JsonObject = {
      spec: {
        agents: [
          { id: 'a', permissions: { default: 'deny', tools: { 'srv.purge': { allow: true } } } },
        ],
        workflow: [],
      },
    } as unknown as JsonObject;
    expect(verifyNoWidening(def, manifest)).toHaveLength(1);
  });
});

describe('verifyNoWidening refuses a field it does not model', () => {
  const grantPath = (m: JsonObject) => (m.spec as Obj).agents as Obj[];
  const cases: [string, (m: JsonObject) => void, string][] = [
    [
      'permissions.filesystem.read',
      (m) => ((agent(m).permissions as Obj).filesystem = { read: ['/'] }),
      'spec.agents.0.permissions.filesystem',
    ],
    [
      'permissions.filesystem.write',
      (m) => ((agent(m).permissions as Obj).filesystem = { write: ['/'] }),
      'spec.agents.0.permissions.filesystem',
    ],
    [
      'permissions.environments',
      (m) => ((agent(m).permissions as Obj).environments = ['prod']),
      'spec.agents.0.permissions.environments',
    ],
    [
      'tools[*].resources',
      (m) => ((agent(m).tools as Obj[])[0]!.resources = ['*']),
      'spec.agents.0.tools.0.resources',
    ],
    [
      'spec.permissions',
      (m) => ((m.spec as Obj).permissions = { default: 'allow' }),
      'spec.permissions',
    ],
    [
      'spec.secrets entry field',
      (m) => ((m.spec as Obj).secrets = [{ name: 's', source: 'x', scope: [], value: 'v' }]),
      'spec.secrets.0.value',
    ],
    [
      'spec.mcpServers',
      (m) => ((m.spec as Obj).mcpServers = [{ name: 'evil' }]),
      'spec.mcpServers',
    ],
    [
      'spec.actionGroups',
      (m) => ((m.spec as Obj).actionGroups = [{ name: 'g' }]),
      'spec.actionGroups',
    ],
    [
      'foreign x- extension on an agent',
      (m) => (agent(m)['x-evil-grant'] = true),
      'spec.agents.0.x-evil-grant',
    ],
    [
      'unknown openagentix extension',
      (m) => (agent(m)['x-openagentix-unknown'] = 1),
      'spec.agents.0.x-openagentix-unknown',
    ],
    ['ref-kind agent entry', (m) => grantPath(m).push({ ref: 'other-agent' }), 'spec.agents.1.ref'],
    [
      'agent field outside the model',
      (m) => (agent(m).delegates = ['a']),
      'spec.agents.0.delegates',
    ],
    ['top-level field', (m) => (m.extra = 1), 'extra'],
    [
      'non-MCP tool source',
      (m) => ((agent(m).tools as Obj[])[0]!.type = 'http'),
      'spec.agents.0.tools.0.type',
    ],
    [
      'tool permission field',
      (m) => ((((agent(m).permissions as Obj).tools as Obj)['srv.do_it'] as Obj).scope = 'all'),
      'spec.agents.0.permissions.tools.srv.do_it.scope',
    ],
    [
      'workflow step field',
      (m) => (((m.spec as Obj).workflow as Obj[])[0]!.run = 'sh'),
      'spec.workflow.0.run',
    ],
    [
      'approval field',
      (m) => (((m.spec as Obj).approval as Obj).autoApprove = true),
      'spec.approval.autoApprove',
    ],
    ['malformed agents', (m) => ((m.spec as Obj).agents = {}), 'spec.agents'],
  ];
  it.each(cases)('%s', (_name, mutate, path) => {
    const { def, manifest } = converted();
    mutate(manifest);
    const found = verifyNoWidening(def, manifest);
    expect(found.map((f) => f.path)).toContain(path);
    expect(found.every((f) => f.code === 'grant_widened')).toBe(true);
  });

  it('network access must be denied whenever it is present', () => {
    const { def, manifest } = converted();
    (agent(manifest).permissions as Obj).network = { allowHosts: [] };
    expect(verifyNoWidening(def, manifest).map((f) => f.path)).toContain(
      'spec.agents.0.permissions.network.egress',
    );
  });

  it('accepts everything the exporter writes for the examples (no false positives)', () => {
    for (const file of [
      'awp/release-notes.agents.md',
      'awp/log-reader.agents.md',
      'awp/ticket-commenter.agents.md',
    ]) {
      const def = definitionOf(readExample(file));
      const r = exportAwpManifest(def, { ownerTeam: def.owner });
      expect(r.ok).toBe(true);
    }
  });
});
