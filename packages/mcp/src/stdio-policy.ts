import { accessSync, constants, realpathSync } from 'node:fs';
import { posix as path } from 'node:path';
import { OaxError } from '@openagentix/core';
import {
  interpreterArgIssues,
  interpreterProgram,
  interpreterRule,
  forbiddenProgram,
  type InterpreterRule,
} from './stdio-programs.js';
import { isReservedStdioEnv } from './stdio-env.js';

/**
 * Rules for tenant-defined stdio MCP servers (ADR 0016 section 3, slice S0).
 *
 * A stdio connection starts a child process. For connections that tenants define (scope tenant,
 * team or agent) three things must hold:
 *
 *  1. the child runs only in a run node (an isolating runner), never in the trusted worker
 *     ({@link STDIO_INLINE_RUNNERS}, enforced at publish, in the worker and at gateway level);
 *  2. the command is an absolute path that the operator listed in `OAX_MCP_STDIO_COMMANDS`;
 *  3. whatever the allowlist says, shells, wrappers that execute their arguments, run-time
 *     installers, network and container tools, and interpreters with a code-injecting flag are
 *     refused, and the environment must not carry loader or interpreter hooks.
 *
 * Platform (operator-defined) connections are not subject to these rules: the command is operator
 * configuration, like any other binary in the worker image (ADR 0016 section 3.1).
 */

/** Runner kinds that execute steps inside the orchestrating (trusted) process. */
export const STDIO_INLINE_RUNNERS: readonly string[] = ['in-process', 'local'];

/** Connection scopes defined by tenants (everything except `platform`). */
export const isTenantScope = (scope: string): boolean => scope !== 'platform';

export type StdioIssueCode = 'mcp_command_forbidden' | 'mcp_env_forbidden';

export interface StdioIssue {
  code: StdioIssueCode;
  /** Config path of the offending field (`command`, `args.2`, `env.PATH`, ...). */
  path: string;
  message: string;
}

/** The stdio fields that the rules look at. */
export interface StdioFields {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  envSecrets?: Readonly<Record<string, string>>;
}

const MAX_COMMAND = 1024;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4096;
const MAX_ENV = 128;
const MAX_ENV_VALUE = 8192;

// ---------------------------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------------------------

/** Directories that are never accepted as an allowlist prefix (`/usr/bin/*` and friends). */
const BROAD_PREFIXES = new Set([
  '/',
  '/bin',
  '/sbin',
  '/usr',
  '/usr/bin',
  '/usr/sbin',
  '/usr/local',
  '/usr/local/sbin',
  '/lib',
  '/lib64',
  '/usr/lib',
  '/usr/lib64',
  '/etc',
  '/tmp',
  '/var',
  '/var/tmp',
  '/dev',
  '/dev/shm',
  '/proc',
  '/sys',
  '/run',
  '/home',
  '/root',
  '/mnt',
  '/media',
  '/opt',
  '/workspace',
  '/work',
]);

/**
 * Directories that are temporary, virtual or written by runs: no entry may lie in or below them
 * (not even a single file), because a run node or a step can create or replace files there (the
 * node's workspace is `/tmp/workspace`, filled from the tenant's repository).
 */
const WRITABLE_ROOTS = ['/tmp', '/var/tmp', '/dev', '/proc', '/sys', '/run', '/workspace', '/work'];
const underWritableRoot = (p: string): boolean =>
  WRITABLE_ROOTS.some((r) => p === r || p.startsWith(`${r}/`));

/** Control characters (and optionally whitespace) have no place in a path or an allowlist entry. */
function hasControlOrSpace(s: string, spaces = true): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || c === 0x7f || (spaces && /\s/u.test(ch))) return true;
  }
  return false;
}

const isNormalizedAbsolute = (p: string): boolean =>
  p.startsWith('/') && path.normalize(p) === p && (p === '/' || !p.endsWith('/'));

/**
 * Parses `OAX_MCP_STDIO_COMMANDS`: comma-separated absolute paths. An entry is either one file
 * (`/opt/mcp/bin/server`) or `dir/*` (every file directly inside `dir`, not below). Throws on an
 * entry that would be unsafe or ambiguous, so a typo fails start-up instead of opening a hole.
 */
