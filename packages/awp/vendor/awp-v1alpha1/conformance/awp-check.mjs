#!/usr/bin/env node
// Reference checker for AWP v1alpha1 manifests and the conformance suite.
//
//   node conformance/awp-check.mjs check [--profiles core,governance] [--verify-digest] [--json] <file...>
//   node conformance/awp-check.mjs run   [--json]
//
// Layers: yaml (spec 3.1) -> schema (schema/awp.v1alpha1.json) -> semantic (conformance/semantic.mjs).
// Dependencies: ajv and yaml, both pinned in package-lock.json (development use only).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseAllDocuments, visit, isScalar, isCollection, LineCounter } from 'yaml';
import { semanticCheck, KNOWN_PROFILES } from './semantic.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema', 'awp.v1alpha1.json'), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validateSchema = ajv.compile(schema);

/** Parse a file into manifests, enforcing the YAML restrictions of spec 3.1. */
export function loadManifests(text) {
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, { version: '1.2', schema: 'core', lineCounter: lc, uniqueKeys: true });
  const results = [];
  for (const doc of docs) {
    const diags = [];
    for (const e of doc.errors) diags.push({ severity: 'error', code: 'yaml.parse-error', section: '3.1', path: '', message: e.message.split('\n')[0], pos: e.pos?.[0] });
    for (const w of doc.warnings) {
      const code = /tag/i.test(w.message) ? 'yaml.custom-tag' : 'yaml.warning';
      diags.push({ severity: 'error', code, section: '3.1', path: '', message: w.message.split('\n')[0], pos: w.pos?.[0] });
    }
    visit(doc, {
      Pair(_, pair) {
        const k = pair.key;
        if (isCollection(k) || (isScalar(k) && typeof k.value !== 'string')) {
          diags.push({ severity: 'error', code: 'yaml.non-string-key', section: '3.1', path: '', message: 'mapping keys MUST be strings', pos: k.range?.[0] });
        }
      },
    });
    results.push({ doc, value: diags.some(d => d.severity === 'error') ? undefined : doc.toJS(), diags, lc });
  }
  return results;
}

function lineOf(doc, lc, p) {
  const parts = p ? p.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
  for (let n = parts.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(parts.slice(0, n).map(s => (/^\d+$/.test(s) ? Number(s) : s)), true);
    if (node?.range) return lc.linePos(node.range[0]);
  }
  return undefined;
}

