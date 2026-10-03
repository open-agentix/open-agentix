import { describe, expect, it } from 'vitest';
import {
  NotImplementedError,
  OaxError,
  PolicyDeniedError,
  ValidationError,
  canonicalJson,
  classificationRank,
  compareSemver,
  isSemver,
  mayFlow,
  sha256Hex,
} from '../src/index.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined, 'x'], c: null }, e: undefined })).toBe(
      '{"a":{"c":null,"d":[1,null,"x"]},"b":1}',
    );
  });
  it('serialises dates, bigints and primitives', () => {
    expect(canonicalJson(new Date('2026-01-01T00:00:00Z'))).toBe('"2026-01-01T00:00:00.000Z"');
    expect(canonicalJson(10n)).toBe('"10"');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(TypeError);
  });
  it('hashes deterministically', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('classification', () => {
  it('orders levels', () => {
    expect(classificationRank('public')).toBeLessThan(classificationRank('restricted'));
    expect(mayFlow('internal', 'confidential')).toBe(true);
    expect(mayFlow('restricted', 'internal')).toBe(false);
  });
});

describe('semver', () => {
  it('validates', () => {
    expect(isSemver('1.2.3')).toBe(true);
    expect(isSemver('1.2.3-rc.1+build.5')).toBe(true);
    expect(isSemver('1.2')).toBe(false);
  });
  it.each([
    ['1.0.0', '1.0.1', -1],
    ['2.0.0', '1.9.9', 1],
    ['1.0.0', '1.0.0+abc', 0],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0', '1.0.0-alpha', 1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha', 1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta', '1.0.0-alpha', 1],
    ['1.0.0-beta.11', '1.0.0-beta.2', 1],
    ['1.0.0-rc.1', '1.0.0-rc.1', 0],
    ['1.0.0-beta', '1.0.0-beta.x', -1],
    ['1.0.0-a', '1.0.0-1', 1],
  ])('compare(%s, %s) = %i', (a, b, r) => {
    expect(compareSemver(a, b)).toBe(r);
  });
  it('throws on invalid input', () => {
    expect(() => compareSemver('x', '1.0.0')).toThrow(TypeError);
    expect(() => compareSemver('1.0.0', 'y')).toThrow(TypeError);
  });
});

describe('errors', () => {
  it('carry stable codes', () => {
    expect(new OaxError('x', 'm').code).toBe('x');
    const v = new ValidationError('bad', [{ path: 'a', message: 'b' }]);
    expect(v.code).toBe('validation_failed');
    expect(v.issues).toHaveLength(1);
    expect(new NotImplementedError('Runner x', 'See ROADMAP.md').message).toContain('Runner x');
    expect(new PolicyDeniedError('no').code).toBe('policy_denied');
    expect(v.name).toBe('ValidationError');
  });
});
