import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OaxError } from '@openagentix/core';

/**
 * Unpacks the workspace seed inside the run node (DOG-4, ADR 0008 Amendment 5). The archive comes
 * from the control node, which got it from the worker, which built it from a Git tree, so none of
 * it is trusted here: this module has its OWN checks and does not reuse the packer's. The whole
 * archive is parsed and validated before the first byte is written, so a bad archive leaves the
 * workspace directory empty.
 *
 * Accepted: a ustar archive of regular files with the modes 0644 and 0755, UTF-8 relative names of
 * portable depth and length, within the limits below. Everything else is refused with the single
 * code `seed_invalid` (the message names the rule, never the offending name): directories, links
 * of any kind, devices, FIFOs, extended headers (pax, GNU long names), absolute names, `..`, `.`
 * and empty segments, backslashes, control characters, a `.git` segment at any depth, duplicate
 * names (also case-insensitive and Unicode-normalised), a file that is also a directory, sizes that
 * do not fit the archive, non-zero padding, trailing data, and a digest that differs.
 */
export interface UnpackLimits {
  maxArchiveBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathChars: number;
  maxDepth: number;
}

export const DEFAULT_UNPACK_LIMITS: UnpackLimits = {
  maxArchiveBytes: 5 * 1024 * 1024,
  maxFiles: 5_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  maxPathChars: 300,
  maxDepth: 24,
};

export interface SeedEntry {
  path: string;
  mode: 0o644 | 0o755;
  content: Buffer;
}

export interface UnpackReport {
  files: number;
  bytes: number;
  sha256: string;
}

const BLOCK = 512;
const bad = (rule: string): never => {
  throw new OaxError('seed_invalid', `the workspace seed is refused: ${rule}`);
};

/** NUL-terminated field: bytes after the first NUL must all be NUL (no hidden data). */
function cString(h: Buffer, off: number, len: number): Buffer {
  const field = h.subarray(off, off + len);
  const nul = field.indexOf(0);
  const end = nul < 0 ? len : nul;
  for (let i = end; i < len; i++) if (field[i] !== 0) bad('malformed header field');
  return field.subarray(0, end);
}

function octal(h: Buffer, off: number, len: number, what: string): number {
  const raw = h.subarray(off, off + len).toString('latin1');
  const m = /^ *([0-7]{1,11})[\0 ]*$/.exec(raw);
  if (!m) return bad(`${what} is not a plain octal number`);
  return parseInt(m[1]!, 8);
}

function utf8(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return bad('a name is not valid UTF-8');
  }
}

/** Validates one relative path of the archive. */
export function checkSeedName(name: string, limits: UnpackLimits = DEFAULT_UNPACK_LIMITS): void {
  if (name.length === 0 || name.length > limits.maxPathChars) bad('name length');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) bad('absolute name');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\\\u2028\u2029\ufffd]/.test(name)) bad('forbidden character');
  const parts = name.split('/');
  if (parts.length > limits.maxDepth) bad('path too deep');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') bad('empty, dot or parent segment');
    if (p.toLowerCase() === '.git') bad('.git segment');
    if (p.endsWith(' ') || p.endsWith('.')) bad('segment ends with space or dot');
  }
}

/** Parses and validates the whole archive; returns the entries without touching the disk. */
export function parseSeedArchive(
  archive: Buffer,
  limits: UnpackLimits = DEFAULT_UNPACK_LIMITS,
): SeedEntry[] {
  if (archive.length === 0 || archive.length > limits.maxArchiveBytes) bad('archive size');
  if (archive.length % BLOCK !== 0) bad('archive is not a multiple of 512 bytes');
  const entries: SeedEntry[] = [];
  const seen = new Set<string>();
  const dirs = new Set<string>();
  let total = 0;
  let off = 0;
  let ended = false;
  while (off + BLOCK <= archive.length) {
    const h = archive.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      // end of archive: this block and everything after it must be zero
      if (!archive.subarray(off).every((b) => b === 0)) bad('data after the end marker');
      ended = true;
      break;
    }
    // checksum over the header with the checksum field read as spaces
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== octal(h, 148, 8, 'checksum')) bad('header checksum');
    const type = h[156]!;
    if (type !== 0x30 && type !== 0) bad('entry is not a regular file (link, device, directory)');
    if (cString(h, 157, 100).length > 0) bad('link target on a regular file');
    if (h.subarray(257, 263).toString('latin1') !== 'ustar\0') bad('not a ustar header');
    const mode = octal(h, 100, 8, 'mode');
    if (mode !== 0o644 && mode !== 0o755) bad('file mode');
    const size = octal(h, 124, 12, 'size');
    if (size > limits.maxFileBytes) bad('file too large');
    const prefix = utf8(cString(h, 345, 155));
    const base = utf8(cString(h, 0, 100));
    const path = prefix ? `${prefix}/${base}` : base;
    checkSeedName(path, limits);
    const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) bad('duplicate name');
    seen.add(key);
    const segs = key.split('/');
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/');
      if (seen.has(d)) bad('a file is also used as a directory');
      dirs.add(d);
    }
    if (dirs.has(key)) bad('a directory is also used as a file');
    if (entries.length + 1 > limits.maxFiles) bad('too many files');
    total += size;
    if (total > limits.maxTotalBytes) bad('total size');
    const start = off + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (start + padded > archive.length) bad('entry exceeds the archive');
    const content = archive.subarray(start, start + size);
    if (!archive.subarray(start + size, start + padded).every((b) => b === 0))
      bad('non-zero padding');
    entries.push({ path, mode: mode as SeedEntry['mode'], content });
    off = start + padded;
  }
  if (!ended) bad('missing end marker');
  return entries;
}

/** Constant-time comparison of two hex digests. */
function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Verifies the digest announced by the control node, validates the archive and writes it below
 * `root`. `root` must not exist or be an empty real directory (never a link).
 */
export async function unpackSeed(
  archive: Buffer,
  expectedSha256: string,
  root: string,
  limits: UnpackLimits = DEFAULT_UNPACK_LIMITS,
): Promise<UnpackReport> {
  const sha256 = createHash('sha256').update(archive).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || !sameDigest(sha256, expectedSha256))
    bad('digest mismatch');
  const entries = parseSeedArchive(archive, limits);
  try {
    const st = await lstat(root);
    if (!st.isDirectory()) bad('the workspace root is not a directory');
    if ((await readdir(root)).length > 0) bad('the workspace root is not empty');
  } catch (e) {
    if (e instanceof OaxError) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  const made = new Set<string>();
  let bytes = 0;
  for (const e of entries) {
    const parts = e.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      if (made.has(dir)) continue;
      await mkdir(dir, { mode: 0o755 });
      if (!(await lstat(dir)).isDirectory()) bad('a directory was replaced');
      made.add(dir);
    }
    const target = join(dir, parts[parts.length - 1]!);
    // exclusive create, never through a link
    const fh = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      e.mode,
    );
    try {
      await fh.writeFile(e.content);
    } finally {
      await fh.close();
    }
    await chmod(target, e.mode);
    bytes += e.content.length;
  }
  return { files: entries.length, bytes, sha256 };
}
