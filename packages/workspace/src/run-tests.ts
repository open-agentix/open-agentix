import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestCommand } from './config.js';
import { findVictims, listProcs, nowTicks, protectedPids } from './procs.js';

export interface RunOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  memoryExceeded: boolean;
  durationMs: number;
  output: string;
  outputTruncated: boolean;
  /** Processes left behind by the test (detached, double-forked, setsid) that were killed. */
  strayProcessesKilled: number;
  /** Processes that could not be killed; the run is then reported as failed. */
  strayProcessesSurvived: number;
}

/** Environment of the test process: fixed variables only, nothing inherited from the node. */
export function scrubbedEnv(cmd: TestCommand, home: string): Record<string, string> {
  return {
    PATH: cmd.path,
    HOME: home,
    TMPDIR: home,
    LANG: 'C.UTF-8',
    CI: 'true',
    NO_COLOR: '1',
    ...cmd.env,
  };
}

/** Time the exit of the test process may take after a kill before the run is abandoned. */
const KILL_GRACE_MS = 1500;
/** Time pipe output may still arrive after the test process exited. */
const DRAIN_MS = 300;
const REAP_ROUNDS = 20;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Removes the absolute paths of the workspace and the throwaway home from the output, so a test
 * run does not tell the model where the node keeps its files.
 */
export function redactPaths(text: string, paths: Record<string, string>): string {
  let out = text;
  for (const [path, label] of Object.entries(paths)) if (path) out = out.split(path).join(label);
  return out;
}

/**
 * Runs the fixed test command: no shell, own process group, scrubbed environment, timeout, output
 * cap and a memory watchdog. When the run ends (exit, timeout or memory) every process that belongs
 * to it is killed with SIGKILL and checked: the process group, all descendants, and orphans of the
 * same UID started during the run (detached children, `setsid`, double fork). The call never waits
 * for the output pipes to close, because a surviving child can hold them open forever: it returns
 * at the latest `timeoutMs` plus a short grace period.
 */
export async function runCommand(
  cmd: TestCommand,
  extraArgs: readonly string[],
  cwd: string,
  maxOutputBytes: number,
): Promise<RunOutcome> {
  const home = await mkdtemp(join(tmpdir(), 'oax-ws-home-'));
  const startTicks = await nowTicks();
  const started = Date.now();
  let output = '';
  let outBytes = 0;
  let truncated = false;
  let timedOut = false;
  let memoryExceeded = false;
  const seen = new Set<number>();
  const child = spawn(cmd.command, [...cmd.args, ...extraArgs], {
    cwd,
    env: scrubbedEnv(cmd, home),
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const victims = async () => {
    const procs = await listProcs();
    return findVictims(procs, {
      childPid: child.pid,
      startTicks,
      protect: protectedPids(procs),
      uid: process.getuid?.() ?? -1,
    });
  };
  /** Kills everything that belongs to the run until nothing is left; returns the survivors. */
  const reap = async (): Promise<number> => {
    for (let round = 0; round < REAP_ROUNDS; round += 1) {
      const list = await victims();
      if (list.length === 0) return 0;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* group already gone */
      }
      for (const p of list) {
        seen.add(p.pid);
        try {
          process.kill(p.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await sleep(25);
    }
    return (await victims()).length;
  };

  const onData = (chunk: Buffer) => {
    if (outBytes >= maxOutputBytes) {
      truncated = true;
      return;
    }
    const room = maxOutputBytes - outBytes;
    const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (take.length < chunk.length) truncated = true;
    outBytes += take.length;
    output += take.toString('utf8');
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  let reaping: Promise<number> | null = null;
  const reapOnce = () => (reaping ??= reap());
  const timer = setTimeout(() => {
    timedOut = true;
    void reapOnce();
  }, cmd.timeoutMs);
  let scanning = false;
  const watchdog = setInterval(() => {
    if (scanning || reaping || !child.pid) return;
    scanning = true;
    void victims()
      .then((list) => {
        const rss = list.reduce((sum, p) => sum + p.rssBytes, 0);
        if (rss > cmd.memoryMb * 1024 * 1024) {
          memoryExceeded = true;
          void reapOnce();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        scanning = false;
      });
  }, 150);

  let hard: NodeJS.Timeout | undefined;
  let exited = false;
  try {
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('error', () => resolve({ code: null, signal: 'spawn_error' }));
      child.once('exit', (code, signal) => {
        exited = true;
        resolve({ code, signal });
      });
      // Hard deadline: never wait longer than timeout + grace, whatever the test left running.
      hard = setTimeout(
        () => resolve({ code: null, signal: 'SIGKILL' }),
        cmd.timeoutMs + KILL_GRACE_MS,
      );
    });
    if (exited && !timedOut && !memoryExceeded) await Promise.race([closed, sleep(DRAIN_MS)]);
    await reapOnce().catch(() => undefined);
    const left = await reap(); // second pass: verifies that nothing is left
    const killed = seen.size - (child.pid && seen.has(child.pid) ? 1 : 0);
    const text = redactPaths(output, { [cwd]: '<workspace>', [home]: '<home>' });
    return {
      exitCode: result.code,
      signal: result.signal,
      timedOut,
      memoryExceeded,
      durationMs: Date.now() - started,
      output: truncated ? `${text}\n[output truncated at ${maxOutputBytes} bytes]` : text,
      outputTruncated: truncated,
      strayProcessesKilled: Math.max(0, killed),
      strayProcessesSurvived: left,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(hard);
    clearInterval(watchdog);
    child.stdout.destroy();
    child.stderr.destroy();
    await reap().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}
