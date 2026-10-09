import { readFile } from 'node:fs/promises';

/**
 * Startup self-check. Test code runs as the same UID as this server (see docs/workspace-tools.md,
 * "Trust boundary of test code"); with Yama `ptrace_scope` 0 it could also attach to the server.
 * Returns a warning text, or `null` when ptrace is restricted or the setting is not visible.
 */
export async function ptraceWarning(
  read: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<string | null> {
  let value: string;
  try {
    value = (await read('/proc/sys/kernel/yama/ptrace_scope')).trim();
  } catch {
    return null; // no Yama (or no /proc): the container's seccomp profile must deny ptrace
  }
  if (value === '0')
    return 'kernel.yama.ptrace_scope is 0: test code can ptrace this server (same UID); set it to at least 1 or deny ptrace in the container profile';
  return null;
}
