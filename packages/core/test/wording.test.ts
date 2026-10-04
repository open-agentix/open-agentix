import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('project wording', () => {
  it('does not describe the product as an MVP anywhere in the repository', () => {
    let files: string[];
    try {
      files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter((f) => f && !/(pnpm-lock\.yaml|\.png|\.ico|\.woff2?)$/.test(f));
    } catch {
      return; // not a git checkout (e.g. a source tarball)
    }
    const offenders = files.filter(
      (f) =>
        f !== 'packages/core/test/wording.test.ts' &&
        /\bMVP\b/i.test(readFileSync(root + f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
