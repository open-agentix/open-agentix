import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as core from '../../core/src/index.js';
import type { JsonObject } from '../../core/src/index.js';
import {
  DEFAULT_BASELINE_FILE,
  baselineIds,
  baselineOf,
  collectReport,
  compareToBaseline,
  createEngine,
  createReference,
  formatSummary,
  judgeCase,
  loadCore,
  loadExamples,
  main,
  parseArgs,
  sortCases,
  summarize,
  type Engine,
  type Reference,
  type Report,
  type ReportCase,
} from '../../../scripts/awp/conformance.mjs';

const mk = (over: Partial<ReportCase>): ReportCase => ({
  group: 'validator',
  id: 'validator:x',
  file: 'x',
  status: 'pass',
  ...over,
});

describe('judgeCase (pass criterion of the reference checker)', () => {
  const invalid = { expect: 'invalid', code: 'id.duplicate', path: '/spec/agents/1/id' };
  it('accepts a valid case without errors and rejects one with errors', () => {
    expect(judgeCase({ expect: 'valid' }, [])).toEqual({ ok: true });
    const r = judgeCase({ expect: 'valid' }, [{ code: 'schema.type', path: '/a' }]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('schema.type /a');
  });

  it('needs the indexed code at the indexed path (descendants match)', () => {
    expect(judgeCase(invalid, [{ code: 'id.duplicate', path: '/spec/agents/1/id' }])).toEqual({
      ok: true,
      codeMatch: true,
    });
    expect(
      judgeCase({ ...invalid, path: '/spec' }, [{ code: 'id.duplicate', path: '/spec/a' }]).ok,
    ).toBe(true);
    expect(judgeCase(invalid, [{ code: 'id.duplicate', path: '/spec/agents/2/id' }]).ok).toBe(
      false,
    );
    expect(judgeCase(invalid, [{ code: 'id.other', path: '/spec/agents/1/id' }]).ok).toBe(false);
  });

  it('reports an accepted invalid manifest', () => {
    const r = judgeCase(invalid, []);
    expect(r).toEqual({
      ok: false,
      detail: 'expected id.duplicate at /spec/agents/1/id, but the manifest was accepted',
    });
  });

  it('compares the path only for a structural schema.* code and records the code match', () => {
    const t = { expect: 'invalid', code: 'schema.enum', path: '/spec/x' };
    expect(judgeCase(t, [{ code: 'schema.const', path: '/spec/x' }])).toEqual({
      ok: true,
      codeMatch: false,
    });
    expect(judgeCase(t, [{ code: 'schema.enum', path: '/spec/x' }])).toMatchObject({
      codeMatch: true,
    });
    expect(judgeCase(t, [{ code: 'schema.const', path: '/spec/y' }]).ok).toBe(false);
  });

  it('rejects errors of another family next to the expected one', () => {
    const r = judgeCase(invalid, [
      { code: 'id.duplicate', path: '/spec/agents/1/id' },
      { code: 'schema.type', path: '/other' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('another family');
  });

  it('does not require a path when the index has none', () => {
    expect(
      judgeCase({ expect: 'invalid', code: 'yaml.parse-error' }, [
        { code: 'yaml.parse-error', path: '' },
      ]).ok,
    ).toBe(true);
  });
});

describe('report helpers', () => {
  const cases = [
    mk({ group: 'golden', id: 'golden:b' }),
    mk({ group: 'validator', id: 'validator:b', status: 'fail', detail: 'boom' }),
    mk({ group: 'validator', id: 'validator:a' }),
    mk({ group: 'export', id: 'export:a', status: 'skipped' }),
    mk({ group: 'reference', id: 'reference:a', atSupportedProfiles: 'differs' }),
  ];

  it('sorts by group, then id, without changing the input', () => {
    const before = [...cases];
    expect(sortCases(cases).map((c) => c.id)).toEqual([
      'validator:a',
      'validator:b',
      'reference:a',
      'export:a',
      'golden:b',
    ]);
    expect(cases).toEqual(before);
  });

  it('counts per group; skipped cases are outside the pass rate', () => {
    const s = summarize(cases);
    expect(s).toMatchObject({ total: 5, passed: 3, failed: 1, skipped: 1, passRate: 0.75 });
    expect(s.groups.validator).toMatchObject({ total: 2, passed: 1, failed: 1, passRate: 0.5 });
    expect(s.groups.export).toMatchObject({ total: 1, passed: 0, skipped: 1, passRate: null });
    expect(s.validatorAndExportsAllPass).toBe(false);
    expect(s.differAtSupportedProfiles).toBe(1);
    expect(summarize([mk({})]).validatorAndExportsAllPass).toBe(true);
    expect(summarize([]).validatorAndExportsAllPass).toBe(false);
  });

  it('builds the baseline from passing cases only and reads both formats', () => {
    const b = baselineOf({ cases });
    expect(b.passing).toEqual(['golden:b', 'reference:a', 'validator:a']);
    expect(baselineIds(b)).toEqual(b.passing);
    expect(baselineIds(['x'])).toEqual(['x']);
    expect(() => baselineIds({ passing: 'x' })).toThrow('expected');
    expect(() => baselineIds([1])).toThrow('expected');
    expect(() => baselineIds(null)).toThrow('expected');
  });

  describe('regression gate', () => {
    it('passes when every required case passes; never-passed failures do not gate', () => {
      const r = compareToBaseline({ cases }, [{ passing: ['validator:a', 'golden:b'] }]);
      expect(r.regressions).toEqual([]);
      expect(r.neverPassed).toEqual(['validator:b']);
      expect(r.required).toBe(2);
    });

    it('fails when a required case fails, is skipped or has disappeared', () => {
      const r = compareToBaseline({ cases }, [
        { passing: ['validator:b', 'export:a', 'gone'] },
        ['validator:a'],
      ]);
      expect(r.regressions).toEqual([
        { id: 'export:a', reason: 'status skipped' },
        { id: 'gone', reason: 'case is missing from the report' },
        { id: 'validator:b', reason: 'status fail: boom' },
      ]);
      expect(r.neverPassed).toEqual([]);
    });
  });

  it('formats a summary with failures, the gate and the notice (no claim)', () => {
    const report = {
      awp: { version: 'v1alpha1', commit: 'abc' },
      suite: { name: 's', version: '1' },
      profiles: { validatorSupports: ['core'] },
      summary: summarize(cases),
      cases,
    } as unknown as Report;
    const text = formatSummary(
      report,
      compareToBaseline({ cases }, [{ passing: ['validator:b', 'validator:a'] }]),
    );
    expect(text).toContain('FAIL validator:b\n       boom');
    expect(text).toContain('REGRESSION validator:b');
    expect(text).toContain('1 validator cases need a profile');
    expect(text).toContain('not a conformance statement');
    expect(text).not.toContain('All vendored cases pass');
    const good = formatSummary({ ...report, summary: summarize([mk({})]) } as Report);
    expect(good).toContain('All vendored cases pass');
    expect(good).not.toContain('Regression gate');
    expect(text).not.toMatch(/\bconformant to AWP\b(?!.*not)/);
  });

  it('parses the arguments', () => {
    expect(parseArgs([])).toMatchObject({
      out: 'awp-report.json',
      baselines: [DEFAULT_BASELINE_FILE],
      writeBaseline: false,
    });
    expect(
      parseArgs(['--out', 'r.json', '--baseline', 'a', '--baseline', 'b', '--quiet']),
    ).toMatchObject({
      out: 'r.json',
      baselines: ['a', 'b'],
      quiet: true,
    });
    expect(parseArgs(['--write-baseline', '--baseline-out', 'x'])).toMatchObject({
      writeBaseline: true,
      baselines: [],
      baselineOut: 'x',
    });
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument');
  });
});

describe(
  'harness against the real validator, exporter and vendored checker',
  { timeout: 120_000 },
  () => {
    let reference: Reference;
    let closeReal: () => void;
    let tmp: string;
    let inputs: ReturnType<typeof loadExamples>;
    let report: Report;
    const engine = createEngine(core);

    beforeAll(async () => {
      tmp = mkdtempSync(path.join(tmpdir(), 'awp-conformance-test-'));
      const real = createReference();
      closeReal = () => real.close();
      // the vendored checker is deterministic: spawn it once per distinct input
      const suiteRun = real.runSuite();
      const seen = new Map<string, ReturnType<Reference['check']>>();
      reference = {
        runSuite: () => suiteRun,
        check: (manifest, profiles) => {
          const key = JSON.stringify([manifest, profiles]);
          if (!seen.has(key)) seen.set(key, real.check(manifest, profiles));
          return seen.get(key)!;
        },
        close: closeReal,
      };
      inputs = loadExamples(core);
      report = await collectReport({ engine, ...inputs, reference });
    }, 120_000);
    afterAll(() => {
      closeReal();
      rmSync(tmp, { recursive: true, force: true });
    });

    it('measures every vendored case, the vendored suite, every export and every golden', () => {
      const s = report.summary;
      expect(report.awp).toMatchObject({ version: 'v1alpha1', status: 'draft' });
      expect(report.awp.commit).toBe(
        JSON.parse(
          readFileSync(new URL('../vendor/awp-v1alpha1/PROVENANCE.json', import.meta.url), 'utf8'),
        ).source.commit,
      );
      const index = JSON.parse(
        readFileSync(
          new URL('../vendor/awp-v1alpha1/conformance/index.json', import.meta.url),
          'utf8',
        ),
      ) as { tests: unknown[] };
      expect(s.groups.validator!.total).toBe(index.tests.length);
      expect(s.groups.reference!.total).toBeGreaterThanOrEqual(index.tests.length);
      expect(s.groups.export!.passed).toBeGreaterThanOrEqual(7);
      expect(s.groups.golden!.passed).toBeGreaterThanOrEqual(7);
      expect(s.failed).toBe(0);
      expect(s.validatorAndExportsAllPass).toBe(true);
      expect(report.cases.map((c) => c.id)).toEqual(sortCases(report.cases).map((c) => c.id));
      expect(new Set(report.cases.map((c) => c.id)).size).toBe(report.cases.length);
    });

    it('is identical on every run (no timestamps, no paths)', async () => {
      const again = await collectReport({ engine, ...loadExamples(core), reference });
      expect(JSON.stringify(again)).toBe(JSON.stringify(report));
      expect(JSON.stringify(report)).not.toContain(tmpdir());
    });

    it('lists the four AWP-native examples as exported without a critical extension', () => {
      for (const name of [
        'manual-summarizer',
        'nightly-digest',
        'webhook-intake',
        'approved-publisher',
      ])
        expect(report.cases.find((c) => c.id === `export:awp/${name}.agents.md`)).toMatchObject({
          status: 'pass',
          outcome: 'exported',
        });
    });

    it('reports refusals of examples as skipped, with the refusal codes', () => {
      const refused = report.cases.filter((c) => c.outcome === 'refused');
      expect(refused.length).toBeGreaterThan(0);
      for (const c of refused) {
        expect(c.status).toBe('skipped');
        expect(c.refusal).toEqual(expect.any(Array));
      }
    });

    it('matches the committed baseline exactly (a new or changed case needs a reviewed baseline update)', () => {
      const committed = JSON.parse(readFileSync(DEFAULT_BASELINE_FILE, 'utf8')) as {
        passing: string[];
      };
      expect(committed.passing).toEqual([...new Set(committed.passing)].sort());
      expect(baselineOf(report).passing).toEqual(committed.passing);
      expect(compareToBaseline(report, [committed]).regressions).toEqual([]);
    });

    it('states no conformance claim', () => {
      expect(report.notice).toContain('not a conformance statement');
      expect(JSON.stringify(report)).not.toMatch(/"conformant"\s*:\s*true/);
    });

    describe('mutations: a broken validator or exporter makes the gate fail', () => {
      const gate = (r: Report) => compareToBaseline(r, [baselineOf(report)]).regressions;

      it('a validator that accepts everything', async () => {
        const broken: Engine = { ...engine, validate: () => ({ findings: [] }) };
        const r = await collectReport({ engine: broken, ...inputs, reference });
        const failed = gate(r);
        expect(failed.length).toBeGreaterThan(50);
        expect(failed.every((f) => f.id.startsWith('validator:'))).toBe(true);
      });

      it('a validator that rejects everything', async () => {
        const broken: Engine = {
          ...engine,
          validate: () => ({ findings: [{ severity: 'error', code: 'schema.type', path: '' }] }),
        };
        const r = await collectReport({ engine: broken, ...inputs, reference });
        expect(
          gate(r).some((f) => f.id.startsWith('validator:valid/') || f.id.includes(':3.')),
        ).toBe(true);
        expect(gate(r).some((f) => f.id.startsWith('export:'))).toBe(true);
      });

      it('a validator that drops one rule (duplicate agent ids)', async () => {
        const broken: Engine = {
          ...engine,
          validate: (s, o) => {
            const r = engine.validate(s, o);
            return { findings: r.findings.filter((f) => f.code !== 'id.duplicate') };
          },
        };
        const r = await collectReport({ engine: broken, ...inputs, reference });
        const ids = gate(r).map((f) => f.id);
        expect(ids).toContain('validator:3.4-duplicate-agent-id');
        expect(ids.every((id) => id.startsWith('validator:'))).toBe(true);
        expect(ids.length).toBeLessThan(5);
      });

      it('an exporter that writes a wrong digest', async () => {
        const broken = loadExamples({
          ...core,
          exportAwpManifest: (...args: Parameters<typeof core.exportAwpManifest>) => {
            const r = core.exportAwpManifest(...args);
            if (!r.ok) return r;
            const manifest = structuredClone(r.manifest) as {
              metadata: { integrity: { digest: string } };
              spec: { approval?: unknown };
            };
            manifest.metadata.integrity.digest = `sha256:${'0'.repeat(64)}`;
            return { ...r, manifest: manifest as unknown as JsonObject };
          },
        });
        const r = await collectReport({ engine, ...broken, reference });
        const ids = gate(r).map((f) => f.id);
        expect(ids).toContain('export:awp/release-notes.agents.md');
        expect(ids).toContain('golden:awp/release-notes.awp.json');
      });

      it('an exporter that drops an approval requirement is caught by the golden files', async () => {
        const broken = loadExamples({
          ...core,
          exportAwpManifest: (...args: Parameters<typeof core.exportAwpManifest>) => {
            const r = core.exportAwpManifest(...args);
            if (!r.ok) return r;
            const manifest = structuredClone(r.manifest) as {
              metadata: { integrity: { digest: string } };
              spec: { approval?: unknown };
            };
            delete manifest.spec.approval;
            return { ...r, manifest: manifest as unknown as JsonObject };
          },
        });
        const r = await collectReport({ engine, ...broken, reference });
        expect(gate(r).map((f) => f.id)).toContain('golden:awp/approved-publisher.awp.json');
      });

      it('an exporter that stops exporting', async () => {
        const broken = loadExamples({
          ...core,
          exportAwpManifest: () => ({
            ok: false,
            findings: [{ code: 'unknown_field', path: '', message: '' }],
          }),
        });
        const r = await collectReport({ engine, ...broken, reference });
        expect(gate(r).map((f) => f.id)).toContain('export:awp/nightly-digest.agents.md');
      });

      it('a corrupted golden file and an example without a golden file', async () => {
        const badGolden = structuredClone(inputs.goldens);
        badGolden[0]!.manifest.metadata.description = 'edited by hand';
        badGolden[0]!.jcs = core.jcs(badGolden[0]!.manifest);
        const r = await collectReport({ engine, ...inputs, goldens: badGolden, reference });
        expect(gate(r).map((f) => f.id)).toContain(`golden:${badGolden[0]!.file}`);
        const missing = await collectReport({
          engine,
          ...inputs,
          goldens: inputs.goldens.slice(1),
          reference,
        });
        expect(
          missing.cases.some((c) => c.id.startsWith('golden:missing:') && c.status === 'fail'),
        ).toBe(true);
      });

      it('a critical extension in an export is a failure', async () => {
        const noisy: Engine = {
          ...engine,
          validate: (s, o) => {
            const r = engine.validate(s, o);
            return {
              findings: [
                ...r.findings,
                { severity: 'warning', code: 'extension.critical-not-declared', path: '/spec' },
              ],
            };
          },
        };
        const r = await collectReport({ engine: noisy, ...inputs, reference });
        expect(r.cases.find((c) => c.id === 'export:awp/nightly-digest.agents.md')).toMatchObject({
          status: 'fail',
          detail: expect.stringContaining('critical extension'),
        });
      });

      it('a reference checker that fails', async () => {
        const broken: Reference = {
          ...reference,
          check: async () => ({ valid: false, diagnostics: [], error: 'no output' }),
          runSuite: async () => ({
            results: [{ id: 'c', file: 'f', expect: 'valid', ok: false, detail: 'bad' }],
          }),
        };
        const r = await collectReport({ engine, ...inputs, reference: broken });
        expect(r.cases.find((c) => c.id === 'reference:c')).toMatchObject({
          status: 'fail',
          detail: 'bad',
        });
        expect(
          r.cases.find((c) => c.id === 'export:awp/nightly-digest.agents.md')?.detail,
        ).toContain('reference checker: no output');
      });
    });

    describe('main', () => {
      const logs = () => {
        const lines: string[] = [];
        return {
          lines,
          log: (m: string) => lines.push(m),
          error: (m: string) => lines.push(`ERR ${m}`),
        };
      };

      it('writes the report and exits 0 against the committed baseline', async () => {
        const out = logs();
        const file = path.join(tmp, 'report.json');
        const code = await main(['--out', file], out, { core, reference });
        expect(code).toBe(0);
        const written = JSON.parse(readFileSync(file, 'utf8')) as Report;
        expect(JSON.stringify(written)).toBe(JSON.stringify(report));
        expect(out.lines.join('\n')).toContain('Regression gate');
        expect(out.lines.at(-1)).toBe(`report: ${file}`);
      });

      it('exits 1 on a regression against a baseline and 0 without one', async () => {
        const base = path.join(tmp, 'base.json');
        writeFileSync(base, JSON.stringify({ passing: ['validator:does-not-exist'] }));
        const out = logs();
        expect(
          await main(['--out', path.join(tmp, 'a.json'), '--baseline', base, '--quiet'], out, {
            core,
            reference,
          }),
        ).toBe(1);
        expect(
          await main(
            ['--out', path.join(tmp, 'b.json'), '--baseline', path.join(tmp, 'none.json')],
            logs(),
            {
              core,
              reference,
            },
          ),
        ).toBe(0);
      });

      it('writes a baseline only when asked, to the file asked for', async () => {
        const target = path.join(tmp, 'new-baseline.json');
        const out = logs();
        expect(
          await main(
            [
              '--out',
              path.join(tmp, 'c.json'),
              '--write-baseline',
              '--baseline-out',
              target,
              '--quiet',
            ],
            out,
            { core, reference },
          ),
        ).toBe(0);
        expect(JSON.parse(readFileSync(target, 'utf8')).passing).toEqual(
          baselineOf(report).passing,
        );
      });

      it('exits 2 on bad arguments and when the core build is missing', async () => {
        const out = logs();
        expect(await main(['--nope'], out)).toBe(2);
        const failing: Reference = {
          ...reference,
          runSuite: async () => {
            throw new Error('checker crashed');
          },
        };
        expect(
          await main(['--out', path.join(tmp, 'd.json')], out, { core, reference: failing }),
        ).toBe(2);
        expect(out.lines.join('\n')).toContain('checker crashed');
        expect(out.lines.join('\n')).toContain('ERR');
        await expect(loadCore(path.join(tmp, 'missing.js'))).rejects.toThrow(
          'pnpm awp:conformance',
        );
      });
    });
  },
);
