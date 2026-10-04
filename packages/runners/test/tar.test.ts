import { describe, expect, it } from 'vitest';
import { tarFiles } from '../src/index.js';

const file = (name: string, text: string) => ({
  name,
  content: Buffer.from(text),
  mode: 0o400,
  uid: 10001,
  gid: 10001,
});

describe('tar writer', () => {
  it('writes a valid ustar archive with a correct checksum', () => {
    const tar = tarFiles([file('token', 'oaxrt.a.b'), file('proxy-url', 'http://x')]);
    expect(tar.length % 512).toBe(0);
    const header = tar.subarray(0, 512);
    expect(header.toString('ascii', 0, 5)).toBe('token');
    expect(header.toString('ascii', 257, 262)).toBe('ustar');
    expect(parseInt(header.toString('ascii', 100, 107), 8)).toBe(0o400);
    expect(parseInt(header.toString('ascii', 108, 115), 8)).toBe(10001);
    expect(parseInt(header.toString('ascii', 124, 135), 8)).toBe(9);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
    expect(parseInt(header.toString('ascii', 148, 154), 8)).toBe(sum);
    expect(tar.subarray(512, 521).toString()).toBe('oaxrt.a.b');
    // second entry starts after the padded content block; the archive ends with two zero blocks
    expect(tar.subarray(1024, 1033).toString('ascii')).toBe('proxy-url');
    expect(tar.subarray(tar.length - 1024).every((b) => b === 0)).toBe(true);
  });
  it('refuses names that could escape the target directory', () => {
    for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b', 'é', 'x'.repeat(100)])
      expect(() => tarFiles([file(name, 'x')])).toThrow(RangeError);
    expect(() => tarFiles([])).toThrow(RangeError);
  });
});
