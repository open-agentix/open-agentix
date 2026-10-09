import { domainToASCII } from 'node:url';
import { GitError } from './errors.js';

/** A repository URL that passed `parseRepoUrl`: canonical, credential-free, https only. */
export interface RepoUrl {
  /** Canonical URL handed to Git (`https://host[:port]/path`, no `.git` normalisation). */
  url: string;
  host: string;
  port: number;
  /** Path without leading `/`, e.g. `open-agentix/dogfood-sandbox`. */
  path: string;
  /** `owner/name` (first two path segments without `.git`) for host-specific rules. */
  repoKey: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0020\u007f-\u009f\\]/;
const SEGMENT = /^[A-Za-z0-9._~%+@=,-]+$/;

/**
 * ADR 0010 A1.1 (https subset). Refused: every other scheme (`http`, `git`, `file`, `ssh`, `ext::`,
 * scp-like), userinfo, query, fragment, IP literals and numeric host spellings, `..`, control
 * characters, whitespace and a leading `-` in any path part (option injection).
 */
export function parseRepoUrl(raw: string): RepoUrl {
  const bad = (why: string): never => {
    throw new GitError('url_invalid', `repository URL refused: ${why}`);
  };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return bad('length');
  if (CONTROL.test(raw)) return bad('control characters or whitespace');
  if (!/^https:\/\//.test(raw)) return bad('only https:// is accepted');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return bad('not a URL');
  }
  if (u.protocol !== 'https:') return bad('only https:// is accepted');
  if (u.username || u.password || /^https:\/\/[^/]*@/.test(raw))
    return bad('credentials in the URL');
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) return bad('query or fragment');
  const host = domainToASCII(u.hostname.toLowerCase());
  if (!host) return bad('host');
  // IP literals (v4, v6, decimal/hex/octal spellings) are not accepted for Git bindings.
  if (
    u.hostname.startsWith('[') ||
    /^[0-9.x]+$/i.test(host) ||
    /^\d+$/.test(host.split('.').pop() ?? '')
  )
    return bad('IP literal');
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) return bad('host');
  const port = u.port ? Number(u.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return bad('port');
  const rawPath = raw.slice(raw.indexOf('//') + 2).replace(/^[^/]*/, '');
  const parts = rawPath
    .split('/')
    .filter((p, i, a) => !(p === '' && i === 0) && !(p === '' && i === a.length - 1));
  if (parts.length === 0 || parts.length > 8) return bad('path');
  for (const p of parts) {
    let dec: string;
    try {
      dec = decodeURIComponent(p);
    } catch {
      return bad('path encoding');
    }
    if (
      p === '' ||
      p === '.' ||
      p === '..' ||
      dec === '..' ||
      dec === '.' ||
      p.startsWith('-') ||
      dec.startsWith('-')
    )
      return bad('path segment');
    if (CONTROL.test(dec) || !SEGMENT.test(p)) return bad('path characters');
    if (dec.includes('/')) return bad('encoded slash');
  }
  const path = parts.join('/');
  const canonical = `https://${host}${port === 443 ? '' : `:${port}`}/${path}`;
  const key = parts
    .slice(0, 2)
    .map((p) => p.replace(/\.git$/i, ''))
    .join('/')
    .toLowerCase();
  return { url: canonical, host, port, path, repoKey: key };
}

const HEX40 = /^[0-9a-f]{40}$/;

export function assertSha(sha: string): string {
  if (typeof sha !== 'string' || !HEX40.test(sha))
    throw new GitError('sha_invalid', 'a full 40-character lowercase commit id is required');
  return sha;
}

/**
 * Ref names the worker will fetch or advertise: `refs/heads/<name>` with a conservative charset.
 * Option injection (`-x`), `..`, `@{`, control characters, `.lock` and trailing dots are refused.
 */
export function assertBranchRef(ref: string): string {
  if (typeof ref !== 'string' || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref))
    throw new GitError('ref_invalid', 'the ref name is not acceptable');
  assertRefShape(ref.slice('refs/heads/'.length), 'ref_invalid');
  return ref;
}

function assertRefShape(name: string, code: 'ref_invalid' | 'branch_invalid'): void {
  const bad =
    name.includes('..') ||
    name.includes('//') ||
    name.includes('@{') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.split('/').some((s) => s === '' || s.startsWith('.') || s.endsWith('.lock') || s === '@');
  if (bad) throw new GitError(code, 'the ref name is not acceptable');
}

/** A new branch name the engine may create: `<prefix><segments>`, prefix chosen by the operator. */
export function assertNewBranch(branch: string, prefix: string): string {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch))
    throw new GitError('branch_invalid', 'the branch name is not acceptable');
  assertRefShape(branch, 'branch_invalid');
  if (!branch.startsWith(prefix) || branch.length === prefix.length)
    throw new GitError('branch_prefix_refused', 'the branch is outside the allowed prefix');
  return branch;
}

export interface Identity {
  name: string;
  email: string;
}

export function assertIdentity(id: Identity): Identity {
  const ok = (s: string, re: RegExp) => typeof s === 'string' && s.length <= 120 && re.test(s);
  if (
    !ok(id.name, /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/) ||
    !ok(id.email, /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/)
  )
    throw new GitError('identity_invalid', 'the commit identity is not acceptable');
  return id;
}

/** Commit message: printable text, no NUL, bounded; passed on stdin, never as an argument. */
export function assertMessage(message: string, max = 4096): string {
  if (
    typeof message !== 'string' ||
    message.length === 0 ||
    message.length > max ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)
  )
    throw new GitError('message_invalid', 'the commit message is not acceptable');
  return message;
}
