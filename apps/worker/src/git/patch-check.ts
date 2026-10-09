import { createHash, timingSafeEqual } from 'node:crypto';
import { GitError } from './errors.js';

/**
 * Worker-side validation of a node-computed patch (dogfooding D5, defence in depth: the node
 * checked it already and is not trusted). The patch is parsed strictly, line by line, with hunk
 * counts, so a content line that looks like a header cannot hide a second file. Anything the
 * node should never produce is refused as a whole: renames and copies, mode changes, non-regular
 * modes (symlink, gitlink), binary patches, paths outside the allowlist, path tricks.
 */
export interface PatchPolicy {
  /** Every touched path must match one of these (default `^(src|test)/[A-Za-z0-9._/-]{1,200}$`). */
  pathAllow: readonly RegExp[];
  maxBytes: number;
  maxFiles: number;
  /** Deletions are allowed only inside these areas (default: same as `pathAllow`). */
  deleteAllow?: readonly RegExp[] | undefined;
}

export const DEFAULT_PATH_ALLOW: readonly RegExp[] = [/^(?:src|test)\/[A-Za-z0-9._/-]{1,200}$/];

export interface PatchFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

export interface CheckedPatch {
  sha256: string;
  bytes: number;
  files: PatchFile[];
}

const MODE = /^100(?:644|755)$/;

export function sha256Hex(v: string | Buffer): string {
  return createHash('sha256').update(v).digest('hex');
}

function refuse(
  code: 'patch_invalid' | 'patch_path_refused' | 'patch_too_large',
  why: string,
): never {
  throw new GitError(code, `patch refused: ${why}`);
}

/** Path rules independent of the allowlist: relative, portable, no dot segments or hidden parts. */
export function assertSafePatchPath(p: string): void {
  if (
    p.length === 0 ||
    p.length > 300 ||
    p.startsWith('/') ||
    p.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f"]/.test(p) ||
    p
      .split('/')
      .some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.') || s.includes(':'))
  )
    refuse('patch_path_refused', 'a path is not acceptable');
}

export function checkPatch(
  patch: string,
  expectedSha256: string,
  policy: PatchPolicy,
): CheckedPatch {
  if (typeof patch !== 'string' || patch.length === 0) return refuse('patch_invalid', 'empty');
  const bytes = Buffer.byteLength(patch);
  if (bytes > policy.maxBytes)
    return refuse('patch_too_large', `larger than ${policy.maxBytes} bytes`);
  const sha = sha256Hex(patch);
  const want = Buffer.from(String(expectedSha256).toLowerCase(), 'hex');
  const got = Buffer.from(sha, 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got))
    throw new GitError('patch_digest_mismatch', 'the patch does not match its digest');
  if (patch.includes('\0') || patch.includes('\r'))
    return refuse('patch_invalid', 'control characters');
  if (!patch.endsWith('\n')) return refuse('patch_invalid', 'missing final newline');

  const lines = patch.slice(0, -1).split('\n');
  const files: PatchFile[] = [];
  const seen = new Set<string>();
  const deleteAllow = policy.deleteAllow ?? policy.pathAllow;
  let i = 0;

  const allowed = (p: string, res: readonly RegExp[]) => res.some((re) => re.test(p));

  while (i < lines.length) {
    const head = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i]!);
    if (!head) return refuse('patch_invalid', `unexpected line ${i + 1}`);
    const [, a, b] = head as unknown as [string, string, string];
    if (a !== b) return refuse('patch_invalid', 'rename or copy');
    assertSafePatchPath(a);
    if (!allowed(a, policy.pathAllow))
      return refuse('patch_path_refused', 'path outside the allowed area');
    if (seen.has(a)) return refuse('patch_invalid', 'path listed twice');
    seen.add(a);
    if (files.length >= policy.maxFiles)
      return refuse('patch_too_large', `more than ${policy.maxFiles} files`);
    i++;

    let status: PatchFile['status'] = 'modified';
    // extended header lines
    for (; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^new file mode (\d+)$/.test(l)) {
        const m = /^new file mode (\d+)$/.exec(l)![1]!;
        if (!MODE.test(m)) return refuse('patch_invalid', 'special file mode');
        status = 'added';
      } else if (/^deleted file mode (\d+)$/.test(l)) {
        const m = /^deleted file mode (\d+)$/.exec(l)![1]!;
        if (!MODE.test(m)) return refuse('patch_invalid', 'special file mode');
        status = 'deleted';
      } else if (/^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: 100(?:644|755))?$/.test(l)) {
        // accepted, ignored
      } else break;
    }
    if (status === 'deleted' && !allowed(a, deleteAllow))
      return refuse('patch_path_refused', 'deletion outside the allowed area');

    let additions = 0;
    let deletions = 0;
    if (i < lines.length && lines[i]!.startsWith('--- ')) {
      const from = status === 'added' ? '--- /dev/null' : `--- a/${a}`;
      const to = status === 'deleted' ? '+++ /dev/null' : `+++ b/${a}`;
      if (lines[i] !== from || lines[i + 1] !== to)
        return refuse('patch_invalid', 'file header mismatch');
      i += 2;
      let hunks = 0;
      while (i < lines.length && lines[i]!.startsWith('@@ ')) {
        const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[i]!);
        if (!h) return refuse('patch_invalid', 'hunk header');
        let oldN = h[2] === undefined ? 1 : Number(h[2]);
        let newN = h[4] === undefined ? 1 : Number(h[4]);
        i++;
        hunks++;
        while (oldN > 0 || newN > 0) {
          const l = lines[i];
          if (l === undefined) return refuse('patch_invalid', 'truncated hunk');
          const c = l[0];
          if (c === ' ') {
            oldN--;
            newN--;
          } else if (c === '-') {
            oldN--;
            deletions++;
          } else if (c === '+') {
            newN--;
            additions++;
          } else return refuse('patch_invalid', 'hunk body');
          if (oldN < 0 || newN < 0) return refuse('patch_invalid', 'hunk counts');
          i++;
        }
        if (lines[i] !== undefined && lines[i]!.startsWith('\\ ')) i++;
      }
      if (hunks === 0) return refuse('patch_invalid', 'no hunks');
    } else if (status === 'modified') {
      // a modified file without any hunk would be a mode-only or binary change
      return refuse('patch_invalid', 'a modified file needs hunks');
    } else if (status === 'deleted') {
      return refuse('patch_invalid', 'a deletion needs hunks');
    }
    files.push({ path: a, status, additions, deletions });
  }
  if (files.length === 0) return refuse('patch_invalid', 'no files');
  return { sha256: sha, bytes, files };
}
