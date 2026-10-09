/**
 * Deterministic ustar archive of a source tree: the seed handed to the run node (DOG-2 defines the
 * endpoint and the unpacking, DOG-4 the wiring). Sorted paths, fixed owner and time, regular
 * files only; the SHA-256 of the archive is the audited seed digest.
 */
export interface SeedFile {
  path: string;
  mode: '100644' | '100755';
  content: Buffer;
}

export interface SeedSkip {
  path: string;
  reason: 'symlink' | 'gitlink' | 'special_mode' | 'too_large' | 'lfs_pointer' | 'unsafe_path';
}

function field(buf: Buffer, off: number, len: number, v: string): void {
  buf.write(v, off, len, 'latin1');
}

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  const slash = path.lastIndexOf('/', path.length - 1);
  for (let at = slash; at > 0; at = path.lastIndexOf('/', at - 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error('path too long for the seed archive');
}

export function packSeed(files: readonly SeedFile[]): Buffer {
  const chunks: Buffer[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const { name, prefix } = splitName(f.path);
    const h = Buffer.alloc(512);
    field(h, 0, 100, name);
    field(h, 100, 8, octal(f.mode === '100755' ? 0o755 : 0o644, 8));
    field(h, 108, 8, octal(0, 8));
    field(h, 116, 8, octal(0, 8));
    field(h, 124, 12, octal(f.content.length, 12));
    field(h, 136, 12, octal(0, 12));
    field(h, 148, 8, '        ');
    field(h, 156, 1, '0');
    field(h, 257, 6, 'ustar\0');
    field(h, 263, 2, '00');
    field(h, 345, 155, prefix);
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
    chunks.push(h, f.content, Buffer.alloc((512 - (f.content.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
