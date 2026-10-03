#!/usr/bin/env node
// Sets the version in the root package.json (single source of truth) and copies it to every
// workspace package. Usage: node scripts/set-version.mjs 0.2.0
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <semver>');
  process.exit(2);
}
const files = ['package.json'];
for (const dir of ['packages', 'apps']) {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}/package.json`;
    if (existsSync(p)) files.push(p);
  }
}
for (const f of files) {
  const pkg = JSON.parse(readFileSync(f, 'utf8'));
  pkg.version = version;
  writeFileSync(f, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${f} -> ${version}`);
}
