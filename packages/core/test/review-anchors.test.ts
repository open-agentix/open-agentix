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
});
