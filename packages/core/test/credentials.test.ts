import { describe, expect, it } from 'vitest';
import {
  StaticCredentialSource,
  StaticSecretResolver,
  matchSecretGlob,
  parseSecretRefPatterns,
  secretRefAllowed,
  type OaxError,
} from '../src/index.js';

describe('secret reference globs', () => {
  it.each([
    ['*', 'anything', true],
    ['jira-bot', 'jira-bot', true],
    ['jira-bot', 'jira-bot2', false],
    ['jira-*', 'jira-bot', true],
    ['jira-*', 'jira-', true],
    ['jira-*', 'confluence-bot', false],
    ['*-token', 'x-token', true],
    ['*-token', 'x-token2', false],
    ['a*b*c', 'a1b2c', true],
    ['a*b*c', 'ac', false],
    ['a*b*c', 'abc', true],
    ['a*a', 'a', false],
    ['ops.*.key', 'ops.prod.key', true],
    ['a**b', 'ab', true],
  ])('%s vs %s -> %s', (pattern, ref, expected) => {
    expect(matchSecretGlob(pattern, ref)).toBe(expected);
  });
  it('does not treat regex metacharacters specially and stays linear', () => {
    expect(matchSecretGlob('a.b', 'axb')).toBe(false);
    const evil = `${'a'.repeat(10_000)}!`;
    const t = Date.now();
    expect(matchSecretGlob('*a*a*a*a*a*b', evil)).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it('an empty allowlist allows nothing (fail closed)', () => {
    expect(secretRefAllowed([], 'x')).toBe(false);
    expect(secretRefAllowed(['y', 'x*'], 'xyz')).toBe(true);
  });
  it('validates and normalises patterns', () => {
    expect(parseSecretRefPatterns(['b', 'a*', 'b'])).toEqual(['a*', 'b']);
    for (const bad of ['', '.hidden', 'a b', 'a/b', '$x'])
      expect(() => parseSecretRefPatterns([bad])).toThrow(/invalid secret reference pattern/);
    expect(() => parseSecretRefPatterns(Array.from({ length: 65 }, (_, i) => `s${i}`))).toThrow(
      /at most 64/,
    );
  });
});

describe('StaticCredentialSource', () => {
  const src = new StaticCredentialSource(new StaticSecretResolver({ tok: 'v1' }));
  it('issues the resolved value without an expiry or handle', async () => {
    expect(src.name).toBe('static');
    expect(await src.issue('tok')).toEqual({ value: 'v1' });
    expect('revoke' in src).toBe(false);
  });
  it('propagates a missing secret', async () => {
    await expect(src.issue('nope')).rejects.toMatchObject({
      code: 'secret_not_found',
    } satisfies Partial<OaxError>);
  });
});
