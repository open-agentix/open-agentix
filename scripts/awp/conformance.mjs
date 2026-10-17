#!/usr/bin/env node
// AWP conformance harness (AWP-4): the vendored AWP conformance suite against what OpenAgentix really
// validates and exports, offline, with a machine-readable report and a regression gate.
//
//   pnpm awp:conformance                      builds packages/core, runs the harness, writes awp-report.json
//   node scripts/awp/conformance.mjs [--out FILE] [--baseline FILE]... [--write-baseline [--baseline-out FILE]] [--quiet]
//
// What it runs:
//   validator    every case of the vendored conformance/index.json through the OpenAgentix validator
//   reference    the vendored suite itself (`awp-check.mjs run`, unmodified, on a temporary copy)
//   export       every examples/*.agents.md through the real exporter, the result through the vendored
//                reference checker with --verify-digest (a refusal is "skipped", not a pass)
//   golden       every examples/awp/*.awp.json equals the real export of its agents.md and passes the
//                reference checker with --verify-digest
//
// The report states measured pass counts only. It is not a conformance statement and the harness never
// edits a tracked file (except with the explicit --write-baseline). Nothing is fetched: all inputs are
// local files (the vendored copy, the examples, the built packages/core).
import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const DEFAULT_VENDOR_DIR = path.join(ROOT, 'packages/awp/vendor/awp-v1alpha1');
export const DEFAULT_EXAMPLES_DIR = path.join(ROOT, 'examples');
export const DEFAULT_CATALOG_FILE = path.join(
  ROOT,
  'packages/awp/conformance/example-catalog.json',
);
export const DEFAULT_BASELINE_FILE = path.join(ROOT, 'packages/awp/conformance/baseline.json');
export const DEFAULT_REPORT_FILE = 'awp-report.json';
export const REPORT_VERSION = 1;
export const NOTICE =
  'Measured pass counts only. This is not a conformance statement: OpenAgentix is not conformant to any AWP profile (AWP is a draft, v1alpha1).';

const GROUPS = ['validator', 'reference', 'export', 'golden'];

// ---------------------------------------------------------------------------------------------------
// Pure helpers (report format, comparison)

/** Pass criterion of the reference checker for one indexed case, applied to the findings of a validator. */
export function judgeCase(test, errors) {
  const family = (code) => String(code).split('.')[0];
  if (test.expect === 'valid') {
    return errors.length === 0
      ? { ok: true }
      : { ok: false, detail: `expected acceptance, got ${describe(errors)}` };
  }
  const onPath = (e) =>
    test.path === undefined || e.path === test.path || e.path.startsWith(`${test.path}/`);
  const hit = errors.filter(onPath);
  const exact = hit.some((e) => e.code === test.code);
  // `schema.*` names the JSON Schema keyword of the reference schema: another structure may report a
  // different structural code for the same path, so there the path decides. Every other code must match.
  const structural = String(test.code).startsWith('schema.');
  const matched = structural ? hit.length > 0 : exact;
  const stray = errors.filter((e) => family(e.code) !== family(test.code));
  if (!matched)
    return {
      ok: false,
      detail: errors.length
        ? `expected ${test.code} at ${test.path ?? '*'}, got ${describe(errors)}`
        : `expected ${test.code} at ${test.path ?? '*'}, but the manifest was accepted`,
    };
  if (stray.length > 0)
    return { ok: false, detail: `unexpected errors of another family: ${describe(stray)}` };
  return { ok: true, codeMatch: exact };
}

function describe(errors) {
  return errors
    .slice(0, 5)
    .map((e) => `${e.code} ${e.path}`)
    .join('; ');
}

/** Counts per group and overall; `skipped` cases are not part of the pass rate. */
export function summarize(cases) {
  const count = (list) => {
    const passed = list.filter((c) => c.status === 'pass').length;
    const failed = list.filter((c) => c.status === 'fail').length;
    const skipped = list.length - passed - failed;
    const measured = passed + failed;
    return {
      total: list.length,
      passed,
      failed,
      skipped,
      passRate: measured === 0 ? null : Math.round((passed / measured) * 10000) / 10000,
    };
  };
  const groups = {};
  for (const g of GROUPS) groups[g] = count(cases.filter((c) => c.group === g));
  const total = count(cases);
  const gated = cases.filter((c) => c.group === 'validator' || c.group === 'export');
  const gatedFailed = gated.filter((c) => c.status === 'fail').length;
  return {
    ...total,
    groups,
    // (a) the vendored cases through the validator and (b) real exports through the reference checker
    validatorAndExportsAllPass: gated.length > 0 && gatedFailed === 0,
    // information only: cases whose verdict changes when only the profiles the validator supports are on
    differAtSupportedProfiles: cases.filter((c) => c.atSupportedProfiles === 'differs').length,
  };
}

