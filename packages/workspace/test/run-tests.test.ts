import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceError } from '../src/errors.js';
import { NODE_TESTS, openWorkspace, tempDir } from './helpers.js';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof WorkspaceError ? e.code : `other:${(e as Error).message}`;
  }
  return 'none';
}

const withCommand = (script: string, extra: object = {}) => ({
  tests: { command: process.execPath, args: ['-e', script], timeoutMs: 20_000, ...extra },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('run_tests', () => {
  it('runs the real project tests and reports pass and fail', async () => {
    const { ws, root } = await openWorkspace({ tests: NODE_TESTS });
    const green = await ws.runTests();
    expect(green).toMatchObject({ passed: true, exitCode: 0, timedOut: false });
    expect(green.output).toContain('pass');
    await writeFile(
      join(root, 'test', 'broken.test.js'),
      "import test from 'node:test';\ntest('x', () => { throw new Error('boom'); });\n",
    );
    const red = await ws.runTests('test/broken.test.js');
    expect(red).toMatchObject({ passed: false });
    expect(red.output).toContain('boom');
    expect(red.file).toBe('test/broken.test.js');
  });

  it('runs without a configured command only with an error', async () => {
    const { ws } = await openWorkspace();
    expect(await code(ws.runTests())).toBe('tests_not_configured');
  });

  it('scrubs the environment: no OAX_*, ANTHROPIC_*, proxy or token variables', async () => {
    vi.stubEnv('OAX_RUN_TOKEN', 'run-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://control/v1');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy:3128');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_secret');
    vi.stubEnv('OAX_MODEL_TOKEN', 'model-secret');
    const { ws } = await openWorkspace(
      withCommand('console.log("ENV=" + JSON.stringify(process.env))'),
    );
    const r = await ws.runTests();
    const env = JSON.parse(r.output.split('ENV=')[1]!.trim()) as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(
      ['CI', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'TMPDIR'].sort(),
    );
    expect(r.output).not.toMatch(/secret|proxy:3128|control\/v1/);
  });

  it('passes fixed extra variables from the configuration only', async () => {
    const { ws } = await openWorkspace(
      withCommand('console.log("V=" + process.env.FIXED_VAR)', { env: { FIXED_VAR: 'yes' } }),
    );
    expect((await ws.runTests()).output).toContain('V=yes');
  });

  it('runs in the workspace directory with a throwaway HOME', async () => {
    const { ws, root } = await openWorkspace(
      withCommand('console.log(process.cwd() + "|" + process.env.HOME)'),
    );
    const out = (await ws.runTests()).output.trim().split('|');
    expect(out[0]).toBe(await (await import('node:fs/promises')).realpath(root));
    expect(out[1]).toContain('oax-ws-home-');
    await expect(readFile(out[1]!)).rejects.toThrow(); // removed afterwards
  });

  it('kills a test that exceeds the timeout, including its children', async () => {
    const marker = join(await tempDir(), 'alive');
    const script = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1500)'], {stdio:'ignore'}); setInterval(()=>{}, 1000)`;
    const { ws } = await openWorkspace(withCommand(script, { timeoutMs: 400 }));
    const r = await ws.runTests();
    expect(r).toMatchObject({ timedOut: true, passed: false });
    await new Promise((res) => setTimeout(res, 2000));
    await expect(readFile(marker)).rejects.toThrow(); // child never finished: group was killed
  });

  it('kills a test that exceeds the memory limit', async () => {
    const script =
      'const a=[]; setInterval(()=>{ a.push(Buffer.alloc(40*1024*1024, 1)); }, 30); setTimeout(()=>{}, 15000)';
    const { ws } = await openWorkspace(withCommand(script, { memoryMb: 100, timeoutMs: 15_000 }));
    const r = await ws.runTests();
    expect(r.memoryExceeded).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('caps output and survives an output flood', async () => {
    const script = 'const b = "x".repeat(65536); for (let i=0;i<400;i++) process.stdout.write(b)';
    const { ws } = await openWorkspace({ ...withCommand(script), maxOutputBytes: 4096 });
    const r = await ws.runTests();
    expect(r.outputTruncated).toBe(true);
    expect(Buffer.byteLength(r.output)).toBeLessThan(4096 + 100);
    expect(r.passed).toBe(true);
  });

  it('limits the number of runs', async () => {
    const { ws } = await openWorkspace(withCommand('', { maxRuns: 2 }));
    await ws.runTests();
    await ws.runTests();
    expect(await code(ws.runTests())).toBe('budget_exhausted');
  });

  it('refuses a spawn failure cleanly', async () => {
    const { ws } = await openWorkspace({
      tests: { command: '/nonexistent/binary', timeoutMs: 5000 },
    });
    const r = await ws.runTests();
    expect(r.passed).toBe(false);
    expect(r.signal).toBe('spawn_error');
  });
});

describe('command injection through the file argument', () => {
  it.each([
    '--eval=process.exit(0)',
    '-e',
    '--require=./evil.js',
    'test/a.test.js; rm -rf /',
    'test/a.test.js && id',
    'test/$(id).test.js',
    'test/`id`.test.js',
    'test/a.test.js|cat',
    '../outside.test.js',
    '/etc/passwd',
    'src/price.js',
    'test/UPPER.test.js',
    'test/a b.test.js',
    'test/a.test.js\n--eval',
  ])('refuses %j', async (file) => {
    const { ws } = await openWorkspace({ tests: NODE_TESTS });
    const c = await code(ws.runTests(file));
    expect(['arg_not_allowed', 'invalid_path']).toContain(c);
  });

  it('refuses a file argument when the command takes none, and missing/dir/symlink files', async () => {
    const a = await openWorkspace(withCommand(''));
    expect(await code(a.ws.runTests('test/a.test.js'))).toBe('arg_not_allowed');
    const { ws, root } = await openWorkspace({ tests: NODE_TESTS });
    expect(await code(ws.runTests('test/missing.test.js'))).toBe('not_found');
    await mkdir(join(root, 'test', 'dir.test.js'));
    expect(await code(ws.runTests('test/dir.test.js'))).toBe('not_a_file');
    await (
      await import('node:fs/promises')
    ).symlink('/etc/hostname', join(root, 'test', 'link.test.js'));
    expect(await code(ws.runTests('test/link.test.js'))).toBe('symlink_refused');
  });

  it('never runs a shell: metacharacters in fixed arguments stay literal', async () => {
    const { ws } = await openWorkspace({
      tests: {
        command: process.execPath,
        args: ['-e', 'console.log(process.argv[1])', '$(echo pwned); `id`'],
        timeoutMs: 10_000,
      },
    });
    const r = await ws.runTests();
    expect(r.output.trim()).toBe('$(echo pwned); `id`');
  });

  it('rejects an unsafe command in the configuration', async () => {
    const root = await tempDir();
    const { Workspace } = await import('../src/index.js');
    await expect(Workspace.open({ root, tests: { command: 'node; id' } })).rejects.toThrow();
    await expect(Workspace.open({ root, tests: { command: 'node --test' } })).rejects.toThrow();
    await expect(
      Workspace.open({ root, tests: { command: 'node', filePattern: '(' } }),
    ).rejects.toThrow();
  });
});
