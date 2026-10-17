import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  awpManifestDigest,
  jcs,
  splitFrontMatter,
  type ExportResult,
  type JsonObject,
} from '../src/index.js';
import { pinErrors, referenceDigest } from './awp-pin.js';
import {
  EXAMPLES_DIR,
  definitionOf,
  exampleFiles,
  exportOf,
  readExample,
  walk,
} from './awp-fixtures.js';

/** Outcome per example. A change here is a decision, not an accident. */
const EXPECTED: Record<string, 'exported' | 'refused'> = {
  'agents/bug-fix-agent.md': 'refused',
  'agents/code-quality-reviewer.md': 'refused',
  'awp/approved-publisher.agents.md': 'exported',
  'awp/log-reader.agents.md': 'exported',
  'awp/manual-summarizer.agents.md': 'exported',
  'awp/nightly-digest.agents.md': 'exported',
  'awp/release-notes.agents.md': 'exported',
  'awp/ticket-commenter.agents.md': 'exported',
  'awp/webhook-intake.agents.md': 'exported',
  'cve-triage.agents.md': 'refused',
  'ticket-triage.agents.md': 'refused',
  'ticket-updater.agents.md': 'refused',
};

const okOf = (r: ExportResult) => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.findings)}`);
  return r;
};

describe('examples', () => {
  it('lists every example in the expectation table', () => {
    expect(exampleFiles()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(exampleFiles())('%s is exported or refused with field-level findings', (file) => {
    const r = exportOf(definitionOf(readExample(file)));
    expect(r.ok ? 'exported' : 'refused').toBe(EXPECTED[file]);
    if (r.ok) {
      expect(pinErrors(r.manifest, r.profiles)).toEqual([]);
      expect(r.digest).toBe(referenceDigest(r.manifest));
    } else {
      expect(r.findings.length).toBeGreaterThan(0);
      for (const f of r.findings) expect(f.path.length + f.message.length).toBeGreaterThan(0);
      for (const f of r.findings.filter((x) => x.code === 'critical_extension'))
        expect(f).toMatchObject({
          field: expect.any(String),
          extension: expect.stringMatching(/^x-openagentix-/),
        });
    }
  });

  it('refuses ticket-updater with one finding per restricted field', () => {
    const r = exportOf(definitionOf(readExample('ticket-updater.agents.md')));
    if (r.ok) throw new Error('expected a refusal');
    expect(r.findings.map((f) => `${f.field} ${f.path}`)).toEqual([
      'args agents.0.tools.0.args',
      'allowAdditionalArgs agents.0.tools.0.allowAdditionalArgs',
      'args agents.0.tools.1.args',
      'allowAdditionalArgs agents.0.tools.1.allowAdditionalArgs',
      'maxCallsPerRun agents.0.tools.1.maxCallsPerRun',
    ]);
  });
});

const publishedLogReader = () => definitionOf(readExample('awp/log-reader.agents.md'));

describe('golden manifests', () => {
  const cases: [string, () => ReturnType<typeof definitionOf>][] = [
    ['awp/release-notes', () => definitionOf(readExample('awp/release-notes.agents.md'))],
    ['awp/ticket-commenter', () => definitionOf(readExample('awp/ticket-commenter.agents.md'))],
    ['awp/log-reader', publishedLogReader],
    ...['approved-publisher', 'manual-summarizer', 'nightly-digest', 'webhook-intake'].map(
      (name) =>
        [`awp/${name}`, () => definitionOf(readExample(`awp/${name}.agents.md`))] as [
          string,
          () => ReturnType<typeof definitionOf>,
        ],
    ),
  ];

  it.each(cases)(
    '%s matches its golden file and validates against the pinned schema',
    (name, load) => {
      const r = okOf(exportOf(load()));
      const file = `${EXAMPLES_DIR}${name}.awp.json`;
      // Regenerate with UPDATE_GOLDEN=1, then run prettier (the files are formatted like the repo).
      if (process.env.UPDATE_GOLDEN === '1')
        writeFileSync(file, `${JSON.stringify(r.manifest, null, 2)}\n`);
      const golden = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
      expect(jcs(golden)).toBe(jcs(r.manifest));
      expect(pinErrors(golden, r.profiles)).toEqual([]);
      expect((golden.metadata as JsonObject).integrity).toEqual({ digest: r.digest });
    },
  );

  it('exports release-notes as a two-step chain with the declared secrets, budget and egress', () => {
    const { manifest } = okOf(exportOf(definitionOf(readExample('awp/release-notes.agents.md'))));
    const spec = manifest.spec as JsonObject;
    const steps = spec.workflow as JsonObject[];
    expect(steps.map((s) => s.id)).toEqual(['drafter', 'proofreader']);
    expect(steps[1]).toMatchObject({
      dependsOn: ['drafter'],
      task: '${{ steps.drafter.outputs.result }}',
    });
    expect(spec.secrets).toEqual([
      { name: 'changelog-reader', source: 'openagentix', scope: ['drafter'] },
    ]);
    expect(spec.triggers).toEqual([
      { type: 'schedule', cron: '0 8 * * 1', timezone: 'Europe/Berlin' },
      { type: 'manual' },
    ]);
    const drafter = (spec.agents as JsonObject[])[0]!;
    expect(drafter.permissions).toMatchObject({
      default: 'deny',
      network: { egress: 'deny', allowHosts: ['api.example.org'] },
      secrets: ['changelog-reader'],
    });
    expect(drafter['x-openagentix-credentialEnv']).toEqual({
      'changelog-reader': 'CHANGELOG_TOKEN',
    });
  });

  it('exports an approval-required grant as approval.requiredFor with onTimeout fail', () => {
    const r = okOf(exportOf(definitionOf(readExample('awp/ticket-commenter.agents.md'))));
    expect(r.profiles).toEqual(['core', 'governance', 'mcp']);
    expect((r.manifest.spec as JsonObject).approval).toEqual({
      requiredFor: ['tickets.add_comment'],
      approvers: [{ role: 'operator' }, { role: 'admin' }],
      timeout: '1800s',
      onTimeout: 'fail',
    });
  });
});

/** Small deterministic generator so a failing case can be replayed. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function shuffleKeys(value: unknown, rand: () => number): unknown {
  if (Array.isArray(value)) return value.map((v) => shuffleKeys(v, rand));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value).map(([k, v]) => [k, shuffleKeys(v, rand)] as const);
  entries.sort(() => rand() - 0.5);
  return Object.fromEntries(entries);
}

function restyle(source: string, rand: () => number): string {
  const { frontMatter, body } = splitFrontMatter(source);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const value = shuffleKeys(parse(frontMatter), rand);
  const options = {
    indent: pick([2, 3, 4]),
    lineWidth: pick([0, 30, 80]),
    collectionStyle: pick(['any', 'block', 'flow'] as const),
    defaultStringType: pick(['PLAIN', 'QUOTE_DOUBLE', 'QUOTE_SINGLE'] as const),
  };
  let yaml = stringify(value, options);
  // yaml 2.9.1 can corrupt a folded double-quoted string inside a flow collection; the property
  // is about the exporter, so a style the library cannot round-trip falls back to no folding.
  if (JSON.stringify(parse(yaml)) !== JSON.stringify(value))
    yaml = stringify(value, { ...options, lineWidth: 0 });
  return `---\n${yaml}---\n${body}`;
}

describe('digest stability', () => {
  // Required-extension mode exports every example, so the property covers all fields.
  const full = (source: string) =>
    exportOf(definitionOf(source), { requiredExtensionsSupported: true });

  it.each(exampleFiles())('%s: key order and YAML style do not change the digest', (file) => {
    const source = readExample(file);
    const expected = okOf(full(source));
    const rand = rng(file.length * 7919);
    for (let i = 0; i < 25; i++) {
      const again = okOf(full(restyle(source, rand)));
      expect(jcs(again.manifest)).toBe(jcs(expected.manifest));
      expect(again.digest).toBe(expected.digest);
    }
  });

  it('changes when any x-openagentix-* value changes', () => {
    const { manifest } = okOf(full(readExample('agents/code-quality-reviewer.md')));
    const before = awpManifestDigest(manifest);
    let mutated = 0;
    walk(manifest, (key, value, parent) => {
      if (!key.startsWith('x-openagentix-')) return;
      parent[key] = { changed: true };
      expect(awpManifestDigest(manifest)).not.toBe(before);
      parent[key] = value as never;
      mutated++;
    });
    expect(mutated).toBeGreaterThan(3);
    expect(awpManifestDigest(manifest)).toBe(before);
  });

  it('changes when a source restriction changes', () => {
    const source = readExample('ticket-updater.agents.md');
    const changed = source.replace('maxCallsPerRun: 1', 'maxCallsPerRun: 2');
    expect(changed).not.toBe(source);
    expect(okOf(full(changed)).digest).not.toBe(okOf(full(source)).digest);
  });

  it('ignores the markdown prose outside the agent sections', () => {
    const source = readExample('awp/release-notes.agents.md');
    const edited = source.replace('# Release notes', '# Release notes (edited title)');
    const a = okOf(exportOf(definitionOf(source)));
    const b = okOf(exportOf(definitionOf(edited)));
    expect(b.digest).toBe(a.digest);
    expect(b.sourceDigest).not.toBe(a.sourceDigest);
  });
});

describe('immutability', () => {
  it('exports the same bytes from the stored JSON form, without touching it', () => {
    const stored = publishedLogReader();
    const fresh = okOf(exportOf(stored));
    const roundTrip = JSON.parse(JSON.stringify(stored)) as typeof stored;
    const frozen = structuredClone(roundTrip);
    const deepFreeze = (v: unknown): void => {
      if (v !== null && typeof v === 'object') {
        Object.values(v).forEach(deepFreeze);
        Object.freeze(v);
      }
    };
    deepFreeze(frozen);
    expect(jcs(okOf(exportOf(frozen)).manifest)).toBe(jcs(fresh.manifest));
    expect(JSON.stringify(roundTrip)).toBe(JSON.stringify(stored));
  });
});
