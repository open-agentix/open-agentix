import { describe, expect, it } from 'vitest';
import type { WorkspaceError } from '../src/errors.js';
import { assertWritable, isForbidden, isPatchable, splitPath } from '../src/paths.js';

const W = [/^(src|test)\/[A-Za-z0-9._/-]{1,200}$/u];
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as WorkspaceError).code;
  }
  return 'none';
};

describe('splitPath', () => {
  it.each([
    '../etc/passwd',
    'src/../../etc/passwd',
    'src/..',
    '/etc/passwd',
    'C:/Windows',
    '~/x',
    'src\\..\\x',
    'src//x',
    'src/./x',
    'a\u0000b',
    'a\nb',
    'x'.repeat(301),
    Array.from({ length: 30 }, () => 'd').join('/'),
  ])('refuses %j', (p) => {
    expect(code(() => splitPath(p))).toBe('invalid_path');
  });

  it('refuses non-strings and the root unless allowed', () => {
    expect(code(() => splitPath(42 as unknown))).toBe('invalid_path');
    expect(code(() => splitPath('.'))).toBe('invalid_path');
    expect(splitPath('.', { allowRoot: true })).toEqual([]);
    expect(splitPath('', { allowRoot: true })).toEqual([]);
  });

  it('splits a normal path and tolerates one trailing slash', () => {
    expect(splitPath('src/a/b.js')).toEqual(['src', 'a', 'b.js']);
    expect(splitPath('src/')).toEqual(['src']);
  });
});

describe('forbidden and writable paths', () => {
  it.each([
    '.git/config',
    'a/.git/hooks/pre-commit',
    '.github/workflows/ci.yml',
    '.GitHub/workflows/x.yml',
    '.gitlab-ci.yml',
    'Jenkinsfile',
    '.circleci/config.yml',
    '.env',
    '.env.production',
    'config/server.pem',
    'deploy/id_rsa',
    'credentials.json',
    'secrets.yaml',
    '.npmrc',
    '.gitattributes',
    'a/.ssh/id_ed25519',
  ])('treats %s as forbidden', (p) => {
    expect(isForbidden(p.split('/'))).toBe(true);
  });

  it('does not forbid ordinary files', () => {
    expect(isForbidden(['src', 'price.js'])).toBe(false);
    expect(isForbidden(['README.md'])).toBe(false);
  });

  it('only src/ and test/ are writable and names are portable', () => {
    expect(() => assertWritable(['src', 'a.js'], 'src/a.js', W)).not.toThrow();
    expect(code(() => assertWritable(['package.json'], 'package.json', W))).toBe(
      'path_not_writable',
    );
    expect(code(() => assertWritable(['src', '.hidden'], 'src/.hidden', W))).toBe(
      'path_not_writable',
    );
    expect(code(() => assertWritable(['src', 'a b.js'], 'src/a b.js', W))).toBe(
      'path_not_writable',
    );
    expect(code(() => assertWritable(['.github', 'x.yml'], '.github/x.yml', W))).toBe(
      'path_forbidden',
    );
    expect(code(() => assertWritable([], '', W))).toBe('path_not_writable');
  });

  it('isPatchable rejects odd names, forbidden and outside paths', () => {
    expect(isPatchable('src/a.js', W)).toBe(true);
    expect(isPatchable('src/a\nb.js', W)).toBe(false);
    expect(isPatchable('src/../x', W)).toBe(false);
    expect(isPatchable('package.json', W)).toBe(false);
    expect(isPatchable('src/.env', W)).toBe(false);
    expect(isPatchable('src/.hidden', W)).toBe(false);
  });
});
