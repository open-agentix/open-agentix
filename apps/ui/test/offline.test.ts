import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain ESM script without type declarations
import { scanDist } from '../scripts/offline-scan.mjs';

const root = join(__dirname, '..');

describe('no third-party requests', () => {
  it('index.html and styles reference no external hosts', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).not.toMatch(/(src|href)=["']https?:\/\//);
    for (const file of readdirSync(join(root, 'src/styles'))) {
      const css = readFileSync(join(root, 'src/styles', file), 'utf8');
      expect(css).not.toMatch(/url\(["']?https?:/);
      expect(css).not.toMatch(/@import/);
    }
  });

  it('source strings reference no third-party hosts (runs without a build)', () => {
    expect(scanDist(join(root, 'src'), ['.ts', '.tsx'])).toEqual([]);
  });

  it.skipIf(!existsSync(join(root, 'dist')))(
    'the built dist/ contains no third-party references',
    () => {
      expect(scanDist(join(root, 'dist'))).toEqual([]);
    },
  );
});
