import { spawn } from 'node:child_process';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestCommand } from './config.js';

export interface RunOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  memoryExceeded: boolean;
  durationMs: number;
  output: string;
  outputTruncated: boolean;
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

/** Resident memory (bytes) of every process in the group, from /proc; 0 when unavailable. */
async function groupRss(pgid: number): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch {
    return 0;
  }
  await Promise.all(
    names
      .filter((n) => /^\d+$/.test(n))
      .map(async (n) => {
        try {
          const stat = await readFile(`/proc/${n}/stat`, 'utf8');
          // Fields after the parenthesised command name: state ppid pgrp ... rss at index 21.
          const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          if (Number(rest[2]) === pgid) total += Number(rest[21]) * 4096;
        } catch {
          /* process ended */
        }
      }),
  );
  return total;
}

/**
 * Runs the fixed test command: no shell, own process group, scrubbed environment, timeout, output
 * cap and a memory watchdog. The whole group is killed at the end so nothing survives the call.
 */
export async function runCommand(
  cmd: TestCommand,
  extraArgs: readonly string[],
  cwd: string,
  maxOutputBytes: number,
): Promise<RunOutcome> {
  const home = await mkdtemp(join(tmpdir(), 'oax-ws-home-'));
  const started = Date.now();
  let output = '';
  let outBytes = 0;
  let truncated = false;
  let timedOut = false;
  let memoryExceeded = false;
  const child = spawn(cmd.command, [...cmd.args, ...extraArgs], {
    cwd,
    env: scrubbedEnv(cmd, home),
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const killGroup = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
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
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, cmd.timeoutMs);
  const watchdog = setInterval(() => {
    if (!child.pid) return;
    void groupRss(child.pid).then((rss) => {
      if (rss > cmd.memoryMb * 1024 * 1024) {
        memoryExceeded = true;
        killGroup();
      }
    });
  }, 150);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('error', () => resolve({ code: null, signal: 'spawn_error' }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    return {
      exitCode: result.code,
      signal: result.signal,
      timedOut,
      memoryExceeded,
      durationMs: Date.now() - started,
      output: truncated ? `${output}\n[output truncated at ${maxOutputBytes} bytes]` : output,
      outputTruncated: truncated,
    };
  } finally {
    clearTimeout(timer);
    clearInterval(watchdog);
    killGroup();
    await rm(home, { recursive: true, force: true });
  }
}
