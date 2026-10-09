import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
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

/**
 * Test files run in parallel processes, and a test run kills every stray process started during
 * it (by design). To keep tests that leave strays from killing each other's, all workspace tests
 * take a cross-process lock (an atomic `mkdir`; a lock of a dead process is broken).
 */
const LOCK = join(tmpdir(), 'oax-ws-tests.lock');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function holderAlive(): Promise<boolean> {
  try {
    const pid = Number(await readFile(join(LOCK, 'pid'), 'utf8'));
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

beforeEach(async () => {
  for (let i = 0; ; i += 1) {
    try {
      await mkdir(LOCK);
      await writeFile(join(LOCK, 'pid'), String(process.pid));
      return;
    } catch {
      if (i > 20 && !(await holderAlive())) await rm(LOCK, { recursive: true, force: true });
      await sleep(25);
    }
  }
});

afterEach(async () => {
  await rm(LOCK, { recursive: true, force: true });
});
