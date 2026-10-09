import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packSeed } from '../src/git/seed.js';
import {
  DEFAULT_UNPACK_LIMITS,
  checkSeedName,
  parseSeedArchive,
  unpackSeed,
} from '../src/seed-unpack.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface RawEntry {
  name: string;
  type?: string;
  mode?: number;
  size?: number;
  linkname?: string;
  prefix?: string;
  content?: Buffer;
  magic?: string;
  rawName?: Buffer;
  badChecksum?: boolean;
  padJunk?: boolean;
}

/** Hand-made tar: lets a test write headers the packer would never produce. */
function raw(entries: RawEntry[], opts: { end?: boolean; trailer?: Buffer } = {}): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const content = e.content ?? Buffer.alloc(0);
    const h = Buffer.alloc(512);
    (e.rawName ?? Buffer.from(e.name)).copy(h, 0);
    h.write((e.mode ?? 0o644).toString(8).padStart(7, '0') + '\0', 100, 'latin1');
    h.write('0000000\0', 108, 'latin1');
    h.write('0000000\0', 116, 'latin1');
    h.write((e.size ?? content.length).toString(8).padStart(11, '0') + '\0', 124, 'latin1');
    h.write('00000000000\0', 136, 'latin1');
    h.write('        ', 148, 'latin1');
    h.write(e.type ?? '0', 156, 'latin1');
    if (e.linkname) h.write(e.linkname, 157, 'latin1');
    h.write(e.magic ?? 'ustar\0', 257, 'latin1');
    h.write('00', 263, 'latin1');
    if (e.prefix) h.write(e.prefix, 345, 'latin1');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${(e.badChecksum ? sum + 1 : sum).toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
    if (e.padJunk && pad.length > 0) pad[0] = 1;
    chunks.push(h, content, pad);
  }
  if (opts.end !== false) chunks.push(Buffer.alloc(1024));
  if (opts.trailer) chunks.push(opts.trailer);
  return Buffer.concat(chunks);
}

