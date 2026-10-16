#!/usr/bin/env node
// Offline pin check for the vendored AWP copy (packages/awp/vendor/awp-v1alpha1).
//
// Verifies that the directory holds exactly the files listed in PROVENANCE.json, each with the
// recorded SHA-256. It reads local files only: no network access, no child processes.
// Usage: node scripts/awp/verify-pin.mjs [directory]
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROVENANCE_FILE = 'PROVENANCE.json';
export const DEFAULT_DIR = fileURLToPath(
  new URL('../../packages/awp/vendor/awp-v1alpha1', import.meta.url),
);

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const LICENSES = new Set(['Apache-2.0', 'CC-BY-4.0']);

/** Lists all entries below `dir` as POSIX-relative paths. Symlinks and special files are reported. */
function walk(dir, prefix, found) {
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(dir, rel, found);
    else found.push({ rel, regular: entry.isFile() });
  }
}

function safeRelative(p) {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    !p.includes('\\') &&
    !p.startsWith('/') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/**
 * @param {string} [dir] vendored directory
 * @returns {{ ok: boolean, problems: string[], checked: number }}
 */
export function verifyPin(dir = DEFAULT_DIR) {
  const problems = [];
  let prov;
  try {
    prov = JSON.parse(readFileSync(path.join(dir, PROVENANCE_FILE), 'utf8'));
  } catch (e) {
    return {
      ok: false,
      problems: [`${PROVENANCE_FILE}: cannot read or parse (${e.code ?? e.message})`],
      checked: 0,
    };
  }

  if (prov === null || typeof prov !== 'object' || Array.isArray(prov)) {
    return { ok: false, problems: [`${PROVENANCE_FILE}: must be a JSON object`], checked: 0 };
  }
  if (prov.schemaVersion !== 1) problems.push(`${PROVENANCE_FILE}: schemaVersion must be 1`);
  if (
    typeof prov.source?.repository !== 'string' ||
    !prov.source.repository.startsWith('https://')
  ) {
    problems.push(`${PROVENANCE_FILE}: source.repository must be an https URL`);
  }
  if (!COMMIT.test(prov.source?.commit ?? '')) {
    problems.push(`${PROVENANCE_FILE}: source.commit must be a 40-character lowercase hex SHA`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(prov.retrievedAt ?? '')) {
    problems.push(`${PROVENANCE_FILE}: retrievedAt must be YYYY-MM-DD`);
  }
  if (!Array.isArray(prov.files) || prov.files.length === 0) {
    problems.push(`${PROVENANCE_FILE}: files must be a non-empty array`);
    return { ok: false, problems, checked: 0 };
  }

  const listed = new Set();
  for (const f of prov.files) {
    const p = f?.path;
    if (!safeRelative(p)) {
      problems.push(`${PROVENANCE_FILE}: unsafe or invalid path ${JSON.stringify(p)}`);
      continue;
    }
    if (p === PROVENANCE_FILE) {
      problems.push(`${p}: must not list itself`);
      continue;
    }
    if (listed.has(p)) {
      problems.push(`${p}: listed more than once`);
      continue;
    }
    listed.add(p);
    if (!SHA256.test(f.sha256 ?? ''))
      problems.push(`${p}: sha256 must be 64 lowercase hex characters`);
    if (!LICENSES.has(f.license))
      problems.push(`${p}: license must be one of ${[...LICENSES].join(', ')}`);
  }

  const found = [];
  walk(dir, '', found);
  const present = new Map(found.map((e) => [e.rel, e]));

  let checked = 0;
  for (const f of prov.files) {
    const p = f?.path;
    if (!listed.has(p) || !SHA256.test(f.sha256 ?? '')) continue;
    const entry = present.get(p);
    if (!entry) {
      problems.push(`${p}: missing`);
      continue;
    }
    if (!entry.regular || lstatSync(path.join(dir, p)).isSymbolicLink()) {
      problems.push(`${p}: not a regular file`);
      continue;
    }
    checked += 1;
    const actual = createHash('sha256')
      .update(readFileSync(path.join(dir, p)))
      .digest('hex');
    if (actual !== f.sha256)
      problems.push(`${p}: hash mismatch (expected ${f.sha256}, found ${actual})`);
  }
  for (const rel of present.keys()) {
    if (rel !== PROVENANCE_FILE && !listed.has(rel))
      problems.push(`${rel}: extra file not listed in ${PROVENANCE_FILE}`);
  }

  return { ok: problems.length === 0, problems, checked };
}

export function main(argv, out = console) {
  const dir = argv[0] ? path.resolve(argv[0]) : DEFAULT_DIR;
  let result;
  try {
    result = verifyPin(dir);
  } catch (e) {
    result = { ok: false, problems: [`cannot verify ${dir}: ${e.code ?? e.message}`], checked: 0 };
  }
  if (!result.ok) {
    out.error('AWP pin check FAILED:');
    for (const p of result.problems) out.error(`  - ${p}`);
    return 1;
  }
  out.log(`AWP pin check passed: ${result.checked} files match PROVENANCE.json`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
