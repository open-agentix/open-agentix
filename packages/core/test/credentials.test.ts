import { describe, expect, it } from 'vitest';
import {
  StaticCredentialSource,
  StaticSecretResolver,
  matchSecretGlob,
  canonicalSecretRef,
  hasTenantPrefix,
  parseSecretRefPatterns,
  secretRefAllowed,
  slugsCollide,
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
    expect(parseSecretRefPatterns(['bb', 'ab.*', 'bb', 'a_b-*'])).toEqual(['a_b-*', 'ab.*', 'bb']);
    for (const bad of [
      '',
      '*',
      '.hidden',
      'a b',
      'a/b',
      '$x',
      'ACME.x',
      'acme*',
      'a*b',
      'a.*.b',
      'x',
    ])
      expect(() => parseSecretRefPatterns([bad]), bad).toThrow(/invalid secret reference pattern/);
    expect(() => parseSecretRefPatterns(Array.from({ length: 65 }, (_, i) => `s${i}x`))).toThrow(
      /at most 64/,
    );
  });
});

describe('canonical form (what the resolver sees)', () => {
  it('maps like envNameForSecret: lower case, everything else becomes _', () => {
    expect(canonicalSecretRef('Acme.Corp-DB.pass')).toBe('acme_corp_db_pass');
    expect(canonicalSecretRef('acme.corp.db-password')).toBe(
      canonicalSecretRef('acme-corp.db-password'),
    );
  });
  it('a tenant pattern cannot reach a differently written but identical secret', () => {
    // `acme.*` would otherwise allow `acme.corp.db-password`, which IS the secret `acme-corp.db-password`
    // for the resolver (same environment variable). Both are the same canonical name, so an
    // allowlist for `acme.*` allows it, which is why slugs that overlap cannot coexist:
    expect(matchSecretGlob('acme.*', 'acme.corp.db-password')).toBe(true);
    expect(matchSecretGlob('acme.*', 'acme-corp.db-password')).toBe(true);
    expect(slugsCollide('acme', 'acme-corp')).toBe(true);
    expect(slugsCollide('acme-corp', 'acme')).toBe(true);
    expect(slugsCollide('acme', 'acmecorp')).toBe(false);
    expect(slugsCollide('acme', 'acme')).toBe(true);
    expect(slugsCollide('beta', 'acme')).toBe(false);
  });
  it('prefix checks use the canonical form and need a separator', () => {
    expect(hasTenantPrefix('acme', 'acme.db')).toBe(true);
    expect(hasTenantPrefix('acme', 'ACME-db')).toBe(true);
    expect(hasTenantPrefix('acme', 'acme_db')).toBe(true);
    expect(hasTenantPrefix('acme', 'acmecorp.db')).toBe(false);
    expect(hasTenantPrefix('acme', 'other.acme.db')).toBe(false);
    expect(hasTenantPrefix('acme-corp', 'acme.corp.db')).toBe(true);
  });
  it('globs compare canonically and case-insensitively', () => {
    expect(matchSecretGlob('jira.*', 'JIRA-token')).toBe(true);
    expect(matchSecretGlob('jira-bot', 'Jira.Bot')).toBe(true);
    expect(matchSecretGlob('jira-bot', 'jira.bot2')).toBe(false);
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
