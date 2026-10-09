import { createHash } from 'node:crypto';
import { realpath, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWorkspaceConfig, type WorkspaceConfig, type WorkspaceConfigInput } from './config.js';
import { WorkspaceError } from './errors.js';
import { readRegularFile, writeFileAtomic } from './fs-safe.js';
import { computePatch, type ChangedFile, type PatchResult } from './patch.js';
import { assertAllowed, assertWritable, isForbidden, splitPath } from './paths.js';
import { runCommand } from './run-tests.js';
import { literalMatches, regexMatches, type SearchLine } from './search.js';
import { walkTree, type TreeSnapshot } from './tree.js';

export interface TestRunRecord {
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  memoryExceeded: boolean;
  durationMs: number;
  file: string | null;
  /** Processes the test left running (detached, double fork, setsid) that were killed. */
  strayProcessesKilled: number;
  /** Processes that survived the kill; such a run never counts as passed. */
  strayProcessesSurvived: number;
  /** Digest of the patch at the time of the run, `null` if no valid patch existed then. */
  patchSha256: string | null;
}

export interface FinalResult {
  /** The patch computed by the node from the tree (never from model text). */
  patch: PatchResult;
  lastTestRun: TestRunRecord | null;
  /** The last test run was the full suite (no file argument) and passed. */
  fullSuitePassed: boolean;
  /** The tree after the last test run is exactly the tree the patch describes. */
  treeMatchesLastRun: boolean;
  /** `fullSuitePassed && treeMatchesLastRun`: the full suite passed on exactly the final tree. */
  testedFinalTree: boolean;
  toolCalls: number;
  denied: number;
}

export interface TextResult {
  content: string;
  truncated: boolean;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function decodeStrict(buf: Buffer, rel: string): string {
  if (buf.includes(0)) throw new WorkspaceError('binary_file', `"${rel}" is a binary file`);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw new WorkspaceError('binary_file', `"${rel}" is not valid UTF-8 text`);
  }
}

