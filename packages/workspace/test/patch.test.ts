import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffLines, splitLines, unifiedHunks } from '../src/diff.js';
import { NODE_TESTS, SEED, openWorkspace, seedDir } from './helpers.js';
import { Workspace } from '../src/index.js';

function gitApplyCheck(rootSeed: string, patch: string): string {
  const out = execFileSync('git', ['apply', '--check', '--verbose', '-'], {
    cwd: rootSeed,
    input: patch,
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out;
}

describe('unified diff', () => {
  it('is empty for equal text and handles missing final newlines', () => {
    expect(unifiedHunks('a\nb\n', 'a\nb\n')).toBe('');
    expect(unifiedHunks('a\nb', 'a\nb\n')).toContain('\\ No newline at end of file');
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb')).toEqual(['a\n', 'b']);
  });

  it('applies cleanly with git for many shapes of change', () => {
    const cases: [string, string][] = [
      ['', 'new\nfile\n'],
      ['one\ntwo\nthree\n', ''],
      ['a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\n', 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\nm\nextra\n'],
      ['x\ny', 'x\ny\nz'],
      ['line\r\nwindows\r\n', 'line\r\nunix\n'],
      [
        Array.from({ length: 50 }, (_, i) => `l${i}\n`).join(''),
        Array.from({ length: 50 }, (_, i) => (i % 7 === 0 ? `c${i}\n` : `l${i}\n`)).join(''),
      ],
    ];
    for (const [before, after] of cases) {
      const dir = execFileSync('mktemp', ['-d', '-p', process.env.TMPDIR ?? '/tmp'], {
        encoding: 'utf8',
      }).trim();
      try {
        execFileSync('sh', ['-c', 'true'], { cwd: dir });
        require_write(dir, 'f.txt', before);
        const hunks = unifiedHunks(before, after);
        const patch = `diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n${hunks}`;
        gitApplyCheck(dir, patch);
        execFileSync('git', ['apply', '-'], {
          cwd: dir,
          input: patch,
          env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent' },
        });
        expect(execFileSync('cat', ['f.txt'], { cwd: dir, encoding: 'utf8' })).toBe(after);
      } finally {
        execFileSync('rm', ['-rf', dir]);
      }
    }
  });

  it('falls back to a replace hunk for huge edit distances', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}\n`);
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}\n`);
    const ops = diffLines(a, b);
    expect(ops.filter((o) => o.t === '-')).toHaveLength(1500);
    expect(ops.filter((o) => o.t === '+')).toHaveLength(1500);
  });
});

function require_write(dir: string, name: string, content: string): void {
  execFileSync('sh', ['-c', 'cat > "$1"', 'sh', join(dir, name)], { input: content });
}

