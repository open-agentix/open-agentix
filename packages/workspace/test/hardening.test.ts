import { chmod, link, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unifiedHunks } from '../src/diff.js';
import { WorkspaceError } from '../src/errors.js';
import { writeResultFile } from '../src/fs-safe.js';
import { ptraceWarning } from '../src/hardening.js';
import { isForbidden } from '../src/paths.js';
import { walkTree } from '../src/tree.js';
import { Workspace } from '../src/index.js';
import { NODE_TESTS, openWorkspace, seedDir, SEED, tempDir } from './helpers.js';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof WorkspaceError ? e.code : `other:${(e as Error).message}`;
  }
  return 'none';
}

describe('M2: testedFinalTree needs the full suite', () => {
  it('a single passing test file is not a tested final tree', async () => {
    const { ws } = await openWorkspace({ tests: NODE_TESTS });
    await ws.editFile('src/price.js', 'Math.floor', 'Math.round');
    await ws.runTests('test/price.test.js');
    const one = await ws.finalize();
    expect(one.lastTestRun).toMatchObject({ passed: true, file: 'test/price.test.js' });
    expect(one).toMatchObject({
      fullSuitePassed: false,
      treeMatchesLastRun: true,
      testedFinalTree: false,
    });
    await ws.runTests();
    expect(await ws.finalize()).toMatchObject({
      fullSuitePassed: true,
      treeMatchesLastRun: true,
      testedFinalTree: true,
    });
  });

  it('a full pass followed by a change, or by a single file, is not enough', async () => {
    const { ws } = await openWorkspace({ tests: NODE_TESTS });
    await ws.runTests();
    await ws.writeFile('src/later.js', 'export {};\n');
    expect(await ws.finalize()).toMatchObject({
      fullSuitePassed: true,
      treeMatchesLastRun: false,
      testedFinalTree: false,
    });
    await ws.runTests('test/price.test.js');
    expect((await ws.finalize()).testedFinalTree).toBe(false);
  });
});

describe('L1: extended deny list', () => {
  it.each([
    '.envrc',
    '.env.local',
    '.pgpass',
    'infra/prod.tfvars',
    'infra/prod.auto.tfvars.json',
    'terraform.tfstate',
    'terraform.tfstate.backup',
    'x/.vault-token',
    '.dev.vars',
    'secrets.gpg',
    'private.GPG',
    '.s3cfg',
    '.boto',
    'service-account.json',
    'service-account-prod.json',
    'serviceaccount.json',
    'id_rsa',
    'id_custom_key',
    'id_ed25519.pub',
    'server.pem',
    'tls.key',
    '.netrc',
    '.npmrc',
    '.npmrc.local',
    'a/.NPMRC',
    '.yarnrc',
    '.pnpmrc',
  ])('forbids %s', (p) => {
    expect(isForbidden(p.split('/'))).toBe(true);
  });

  it.each(['src/price.js', 'test/a.test.js', 'src/idle.js', 'src/service.json', 'src/keys.js'])(
    'still allows %s',
    (p) => {
      expect(isForbidden(p.split('/'))).toBe(false);
    },
  );

  it('hides and refuses them through the tools', async () => {
    const { ws, root } = await openWorkspace(
      {},
      { 'src/a.js': 'x\n', '.envrc': 'export T=1\n', '.pgpass': 'h:1:d:u:p\n' },
    );
    expect(await code(ws.readFile('.envrc'))).toBe('path_forbidden');
    expect(await code(ws.readFile('.pgpass'))).toBe('path_forbidden');
    expect((await ws.listFiles('.')).entries.join('\n')).not.toContain('envrc');
    expect(root).toBeTruthy();
  });
});

describe('L2: hard links are refused', () => {
  it('refuses read and edit of a file with a second hard link', async () => {
    const { ws, root } = await openWorkspace();
    const outside = join(await tempDir(), 'outside.txt');
    await writeFile(outside, 'secret outside\n');
    await link(outside, join(root, 'src', 'linked.js'));
    expect(await code(ws.readFile('src/linked.js'))).toBe('hardlink_refused');
    expect(await code(ws.editFile('src/linked.js', 'secret', 'x'))).toBe('hardlink_refused');
    expect(await code(ws.writeFile('src/linked.js', 'x'))).toBe('hardlink_refused');
    expect(await readFile(outside, 'utf8')).toBe('secret outside\n');
    // an ordinary file still reads
    expect((await ws.readFile('src/price.js')).content).toContain('applyDiscount');
  });
});

