import { constants as C } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WorkspaceError } from './errors.js';

export interface TreeEntry {
  type: 'file' | 'symlink' | 'other';
  size: number;
  /** Any execute bit set. A change of it is a mode change and refuses the patch. */
  exec: boolean;
  /** SHA-256 of the content (file) or of the link target (symlink). */
  sha256: string;
  /** Content, kept only for the baseline. */
  content?: Buffer;
}

export type TreeSnapshot = Map<string, TreeEntry>;

export interface WalkLimits {
  maxEntries: number;
  maxBytes: number;
  keepContent: boolean;
  /** Absolute deadline (ms, same clock as `now`); the walk fails with `timeout` after it. */
  deadline?: number;
  now?: () => number;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function hashFile(abs: string, keep: boolean): Promise<{ sha256: string; content?: Buffer }> {
  const fh = await open(abs, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      const piece = buf.subarray(0, bytesRead);
      hash.update(piece);
      if (keep) chunks.push(Buffer.from(piece));
      pos += bytesRead;
    }
    return { sha256: hash.digest('hex'), ...(keep ? { content: Buffer.concat(chunks) } : {}) };
  } finally {
    await fh.close();
  }
}

/**
 * Lists every file below `root` without following links. Symbolic links and special files are
 * recorded (never read through). Directories are not entries. Bounded in entries and bytes.
 */
export async function walkTree(root: string, limits: WalkLimits): Promise<TreeSnapshot> {
  const out: TreeSnapshot = new Map();
  let bytes = 0;
  let dirs = 0;
  const now = limits.now ?? Date.now;
  const stack: string[] = [''];
  while (stack.length > 0) {
    const dirRel = stack.pop()!;
    // Directories count like files, so a tree of empty directories cannot exhaust the walk.
    dirs += 1;
    if (out.size + dirs > limits.maxEntries)
      throw new WorkspaceError('tree_too_large', 'the workspace has too many files');
    let names: string[];
    try {
      names = await readdir(join(root, dirRel));
    } catch {
      throw new WorkspaceError('io_error', 'cannot read the workspace tree');
    }
    for (const name of names) {
      if (limits.deadline !== undefined && now() > limits.deadline)
        throw new WorkspaceError('timeout', 'walking the workspace took too long');
      const rel = dirRel === '' ? name : `${dirRel}/${name}`;
      const abs = join(root, rel);
      const st = await lstat(abs).catch(() => null);
      if (!st) continue; // vanished while walking
      if (st.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (out.size >= limits.maxEntries)
        throw new WorkspaceError('tree_too_large', 'the workspace has too many files');
      if (st.isSymbolicLink()) {
        const target = await readlink(abs).catch(() => '');
        out.set(rel, { type: 'symlink', size: 0, exec: false, sha256: sha(target) });
      } else if (st.isFile()) {
        bytes += st.size;
        if (bytes > limits.maxBytes)
          throw new WorkspaceError('tree_too_large', 'the workspace is too large');
        let h;
        try {
          h = await hashFile(abs, limits.keepContent);
        } catch {
          throw new WorkspaceError('io_error', `cannot read "${rel}"`);
        }
        out.set(rel, {
          type: 'file',
          size: st.size,
          exec: (st.mode & 0o111) !== 0,
          sha256: h.sha256,
          ...(h.content ? { content: h.content } : {}),
        });
      } else {
        out.set(rel, { type: 'other', size: 0, exec: false, sha256: '' });
      }
    }
  }
  return out;
}
