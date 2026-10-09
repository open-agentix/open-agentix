import { WorkspaceError } from './errors.js';

const MAX_PATH_CHARS = 300;
const MAX_DEPTH = 24;

/** Directory names that are never readable or writable at any depth (case-insensitive). */
const FORBIDDEN_DIRS = new Set([
  '.git',
  '.github',
  '.gitea',
  '.gitlab',
  '.circleci',
  '.woodpecker',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
]);

/** File names (lower case) of CI configuration and Git control files. */
const FORBIDDEN_FILES = new Set([
  'jenkinsfile',
  '.gitlab-ci.yml',
  '.travis.yml',
  '.drone.yml',
  '.woodpecker.yml',
  '.woodpecker.yaml',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  'cloudbuild.yaml',
  'buildkite.yml',
  '.gitmodules',
  '.gitattributes',
  '.gitignore.local',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.dockercfg',
  '.htpasswd',
  'authorized_keys',
  'known_hosts',
]);

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^(credentials|secrets?)(\.|$)/i,
  /^\.?(secret|token)s?\.(json|ya?ml|txt|toml|ini)$/i,
  /\.(secret|secrets)$/i,
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validates a model-supplied path and splits it into segments. Rejects absolute paths, `..`,
 * `.` segments, empty segments, backslashes, control characters and over-long or deep paths.
 * `.`/empty means the workspace root (only when `allowRoot`).
 */
export function splitPath(input: unknown, opts: { allowRoot?: boolean } = {}): string[] {
  if (typeof input !== 'string') throw new WorkspaceError('invalid_path', 'path must be a string');
  if (input.length > MAX_PATH_CHARS) throw new WorkspaceError('invalid_path', 'path is too long');
  if (CONTROL_CHARS.test(input))
    throw new WorkspaceError('invalid_path', 'path contains control characters');
  if (input.includes('\\')) throw new WorkspaceError('invalid_path', 'backslashes are not allowed');
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input) || input.startsWith('~'))
    throw new WorkspaceError('invalid_path', 'absolute paths are not allowed');
  if (input === '.' || input === '') {
    if (opts.allowRoot) return [];
    throw new WorkspaceError('invalid_path', 'a file path is required');
  }
  const trimmed = input.endsWith('/') ? input.slice(0, -1) : input;
  const segments = trimmed.split('/');
  if (segments.length > MAX_DEPTH) throw new WorkspaceError('invalid_path', 'path is too deep');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..')
      throw new WorkspaceError(
        'invalid_path',
        'path must be normalised and stay inside the workspace',
      );
  }
  return segments;
}

/** True for control, CI and secret-like paths (any segment matches). */
export function isForbidden(segments: readonly string[]): boolean {
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i]!.toLowerCase();
    if (FORBIDDEN_DIRS.has(s)) return true;
    if (FORBIDDEN_FILES.has(s)) return true;
    if (FORBIDDEN_PATTERNS.some((re) => re.test(s))) return true;
  }
  return false;
}

export function assertAllowed(segments: readonly string[], rel: string): void {
  if (isForbidden(segments))
    throw new WorkspaceError('path_forbidden', `path "${rel}" is not accessible`);
}

const WRITE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/** Extra hygiene for paths that may be written: portable names, no hidden files. */
export function assertWritable(
  segments: readonly string[],
  rel: string,
  writable: readonly RegExp[],
): void {
  assertAllowed(segments, rel);
  if (segments.length === 0 || !segments.every((s) => WRITE_SEGMENT.test(s)))
    throw new WorkspaceError(
      'path_not_writable',
      `path "${rel}" has a name that cannot be written`,
    );
  if (!writable.some((re) => re.test(segments.join('/'))))
    throw new WorkspaceError('path_not_writable', `path "${rel}" is outside the writable area`);
}

/** Whether a path found in the tree may be part of the final patch. */
export function isPatchable(rel: string, writable: readonly RegExp[]): boolean {
  if (!/^[A-Za-z0-9._/-]{1,300}$/.test(rel)) return false;
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  if (isForbidden(segments)) return false;
  if (!segments.every((s) => WRITE_SEGMENT.test(s))) return false;
  return writable.some((re) => re.test(rel));
}