describe('L3: directories count, and the final steps have a time cap', () => {
  it('counts empty directories toward the entry limit', async () => {
    const root = await tempDir();
    for (let i = 0; i < 30; i += 1) await mkdir(join(root, `d${i}`));
    expect(await code(walkTree(root, { maxEntries: 10, maxBytes: 1e6, keepContent: false }))).toBe(
      'tree_too_large',
    );
  });

  it('fails closed with timeout when the walk exceeds its deadline', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'a.txt'), 'x');
    expect(
      await code(
        walkTree(root, { maxEntries: 100, maxBytes: 1e6, keepContent: false, deadline: -1 }),
      ),
    ).toBe('timeout');
  });

  it('fails closed with timeout when the diff exceeds its deadline', () => {
    const a = Array.from({ length: 200 }, (_, i) => `a${i}\n`).join('');
    const b = Array.from({ length: 200 }, (_, i) => `b${i}\n`).join('');
    expect(() => unifiedHunks(a, b, 3, { deadline: 0, now: () => 1 })).toThrow(/too long/);
    expect(unifiedHunks(a, b, 3, { deadline: 1e12, now: () => 1 })).toContain('@@');
  });

  it('finalize reports timeout instead of hanging when the clock runs past the cap', async () => {
    let t = 0;
    let slow = false;
    const root = await seedDir();
    const ws = await Workspace.open(
      { root, maxFinalizeMs: 100 },
      { now: () => (slow ? (t += 1000) : 0) },
    );
    await writeFile(join(root, 'src', 'more.js'), 'export {};\n');
    slow = true;
    expect((await ws.finalize()).patch).toMatchObject({ ok: false, code: 'timeout' });
  });
});

describe('L4: invalid paths and disallowed arguments count as denied', () => {
  it('increments denied for every refusal class', async () => {
    const { ws } = await openWorkspace({ tests: NODE_TESTS });
    const attempts: (() => Promise<unknown>)[] = [
      () => ws.readFile('../etc/passwd'), // invalid_path
      () => ws.readFile('/etc/passwd'), // invalid_path
      () => ws.runTests('--eval=1'), // arg_not_allowed
      () => ws.readFile('.env'), // path_forbidden
    ];
    for (const a of attempts) await code(ws.call(a));
    expect((await ws.finalize()).denied).toBe(4);
  });
});

describe('L5: patch header uses the real mode', () => {
  it('deleted executable file keeps 100755, added executable file too', async () => {
    const root = await seedDir({ ...SEED, 'src/tool.js': 'run\n' });
    await chmod(join(root, 'src', 'tool.js'), 0o755);
    const ws = await Workspace.open({ root });
    await rm(join(root, 'src', 'tool.js'));
    await writeFile(join(root, 'src', 'fresh.js'), 'x\n');
    await chmod(join(root, 'src', 'fresh.js'), 0o755);
    await writeFile(join(root, 'src', 'plain.js'), 'y\n');
    const r = await ws.computePatch();
    expect(r.ok && r.patch).toContain('deleted file mode 100755');
    expect(r.ok && r.patch).toContain('new file mode 100755');
    expect(r.ok && r.patch).toContain('new file mode 100644');
  });
});

describe('L8: result file', () => {
  it('writes mode 0600 and refuses a planted symbolic link', async () => {
    const dir = await tempDir();
    const target = join(dir, 'victim.txt');
    await writeFile(target, 'keep');
    await symlink(target, join(dir, 'result.json'));
    await expect(writeResultFile(join(dir, 'result.json'), '{}')).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('keep');
    await writeResultFile(join(dir, 'ok.json'), '{"a":1}');
    expect(await readFile(join(dir, 'ok.json'), 'utf8')).toBe('{"a":1}');
    expect((await (await import('node:fs/promises')).stat(join(dir, 'ok.json'))).mode & 0o777).toBe(
      0o600,
    );
  });
});

describe('M3: startup ptrace self-check', () => {
  it('warns only when ptrace_scope is 0', async () => {
    expect(await ptraceWarning(async () => '0\n')).toMatch(/ptrace_scope is 0/);
    expect(await ptraceWarning(async () => '1\n')).toBeNull();
    expect(await ptraceWarning(async () => '3\n')).toBeNull();
    expect(
      await ptraceWarning(async () => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
    expect(await ptraceWarning()).toSatisfy((v: unknown) => v === null || typeof v === 'string');
  });
});
