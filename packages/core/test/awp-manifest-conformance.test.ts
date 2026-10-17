import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateManifestSource } from '../src/index.js';

/**
 * The vendored AWP conformance cases (`packages/awp/vendor/awp-v1alpha1/conformance/`) through the
 * OpenAgentix validator. Same pass criterion as the reference checker: a valid case has no error, an
 * invalid case reports the indexed code at the indexed path (descendants match) and no error of
 * another family. This is a test of the validator, not a conformance claim.
 */
const DIR = fileURLToPath(new URL('../../awp/vendor/awp-v1alpha1/conformance/', import.meta.url));

interface Case {
  id: string;
  file: string;
  expect: 'valid' | 'invalid';
  code?: string;
  path?: string;
  profiles?: string[];
  verifyDigest?: boolean;
}
const index = JSON.parse(readFileSync(`${DIR}index.json`, 'utf8')) as {
  defaults: { profiles: string[]; verifyDigest: boolean };
  tests: Case[];
};

describe('vendored conformance cases', () => {
  it('lists every file of valid/ and invalid/', () => {
    const indexed = new Set(index.tests.map((t) => t.file));
    for (const dir of ['valid', 'invalid'])
      for (const f of readdirSync(`${DIR}${dir}`)) expect(indexed.has(`${dir}/${f}`)).toBe(true);
  });

  it.each(index.tests)('$id', (t) => {
    const r = validateManifestSource(readFileSync(`${DIR}${t.file}`, 'utf8'), {
      layout: 'document',
      profiles: t.profiles ?? index.defaults.profiles,
      verifyDigest: t.verifyDigest ?? index.defaults.verifyDigest,
    });
    expect(r).not.toBeNull();
    const errors = r!.findings.filter((f) => f.severity === 'error');
    if (t.expect === 'valid') {
      expect(errors).toEqual([]);
      expect(r!.valid).toBe(true);
      return;
    }
    const family = (code: string) => code.split('.')[0];
    const hit = errors.filter(
      (e) =>
        e.code === t.code &&
        (t.path === undefined || e.path === t.path || e.path.startsWith(`${t.path}/`)),
    );
    expect(
      hit.length,
      `expected ${t.code} at ${t.path}, got ${JSON.stringify(errors)}`,
    ).toBeGreaterThan(0);
    expect(errors.filter((e) => family(e.code) !== family(t.code!))).toEqual([]);
    expect(r!.valid).toBe(false);
    expect(r!.manifest).toBeNull();
  });
});