describe('final patch computed by the node', () => {
  it('is empty and valid without changes', async () => {
    const { ws } = await openWorkspace();
    const r = await ws.finalize();
    expect(r.patch).toMatchObject({ ok: true, patch: '', changedFiles: [] });
    expect(r.testedFinalTree).toBe(false);
  });

  it('contains modified, added and deleted files, applies with git and has a stable digest', async () => {
    const { ws, root } = await openWorkspace();
    await ws.editFile('src/price.js', 'Math.floor', 'Math.round');
    await ws.writeFile(
      'test/discount.test.js',
      "import test from 'node:test';\ntest('d', () => {});\n",
    );
    await rm(join(root, 'src', 'hours.js'));
    const r = await ws.finalize();
    if (!r.patch.ok) throw new Error(r.patch.message);
    expect(r.patch.changedFiles.map((f) => [f.path, f.status])).toEqual([
      ['src/hours.js', 'deleted'],
      ['src/price.js', 'modified'],
      ['test/discount.test.js', 'added'],
    ]);
    expect(r.patch.patchSha256).toBe(createHash('sha256').update(r.patch.patch).digest('hex'));
    expect((await ws.finalize()).patch).toEqual(r.patch);
    const pristine = await seedDir();
    gitApplyCheck(pristine, r.patch.patch);
    execFileSync('git', ['apply', '-'], {
      cwd: pristine,
      input: r.patch.patch,
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent' },
    });
    expect(await readFile(join(pristine, 'src/price.js'), 'utf8')).toBe(
      await readFile(join(root, 'src/price.js'), 'utf8'),
    );
    expect(await readFile(join(pristine, 'test/discount.test.js'), 'utf8')).toContain("test('d'");
  });

  it('matches the model-independent digest: only the tree decides, not the diff tool output', async () => {
    const { ws } = await openWorkspace();
    await ws.writeFile('src/a.js', 'one\n');
    const d = await ws.computePatch();
    await ws.writeFile('src/a.js', 'two\n');
    const d2 = await ws.computePatch();
    expect(d.ok && d2.ok && d.patchSha256 !== d2.patchSha256).toBe(true);
  });

  it('refuses changes outside the writable area made by test code', async () => {
    const { ws, root } = await openWorkspace();
    await mkdir(join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(join(root, '.github', 'workflows', 'release.yml'), 'name: pwn\n');
    let r = await ws.computePatch();
    expect(r).toMatchObject({ ok: false, code: 'forbidden_path_changed' });
    await rm(join(root, '.github', 'workflows', 'release.yml'));
    await writeFile(join(root, 'package.json'), '{"scripts":{"postinstall":"curl evil"}}');
    r = await ws.computePatch();
    expect(r).toMatchObject({ ok: false, code: 'forbidden_path_changed', paths: ['package.json'] });
  });

  it('refuses git control files, secrets and weird file names', async () => {
    const { ws, root } = await openWorkspace();
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), '[core]\nfsmonitor = evil\n');
    expect(await ws.computePatch()).toMatchObject({ ok: false, code: 'forbidden_path_changed' });
    await rm(join(root, '.git'), { recursive: true });
    await writeFile(join(root, 'src', 'x\ny.js'), 'x');
    expect(await ws.computePatch()).toMatchObject({ ok: false, code: 'forbidden_path_changed' });
  });

  it('refuses symlinks and special files planted by test code', async () => {
    const { ws, root } = await openWorkspace();
    await symlink('/etc/passwd', join(root, 'src', 'passwd.js'));
    expect(await ws.computePatch()).toMatchObject({ ok: false, code: 'unsafe_entry' });
    await rm(join(root, 'src', 'passwd.js'));
    execFileSync('mkfifo', [join(root, 'src', 'pipe')]);
    expect(await ws.computePatch()).toMatchObject({ ok: false, code: 'unsafe_entry' });
  });

  it('refuses a replaced seed symlink and mode changes', async () => {
    const root = await seedDir();
    await symlink('src/price.js', join(root, 'link.js'));
    const ws = await Workspace.open({ root });
    expect((await ws.computePatch()).ok).toBe(true); // unchanged links are fine
    await rm(join(root, 'link.js'));
    expect(await ws.computePatch()).toMatchObject({ ok: false, code: 'unsafe_entry' });
    await symlink('src/price.js', join(root, 'link.js'));
    await chmod(join(root, 'src', 'price.js'), 0o755);
    expect(await ws.computePatch()).toMatchObject({ ok: false, code: 'mode_change' });
  });

  it('refuses binary changes, too many files, oversized patches and oversized files', async () => {
    const a = await openWorkspace();
    await writeFile(join(a.root, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    expect(await a.ws.computePatch()).toMatchObject({ ok: false, code: 'binary_file' });

    const b = await openWorkspace({ maxPatchFiles: 2 });
    for (const n of ['a', 'b', 'c']) await b.ws.writeFile(`src/${n}.js`, 'x\n');
    expect(await b.ws.computePatch()).toMatchObject({ ok: false, code: 'too_many_files' });

    const c = await openWorkspace({ maxPatchBytes: 1024, maxWriteBytes: 8192 });
    await c.ws.writeFile('src/big.js', 'line\n'.repeat(1000));
    expect(await c.ws.computePatch()).toMatchObject({ ok: false, code: 'patch_too_large' });

    const d = await openWorkspace({ maxReadFileBytes: 2048 });
    await writeFile(join(d.root, 'src', 'huge.js'), 'x'.repeat(5000));
    expect(await d.ws.computePatch()).toMatchObject({ ok: false, code: 'file_too_large' });
  });

  it('refuses a workspace that grew beyond the tree limits', async () => {
    const { ws, root } = await openWorkspace({ maxTreeBytes: 4096, maxTreeEntries: 10 });
    await writeFile(join(root, 'src', 'fill.txt'), 'x'.repeat(10_000));
    const r = await ws.finalize();
    expect(r.patch).toMatchObject({ ok: false, code: 'tree_too_large' });
  });

  it('reports whether the last test run saw exactly the final tree', async () => {
    const { ws } = await openWorkspace({ tests: NODE_TESTS });
    await ws.editFile('src/price.js', 'Math.floor', 'Math.round');
    await ws.runTests();
    expect((await ws.finalize()).testedFinalTree).toBe(true);
    await ws.writeFile('src/later.js', 'export {};\n');
    const after = await ws.finalize();
    expect(after.lastTestRun?.passed).toBe(true);
    expect(after.testedFinalTree).toBe(false);
  });

  it('handles an empty added file', async () => {
    const { ws } = await openWorkspace();
    await ws.writeFile('src/empty.js', '');
    const r = await ws.computePatch();
    expect(r.ok && r.patch).toContain('new file mode 100644');
    expect(SEED['src/price.js']).toBeTruthy();
  });
});
