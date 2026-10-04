/**
 * Minimal ustar writer: flat archives of regular files, used to put the run token into the node's
 * tmpfs through the engine's archive endpoint (`PUT /containers/{id}/archive`). No directories,
 * no links, no long names: everything outside that is refused, so a crafted name cannot escape.
 */
export interface TarFile {
  /** Relative file name, at most 99 characters, no `/`, no `..`, no NUL. */
  name: string;
  content: Buffer;
  /** Octal mode, e.g. `0o400`. */
  mode: number;
  uid: number;
  gid: number;
}

const BLOCK = 512;

function field(buf: Buffer, offset: number, length: number, value: string): void {
  buf.write(value, offset, length, 'ascii');
}

function octal(value: number, digits: number): string {
  return value.toString(8).padStart(digits - 1, '0');
}

function entry(file: TarFile): Buffer {
  if (
    !file.name ||
    file.name.length > 99 ||
    /[/\\\0]/.test(file.name) ||
    file.name === '.' ||
    file.name === '..' ||
    !/^[\x20-\x7e]+$/.test(file.name)
  )
    throw new RangeError(`invalid tar file name "${file.name}"`);
  const header = Buffer.alloc(BLOCK);
  field(header, 0, 100, file.name);
  field(header, 100, 8, `${octal(file.mode & 0o7777, 8)}\0`);
  field(header, 108, 8, `${octal(file.uid, 8)}\0`);
  field(header, 116, 8, `${octal(file.gid, 8)}\0`);
  field(header, 124, 12, `${octal(file.content.length, 12)}\0`);
  field(header, 136, 12, `${octal(0, 12)}\0`);
  field(header, 148, 8, '        '); // checksum placeholder: eight spaces
  header[156] = '0'.charCodeAt(0); // regular file
  field(header, 257, 6, 'ustar\0');
  field(header, 263, 2, '00');
  let sum = 0;
  for (const byte of header) sum += byte;
  field(header, 148, 8, `${octal(sum, 7)}\0`);
  const padding = (BLOCK - (file.content.length % BLOCK)) % BLOCK;
  return Buffer.concat([header, file.content, Buffer.alloc(padding)]);
}

/** A tar archive of regular files (flat, no directories). */
export function tarFiles(files: readonly TarFile[]): Buffer {
  if (files.length === 0) throw new RangeError('a tar archive needs at least one file');
  return Buffer.concat([...files.map(entry), Buffer.alloc(BLOCK * 2)]);
}