const file = (p: string, c: string, mode: '100644' | '100755' = '100644') => ({
  path: p,
  mode,
  content: Buffer.from(c),
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'oax-unpack-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const refuses = (archive: Buffer, rule: RegExp | string) => {
  expect(() => parseSeedArchive(archive)).toThrowError(
    expect.objectContaining({ code: 'seed_invalid', message: expect.stringMatching(rule) }),
  );
};

describe('unpackSeed: the happy path', () => {
  it('verifies the digest and writes regular files with the declared modes', async () => {
    const archive = packSeed([
      file('src/price.js', 'export const a = 1;\n'),
      file('test/price.test.js', 'import test from "node:test";\n'),
      file('bin/run.sh', '#!/bin/sh\n', '100755'),
      file('README.md', '# hi\n'),
      file(`dir/${'x'.repeat(120)}/deep/${'y'.repeat(60)}.js`, 'long\n'),
    ]);
    const root = path.join(tmp, 'ws');
    const rep = await unpackSeed(archive, sha(archive), root);
    expect(rep).toMatchObject({ files: 5, sha256: sha(archive) });
    expect(readFileSync(path.join(root, 'src/price.js'), 'utf8')).toBe('export const a = 1;\n');
    expect(statSync(path.join(root, 'bin/run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(root, 'README.md')).mode & 0o777).toBe(0o644);
    expect(readdirSync(path.join(root, 'dir'))).toHaveLength(1);
  });

  it('accepts an existing empty directory and a legacy type flag of NUL', async () => {
    const archive = raw([{ name: 'a.txt', type: '\0', content: Buffer.from('x') }]);
    const root = path.join(tmp, 'empty');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(root);
    expect((await unpackSeed(archive, sha(archive), root)).files).toBe(1);
  });

  it('accepts an archive with no entries', async () => {
    const archive = raw([]);
    expect((await unpackSeed(archive, sha(archive), path.join(tmp, 'n'))).files).toBe(0);
  });
});

describe('unpackSeed: refusals leave the workspace untouched', () => {
  it('refuses a digest mismatch before reading the archive', async () => {
    const archive = packSeed([file('a.txt', 'x')]);
    const root = path.join(tmp, 'ws');
    await expect(unpackSeed(archive, 'f'.repeat(64), root)).rejects.toMatchObject({
      code: 'seed_invalid',
    });
    await expect(unpackSeed(archive, 'not-hex', root)).rejects.toMatchObject({
      code: 'seed_invalid',
    });
    expect(existsSync(root)).toBe(false);
  });

  it('parses everything before it writes anything', async () => {
    // a valid first file and a poisoned second one: nothing is written
    const archive = raw([
      { name: 'good.txt', content: Buffer.from('ok') },
      { name: '../evil.txt', content: Buffer.from('x') },
    ]);
    const root = path.join(tmp, 'ws');
    await expect(unpackSeed(archive, sha(archive), root)).rejects.toMatchObject({
      code: 'seed_invalid',
    });
    expect(existsSync(root)).toBe(false);
    expect(existsSync(path.join(tmp, 'evil.txt'))).toBe(false);
  });

  it('refuses a non-empty root, a file as root and a link as root', async () => {
    const archive = packSeed([file('a.txt', 'x')]);
    const full = path.join(tmp, 'full');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(full);
    writeFileSync(path.join(full, 'old'), 'x');
    await expect(unpackSeed(archive, sha(archive), full)).rejects.toThrow(/not empty/);
    const f = path.join(tmp, 'file');
    writeFileSync(f, 'x');
    await expect(unpackSeed(archive, sha(archive), f)).rejects.toThrow(/not a directory/);
    const l = path.join(tmp, 'link');
    symlinkSync(tmp, l);
    await expect(unpackSeed(archive, sha(archive), l)).rejects.toThrow(/not a directory/);
    expect(lstatSync(l).isSymbolicLink()).toBe(true);
  });
});

describe('parseSeedArchive: entry types and names', () => {
  it.each([
    ['symlink', '2', /regular file/],
    ['hardlink', '1', /regular file/],
    ['character device', '3', /regular file/],
    ['block device', '4', /regular file/],
    ['directory', '5', /regular file/],
    ['FIFO', '6', /regular file/],
    ['pax extended header', 'x', /regular file/],
    ['pax global header', 'g', /regular file/],
    ['GNU long name', 'L', /regular file/],
    ['GNU long link', 'K', /regular file/],
  ])('refuses a %s entry', (_n, type, rule) => {
    refuses(
      raw([{ name: 'a', type, linkname: type === '2' || type === '1' ? '/etc/passwd' : '' }]),
      rule,
    );
  });

  it('refuses a link target on a regular file', () => {
    refuses(raw([{ name: 'a', linkname: 'b' }]), /link target/);
  });

  it.each([
    ['parent segment', '../x'],
    ['inner parent segment', 'a/../x'],
    ['dot segment', './x'],
    ['inner dot segment', 'a/./x'],
    ['absolute path', '/etc/passwd'],
    ['drive path', 'C:/x'],
    ['empty segment', 'a//b'],
    ['trailing slash', 'a/'],
    ['backslash', 'a\\b'],
    ['git directory', '.git/config'],
    ['nested git directory', 'src/.GIT/hooks/x'],
    ['segment with trailing dot', 'a./x'],
    ['segment with trailing space', 'a /x'],
    ['control character', 'a\u0001b'],
    ['unicode line separator', 'a\u2028b'],
    ['replacement character', 'a\ufffdb'],
  ])('refuses %s', (_n, name) => {
    refuses(raw([{ name, content: Buffer.from('x') }]), /./);
  });

  it('refuses a prefix field that makes the path escape', () => {
    refuses(raw([{ name: 'x', prefix: '../..' }]), /parent/);
    refuses(raw([{ name: 'x', prefix: '/abs' }]), /absolute/);
  });

  it('refuses names that are not valid UTF-8', () => {
    refuses(raw([{ name: '', rawName: Buffer.from([0x61, 0xff, 0xfe]) }]), /UTF-8/);
    refuses(raw([{ name: 'x', prefix: '', rawName: Buffer.from([0xc0, 0xaf]) }]), /UTF-8/);
  });

  it('refuses data hidden after the NUL of a name field', () => {
    const a = raw([{ name: 'a.txt' }]);
    a[10] = 0x41; // byte after the terminator
    // fix the checksum so only the hidden byte is wrong
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : a[i]!;
    a.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    refuses(a, /malformed header field/);
  });

  it('refuses duplicates, also by case and Unicode form', () => {
    refuses(raw([{ name: 'a.txt' }, { name: 'a.txt' }]), /duplicate/);
    refuses(raw([{ name: 'src/Readme' }, { name: 'src/README' }]), /duplicate/);
    refuses(raw([{ name: 'caf\u00e9' }, { name: 'cafe\u0301' }]), /duplicate/);
  });

  it('refuses a file that is also a directory, in both orders', () => {
    refuses(raw([{ name: 'a' }, { name: 'a/b' }]), /also used as a directory/);
    refuses(raw([{ name: 'a/b' }, { name: 'a' }]), /also used as a file/);
  });

  it('refuses unusual modes (setuid, writable by all, no permission)', () => {
    for (const mode of [0o4755, 0o666, 0o777, 0o600, 0])
      refuses(raw([{ name: 'a', mode }]), /mode/);
  });

  it('refuses a non-ustar header and a bad checksum', () => {
    refuses(raw([{ name: 'a', magic: 'GNUtar' }]), /ustar/);
    refuses(raw([{ name: 'a', badChecksum: true }]), /checksum/);
  });
});

describe('parseSeedArchive: sizes and structure', () => {
  it('refuses an oversized file, too many files and too much data', () => {
    const lim = { ...DEFAULT_UNPACK_LIMITS };
    const big = raw([{ name: 'a', content: Buffer.alloc(2000) }]);
    expect(() => parseSeedArchive(big, { ...lim, maxFileBytes: 1000 })).toThrow(/too large/);
    const two = raw([{ name: 'a' }, { name: 'b' }]);
    expect(() => parseSeedArchive(two, { ...lim, maxFiles: 1 })).toThrow(/too many files/);
    const data = raw([
      { name: 'a', content: Buffer.alloc(600) },
      { name: 'b', content: Buffer.alloc(600) },
    ]);
    expect(() => parseSeedArchive(data, { ...lim, maxTotalBytes: 1000 })).toThrow(/total size/);
    expect(() => parseSeedArchive(data, { ...lim, maxArchiveBytes: 1024 })).toThrow(/archive size/);
  });

  it('refuses empty input, a ragged length, a missing end marker and trailing data', () => {
    refuses(Buffer.alloc(0), /archive size/);
    refuses(Buffer.alloc(700), /multiple of 512/);
    refuses(raw([{ name: 'a' }], { end: false }), /missing end marker/);
    refuses(
      raw([{ name: 'a' }], {
        trailer: Buffer.concat([Buffer.alloc(512), Buffer.from('x'.repeat(512))]),
      }),
      /after the end marker/,
    );
  });

  it('refuses a size that points past the archive and junk in the padding', () => {
    refuses(raw([{ name: 'a', size: 100000, content: Buffer.alloc(0) }]), /too large|exceeds/);
    const small = raw([{ name: 'a', size: 5000 }], { end: false });
    refuses(Buffer.concat([small, Buffer.alloc(512)]), /exceeds the archive|missing/);
    refuses(raw([{ name: 'a', content: Buffer.from('xyz'), padJunk: true }]), /padding/);
  });

  it('refuses sizes that are not plain octal numbers (base-256, signs, letters)', () => {
    const a = raw([{ name: 'a', content: Buffer.from('x') }]);
    a[124] = 0x80; // GNU base-256 marker
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : a[i]!;
    a.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    refuses(a, /octal/);
  });
});

describe('checkSeedName', () => {
  it('limits length and depth', () => {
    expect(() => checkSeedName('a/b/c.js')).not.toThrow();
    expect(() => checkSeedName('x'.repeat(301))).toThrow(/name length/);
    expect(() => checkSeedName(Array(26).fill('d').join('/'))).toThrow(/too deep/);
    expect(() => checkSeedName('')).toThrow(/name length/);
  });
});