/** Cuts text to at most `max` bytes on a character boundary. */
function capBytes(text: string, max: number): TextResult {
  const buf = Buffer.from(text);
  if (buf.length <= max) return { content: text, truncated: false };
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { content: buf.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * The confined workspace of one harness step. All methods take model-controlled input and treat it
 * as hostile: paths are validated and resolved without following links, sizes and counts are
 * capped, and nothing runs through a shell.
 */
export class Workspace {
  private readonly writable: RegExp[];
  private readonly started: number;
  private calls = 0;
  private denied = 0;
  private created = 0;
  private testRuns = 0;
  private last: TestRunRecord | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly config: WorkspaceConfig,
    private readonly rootReal: string,
    private readonly baseline: TreeSnapshot,
    private readonly now: () => number,
  ) {
    this.writable = config.writable.map((s) => new RegExp(s, 'u'));
    this.started = now();
  }

  /** Validates the configuration and takes the baseline snapshot of the seeded directory. */
  static async open(
    input: WorkspaceConfigInput,
    opts: { now?: () => number } = {},
  ): Promise<Workspace> {
    const config = parseWorkspaceConfig(input);
    let rootReal: string;
    try {
      rootReal = await realpath(config.root);
    } catch {
      throw new WorkspaceError('root_missing', 'the workspace directory does not exist');
    }
    const baseline = await walkTree(rootReal, {
      maxEntries: config.maxTreeEntries,
      maxBytes: config.maxSeedBytes,
      keepContent: true,
      deadline: (opts.now ?? Date.now)() + config.maxFinalizeMs,
      ...(opts.now ? { now: opts.now } : {}),
    });
    return new Workspace(config, rootReal, baseline, opts.now ?? Date.now);
  }

  /** Runs one tool call serialised, under the per-run call and time budget. */
  call<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.now() - this.started > this.config.maxDurationMs)
        throw new WorkspaceError('budget_exhausted', 'the workspace time budget is used up');
      if (this.calls >= this.config.maxToolCalls)
        throw new WorkspaceError('budget_exhausted', 'the tool call budget is used up');
      this.calls += 1;
      try {
        return await fn();
      } catch (e) {
        if (
          e instanceof WorkspaceError &&
          /forbidden|not_writable|escape|symlink|hardlink|invalid_path|arg_not_allowed/.test(e.code)
        )
          this.denied += 1;
        throw e;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async listFiles(path = '.', depth = 1): Promise<{ entries: string[]; truncated: boolean }> {
    const segments = splitPath(path, { allowRoot: true });
    assertAllowed(segments, path);
    const dir = await this.resolveDir(segments, path);
    const max = this.config.maxListEntries;
    const maxDepth = Math.min(Math.max(1, depth), 3);
    const entries: string[] = [];
    let truncated = false;
    const visit = async (abs: string, rel: string[], level: number): Promise<void> => {
      const names = (await readdir(abs)).sort();
      for (const name of names) {
        const childRel = [...rel, name];
        if (isForbidden(childRel)) continue;
        const st = await lstat(join(abs, name)).catch(() => null);
        if (!st) continue;
        if (entries.length >= max) {
          truncated = true;
          return;
        }
        const label = childRel.join('/');
        if (st.isSymbolicLink()) entries.push(`${label} (symlink, not followed)`);
        else if (st.isDirectory()) {
          entries.push(`${label}/`);
          if (level < maxDepth) await visit(join(abs, name), childRel, level + 1);
        } else if (st.isFile()) entries.push(`${label} (${st.size} bytes)`);
        else entries.push(`${label} (special)`);
        if (truncated) return;
      }
    };
    await visit(dir, segments, 1);
    return { entries, truncated };
  }

  private async resolveDir(segments: string[], rel: string): Promise<string> {
    let current = this.rootReal;
    for (const s of segments) {
      current = join(current, s);
      const st = await lstat(current).catch(() => null);
      if (!st) throw new WorkspaceError('not_found', `"${rel}" does not exist`);
      if (st.isSymbolicLink())
        throw new WorkspaceError('symlink_refused', `"${rel}" passes through a symbolic link`);
      if (!st.isDirectory())
        throw new WorkspaceError('not_a_directory', `"${rel}" is not a directory`);
    }
    return current;
  }

  async readFile(
    path: string,
    offset = 0,
    limit = 2000,
  ): Promise<{
    path: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
    content: string;
  }> {
    const segments = splitPath(path);
    assertAllowed(segments, path);
    const buf = await readRegularFile(this.rootReal, segments, path, this.config.maxReadFileBytes);
    const lines = decodeStrict(buf, path).split(/(?<=\n)/);
    const total = lines.length === 1 && lines[0] === '' ? 0 : lines.length;
    const slice = lines.slice(offset, offset + limit).join('');
    const capped = capBytes(slice, this.config.maxReadBytesPerCall);
    const shown = capped.content === '' ? 0 : capped.content.split(/(?<=\n)/).length;
    return {
      path,
      startLine: offset + 1,
      endLine: offset + shown,
      totalLines: total,
      truncated: capped.truncated || offset + limit < total,
      content: capped.content,
    };
  }

  async search(
    pattern: string,
    opts: { path?: string; literal?: boolean; ignoreCase?: boolean } = {},
  ): Promise<{ matches: SearchLine[]; truncated: boolean; scannedFiles: number }> {
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 200)
      throw new WorkspaceError('bad_pattern', 'pattern must be 1 to 200 characters');
    const base = splitPath(opts.path ?? '.', { allowRoot: true });
    assertAllowed(base, opts.path ?? '.');
    const files: string[] = [];
    const baseAbs = await this.resolveStart(base, opts.path ?? '.');
    if (baseAbs.isFile) files.push(base.join('/'));
    else {
      const stack: string[][] = [base];
      while (stack.length > 0 && files.length < 2000) {
        const rel = stack.pop()!;
        for (const name of (await readdir(join(this.rootReal, ...rel))).sort()) {
          const child = [...rel, name];
          if (isForbidden(child) || child.length > 12) continue;
          const st = await lstat(join(this.rootReal, ...child)).catch(() => null);
          if (!st) continue;
          if (st.isDirectory()) stack.push(child);
          else if (st.isFile() && st.size <= this.config.maxReadFileBytes)
            files.push(child.join('/'));
        }
      }
    }
    const lines: SearchLine[] = [];
    let scannedBytes = 0;
    let scanned = 0;
    for (const f of files.sort()) {
      let text: string;
      try {
        const buf = await readRegularFile(
          this.rootReal,
          f.split('/'),
          f,
          this.config.maxReadFileBytes,
        );
        scannedBytes += buf.length;
        if (scannedBytes > 4 * 1024 * 1024) break;
        text = decodeStrict(buf, f);
      } catch {
        continue; // binary, link or vanished files are skipped silently
      }
      scanned += 1;
      text.split('\n').forEach((t, i) => {
        if (t.length > 0) lines.push({ path: f, line: i + 1, text: t.slice(0, 500) });
      });
    }
    const texts = lines.map((l) => l.text);
    const ignoreCase = opts.ignoreCase === true;
    const hits =
      opts.literal === false
        ? await regexMatches(pattern, ignoreCase, texts, this.config.searchTimeoutMs)
        : literalMatches(pattern, ignoreCase, texts);
    const matches: SearchLine[] = [];
    let size = 0;
    let truncated = hits.length > this.config.maxSearchMatches;
    for (const i of hits.slice(0, this.config.maxSearchMatches)) {
      const m = lines[i]!;
      size += Buffer.byteLength(m.text) + m.path.length + 16;
      if (size > this.config.maxOutputBytes) {
        truncated = true;
        break;
      }
      matches.push(m);
    }
    return { matches, truncated, scannedFiles: scanned };
  }

  private async resolveStart(
    segments: string[],
    rel: string,
  ): Promise<{ abs: string; isFile: boolean }> {
    let current = this.rootReal;
    let st = null;
    for (const s of segments) {
      current = join(current, s);
      st = await lstat(current).catch(() => null);
      if (!st) throw new WorkspaceError('not_found', `"${rel}" does not exist`);
      if (st.isSymbolicLink())
        throw new WorkspaceError('symlink_refused', `"${rel}" passes through a symbolic link`);
    }
    return { abs: current, isFile: st?.isFile() ?? false };
  }

  async editFile(
    path: string,
    oldText: string,
    newText: string,
  ): Promise<{ path: string; bytes: number }> {
    const segments = splitPath(path);
    assertWritable(segments, path, this.writable);
    if (oldText.length === 0) throw new WorkspaceError('bad_edit', '"old" must not be empty');
    if (oldText === newText) throw new WorkspaceError('bad_edit', '"old" and "new" are identical');
    const buf = await readRegularFile(this.rootReal, segments, path, this.config.maxReadFileBytes);
    const text = decodeStrict(buf, path);
    const first = text.indexOf(oldText);
    if (first === -1) throw new WorkspaceError('no_match', `"old" was not found in "${path}"`);
    if (text.indexOf(oldText, first + 1) !== -1)
      throw new WorkspaceError('ambiguous_match', `"old" occurs more than once in "${path}"`);
    const next = text.slice(0, first) + newText + text.slice(first + oldText.length);
    return this.store(segments, path, next, { mustExist: true });
  }

  async writeFile(
    path: string,
    content: string,
  ): Promise<{ path: string; bytes: number; created: boolean }> {
    const segments = splitPath(path);
    assertWritable(segments, path, this.writable);
    const out = await this.store(segments, path, content, {});
    return out;
  }

  private async store(
    segments: string[],
    rel: string,
    content: string,
    opts: { mustExist?: boolean },
  ): Promise<{ path: string; bytes: number; created: boolean }> {
    if (content.includes('\u0000')) throw new WorkspaceError('binary_file', 'content contains NUL');
    const data = Buffer.from(content, 'utf8');
    if (data.length > this.config.maxWriteBytes)
      throw new WorkspaceError(
        'file_too_large',
        `content is larger than ${this.config.maxWriteBytes} bytes`,
      );
    const exists = await readRegularFile(this.rootReal, segments, rel, this.config.maxReadFileBytes)
      .then(() => true)
      .catch((e: unknown) => {
        if (e instanceof WorkspaceError && e.code === 'not_found') return false;
        throw e;
      });
    if (!exists && this.created >= this.config.maxCreatedFiles)
      throw new WorkspaceError(
        'too_many_files',
        `at most ${this.config.maxCreatedFiles} new files`,
      );
    const r = await writeFileAtomic(this.rootReal, segments, rel, data, opts);
    if (r.created) this.created += 1;
    return { path: rel, bytes: data.length, created: r.created };
  }

  async runTests(
    file?: string,
  ): Promise<TestRunRecord & { output: string; outputTruncated: boolean }> {
    const cmd = this.config.tests;
    if (!cmd) throw new WorkspaceError('tests_not_configured', 'no test command is configured');
    if (this.testRuns >= cmd.maxRuns)
      throw new WorkspaceError('budget_exhausted', `at most ${cmd.maxRuns} test runs`);
    const extra: string[] = [];
    if (file !== undefined) {
      if (!cmd.filePattern)
        throw new WorkspaceError('arg_not_allowed', 'this test command takes no file argument');
      const segments = splitPath(file);
      assertAllowed(segments, file);
      if (file.startsWith('-') || !new RegExp(cmd.filePattern, 'u').test(file))
        throw new WorkspaceError(
          'arg_not_allowed',
          'the test file does not match the allowed pattern',
        );
      await readRegularFile(this.rootReal, segments, file, this.config.maxReadFileBytes);
      extra.push(file);
    }
    this.testRuns += 1;
    const out = await runCommand(cmd, extra, this.rootReal, this.config.maxOutputBytes);
    // Digest of the tree AFTER the run: a test that writes files is part of what was tested.
    const after = await this.currentPatchDigest();
    const record: TestRunRecord = {
      passed:
        out.exitCode === 0 &&
        !out.timedOut &&
        !out.memoryExceeded &&
        out.strayProcessesSurvived === 0,
      exitCode: out.exitCode,
      signal: out.signal,
      timedOut: out.timedOut,
      memoryExceeded: out.memoryExceeded,
      durationMs: out.durationMs,
      file: file ?? null,
      strayProcessesKilled: out.strayProcessesKilled,
      strayProcessesSurvived: out.strayProcessesSurvived,
      patchSha256: after,
    };
    this.last = record;
    return { ...record, output: out.output, outputTruncated: out.outputTruncated };
  }

  private async currentPatchDigest(): Promise<string | null> {
    const p = await this.computePatch();
    return p.ok ? p.patchSha256 : null;
  }

  /** The patch of the current tree against the seed. */
  async computePatch(): Promise<PatchResult> {
    const deadline = this.now() + this.config.maxFinalizeMs;
    const current = await walkTree(this.rootReal, {
      maxEntries: this.config.maxTreeEntries,
      maxBytes: this.config.maxTreeBytes,
      keepContent: false,
      deadline,
      now: this.now,
    });
    return computePatch(
      this.baseline,
      current,
      async (p) => readRegularFile(this.rootReal, p.split('/'), p, this.config.maxReadFileBytes),
      this.writable,
      {
        maxFiles: this.config.maxPatchFiles,
        maxPatchBytes: this.config.maxPatchBytes,
        maxFileBytes: this.config.maxReadFileBytes,
        clock: { deadline, now: this.now },
      },
    );
  }

  /** Final result for the step output; called by the node, never exposed as a model tool. */
  async finalize(): Promise<FinalResult> {
    const patch = await this.computePatch().catch((e: unknown): PatchResult => ({
      ok: false,
      code: e instanceof WorkspaceError ? e.code : 'io_error',
      message: e instanceof WorkspaceError ? e.message : 'cannot compute the patch',
      paths: [],
    }));
    // A single test file proves nothing about the rest of the suite: only a full run counts.
    const fullSuitePassed = !!(this.last?.passed && this.last.file === null);
    const treeMatchesLastRun = !!(patch.ok && this.last?.patchSha256 === patch.patchSha256);
    return {
      patch,
      lastTestRun: this.last,
      fullSuitePassed,
      treeMatchesLastRun,
      testedFinalTree: fullSuitePassed && treeMatchesLastRun,
      toolCalls: this.calls,
      denied: this.denied,
    };
  }
}

export type { ChangedFile };
export { sha256 as digestOf };
