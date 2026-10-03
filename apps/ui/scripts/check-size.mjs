// Bundle budget: initial JavaScript (entry + modulepreloads in dist/index.html) must stay
// below the budget, gzip-compressed. Run after `vite build`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = Number(process.env.UI_JS_BUDGET_KB ?? 200);
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');

const initial = new Set();
for (const m of html.matchAll(/<script[^>]+src="\/?([^"]+\.js)"/g)) initial.add(m[1]);
for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+\.js)"/g))
  initial.add(m[1]);
for (const m of html.matchAll(/<link[^>]+href="\/?([^"]+\.js)"[^>]+rel="modulepreload"/g))
  initial.add(m[1]);

const kb = (n) => (n / 1024).toFixed(1);
let total = 0;
const rows = [];
for (const file of initial) {
  const gz = gzipSync(readFileSync(join(dist, file)), { level: 9 }).length;
  total += gz;
  rows.push([file, gz]);
}
for (const m of html.matchAll(/<link[^>]+href="\/?([^"]+\.css)"/g)) {
  const gz = gzipSync(readFileSync(join(dist, m[1])), { level: 9 }).length;
  rows.push([`${m[1]} (css, not counted)`, gz]);
}
for (const [file, gz] of rows) console.warn(`${kb(gz).padStart(7)} KB gz  ${file}`);
console.warn(`${kb(total).padStart(7)} KB gz  initial JS total (budget ${BUDGET_KB} KB)`);
if (total > BUDGET_KB * 1024) {
  console.error(`Bundle budget exceeded: ${kb(total)} KB > ${BUDGET_KB} KB`);
  process.exit(1);
}
