import { createHash } from 'node:crypto';
import { unifiedHunks } from './diff.js';
import { isPatchable } from './paths.js';
import type { TreeSnapshot } from './tree.js';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

export type PatchResult =
  | { ok: true; patch: string; patchSha256: string; changedFiles: ChangedFile[] }
  | { ok: false; code: string; message: string; paths: string[] };

export interface PatchLimits {
  maxFiles: number;
  maxPatchBytes: number;
  maxFileBytes: number;
}

const refuse = (code: string, message: string, paths: string[] = []): PatchResult => ({
  ok: false,
  code,
  message,
  paths: paths.slice(0, 20),
});

function decodeText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Computes the final patch from the baseline (seed) and the current tree. Pure policy: the patch
 * is refused as a whole when any change is outside the writable area, binary, a link or special
 * file, a mode change, or too large. The model never writes or sees this step's inputs.
 */
export async function computePatch(
  baseline: TreeSnapshot,
  current: TreeSnapshot,
  readCurrent: (path: string) => Promise<Buffer>,
  writable: readonly RegExp[],
  limits: PatchLimits,
): Promise<PatchResult> {
  const paths = [...new Set([...baseline.keys(), ...current.keys()])].sort();
  const unsafe: string[] = [];
  const changed: { path: string; status: ChangedFile['status'] }[] = [];
  const modes: string[] = [];
  for (const p of paths) {
    const b = baseline.get(p);
    const c = current.get(p);
    if (b && c && b.type === c.type && b.sha256 === c.sha256 && b.exec === c.exec) continue;
    if (c && c.type !== 'file') {
      unsafe.push(p);
      continue;
    }
    if (b && b.type !== 'file') {
      // A link or special file of the seed that is replaced or removed cannot be expressed safely.
      unsafe.push(p);
      continue;
    }
    if (b && c && b.exec !== c.exec) {
      modes.push(p);
      continue;
    }
    changed.push({ path: p, status: !b ? 'added' : !c ? 'deleted' : 'modified' });
  }
  if (unsafe.length)
    return refuse(
      'unsafe_entry',
      'symbolic links and special files cannot be part of a patch',
      unsafe,
    );
  if (modes.length)
    return refuse('mode_change', 'file mode changes cannot be part of a patch', modes);
  const outside = changed.map((c) => c.path).filter((p) => !isPatchable(p, writable));
  if (outside.length)
    return refuse(
      'forbidden_path_changed',
      'files outside the writable area were changed',
      outside,
    );
  if (changed.length > limits.maxFiles)
    return refuse('too_many_files', `more than ${limits.maxFiles} files changed`);

  const changedFiles: ChangedFile[] = [];
  let patch = '';
  for (const { path, status } of changed) {
    const before = status === 'added' ? Buffer.alloc(0) : baseline.get(path)!.content!;
    let after: Buffer = Buffer.alloc(0);
    if (status !== 'deleted') {
      if (current.get(path)!.size > limits.maxFileBytes)
        return refuse('file_too_large', `"${path}" is too large`, [path]);
      after = await readCurrent(path);
    }
    const beforeText = decodeText(before);
    const afterText = decodeText(after);
    if (beforeText === null || afterText === null)
      return refuse('binary_file', `"${path}" is binary or not valid UTF-8`, [path]);
    const hunks = unifiedHunks(beforeText, afterText);
    let additions = 0;
    let deletions = 0;
    for (const line of hunks.split('\n')) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
    let head = `diff --git a/${path} b/${path}\n`;
    if (status === 'added') head += 'new file mode 100644\n';
    if (status === 'deleted') head += 'deleted file mode 100644\n';
    const fromName = status === 'added' ? '/dev/null' : `a/${path}`;
    const toName = status === 'deleted' ? '/dev/null' : `b/${path}`;
    patch += hunks === '' ? head : `${head}--- ${fromName}\n+++ ${toName}\n${hunks}`;
    changedFiles.push({ path, status, additions, deletions });
    if (Buffer.byteLength(patch) > limits.maxPatchBytes)
      return refuse('patch_too_large', `the patch is larger than ${limits.maxPatchBytes} bytes`);
  }
  return {
    ok: true,
    patch,
    patchSha256: createHash('sha256').update(patch).digest('hex'),
    changedFiles,
  };
}
