import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { findVictims, parseStat, protectedPids, type ProcInfo } from '../src/procs.js';
import { openWorkspace } from './helpers.js';

/** Live (non-zombie) processes whose working directory is `dir`: the marker of one test run. */
async function aliveIn(dir: string): Promise<number[]> {
  const real = await realpath(dir);
  const out: number[] = [];
  for (const n of await readdir('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try {
      if ((await readlink(`/proc/${n}/cwd`)) !== real) continue;
      const stat = await readFile(`/proc/${n}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z')
        out.push(Number(n));
    } catch {
      /* gone */
    }
  }
  return out;
}

const cmd = (script: string, extra: object = {}) => ({
  tests: { command: process.execPath, args: ['-e', script], timeoutMs: 20_000, ...extra },
});

const leftovers: string[] = [];
afterEach(async () => {
  // Safety net: nothing may survive a test of this file, whatever the assertions said.
  for (const dir of leftovers.splice(0))
    for (const pid of await aliveIn(dir)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
});

async function runOnce(script: string, extra: object = {}) {
  const { ws, root } = await openWorkspace(cmd(script, extra));
  leftovers.push(root);
  const t0 = Date.now();
  const r = await ws.runTests();
  return { ws, root, r, took: Date.now() - t0 };
}

describe('processes left behind by test code', () => {
  it('detached sleep 8 with inherited stdio: returns promptly, nothing survives', async () => {
    const { root, r, took } = await runOnce(
      "require('child_process').spawn('sleep',['8'],{detached:true,stdio:'inherit'}).unref()",
    );
    expect(took).toBeLessThan(3000);
    expect(r).toMatchObject({ passed: true, strayProcessesKilled: 1, strayProcessesSurvived: 0 });
    expect(await aliveIn(root)).toEqual([]);
  });

  it('detached sleep infinity holding the pipes: no hang, nothing survives', async () => {
    const { root, r, took } = await runOnce(
      "require('child_process').spawn('sleep',['infinity'],{detached:true,stdio:'inherit'}).unref()",
    );
    expect(took).toBeLessThan(3000);
    expect(r.strayProcessesKilled).toBeGreaterThanOrEqual(1);
    expect(await aliveIn(root)).toEqual([]);
  });

  it('double fork (orphan re-parented to init) is killed', async () => {
    const { root, r, took } = await runOnce(
      "require('child_process').spawn('sh',['-c','(sleep 60 &) ; exit 0'],{stdio:'inherit'})",
    );
    expect(took).toBeLessThan(3000);
    expect(r.strayProcessesKilled).toBeGreaterThanOrEqual(1);
    expect(await aliveIn(root)).toEqual([]);
  });

  it('setsid child through a small node child, with scrubbed env and ignored stdio', async () => {
    const inner = 'setInterval(()=>{},1000)';
    const script = `
      const { spawn } = require('child_process');
      spawn('setsid', [process.execPath, '-e', ${JSON.stringify(inner)}], { env: {}, stdio: 'ignore', detached: true }).unref();
      spawn(process.execPath, ['-e', ${JSON.stringify(inner)}], { env: {}, stdio: 'ignore', detached: true }).unref();`;
    const { root, r, took } = await runOnce(script);
    expect(took).toBeLessThan(3000);
    expect(r.strayProcessesKilled).toBeGreaterThanOrEqual(1);
    expect(await aliveIn(root)).toEqual([]);
  });

  it('a hanging test with a detached child returns within timeout plus grace', async () => {
    const script =
      "require('child_process').spawn('sleep',['infinity'],{detached:true,stdio:'inherit'}); setInterval(()=>{},1000)";
    const { root, r, took } = await runOnce(script, { timeoutMs: 600 });
    expect(r).toMatchObject({ timedOut: true, passed: false });
    expect(took).toBeLessThan(600 + 2500);
    expect(await aliveIn(root)).toEqual([]);
  });

  it('a following tool call works right after a run that left a pipe holder', async () => {
    const { ws, root } = await openWorkspace(
      cmd(
        "require('child_process').spawn('sleep',['infinity'],{detached:true,stdio:'inherit'}).unref()",
      ),
    );
    leftovers.push(root);
    const t0 = Date.now();
    const first = ws.call(() => ws.runTests());
    const second = ws.call(() => ws.readFile('src/price.js'));
    expect((await first).strayProcessesKilled).toBeGreaterThanOrEqual(1);
    expect((await second).content).toContain('applyDiscount');
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(await aliveIn(root)).toEqual([]);
  });

  it('counts orphaned processes in the memory watchdog', async () => {
    const hog = 'const a=[]; setInterval(()=>{ a.push(Buffer.alloc(30*1024*1024,1)); }, 30);';
    const script = `require('child_process').spawn('sh',['-c',${JSON.stringify(`(${process.execPath} -e '${hog}' &)`)}],{stdio:'ignore'}); setInterval(()=>{},1000)`;
    const { root, r, took } = await runOnce(script, { memoryMb: 100, timeoutMs: 15_000 });
    expect(r.memoryExceeded).toBe(true);
    expect(r.passed).toBe(false);
    expect(took).toBeLessThan(10_000);
    expect(await aliveIn(root)).toEqual([]);
  });
});

describe('process table helpers', () => {
  const p = (o: Partial<ProcInfo> & { pid: number }): ProcInfo => ({
    ppid: 1,
    pgrp: o.pid,
    state: 'S',
    comm: 'x',
    start: 100,
    rssBytes: 4096,
    uid: 0,
    ...o,
  });

  it('parses /proc/<pid>/stat with a tricky command name', () => {
    const stat = `42 (a) b)c (d) S 7 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12345 100 5 0`;
    expect(parseStat(42, stat)).toMatchObject({
      comm: 'a) b)c (d',
      state: 'S',
      ppid: 7,
      pgrp: 42,
      start: 12345,
      rssBytes: 5 * 4096,
    });
    expect(parseStat(1, 'garbage')).toBeNull();
  });

  it('selects group members, descendants and new same-UID orphans, never the server', () => {
    const procs = new Map<number, ProcInfo>(
      [
        p({ pid: 10, ppid: 5 }), // test process
        p({ pid: 11, ppid: 10, pgrp: 99 }), // setsid child of the test
        p({ pid: 12, ppid: 11, pgrp: 99 }), // grandchild
        p({ pid: 13, ppid: 3, pgrp: 10 }), // group member
        p({ pid: 20, ppid: 1, start: 150 }), // new orphan
        p({ pid: 21, ppid: 1, start: 50 }), // old orphan: not ours
        p({ pid: 22, ppid: 1, start: 150, uid: 1000 }), // other user
        p({ pid: 23, ppid: 7, start: 150 }), // new, but parent is a normal process
        p({ pid: 24, ppid: 8, start: 150 }), // adopted by a systemd --user
        p({ pid: 8, ppid: 1, start: 10, comm: 'systemd' }),
        p({ pid: 25, ppid: 10, state: 'Z' }), // zombie
        p({ pid: 5, ppid: 1, start: 150 }), // the server (protected)
      ].map((x) => [x.pid, x]),
    );
    const ids = findVictims(procs, {
      childPid: 10,
      startTicks: 100,
      protect: new Set([5]),
      uid: 0,
    })
      .map((x) => x.pid)
      .sort((a, b) => a - b);
    expect(ids).toEqual([10, 11, 12, 13, 20, 24]);
    expect(
      findVictims(procs, { childPid: undefined, startTicks: null, protect: new Set(), uid: 0 }),
    ).toEqual([]);
  });

  it('protects the server and its ancestors', async () => {
    const { listProcs } = await import('../src/procs.js');
    const prot = protectedPids(await listProcs());
    expect(prot.has(process.pid)).toBe(true);
    expect(prot.has(process.ppid)).toBe(true);
  });
});
