import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { Workspace, type WorkspaceConfigInput } from '../src/index.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export async function tempDir(prefix = 'oax-ws-test-'): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export const SEED: Record<string, string> = {
  'package.json': '{"name":"bakery","type":"module"}\n',
  'src/price.js':
    'export function applyDiscount(cents, percent) {\n  return Math.floor(cents * (100 - percent) / 100);\n}\n',
  'src/hours.js': 'export const open = "08:00";\n',
  'test/price.test.js':
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyDiscount } from '../src/price.js';\ntest('discount', () => { assert.equal(applyDiscount(1000, 10), 900); });\n",
  'README.md': '# Bakery kit\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  '.env': 'TOKEN=super-secret\n',
};

export async function seedDir(files: Record<string, string> = SEED): Promise<string> {
  const root = await tempDir();
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
  return root;
}

export async function openWorkspace(
  extra: Partial<WorkspaceConfigInput> = {},
  files?: Record<string, string>,
): Promise<{ ws: Workspace; root: string }> {
  const root = await seedDir(files);
  const ws = await Workspace.open({ root, ...extra });
  return { ws, root };
}

export const NODE_TESTS: NonNullable<WorkspaceConfigInput['tests']> = {
  command: process.execPath,
  args: ['--test'],
  filePattern: '^test/[a-z0-9-]+\\.test\\.js$',
  timeoutMs: 20_000,
};
