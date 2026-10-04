import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { OaxError, redactString } from '@openagentix/core';
import type { HarnessInvocation, HarnessResult, HarnessTermination } from '../harness.js';

/**
 * Adapter-specific part of a harness run: folds the CLI output (one line at a time) into a result.
 * The process handling (limits, kill, redaction, output cap) is shared by all harnesses.
 */
export interface OutputParser {
  feed(line: string): void;
  /** Model round trips seen so far (platform-side step limit). */
  turnCount(): number;
  /** Cost reported so far, in USD (platform-side budget limit). */
  costUsd(): number;
  /** Called once when the process ended. */
  finalize(exitCode: number | null): ParsedOutput;
}

export interface ParsedOutput {
  text: string;
  isError: boolean;
  errorMessage?: string | undefined;
  /** A limit the harness reported itself (flags / result subtypes). */
  terminated?: HarnessTermination | undefined;
  /** False if the CLI never produced a final result (treated as failure). */
  complete: boolean;
  turns: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  model?: string | undefined;
  sessionId?: string | undefined;
  toolCalls: HarnessResult['toolCalls'];
}

export interface ProcessOptions {
  cwd: string;
  env: Record<string, string>;
  secrets: string[];
  signal: AbortSignal | undefined;
}

export const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

export function runHarnessProcess(
  inv: HarnessInvocation,
  p: ProcessOptions,
  parser: OutputParser,
): Promise<HarnessResult> {
  return new Promise((resolvePromise, reject) => {
    let terminated: HarnessTermination = 'none';
    let stderr = '';
    let bytes = 0;
    let buffer = '';
    const child = spawn(inv.command, inv.args, {
      cwd: p.cwd,
      env: p.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stop = (why: HarnessTermination) => {
      if (terminated === 'none') terminated = why;
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
      }
    };
    const maxTurns = inv.limits?.maxTurns;
    const maxBudgetUsd = inv.limits?.maxBudgetUsd;
    const feed = (line: string) => {
      if (!line.trim()) return;
      parser.feed(line);
      // Platform-side enforcement, independent of the harness' own flags.
      if (maxTurns !== undefined && parser.turnCount() > maxTurns) stop('turns');
      if (maxBudgetUsd !== undefined && parser.costUsd() > maxBudgetUsd) stop('budget');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STDOUT_BYTES) return stop('output_limit');
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        feed(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString('utf8');
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(inv.stdin ?? '');
    const timer = inv.limits?.timeoutMs
      ? setTimeout(() => stop('timeout'), inv.limits.timeoutMs)
      : null;
    const onAbort = () => stop('cancelled');
    if (p.signal?.aborted) onAbort();
    p.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(
        new OaxError(
          'harness_spawn_failed',
          redactString(`cannot start ${inv.command}: ${e.message}`, p.secrets),
        ),
      );
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      p.signal?.removeEventListener('abort', onAbort);
      feed(buffer);
      const out = parser.finalize(code);
      // The harness' own limits surface as reported terminations.
      if (terminated === 'none' && out.terminated) terminated = out.terminated;
      const failed = terminated !== 'none' || out.isError || code !== 0 || !out.complete;
      const message =
        terminated !== 'none'
          ? `harness stopped: ${terminated}`
          : (out.errorMessage ??
            (failed ? `harness exited with code ${String(code)} and no result` : undefined));
      resolvePromise({
        exitCode: code,
        text: redactString(out.text, p.secrets),
        isError: failed,
        ...(message
          ? {
              errorMessage: redactString(
                stderr.trim() && !out.complete
                  ? `${message}: ${stderr.trim().slice(0, 300)}`
                  : message,
                p.secrets,
              ),
            }
          : {}),
        turns: out.turns,
        costUsd: out.costUsd,
        tokensIn: out.tokensIn,
        tokensOut: out.tokensOut,
        ...(out.model ? { model: out.model } : {}),
        ...(out.sessionId ? { sessionId: out.sessionId } : {}),
        toolCalls: out.toolCalls.map((t) => ({ ...t, output: redactString(t.output, p.secrets) })),
        terminated,
      });
    });
  });
}

/** Creates the work directory (0700) and writes the generated files (0600) into it. */
export async function prepareWorkdir(
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const cwd = resolve(dir);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  for (const [rel, content] of Object.entries(files)) {
    const target = resolve(cwd, rel);
    if (!target.startsWith(cwd + sep))
      throw new OaxError('harness_invalid', 'file escapes workdir');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
  return cwd;
}