/** Validate manifests from text. Returns { diagnostics } with errors, warnings and positions. */
export function validateText(text, file = '<input>', opts = {}) {
  const diagnostics = [];
  const loaded = loadManifests(text);
  if (loaded.length === 0) diagnostics.push({ severity: 'error', code: 'yaml.empty', section: '3.1', path: '', message: 'no document found' });
  loaded.forEach(({ doc, value, diags, lc }, idx) => {
    const push = d => {
      const { pos, ...rest } = d;
      const lp = pos !== undefined ? lc.linePos(pos) : lineOf(doc, lc, d.path);
      diagnostics.push({ ...rest, document: idx, source: { file, ...(lp ? { line: lp.line, column: lp.col } : {}) } });
    };
    diags.forEach(push);
    if (value === undefined) return;
    if (!validateSchema(value)) {
      const seen = new Set();
      for (const e of validateSchema.errors) {
        if (e.keyword === 'if') continue;
        let p = e.instancePath;
        if (e.keyword === 'additionalProperties') p += '/' + String(e.params.additionalProperty).replace(/~/g, '~0').replace(/\//g, '~1');
        if (e.keyword === 'propertyNames') p += '/' + e.params.propertyName;
        const key = `${e.keyword}|${p}|${e.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        push({ severity: 'error', code: `schema.${e.keyword}`, section: '', path: p, message: `${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}` });
      }
      return; // semantic rules assume a structurally valid document
    }
    for (const d of semanticCheck(value, opts)) push(d);
  });
  return { diagnostics };
}

export function validateFile(file, opts) {
  return validateText(fs.readFileSync(file, 'utf8'), path.relative(process.cwd(), file) || file, opts);
}

const errorsOf = r => r.diagnostics.filter(d => d.severity === 'error');

function formatDiag(d) {
  const loc = d.source ? `${d.source.file}${d.source.line ? `:${d.source.line}:${d.source.column}` : ''}` : '';
  return `${loc} ${d.severity} ${d.code}${d.path ? ` ${d.path}` : ''}: ${d.message}`;
}

function parseArgs(argv) {
  const o = { _: [], profiles: undefined, json: false, verifyDigest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--verify-digest') o.verifyDigest = true;
    else if (a === '--profiles') o.profiles = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    else o._.push(a);
  }
  if (o.profiles) for (const p of o.profiles) if (!KNOWN_PROFILES.includes(p)) { console.error(`unknown profile: ${p}`); process.exit(2); }
  return o;
}

function runSuite({ json }) {
  const index = JSON.parse(fs.readFileSync(path.join(here, 'index.json'), 'utf8'));
  const results = [];
  const listed = new Set();

  for (const t of index.tests) {
    listed.add(t.file);
    const r = validateFile(path.join(here, t.file), { profiles: t.profiles, verifyDigest: t.verifyDigest });
    const errs = errorsOf(r);
    let ok; let detail = '';
    if (t.expect === 'valid') {
      ok = errs.length === 0;
      if (!ok) detail = formatDiag(errs[0]);
    } else {
      const hit = errs.filter(e => e.code === t.code && (t.path === undefined || e.path === t.path || e.path.startsWith(t.path + '/')));
      const stray = errs.filter(e => e.code.split('.')[0] !== t.code.split('.')[0]);
      ok = hit.length > 0 && stray.length === 0;
      if (!ok) detail = errs.length ? `expected ${t.code} at ${t.path ?? '*'}, got: ${errs.map(e => `${e.code} ${e.path}`).join('; ')}` : `expected ${t.code} at ${t.path ?? '*'}, but the manifest was accepted`;
    }
    results.push({ id: t.id, file: t.file, section: t.section, expect: t.expect, ok, detail });
  }

  // every file in valid/ and invalid/ must be indexed
  for (const dir of ['valid', 'invalid']) {
    for (const f of fs.readdirSync(path.join(here, dir))) {
      const rel = `${dir}/${f}`;
      if (!listed.has(rel)) results.push({ id: rel, file: rel, section: '', expect: dir, ok: false, detail: 'file is not listed in index.json' });
    }
  }

  // the examples of the specification must validate
  const exDir = path.join(root, 'spec', 'v1alpha1', 'examples');
  const nonManifests = new Set(index.nonManifestExamples ?? []);
  for (const f of fs.readdirSync(exDir).sort()) {
    if (!/\.ya?ml$|\.json$/.test(f)) continue;
    const id = `example:${f}`;
    const file = `spec/v1alpha1/examples/${f}`;
    if (nonManifests.has(f)) { results.push({ id, file, section: 'examples', expect: 'skipped', ok: true, detail: 'not a manifest (event stream, record or statement)' }); continue; }
    const errs = errorsOf(validateFile(path.join(exDir, f)));
    results.push({ id, file, section: 'examples', expect: 'valid', ok: errs.length === 0, detail: errs[0] ? formatDiag(errs[0]) : '' });
  }

  const failed = results.filter(r => !r.ok);
  if (json) {
    console.log(JSON.stringify({ awp: 'v1alpha1', suite: index.suite, version: index.version, total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  } else {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}${r.detail && !r.ok ? `\n      ${r.detail}` : ''}`);
    console.log(`\n${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
  }
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  if (cmd === 'run') process.exit(runSuite(o));
  if (cmd === 'check' && o._.length) {
    let bad = false; const all = [];
    for (const f of o._) {
      const r = validateFile(f, { profiles: o.profiles, verifyDigest: o.verifyDigest });
      all.push(...r.diagnostics);
      if (errorsOf(r).length) bad = true;
    }
    if (o.json) console.log(JSON.stringify({ valid: !bad, diagnostics: all }, null, 2));
    else {
      for (const d of all) console.log(formatDiag(d));
      console.log(bad ? 'invalid' : 'valid');
    }
    process.exit(bad ? 1 : 0);
  }
  console.error('usage: awp-check.mjs check [--profiles a,b] [--verify-digest] [--json] <file...> | run [--json]');
  process.exit(2);
}
