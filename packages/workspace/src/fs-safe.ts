import { constants as C } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, sep } from 'node:path';
import { WorkspaceError } from './errors.js';

/** Fails if `abs` (resolved) is not inside the real workspace root. Defence in depth. */
export async function assertInside(rootReal: string, abs: string, rel: string): Promise<void> {
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new WorkspaceError('not_found', `"${rel}" does not exist`);
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep))
    throw new WorkspaceError('path_escape', `"${rel}" resolves outside the workspace`);
}

/**
 * Walks the segments from the root with `lstat` and refuses every symbolic link on the way.
 * Returns the absolute path and the final stat (`null` if the last segment does not exist).
 * Missing intermediate directories yield `not_found`.
 */
export async function resolveNoSymlink(
  rootReal: string,
  segments: readonly string[],
  rel: string,
): Promise<{ abs: string; stat: Stats | null }> {
  let current = rootReal;
  let stat: Stats | null = null;
  for (let i = 0; i < segments.length; i += 1) {
    current = join(current, segments[i]!);
    try {
      stat = await lstat(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        if (i === segments.length - 1) return { abs: current, stat: null };
        throw new WorkspaceError('not_found', `"${rel}" does not exist`);
      }
      throw new WorkspaceError('io_error', `cannot access "${rel}"`);
    }
    if (stat.isSymbolicLink())
      throw new WorkspaceError('symlink_refused', `"${rel}" passes through a symbolic link`);
    if (i < segments.length - 1 && !stat.isDirectory())
      throw new WorkspaceError('not_found', `"${rel}" does not exist`);
  }
  return { abs: current, stat };
}

/** Reads a regular file without following links; at most `max` bytes (else `file_too_large`). */
export async function readRegularFile(
  rootReal: string,
  segments: readonly string[],
  rel: string,
  max: number,
): Promise<Buffer> {
  const { abs, stat } = await resolveNoSymlink(rootReal, segments, rel);
  if (!stat) throw new WorkspaceError('not_found', `"${rel}" does not exist`);
  if (!stat.isFile()) throw new WorkspaceError('not_a_file', `"${rel}" is not a regular file`);
  if (stat.size > max)
    throw new WorkspaceError('file_too_large', `"${rel}" is larger than ${max} bytes`);
  await assertInside(rootReal, abs, rel);
  let fh;
  try {
    // O_NOFOLLOW: a link swapped in after the check is refused; O_NONBLOCK: a FIFO cannot hang.
    fh = await open(abs, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP')
      throw new WorkspaceError('symlink_refused', `"${rel}" is a symbolic link`);
    throw new WorkspaceError('io_error', `cannot open "${rel}"`);
  }
  try {
    const fstat = await fh.stat();
    if (!fstat.isFile()) throw new WorkspaceError('not_a_file', `"${rel}" is not a regular file`);
    // A second hard link could be the way into a file outside the workspace.
    if (fstat.nlink !== 1)
      throw new WorkspaceError('hardlink_refused', `"${rel}" has more than one hard link`);
    if (fstat.size > max)
      throw new WorkspaceError('file_too_large', `"${rel}" is larger than ${max} bytes`);
    const buf = Buffer.alloc(Math.min(fstat.size, max));
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally {
    await fh.close();
  }
}

/** Creates missing directories one level at a time, refusing links; returns the parent path. */
export async function ensureParents(
  rootReal: string,
  segments: readonly string[],
  rel: string,
): Promise<string> {
  let current = rootReal;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = join(current, segments[i]!);
    let st: Stats | null = null;
    try {
      st = await lstat(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new WorkspaceError('io_error', `cannot access "${rel}"`);
    }
    if (!st) {
      try {
        await mkdir(current, { mode: 0o755 });
      } catch {
        throw new WorkspaceError('io_error', `cannot create a directory for "${rel}"`);
      }
      st = await lstat(current);
    }
    if (st.isSymbolicLink())
      throw new WorkspaceError('symlink_refused', `"${rel}" passes through a symbolic link`);
    if (!st.isDirectory()) throw new WorkspaceError('not_a_file', `"${rel}" has a file as parent`);
  }
  await assertInside(rootReal, current, rel);
  return current;
}

/**
 * Atomic write: exclusive temp file in the same directory (no link following), then rename over
 * the target. An existing target must be a regular file; its permission bits are kept.
 */
export async function writeFileAtomic(
  rootReal: string,
  segments: readonly string[],
  rel: string,
  data: Buffer,
  opts: { mustExist?: boolean; mustNotExist?: boolean } = {},
): Promise<{ created: boolean }> {
  let stat: Stats | null = null;
  try {
    stat = (await resolveNoSymlink(rootReal, segments, rel)).stat;
  } catch (e) {
    // Missing parent directories are created below; every other refusal (links) stands.
    if (!(e instanceof WorkspaceError) || e.code !== 'not_found') throw e;
  }
  if (stat && !stat.isFile())
    throw new WorkspaceError('not_a_file', `"${rel}" is not a regular file`);
  if (opts.mustExist && !stat) throw new WorkspaceError('not_found', `"${rel}" does not exist`);
  if (opts.mustNotExist && stat)
    throw new WorkspaceError('already_exists', `"${rel}" already exists`);
  const parent = await ensureParents(rootReal, segments, rel);
  const target = join(parent, segments[segments.length - 1]!);
  const tmp = join(parent, `.oax-tmp-${randomBytes(8).toString('hex')}`);
  let fh;
  try {
    fh = await open(
      tmp,
      C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
      stat ? stat.mode & 0o777 : 0o644,
    );
    await fh.writeFile(data);
    await fh.close();
    fh = undefined;
    await assertInside(rootReal, parent, rel);
    await rename(tmp, target);
  } catch (e) {
    if (fh) await fh.close().catch(() => undefined);
    await rm(tmp, { force: true });
    if (e instanceof WorkspaceError) throw e;
    throw new WorkspaceError('io_error', `cannot write "${rel}"`);
  }
  return { created: !stat };
}

/**
 * Writes the node-side result file. `O_NOFOLLOW`: a link planted at the path is refused instead of
 * followed; `O_CREAT` with mode 0600; an existing file is truncated.
 */
export async function writeResultFile(path: string, data: string): Promise<void> {
  const fh = await open(path, C.O_WRONLY | C.O_CREAT | C.O_TRUNC | C.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}
