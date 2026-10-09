import { readFileSync, statSync } from 'node:fs';
import { GitError } from './errors.js';
import { parsePullRequestTarget, type PullRequestTarget } from './target.js';

/**
 * Loads the operator's pull request targets (`OAX_PR_TARGETS`, dogfooding D5): a JSON file with an
 * array of targets, or `{ "targets": [...] }`. There is no write API; the file is the only place
 * where a repository, a credential reference and the delivery limits are chosen. Every problem is
 * the fixed code `target_invalid` (the message never quotes the file).
 */
const MAX_FILE_BYTES = 64 * 1024;

export function parsePullRequestTargets(raw: unknown): Map<string, PullRequestTarget> {
  const list =
    Array.isArray(raw) || !raw || typeof raw !== 'object'
      ? raw
      : (raw as { targets?: unknown }).targets;
  if (!Array.isArray(list) || list.length < 1 || list.length > 20)
    throw new GitError('target_invalid', 'the pull request targets are not valid');
  const out = new Map<string, PullRequestTarget>();
  const repos = new Set<string>();
  for (const item of list) {
    const t = parsePullRequestTarget(item);
    if (out.has(t.name) || repos.has(t.repoKey))
      throw new GitError('target_invalid', 'duplicate pull request target');
    out.set(t.name, t);
    repos.add(t.repoKey);
  }
  return out;
}

export function loadPullRequestTargets(
  file: string,
  read: (path: string) => string = (p) => {
    if (statSync(p).size > MAX_FILE_BYTES) throw new Error('too large');
    return readFileSync(p, 'utf8');
  },
): Map<string, PullRequestTarget> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(file));
  } catch {
    throw new GitError('target_invalid', 'the pull request targets file cannot be read');
  }
  return parsePullRequestTargets(parsed);
}
