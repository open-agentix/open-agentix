import { GitError } from './errors.js';
import { DEFAULT_PATH_ALLOW } from './patch-check.js';
import { parseRepoUrl } from './validate.js';

/**
 * Operator-configured delivery target (dogfooding D5): the event can never name another
 * repository. Parsed once at start-up; every refusal is the fixed code `target_invalid`.
 */
export interface PullRequestTarget {
  name: string;
  url: string;
  repoKey: string;
  baseBranch: string;
  branchPrefix: string;
  /** Secret reference of the Git credential (push). */
  tokenRef: string;
  /** Secret reference of the host-API credential; default: the same reference as `tokenRef`. */
  extensionTokenRef: string;
  extension: 'github';
  maxOpenPullRequests: number;
  pathAllow: RegExp[];
  maxPatchBytes: number;
  maxFiles: number;
  maxBodyBytes: number;
  username: string;
}

const KEYS = new Set([
  'name',
  'url',
  'baseBranch',
  'branchPrefix',
  'tokenRef',
  'extensionTokenRef',
  'extension',
  'maxOpenPullRequests',
  'pathAllow',
  'maxPatchBytes',
  'maxFiles',
  'maxBodyBytes',
  'username',
]);

const bad = (): never => {
  throw new GitError('target_invalid', 'the pull request target is not valid');
};

function str(v: unknown, re: RegExp, def?: string): string {
  const x = v === undefined ? def : v;
  if (typeof x !== 'string' || !re.test(x)) return bad();
  return x;
}

function int(v: unknown, min: number, max: number, def: number): number {
  const x = v === undefined ? def : v;
  if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max) return bad();
  return x;
}

const REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function parsePullRequestTarget(raw: unknown): PullRequestTarget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad();
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !KEYS.has(k))) return bad();
  if (o.extension !== undefined && o.extension !== 'github') return bad();
  const repo = parseRepoUrl(str(o.url, /^.{1,2048}$/));
  const sources =
    o.pathAllow === undefined ? DEFAULT_PATH_ALLOW.map((x) => x.source) : (o.pathAllow as unknown);
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 10) return bad();
  const pathAllow = sources.map((src: unknown) => {
    // anchored, no free-for-all: a broad pattern would defeat the allowlist
    if (
      typeof src !== 'string' ||
      src.length > 200 ||
      !src.startsWith('^') ||
      /(^|[^\\])\.\*/.test(src)
    )
      return bad();
    try {
      return new RegExp(src);
    } catch {
      return bad();
    }
  });
  const tokenRef = str(o.tokenRef, REF);
  return {
    name: str(o.name, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/),
    url: repo.url,
    repoKey: repo.repoKey,
    baseBranch: str(o.baseBranch, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/, 'main'),
    branchPrefix: str(o.branchPrefix, /^oax\/[a-z0-9][a-z0-9-]*\/$/, 'oax/bug-fix/'),
    tokenRef,
    extensionTokenRef: o.extensionTokenRef === undefined ? tokenRef : str(o.extensionTokenRef, REF),
    extension: 'github',
    maxOpenPullRequests: int(o.maxOpenPullRequests, 1, 10, 2),
    pathAllow,
    maxPatchBytes: int(o.maxPatchBytes, 1024, 1024 * 1024, 65_536),
    maxFiles: int(o.maxFiles, 1, 100, 20),
    maxBodyBytes: int(o.maxBodyBytes, 256, 65_536, 16_384),
    username: str(o.username, /^[A-Za-z0-9._-]{1,64}$/, 'x-access-token'),
  };
}
