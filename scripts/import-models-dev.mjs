#!/usr/bin/env node
// Converts a reviewed, locally downloaded models.dev `api.json` into the pinned catalog snapshot.
// Usage: node scripts/import-models-dev.mjs <api.json> [providers=anthropic,openai,...]
// Never run at application run time; commit the result in a pull request.
import { readFileSync, writeFileSync } from 'node:fs';

const [input, filter] = process.argv.slice(2);
if (!input) {
  console.error(
    'usage: node scripts/import-models-dev.mjs <api.json> [comma separated provider ids]',
  );
  process.exit(2);
}
const api = JSON.parse(readFileSync(input, 'utf8'));
const wanted = filter ? new Set(filter.split(',')) : null;
const target = new URL('../packages/providers/catalog/models.json', import.meta.url);
const current = JSON.parse(readFileSync(target, 'utf8'));
const providers = { ...current.providers };
for (const [id, p] of Object.entries(api)) {
  if (wanted && !wanted.has(id)) continue;
  const models = {};
  for (const [mid, m] of Object.entries(p.models ?? {})) {
    models[mid] = {
      name: String(m.name ?? mid),
      limit: {
        ...(m.limit?.context ? { context: m.limit.context } : {}),
        ...(m.limit?.output ? { output: m.limit.output } : {}),
      },
      ...(m.cost && typeof m.cost.input === 'number'
        ? { cost: { input: m.cost.input, output: m.cost.output ?? 0 } }
        : {}),
    };
  }
  providers[id] = { name: String(p.name ?? id), models };
}
const out = {
  ...current,
  source: 'models.dev',
  snapshotDate: new Date().toISOString().slice(0, 10),
  providers,
};
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${Object.keys(providers).length} providers to ${target.pathname}`);