/** Sorted, deterministic case list: group order, then id. */
export function sortCases(cases) {
  return [...cases].sort(
    (a, b) =>
      GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Ids a baseline requires to pass. Accepts the baseline file format or a plain array. */
export function baselineIds(baseline) {
  const ids = Array.isArray(baseline) ? baseline : baseline?.passing;
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string'))
    throw new Error('baseline: expected {"passing": [case ids]}');
  return ids;
}

/**
 * Regression gate: a case that passes in the baseline (main) must pass now. A case of the baseline that
 * no longer exists is a regression too (a pin upgrade or a removed example must update the baseline in
 * the same change). Cases that never passed do not fail the gate.
 */
export function compareToBaseline(report, baselines) {
  const required = new Set(baselines.flatMap(baselineIds));
  const byId = new Map(report.cases.map((c) => [c.id, c]));
  const regressions = [];
  for (const id of [...required].sort()) {
    const c = byId.get(id);
    if (!c) regressions.push({ id, reason: 'case is missing from the report' });
    else if (c.status !== 'pass')
      regressions.push({ id, reason: `status ${c.status}${c.detail ? `: ${c.detail}` : ''}` });
  }
  const neverPassed = report.cases.filter((c) => c.status === 'fail' && !required.has(c.id));
  return { required: required.size, regressions, neverPassed: neverPassed.map((c) => c.id) };
}

/** The baseline file for a report: ids of the passing cases. */
export function baselineOf(report) {
  return {
    description:
      'Case ids that pass on main. The conformance harness fails when one of them stops passing. Regenerate deliberately with `node scripts/awp/conformance.mjs --write-baseline` after a reviewed change (new case, pin upgrade).',
    reportVersion: REPORT_VERSION,
    passing: report.cases
      .filter((c) => c.status === 'pass')
      .map((c) => c.id)
      .sort(),
  };
}

/** Human summary (stable text, no timestamps or paths). */
export function formatSummary(report, comparison) {
  const s = report.summary;
  const line = (name, g) =>
    `  ${name.padEnd(10)} ${g.passed}/${g.total - g.skipped} passed` +
    (g.skipped ? `, ${g.skipped} skipped` : '') +
    (g.failed ? `, ${g.failed} FAILED` : '');
  const out = [
    `AWP ${report.awp.version} (draft), suite ${report.suite.name} ${report.suite.version}, AWP commit ${report.awp.commit}`,
    ...GROUPS.map((g) => line(g, s.groups[g])),
    `  total      ${s.passed}/${s.total - s.skipped} passed, ${s.failed} failed, ${s.skipped} skipped`,
  ];
  for (const c of report.cases.filter((x) => x.status === 'fail'))
    out.push(`  FAIL ${c.id}${c.detail ? `\n       ${c.detail}` : ''}`);
  if (s.differAtSupportedProfiles > 0)
    out.push(
      `  ${s.differAtSupportedProfiles} validator cases need a profile the validator does not support (${report.profiles.validatorSupports.join(', ')}); they pass only with the suite's six profiles switched on.`,
    );
  if (s.validatorAndExportsAllPass)
    out.push(
      'All vendored cases pass through the OpenAgentix validator and all exports pass the reference checker.',
    );
  if (comparison) {
    out.push(`Regression gate: ${comparison.required} cases are required to pass.`);
    for (const r of comparison.regressions) out.push(`  REGRESSION ${r.id}: ${r.reason}`);
    if (comparison.neverPassed.length)
      out.push(
        `  ${comparison.neverPassed.length} failing cases never passed on main (not gated).`,
      );
  }
  out.push(NOTICE);
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// The vendored reference checker (unmodified, on a temporary copy)

function resolvePackageDir(name, fromFile) {
  const require = createRequire(fromFile);
  let dir = path.dirname(require.resolve(name));
  while (!existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  return dir;
}

const run = (args, cwd) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 120_000, env: { PATH: process.env.PATH ?? '' } },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    ),
  );

/**
 * Prepares a temporary copy of the vendored checker: the upstream layout it expects (an empty
 * `spec/v1alpha1/examples/`, because the specification examples are not vendored) and `ajv` / `yaml` from
 * this repository's install. The vendored files are copied, never changed.
 */
export function createReference(vendorDir = DEFAULT_VENDOR_DIR) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'awp-reference-'));
  for (const entry of ['conformance', 'schema', 'package.json'])
    cpSync(path.join(vendorDir, entry), path.join(tmp, entry), { recursive: true });
  mkdirSync(path.join(tmp, 'spec/v1alpha1/examples'), { recursive: true });
  mkdirSync(path.join(tmp, 'node_modules'));
  const coreManifest = path.join(ROOT, 'packages/core/package.json');
  for (const pkg of ['ajv', 'yaml'])
    symlinkSync(resolvePackageDir(pkg, coreManifest), path.join(tmp, 'node_modules', pkg), 'dir');
  const checker = path.join('conformance', 'awp-check.mjs');
  let counter = 0;
  return {
    /** `awp-check.mjs run --json`: the result of the vendored suite itself. */
    async runSuite() {
      const r = await run([checker, 'run', '--json'], tmp);
      let parsed;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        throw new Error(`the vendored checker did not print a report: ${r.stderr.slice(0, 500)}`);
      }
      return parsed;
    },
    /** `awp-check.mjs check --verify-digest` on one manifest value. */
    async check(manifest, profiles) {
      const file = path.join(tmp, `manifest-${(counter += 1)}.json`);
      writeFileSync(file, JSON.stringify(manifest));
      const r = await run(
        [checker, 'check', '--json', '--verify-digest', '--profiles', profiles.join(','), file],
        tmp,
      );
      let parsed;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        return { valid: false, diagnostics: [], error: r.stderr.slice(0, 500) || 'no output' };
      }
      return parsed;
    },
    close() {
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Collecting the report

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const errorsOf = (diagnostics) =>
  (diagnostics ?? [])
    .filter((d) => d.severity === 'error')
    .map((d) => ({ code: d.code, path: d.path ?? '' }));

/**
 * Builds the report.
 *  - `engine`: `{ validate(source, {profiles, verifyDigest}) -> {findings:[{severity, code, path}]},
 *    supportedProfiles }` (the OpenAgentix validator).
 *  - `examples`: `[{ file, outcome: 'exported'|'refused', manifest?, digest?, profiles?, findings? }]`
 *    (the real exporter applied to the example catalog) and `goldens`: `[{ file, manifest|null }]`.
 *  - `reference`: `createReference()`.
 */
export async function collectReport({ engine, examples, goldens, reference, vendorDir }) {
  const dir = vendorDir ?? DEFAULT_VENDOR_DIR;
  const provenance = readJson(path.join(dir, 'PROVENANCE.json'));
  const index = readJson(path.join(dir, 'conformance/index.json'));
  const cases = [];
  const add = (c) => cases.push(c);

  // (a) vendored cases through the OpenAgentix validator
  for (const t of index.tests) {
    const source = readFileSync(path.join(dir, 'conformance', t.file), 'utf8');
    const profiles = t.profiles ?? index.defaults.profiles;
    const verifyDigest = t.verifyDigest ?? index.defaults.verifyDigest;
    const result = engine.validate(source, { profiles, verifyDigest });
    const errors = errorsOf(result.findings);
    const verdict = judgeCase(t, errors);
    const entry = {
      group: 'validator',
      id: `validator:${t.id}`,
      file: t.file,
      expect: t.expect,
      status: verdict.ok ? 'pass' : 'fail',
      ...(t.code ? { expectedCode: t.code } : {}),
      ...(t.path !== undefined ? { expectedPath: t.path } : {}),
      ...(verdict.ok && t.expect === 'invalid' ? { codeMatch: verdict.codeMatch } : {}),
      ...(verdict.detail ? { detail: verdict.detail } : {}),
    };
    // information only: the same case with the profiles the validator supports in production
    if (engine.supportedProfiles) {
      const prod = engine.validate(source, {
        profiles: engine.supportedProfiles,
        verifyDigest,
      });
      const prodVerdict = judgeCase(t, errorsOf(prod.findings));
      entry.atSupportedProfiles = prodVerdict.ok ? 'same' : 'differs';
    }
    add(entry);
  }
  // every file of valid/ and invalid/ must be indexed (as in the reference suite)
  const listed = new Set(index.tests.map((t) => t.file));
  for (const sub of ['valid', 'invalid'])
    for (const f of readdirSync(path.join(dir, 'conformance', sub)).sort())
      if (!listed.has(`${sub}/${f}`))
        add({
          group: 'validator',
          id: `validator:unindexed:${sub}/${f}`,
          file: `${sub}/${f}`,
          expect: sub,
          status: 'fail',
          detail: 'file is not listed in index.json',
        });

  // (c) the vendored suite itself
  const suite = await reference.runSuite();
  for (const r of suite.results)
    add({
      group: 'reference',
      id: `reference:${r.id}`,
      file: r.file,
      expect: r.expect,
      status: r.ok ? 'pass' : 'fail',
      ...(r.ok ? {} : { detail: r.detail }),
    });

  // (b) exports through the reference checker
  for (const ex of examples) {
    const id = `export:${ex.file}`;
    if (ex.outcome !== 'exported') {
      add({
        group: 'export',
        id,
        file: ex.file,
        status: 'skipped',
        outcome: 'refused',
        refusal: [...new Set(ex.findings.map((f) => f.code))].sort(),
      });
      continue;
    }
    const checked = await reference.check(ex.manifest, ex.profiles);
    const refErrors = errorsOf(checked.diagnostics);
    const own = engine.validate(JSON.stringify(ex.manifest), {
      profiles: ex.profiles,
      verifyDigest: true,
    });
    const ownErrors = errorsOf(own.findings);
    const critical = own.findings.filter((f) => f.code === 'extension.critical-not-declared');
    const problems = [];
    if (!checked.valid || refErrors.length)
      problems.push(`reference checker: ${checked.error ?? describe(refErrors)}`);
    if (ownErrors.length) problems.push(`OpenAgentix validator: ${describe(ownErrors)}`);
    if (critical.length) problems.push(`${critical.length} critical extension(s) in the export`);
    add({
      group: 'export',
      id,
      file: ex.file,
      status: problems.length ? 'fail' : 'pass',
      outcome: 'exported',
      digest: ex.digest,
      profiles: ex.profiles,
      ...(problems.length ? { detail: problems.join(' | ') } : {}),
    });
  }

  // goldens: produced by the real exporter, accepted by the reference checker
  for (const g of goldens) {
    const id = `golden:${g.file}`;
    const problems = [];
    if (!g.export) problems.push('no export: the agents.md source is missing or is refused');
    else if (g.export.jcs !== g.jcs) problems.push('differs from the real export (regenerate)');
    if (g.export?.profiles) {
      const checked = await reference.check(g.manifest, g.export.profiles);
      const refErrors = errorsOf(checked.diagnostics);
      if (!checked.valid || refErrors.length)
        problems.push(`reference checker: ${checked.error ?? describe(refErrors)}`);
    }
    add({
      group: 'golden',
      id,
      file: g.file,
      status: problems.length ? 'fail' : 'pass',
      ...(problems.length ? { detail: problems.join(' | ') } : {}),
    });
  }
  for (const ex of examples.filter((e) => e.outcome === 'exported' && e.hasGoldenDir)) {
    if (!goldens.some((g) => g.source === ex.file))
      add({
        group: 'golden',
        id: `golden:missing:${ex.file}`,
        file: ex.file,
        status: 'fail',
        detail: 'an exported example under examples/awp has no golden file',
      });
  }

  const sorted = sortCases(cases);
  return {
    reportVersion: REPORT_VERSION,
    notice: NOTICE,
    suite: { name: index.suite, version: index.version },
    awp: {
      version: provenance.awpVersion,
      status: provenance.status,
      repository: provenance.source.repository,
      commit: provenance.source.commit,
      tag: provenance.source.tag,
    },
    profiles: {
      suiteDefaults: index.defaults.profiles,
      validatorSupports: engine.supportedProfiles ?? null,
    },
    summary: summarize(sorted),
    cases: sorted,
  };
}

// ---------------------------------------------------------------------------------------------------
// Inputs from the repository (built packages/core, example catalog)

/** The OpenAgentix validator and exporter from the built `packages/core`. */
export async function loadCore(distFile = path.join(ROOT, 'packages/core/dist/index.js')) {
  if (!existsSync(distFile))
    throw new Error(
      `${distFile} is missing: run \`pnpm awp:conformance\` (it builds packages/core)`,
    );
  return import(pathToFileURL(distFile).href);
}

export function createEngine(core) {
  return {
    supportedProfiles: [...core.SUPPORTED_AWP_PROFILES],
    validate(source, { profiles, verifyDigest }) {
      const r = core.validateManifestSource(source, { layout: 'document', profiles, verifyDigest });
      return { findings: r?.findings ?? [{ severity: 'error', code: 'format', path: '' }] };
    },
  };
}

/** Exports every agents.md example with the real exporter; reads the golden files. */
export function loadExamples(
  core,
  examplesDir = DEFAULT_EXAMPLES_DIR,
  catalogFile = DEFAULT_CATALOG_FILE,
) {
  const catalog = readJson(catalogFile);
  const list = (dir, match) =>
    existsSync(path.join(examplesDir, dir))
      ? readdirSync(path.join(examplesDir, dir))
          .filter((f) => match.test(f))
          .map((f) => `${dir}${f}`)
      : [];
  const files = [
    ...list('', /\.agents\.md$/),
    ...list('agents/', /\.md$/),
    ...list('awp/', /\.agents\.md$/),
  ].sort();
  const exportOf = (file) => {
    const source = readFileSync(path.join(examplesDir, file), 'utf8');
    const { definition, errors } = core.expandProfiles(core.parseAgentDefinition(source), catalog);
    if (errors.length > 0)
      return {
        file,
        outcome: 'refused',
        findings: errors.map((e) => ({ code: e.code ?? 'publish_refused' })),
      };
    const r = core.exportAwpManifest(definition, { ownerTeam: definition.owner });
    return r.ok
      ? {
          file,
          outcome: 'exported',
          manifest: r.manifest,
          digest: r.digest,
          profiles: r.profiles,
          jcs: core.jcs(r.manifest),
          hasGoldenDir: file.startsWith('awp/'),
        }
      : { file, outcome: 'refused', findings: r.findings };
  };
  const examples = files.map(exportOf);
  const goldens = list('awp/', /\.awp\.json$/).map((file) => {
    const manifest = readJson(path.join(examplesDir, file));
    const source = file.replace(/\.awp\.json$/, '.agents.md');
    const made = examples.find((e) => e.file === source);
    return {
      file,
      source,
      manifest,
      jcs: core.jcs(manifest),
      export: made?.outcome === 'exported' ? made : null,
    };
  });
  return { examples, goldens };
}

// ---------------------------------------------------------------------------------------------------
// CLI

export function parseArgs(argv) {
  const o = {
    out: DEFAULT_REPORT_FILE,
    baselines: [],
    writeBaseline: false,
    baselineOut: DEFAULT_BASELINE_FILE,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--baseline') o.baselines.push(argv[++i]);
    else if (a === '--write-baseline') o.writeBaseline = true;
    else if (a === '--baseline-out') o.baselineOut = argv[++i];
    else if (a === '--quiet') o.quiet = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.baselines.length === 0 && !o.writeBaseline) o.baselines.push(DEFAULT_BASELINE_FILE);
  return o;
}

/** Runs the harness. Returns the exit code: 0 ok, 1 regression, 2 harness error. */
export async function main(argv, out = console, deps = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    out.error(e.message);
    return 2;
  }
  let ownReference;
  try {
    const core = deps.core ?? (await loadCore());
    const reference = deps.reference ?? (ownReference = createReference());
    const { examples, goldens } = loadExamples(core);
    const report = await collectReport({
      engine: createEngine(core),
      examples,
      goldens,
      reference,
    });
    writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
    if (opts.writeBaseline) {
      writeFileSync(opts.baselineOut, `${JSON.stringify(baselineOf(report), null, 2)}\n`);
      out.log(`baseline written: ${opts.baselineOut}`);
    }
    const baselines = opts.baselines.filter((f) => existsSync(f)).map((f) => readJson(f));
    const comparison = baselines.length ? compareToBaseline(report, baselines) : null;
    if (!opts.quiet) out.log(formatSummary(report, comparison));
    out.log(`report: ${opts.out}`);
    return comparison && comparison.regressions.length > 0 ? 1 : 0;
  } catch (e) {
    out.error(`awp conformance harness failed: ${e.message}`);
    return 2;
  } finally {
    ownReference?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
