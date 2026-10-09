import { isIP } from 'node:net';

/** A parsed IP address: IPv4-mapped IPv6 addresses are folded into IPv4. */
export interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

function v4ToBigint(s: string): bigint {
  return s.split('.').reduce((acc, p) => (acc << 8n) + BigInt(Number(p)), 0n);
}

function v6ToBigint(s: string): bigint | null {
  let text = s;
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) becomes two hex groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    if (isIP(tail[2]!) !== 4) return null;
    const v = v4ToBigint(tail[2]!);
    text = `${tail[1]!}${(v >> 16n).toString(16)}:${(v & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) + BigInt(parseInt(g, 16));
  }
  return value;
}

/**
 * Parses an IPv4 or IPv6 literal (brackets allowed, no zone id). IPv4-mapped IPv6 addresses in
 * both spellings (`::ffff:1.2.3.4` and `::ffff:102:304`) are returned as the embedded IPv4 address,
 * so a mapped spelling can never slip past an IPv4 rule.
 */
export function parseIp(host: string): ParsedIp | null {
  const h = host.replace(/^\[|\]$/g, '');
  if (h.includes('%')) return null;
  const v = isIP(h);
  if (v === 4) return { version: 4, value: v4ToBigint(h) };
  if (v !== 6) return null;
  const value = v6ToBigint(h);
  if (value === null) return null;
  if (value >> 32n === 0xffffn) return { version: 4, value: value & 0xffffffffn };
  return { version: 6, value };
}

export type AddressClass =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'shared'
  | 'multicast'
  | 'reserved'
  | 'metadata';

function inV4(v: bigint, base: string, bits: number): boolean {
  const shift = BigInt(32 - bits);
  return v >> shift === v4ToBigint(base) >> shift;
}

function inV6(v: bigint, base: string, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return v >> shift === (v6ToBigint(base) as bigint) >> shift;
}

const V4_RANGES: ReadonlyArray<[string, number, AddressClass]> = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'shared'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'reserved'],
  ['198.51.100.0', 24, 'reserved'],
  ['203.0.113.0', 24, 'reserved'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const V4_METADATA = ['169.254.169.254', '169.254.170.2', '100.100.100.200', '168.63.129.16'];
const V6_METADATA = ['fd00:ec2::254', 'fd00:ec2::23'];

/** Classifies an address against the ranges that must never be reachable from tenant input. */
export function classifyAddress(ip: ParsedIp): AddressClass {
  if (ip.version === 4) {
    if (V4_METADATA.some((m) => v4ToBigint(m) === ip.value)) return 'metadata';
    for (const [base, bits, cls] of V4_RANGES) if (inV4(ip.value, base, bits)) return cls;
    return 'public';
  }
  const v = ip.value;
  if (V6_METADATA.some((m) => v6ToBigint(m) === v)) return 'metadata';
  if (v === 0n) return 'unspecified';
  if (v === 1n) return 'loopback';
  // NAT64 (64:ff9b::/96) and the deprecated IPv4-compatible range embed an IPv4 address.
  if (inV6(v, '64:ff9b::', 96)) return classifyAddress({ version: 4, value: v & 0xffffffffn });
  if (v >> 32n === 0n) return classifyAddress({ version: 4, value: v & 0xffffffffn });
  if (inV6(v, 'fc00::', 7)) return 'private';
  if (inV6(v, 'fe80::', 10)) return 'link-local';
  if (inV6(v, 'ff00::', 8)) return 'multicast';
  if (inV6(v, '2001:db8::', 32) || inV6(v, '100::', 64)) return 'reserved';
  return 'public';
}

/** Hostnames that always resolve to cloud metadata services. */
const METADATA_NAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.tencentyun.com',
]);

export function isMetadataName(host: string): boolean {
  return METADATA_NAMES.has(host);
}
