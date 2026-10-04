import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources so tests never depend on a prior build.
const packagesDir = fileURLToPath(new URL('./packages', import.meta.url));
const alias: Record<string, string> = {};
if (existsSync(packagesDir)) {
  for (const name of readdirSync(packagesDir)) {
    const entry = `${packagesDir}/${name}/src/index.ts`;
    if (existsSync(entry)) alias[`@openagentix/${name}`] = entry;
  }
}

const apiEntry = fileURLToPath(new URL('./apps/api/src/index.ts', import.meta.url));
if (existsSync(apiEntry)) alias['@openagentix/api'] = apiEntry;

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // The web UI has its own vitest config (jsdom, React) in apps/ui.
    exclude: ['**/node_modules/**', 'apps/ui/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['apps/ui/**', '**/*.d.ts', '**/main.ts', '**/*-cli.ts', '**/types.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