export function parseStdioAllowlist(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const entry of (raw ?? '').split(',').map((e) => e.trim())) {
    if (!entry) continue;
    const bad = (why: string): never => {
      throw new Error(`OAX_MCP_STDIO_COMMANDS entry "${entry}": ${why}`);
    };
    if (hasControlOrSpace(entry)) bad('must not contain whitespace or control characters');
    const wildcard = entry.endsWith('/*');
    const target = wildcard ? entry.slice(0, -2) || '/' : entry;
    if (target.includes('*') || /[?[\]{}$`\\]/u.test(target))
      bad('only a trailing "/*" is supported (no other glob characters)');
    if (!isNormalizedAbsolute(target))
      bad('must be a normalized absolute path (no ".", ".." or "//" segments, no trailing "/")');
    if (wildcard && BROAD_PREFIXES.has(target))
      bad(
        'the directory is too broad for a prefix entry; list the binaries or a dedicated directory',
      );
    if (!wildcard && target === '/') bad('is not a file');
    if (underWritableRoot(target))
      bad(
        'lies in a temporary, virtual or run-writable directory (/tmp, /dev, /proc, /workspace, ...)',
      );
    out.push(wildcard ? `${target}/*` : target);
  }
  return out;
}

/** `true` when `p` equals an entry or lies directly inside a `dir/*` entry. */
export function matchesStdioAllowlist(p: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) =>
    entry.endsWith('/*') ? path.dirname(p) === entry.slice(0, -2) : p === entry,
  );
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

export interface StdioCheckOptions {
  /** Parsed `OAX_MCP_STDIO_COMMANDS`; empty = no tenant stdio command is allowed. */
  allowlist: readonly string[];
  /**
   * How symlinks are treated. `skip`: not resolved (a check that cannot see the image). `if-exists`:
   * resolved when the file exists (control node at save time). `require`: the file must exist and
   * its real path must satisfy every rule (run nodes, which hold the binaries).
   */
  realpath?: 'skip' | 'if-exists' | 'require';
  /** Test seam; defaults to `fs.realpathSync`. Returns `null` when the file does not exist. */
  resolve?: (p: string) => string | null;
  /**
   * Test seam for `require` mode: `true` when this process could change the file or its directory
   * (replace the binary between the check and the start). Defaults to an `access(W_OK)` probe.
   */
  writable?: (p: string) => boolean;
}

function defaultWritable(p: string): boolean {
  const w = (x: string) => {
    try {
      accessSync(x, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  return w(p) || w(path.dirname(p));
}

function defaultResolve(p: string): string | null {
  try {
    return realpathSync(p);
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === 'ENOENT' ||
      (e as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      return null;
    throw e;
  }
}

/**
 * Checks the stdio fields of a tenant connection. Returns all issues (empty = acceptable). Pure
 * apart from the optional realpath lookup.
 */
export function checkStdioConfig(cfg: StdioFields, opts: StdioCheckOptions): StdioIssue[] {
  return [...commandIssues(cfg, opts), ...envIssues(cfg)];
}

function commandIssues(cfg: StdioFields, opts: StdioCheckOptions): StdioIssue[] {
  const issues: StdioIssue[] = [];
  const cmd = (message: string, p = 'command') =>
    issues.push({ code: 'mcp_command_forbidden', path: p, message });
  const command = cfg.command;
  const args = cfg.args ?? [];

  // Shape of the command and arguments.
  if (command.length > MAX_COMMAND || hasControlOrSpace(command, false)) {
    cmd('command must be a plain path (no control characters, at most 1024 characters)');
    return issues;
  }
  if (!command.startsWith('/')) {
    cmd(`command "${command}" must be an absolute path (relative names are resolved via PATH)`);
    return issues;
  }
  if (!isNormalizedAbsolute(command)) {
    cmd(`command "${command}" must be a normalized absolute path (no ".", ".." or "//" segments)`);
    return issues;
  }
  if (args.length > MAX_ARGS) cmd(`at most ${MAX_ARGS} arguments are allowed`, 'args');
  args.forEach((a, i) => {
    if (a.length > MAX_ARG_LENGTH || a.includes('\u0000'))
      cmd(`argument ${i} is too long or contains a NUL character`, `args.${i}`);
  });

  // What the literal path is, then what it resolves to.
  const files = resolveFile(command, 'command', opts, cmd);
  const rules = new Set<InterpreterRule>();
  for (const { file, label } of files) {
    const why = forbiddenProgram(file);
    if (why) cmd(`${label} "${file}" is ${why}; it is refused even if allowlisted`);
    const rule = interpreterRule(file);
    if (rule) {
      rules.add(rule);
      for (const m of interpreterArgIssues(rule, args))
        cmd(
          `${label} "${file}" is an interpreter: ${m.slice(m.indexOf(': ') + 2)}`,
          m.slice(0, m.indexOf(':')),
        );
    }
  }

  // Allowlist: the literal path, and a resolved path must be listed too (symlink escape).
  if (opts.allowlist.length === 0) {
    cmd('no stdio commands are allowed on this platform (set OAX_MCP_STDIO_COMMANDS)');
    return issues;
  }
  for (const { file, label } of files)
    if (!matchesStdioAllowlist(file, opts.allowlist))
      cmd(
        label === 'command'
          ? `command "${file}" is not in OAX_MCP_STDIO_COMMANDS`
          : `${label} is not in OAX_MCP_STDIO_COMMANDS (a symlink may not lead out of the allowlist)`,
      );

  // An interpreter runs a program file, and that file is code as much as the interpreter is: it
  // must be an absolute path in the allowlist too (strict default), so a tenant cannot point an
  // allowlisted `node` or `python` at a file of the workspace or a module on a search path.
  for (const rule of rules) {
    const at = interpreterProgram(rule, args);
    const p = `args.${at.index}`;
    if (at.message) {
      cmd(`command "${command}" is an interpreter: ${at.message}`, p);
      continue;
    }
    const program = args[at.index];
    if (program === undefined) {
      cmd(
        `command "${command}" is an interpreter and must run a program file listed in OAX_MCP_STDIO_COMMANDS`,
        'args',
      );
      continue;
    }
    if (hasControlOrSpace(program, false) || !isNormalizedAbsolute(program)) {
      cmd(
        `the program file of interpreter "${command}" must be a normalized absolute path listed in OAX_MCP_STDIO_COMMANDS`,
        p,
      );
      continue;
    }
    const programFiles = resolveFile(program, 'program file', opts, (m) => cmd(m, p));
    for (const { file, label } of programFiles)
      if (!matchesStdioAllowlist(file, opts.allowlist))
        cmd(
          label === 'program file'
            ? `the program file "${file}" of interpreter "${command}" is not in OAX_MCP_STDIO_COMMANDS`
            : `${label} is not in OAX_MCP_STDIO_COMMANDS (a symlink may not lead out of the allowlist)`,
          p,
        );
  }

  return issues;
}

/**
 * The literal path and, unless `skip`, its real path (when it differs). In `require` mode the file
 * must exist and neither it nor its directory may be writable by this process: a binary the run
 * can replace between this check and the start is not the reviewed binary.
 */
function resolveFile(
  file: string,
  what: string,
  opts: StdioCheckOptions,
  report: (message: string) => void,
): { file: string; label: string }[] {
  const out = [{ file, label: what }];
  if (!opts.realpath || opts.realpath === 'skip') return out;
  const real = (opts.resolve ?? defaultResolve)(file);
  if (real === null) {
    if (opts.realpath === 'require') report(`${what} "${file}" does not exist in this image`);
    return out;
  }
  if (real !== file) out.push({ file: real, label: `real path "${real}" of ${what}` });
  if (opts.realpath === 'require') {
    const writable = opts.writable ?? defaultWritable;
    for (const f of new Set([file, real]))
      if (writable(f))
        report(
          `${what} "${f}" or its directory is writable by the run node; only read-only, reviewed files may be started`,
        );
  }
  return out;
}

function envIssues(cfg: StdioFields): StdioIssue[] {
  const issues: StdioIssue[] = [];
  const envEntries = [
    ...Object.entries(cfg.env ?? {}).map(([k, v]) => ['env', k, v] as const),
    ...Object.keys(cfg.envSecrets ?? {}).map((k) => ['envSecrets', k, ''] as const),
  ];
  if (envEntries.length > MAX_ENV)
    issues.push({
      code: 'mcp_env_forbidden',
      path: 'env',
      message: `at most ${MAX_ENV} environment variables are allowed`,
    });
  for (const [field, key, value] of envEntries) {
    const bad = (message: string) =>
      issues.push({ code: 'mcp_env_forbidden', path: `${field}.${key}`, message });
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)) bad(`"${key}" is not a valid variable name`);
    else if (isReservedStdioEnv(key))
      bad(`"${key}" is reserved (loader, interpreter, proxy and platform variables)`);
    if (value.includes('\u0000') || value.length > MAX_ENV_VALUE)
      bad(`value of "${key}" is too long or contains a NUL character`);
  }
  return issues;
}

/** An {@link OaxError} for the first issue (`details` carries all of them). */
export function stdioError(server: string, issues: readonly StdioIssue[]): OaxError {
  const first = issues[0]!;
  return new OaxError(
    first.code,
    `MCP server "${server}" is refused: ${first.message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`,
    issues,
  );
}
