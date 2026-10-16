import { describe, expect, it } from 'vitest';
import { anchorMatches, hashOfLine, lineHash, sourceLines } from '../src/index.js';

describe('review anchors', () => {
  it('numbers lines like the console: split on newline only', () => {
    expect(sourceLines('a\nb\n')).toEqual(['a', 'b', '']);
    expect(sourceLines('a\r\nb')).toEqual(['a\r', 'b']);
  });

  it('hashes the line without trailing blanks and carriage returns', () => {
    expect(lineHash('x: 1  ')).toBe(lineHash('x: 1'));
    expect(lineHash('x: 1\r')).toBe(lineHash('x: 1'));
    expect(lineHash(' x: 1')).not.toBe(lineHash('x: 1'));
    expect(lineHash('x: 1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('finds the hash of a line, and nothing for a line the source lacks', () => {
    const lines = sourceLines('one\ntwo');
    expect(hashOfLine(lines, 2)).toBe(lineHash('two'));
    expect(hashOfLine(lines, 0)).toBeNull();
    expect(hashOfLine(lines, 3)).toBeNull();
    expect(hashOfLine(lines, 1.5)).toBeNull();
  });

  it('matches an anchor only while the same text is on the same line', () => {
    const anchor = { line: 2, lineHash: lineHash('two') };
    expect(anchorMatches(anchor, sourceLines('one\ntwo'))).toBe(true);
    expect(anchorMatches(anchor, sourceLines('zero\none\ntwo'))).toBe(false);
    expect(anchorMatches(anchor, sourceLines('one'))).toBe(false);
  });

  it('hashes a very long line in linear time, trailing blanks or not', () => {
    const blanks = ' '.repeat(500_000);
    for (const line of [
      `${blanks}x`,
      blanks,
      `x${blanks}`,
      `${'\t'.repeat(500_000)}y`,
      'a'.repeat(500_000),
    ]) {
      const started = performance.now();
      lineHash(line);
      expect(performance.now() - started).toBeLessThan(100);
    }
    expect(lineHash(`x${blanks}`)).toBe(lineHash('x'));
  });

  it('tells long lines apart by their length and their start', () => {
    const a = 'a'.repeat(5000);
    expect(lineHash(a)).not.toBe(lineHash(`${a}a`));
    expect(lineHash(a)).not.toBe(lineHash(`b${a.slice(1)}`));
    expect(lineHash(`${a}   `)).toBe(lineHash(a));
  });
});
