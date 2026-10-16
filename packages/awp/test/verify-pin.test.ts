import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DIR, PROVENANCE_FILE, main, verifyPin } from '../../../scripts/awp/verify-pin.mjs';
import { licenseFor, vendorAwp } from '../../../scripts/awp/vendor-awp.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../../../scripts/awp/verify-pin.mjs');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const tmpDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'oax-awp-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A tiny pinned directory with two files, independent of the real vendored copy. */
function fixture(mutate?: (prov: Record<string, unknown>) => void) {
  const dir = tmp();
  mkdirSync(path.join(dir, 'schema'));
  writeFileSync(path.join(dir, 'schema/a.json'), '{"a":1}\n');
  writeFileSync(path.join(dir, 'b.mjs'), 'export const b = 1;\n');
  const prov: Record<string, unknown> = {
    schemaVersion: 1,
    source: { repository: 'https://example.org/awp', commit: 'a'.repeat(40) },
    retrievedAt: '2026-10-16',
    files: [
      { path: 'b.mjs', sha256: sha('export const b = 1;\n'), license: 'Apache-2.0' },
      { path: 'schema/a.json', sha256: sha('{"a":1}\n'), license: 'Apache-2.0' },
    ],
  };
  mutate?.(prov);
  writeFileSync(path.join(dir, PROVENANCE_FILE), JSON.stringify(prov));
  return dir;
}

describe('verifyPin on a fixture', () => {
  it('passes on a valid copy', () => {
    expect(verifyPin(fixture())).toEqual({ ok: true, problems: [], checked: 2 });
  });

  it('fails on a tampered file and names the path', () => {
    const dir = fixture();
    writeFileSync(path.join(dir, 'schema/a.json'), '{"a":2}\n');
    const r = verifyPin(dir);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/schema\/a\.json: hash mismatch/);
  });

  it('fails on a missing file', () => {
    const dir = fixture();
    rmSync(path.join(dir, 'b.mjs'));
    expect(verifyPin(dir).problems).toContain('b.mjs: missing');
  });

  it('fails on an extra file, also in a new subdirectory', () => {
    const dir = fixture();
    mkdirSync(path.join(dir, 'extra'));
    writeFileSync(path.join(dir, 'extra/evil.mjs'), 'x');
    writeFileSync(path.join(dir, 'schema/new.json'), '{}');
    const problems = verifyPin(dir).problems.join('\n');
    expect(problems).toMatch(/extra\/evil\.mjs: extra file/);
    expect(problems).toMatch(/schema\/new\.json: extra file/);
  });

  it('fails on a wrong recorded hash', () => {
    const dir = fixture((p) => {
      (p.files as { sha256: string }[])[0]!.sha256 = sha('something else');
    });
    expect(verifyPin(dir).problems.join('\n')).toMatch(/b\.mjs: hash mismatch/);
  });

  it('fails on a malformed hash, license, commit and date', () => {
    const dir = fixture((p) => {
      const f = p.files as { sha256: string; license: string }[];
      f[0]!.sha256 = 'ABC';
      f[1]!.license = 'MIT';
      p.source = { repository: 'http://example.org', commit: 'abc' };
      p.retrievedAt = 'yesterday';
      p.schemaVersion = 2;
    });
    const problems = verifyPin(dir).problems.join('\n');
    for (const re of [
      /b\.mjs: sha256 must be/,
      /schema\/a\.json: license must be/,
      /source\.repository/,
      /source\.commit/,
      /retrievedAt/,
      /schemaVersion/,
    ]) {
      expect(problems).toMatch(re);
    }
  });

  it.each(['../x', '/etc/passwd', 'a//b', './b.mjs', 'a\\b', ''])(
    'rejects unsafe path %j',
    (bad) => {
      const dir = fixture((p) => {
        (p.files as { path: string }[]).push({ path: bad } as never);
      });
      expect(verifyPin(dir).problems.join('\n')).toMatch(/unsafe or invalid path/);
    },
  );

  it('rejects a non-string path entry', () => {
    const dir = fixture((p) => {
      (p.files as unknown[]).push(null);
    });
    expect(verifyPin(dir).ok).toBe(false);
  });

  it('rejects duplicates and a self-listing of PROVENANCE.json', () => {
    const dir = fixture((p) => {
      const f = p.files as unknown[];
      f.push(f[0], { path: PROVENANCE_FILE, sha256: sha('x'), license: 'Apache-2.0' });
    });
    const problems = verifyPin(dir).problems.join('\n');
    expect(problems).toMatch(/b\.mjs: listed more than once/);
    expect(problems).toMatch(/must not list itself/);
  });

  it('rejects a symlink standing in for a listed file', () => {
    const dir = fixture();
    const outside = path.join(tmp(), 'outside.mjs');
    writeFileSync(outside, 'export const b = 1;\n');
    rmSync(path.join(dir, 'b.mjs'));
    symlinkSync(outside, path.join(dir, 'b.mjs'));
    expect(verifyPin(dir).problems).toContain('b.mjs: not a regular file');
  });

  it('rejects an empty or non-array file list', () => {
    expect(verifyPin(fixture((p) => (p.files = []))).ok).toBe(false);
    expect(verifyPin(fixture((p) => (p.files = 'nope'))).ok).toBe(false);
  });

  it('fails when PROVENANCE.json is missing, unparsable or not an object', () => {
    const dir = fixture();
    writeFileSync(path.join(dir, PROVENANCE_FILE), '{not json');
    expect(verifyPin(dir).problems[0]).toMatch(/cannot read or parse/);
    writeFileSync(path.join(dir, PROVENANCE_FILE), '[]');
    expect(verifyPin(dir).problems[0]).toMatch(/must be a JSON object/);
    rmSync(path.join(dir, PROVENANCE_FILE));
    expect(verifyPin(dir).ok).toBe(false);
  });
});

