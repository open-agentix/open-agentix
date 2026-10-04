/** Small CIDR toolkit (IPv4 and IPv6) used to bound NetworkPolicy egress. No dependencies. */

export interface Cidr {
  version: 4 | 6;
  /** Network address with host bits cleared. */
  base: bigint;
  bits: number;
  text: string;
}

function parseV4(s: string): bigint | undefined {
  const parts = s.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return undefined;
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function parseV6(s: string): bigint | undefined {
  if (!/^[0-9a-fA-F:]+$/.test(s) || s.split('::').length > 2) return undefined;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - h.length - t.length;
  if (s.includes('::') ? missing < 1 : missing !== 0) return undefined;
  const groups = [...h, ...Array<string>(s.includes('::') ? missing : 0).fill('0'), ...t];
  if (groups.length !== 8) return undefined;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    n = (n << 16n) | BigInt(`0x${g}`);
  }
  return n;
}

export function parseCidr(text: string): Cidr | undefined {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(text.trim());
  if (!m) return undefined;
  const v = m[1]!.includes(':') ? 6 : 4;
  const width = v === 6 ? 128 : 32;
  const addr = v === 6 ? parseV6(m[1]!) : parseV4(m[1]!);
  const bits = Number(m[2]);
  if (addr === undefined || bits > width) return undefined;
  const shift = BigInt(width - bits);
  return { version: v, base: (addr >> shift) << shift, bits, text: text.trim() };
}

/** True when `outer` contains every address of `inner`. */
export function cidrContains(outer: Cidr, inner: Cidr): boolean {
  if (outer.version !== inner.version || outer.bits > inner.bits) return false;
  const width = outer.version === 6 ? 128 : 32;
  const shift = BigInt(width - outer.bits);
  return inner.base >> shift === outer.base >> shift;
}

/** Minimum prefix length a step may open: /8 for IPv4, /32 for IPv6. */
export function minPrefix(version: 4 | 6): number {
  return version === 4 ? 8 : 32;
}

/** Destinations that no allowlist entry may reach (cloud metadata, link-local, loopback). */
export const ALWAYS_DENIED_CIDRS: readonly string[] = [
  '169.254.0.0/16', // link-local incl. AWS/GCP/Azure IMDS 169.254.169.254
  '127.0.0.0/8',
  '::1/128',
  'fe80::/10',
  'fd00:ec2::254/128', // AWS IMDS over IPv6
];
