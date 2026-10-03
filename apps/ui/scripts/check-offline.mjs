// Fails when the built UI references any third-party host (no CDNs, fonts or trackers).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDist } from './offline-scan.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(dist)) {
  console.error('dist/ not found - run `pnpm build` first');
  process.exit(1);
}
const violations = scanDist(dist);
for (const v of violations) console.error(v);
if (violations.length) process.exit(1);
console.warn('offline check passed: no third-party references in dist/');