describe('command line', () => {
  const run = (...args: string[]) => {
    try {
      const out = execFileSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { code: 0, out, err: '' };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout, err: x.stderr };
    }
  };

  it('exits 0 on the committed vendored copy', () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/AWP pin check passed: \d+ files/);
  });

  it('exits 1 and prints the path of a tampered file', () => {
    const dir = fixture();
    writeFileSync(path.join(dir, 'b.mjs'), 'tampered');
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/b\.mjs: hash mismatch/);
  });

  it('exits 1 when the directory does not exist', () => {
    const r = run(path.join(tmp(), 'nope'));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/FAILED/);
  });

  it('main reports in process: pass, fail and unreadable directory', () => {
    const lines: string[] = [];
    const out = {
      log: (m: string) => lines.push(`log ${m}`),
      error: (m: string) => lines.push(`err ${m}`),
    };
    expect(main([], out)).toBe(0);
    const dir = fixture();
    writeFileSync(path.join(dir, 'b.mjs'), 'tampered');
    expect(main([dir], out)).toBe(1);
    expect(main([path.join(tmp(), 'nope')], out)).toBe(1);
    expect(lines.filter((l) => l.startsWith('err')).join('\n')).toMatch(/b\.mjs: hash mismatch/);
    expect(lines[0]).toMatch(/^log AWP pin check passed/);
  });
});

describe('the committed vendored copy', () => {
  it('passes the pin check and records a full commit SHA', () => {
    const r = verifyPin(DEFAULT_DIR);
    expect(r.problems).toEqual([]);
    const prov = JSON.parse(readFileSync(path.join(DEFAULT_DIR, PROVENANCE_FILE), 'utf8'));
    expect(prov.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(prov.status).toBe('draft');
    const paths = prov.files.map((f: { path: string }) => f.path);
    expect(paths).toContain('schema/awp.v1alpha1.json');
    expect(paths).toContain('conformance/awp-check.mjs');
    expect(paths).toContain('conformance/index.json');
  });

  it('is detected when a vendored file is altered in a copy', () => {
    const dir = tmp();
    cpSync(DEFAULT_DIR, dir, { recursive: true });
    const f = path.join(dir, 'schema/awp.v1alpha1.json');
    writeFileSync(f, `${readFileSync(f, 'utf8')} `);
    expect(verifyPin(dir).problems.join('\n')).toMatch(
      /schema\/awp\.v1alpha1\.json: hash mismatch/,
    );
  });
});

describe('vendor-awp', () => {
  it('assigns licences by file kind', () => {
    expect(licenseFor('LICENSE')).toBe('Apache-2.0');
    expect(licenseFor('LICENSE-SPEC')).toBe('CC-BY-4.0');
    expect(licenseFor('schema/README.md')).toBe('CC-BY-4.0');
    expect(licenseFor('conformance/valid/x.yaml')).toBe('Apache-2.0');
  });

  it('copies a clean local checkout and produces a passing pin', () => {
    const src = tmp();
    const g = (...a: string[]) => execFileSync('git', ['-C', src, ...a], { stdio: 'pipe' });
    g('init', '-q');
    mkdirSync(path.join(src, 'schema'));
    mkdirSync(path.join(src, 'spec'));
    writeFileSync(path.join(src, 'schema/awp.v1alpha1.json'), '{}');
    writeFileSync(path.join(src, 'spec/x.md'), 'not vendored');
    writeFileSync(path.join(src, 'package.json'), '{}');
    g('add', '.');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-q', '-m', 'init');
    const target = path.join(tmp(), 'out');
    const prov = vendorAwp(src, target, { tag: 'v0.0.1', now: new Date('2026-01-02T00:00:00Z') });
    expect(prov.files.map((f) => f.path)).toEqual(['package.json', 'schema/awp.v1alpha1.json']);
    expect(prov.retrievedAt).toBe('2026-01-02');
    expect(prov.source.tag).toBe('v0.0.1');
    expect(verifyPin(target).problems).toEqual([]);

    writeFileSync(path.join(src, 'dirty.txt'), 'x');
    expect(() => vendorAwp(src, target)).toThrow(/uncommitted changes/);
  });
});
