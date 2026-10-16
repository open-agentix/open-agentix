#!/usr/bin/env node
// Replaces the vendored AWP copy from a LOCAL checkout of the AWP repository and rewrites
// PROVENANCE.json. It never touches the network: clone or update the AWP repository yourself,
// review it, then point this script at the checkout.
// Usage: node scripts/awp/vendor-awp.mjs <awp-checkout> [target-directory] [--tag vX.Y.Z]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DIR, PROVENANCE_FILE } from './verify-pin.mjs';

export const REPOSITORY = 'https://github.com/open-agentix/agenticWorkflowProtocol.org';

/** Files taken from the AWP repository: the schema, the conformance suite, its pinned tooling, licences. */
const INCLUDE = [/^schema\//, /^conformance\//, /^package(-lock)?\.json$/, /^LICENSE(-SPEC)?$/];

/** Prose is CC BY 4.0 (LICENSE-SPEC); code, schemas, tests and manifests are Apache-2.0 (LICENSE). */
export function licenseFor(p) {
  if (p === 'LICENSE-SPEC') return 'CC-BY-4.0';
  return p.endsWith('.md') ? 'CC-BY-4.0' : 'Apache-2.0';
}

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

export function vendorAwp(source, target = DEFAULT_DIR, { tag = null, now = new Date() } = {}) {
  if (git(source, 'status', '--porcelain') !== '') {
    throw new Error('the AWP checkout has uncommitted changes; vendor a clean checkout only');
  }
  const commit = git(source, 'rev-parse', 'HEAD');
  const commitDate = git(source, 'show', '-s', '--format=%cI', 'HEAD');
  const paths = git(source, 'ls-files', '-z')
    .split('\0')
    .filter((p) => p && INCLUDE.some((re) => re.test(p)))
    .sort();

  rmSync(target, { recursive: true, force: true });
  const files = [];
  for (const p of paths) {
    const dest = path.join(target, p);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(path.join(source, p), dest);
    files.push({
      path: p,
      sha256: createHash('sha256').update(readFileSync(dest)).digest('hex'),
      license: licenseFor(p),
    });
  }
  const provenance = {
    schemaVersion: 1,
    description:
      'Vendored copy of the AWP schema and conformance suite. Never edit by hand: replace it with scripts/awp/vendor-awp.mjs and review the diff.',
    awpVersion: 'v1alpha1',
    status: 'draft',
    source: { repository: REPOSITORY, commit, commitDate, tag },
    retrievedAt: now.toISOString().slice(0, 10),
    licenses: {
      'Apache-2.0': 'code, JSON schema, conformance manifests and tooling (LICENSE)',
      'CC-BY-4.0': 'Markdown prose (LICENSE-SPEC)',
    },
    files,
  };
  writeFileSync(path.join(target, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tagAt = args.indexOf('--tag');
  const tag = tagAt >= 0 ? args.splice(tagAt, 2)[1] : null;
  if (!args[0]) {
    console.error(
      'usage: node scripts/awp/vendor-awp.mjs <awp-checkout> [target-directory] [--tag vX.Y.Z]',
    );
    process.exit(2);
  }
  const p = vendorAwp(path.resolve(args[0]), args[1] ? path.resolve(args[1]) : DEFAULT_DIR, {
    tag,
  });
  console.log(`vendored ${p.files.length} files from ${p.source.commit}`);
}
