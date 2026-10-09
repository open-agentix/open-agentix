import { lookup as dnsLookup } from 'node:dns/promises';
import { EgressPolicy, OaxError, isLoopback, parseAllowlist } from '@openagentix/core';
import { isIP } from 'node:net';

export type HostLookup = (host: string) => Promise<{ address: string }[]>;

const defaultLookup: HostLookup = (host) => dnsLookup(host, { all: true });

/** Parses an IPv6 text form into 16 bytes (null when it is not a valid IPv6 address). */
function ipv6Bytes(address: string): Uint8Array | null {
  let a = address.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (isIP(a) !== 6) return null;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const [, p, q, r, t] = dotted.map(Number) as [number, number, number, number, number];
    a = a.slice(0, dotted.index) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const [head = '', tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? h : [...h, ...new Array<string>(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = parseInt(g, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 255;
  });
  return out;
}

const v4 = (b: Uint8Array, at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

/**
 * The IPv4 address an IPv6 form embeds, when it is one of the translation forms: IPv4-mapped
 * `::ffff:a.b.c.d`, IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`.
 */
function embeddedV4(b: Uint8Array): string | null {
  const zeros = (n: number) => b.subarray(0, n).every((x) => x === 0);
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return v4(b, 12);
  // ::a.b.c.d (`::` and `::1` stay IPv6 addresses)
  if (zeros(12) && !(zeros(15) && (b[15] === 0 || b[15] === 1))) return v4(b, 12);
  if (
    b[0] === 0 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.subarray(4, 12).every((x) => x === 0)
  )
    return v4(b, 12);
  if (b[0] === 0x20 && b[1] === 0x02) return v4(b, 2);
  return null;
}

/** Text form of the IPv4 address inside a translated IPv6 address, else the address unchanged. */
function unmap(address: string): string {
  const a = address.replace(/^\[|\]$/g, '').toLowerCase();
  const b = ipv6Bytes(a);
  return (b && embeddedV4(b)) ?? a;
}

/** Loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(address: string): boolean {
  const a = unmap(address);
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number];
    return (
      p === 0 ||
      p === 10 ||
      p === 127 ||
      (p === 100 && q >= 64 && q <= 127) ||
      (p === 169 && q === 254) ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 192 && q === 0) ||
      (p === 198 && (q === 18 || q === 19)) ||
      p >= 224
    );
  }
  if (isIP(a) === 6) {
    const b = ipv6Bytes(a);
    // NAT64 local-use 64:ff9b:1::/48, Teredo 2001::/32 and site-local fec0::/10 embed or reach
    // private space; IPv4-embedding forms were reduced to their IPv4 address above.
    if (
      b &&
      ((b[0] === 0 &&
        b[1] === 0x64 &&
        b[2] === 0xff &&
        b[3] === 0x9b &&
        b[4] === 0 &&
        b[5] === 1) ||
        (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) ||
        (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0))
    )
      return true;
    return (
      a === '::' ||
      a === '::1' ||
      a.startsWith('fe8') ||
      a.startsWith('fe9') ||
      a.startsWith('fea') ||
      a.startsWith('feb') ||
      a.startsWith('fc') ||
      a.startsWith('fd') ||
      a.startsWith('ff')
    );
  }
  return true;
}

/**
 * Refuses a destination that is or resolves to a non-public address, unless the operator listed it
 * (hosts, suffixes, CIDRs as in `OAX_AIRGAPPED_ALLOW`). Used for tenant-controlled endpoints.
 */
export async function assertPublicDestination(
  host: string,
  opts: { allow?: readonly string[] | undefined; lookup?: HostLookup | undefined } = {},
): Promise<void> {
  const h = host.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(h)) addresses = [h];
  else {
    try {
      addresses = (await (opts.lookup ?? defaultLookup)(h)).map((r) => r.address);
    } catch {
      // Fail closed: a name that cannot be checked is not called.
      throw new OaxError('egress_denied', UNCHECKED);
    }
    if (addresses.length === 0) throw new OaxError('egress_denied', UNCHECKED);
  }
  checkAddresses(h, addresses, opts.allow ?? []);
}

const UNCHECKED = 'the endpoint could not be resolved and checked';

/** Throws `egress_denied` when one of the addresses is non-public and not operator-listed. */
function checkAddresses(h: string, addresses: readonly string[], allowList: readonly string[]) {
  const allow = new EgressPolicy({
    airgapped: true,
    allow: parseAllowlist(allowList.join(',')),
  });
  const listed = new Set(allowList.map((x) => x.trim().toLowerCase()));
  for (const raw of addresses) {
    const addr = unmap(raw);
    if (!isPrivateAddress(addr)) continue;
    // The egress policy treats loopback as always allowed; here only an explicit entry counts.
    const ok = isLoopback(addr)
      ? listed.has(addr.toLowerCase()) || listed.has(h.toLowerCase())
      : allow.isAllowed(addr) || allow.isAllowed(h);
    if (!ok) throw new OaxError('egress_denied', 'the endpoint resolves to a non-public address');
  }
}

export interface PinnedLookupOptions {
  allow?: readonly string[] | undefined;
  lookup?: HostLookup | undefined;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * A `dns.lookup`-compatible function for the connect step of an HTTP client (undici
 * `connect.lookup`, `https.Agent({ lookup })`). It resolves the name, validates EVERY address with
 * the same rules as `assertPublicDestination` and hands exactly the validated addresses to the
 * socket, so the address that is checked is the address that is connected (no second resolution:
 * DNS rebinding between check and connect is closed). A failure or a non-public address rejects
 * the connection.
 */
export function createPinnedLookup(opts: PinnedLookupOptions = {}) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number | string } | LookupCallback,
    callback?: LookupCallback,
  ): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
    const o = typeof options === 'function' ? {} : options;
    void (async () => {
      const found = await (opts.lookup ?? defaultLookup)(hostname.replace(/^\[|\]$/g, ''));
      const fam =
        o.family === 4 || o.family === '4' ? 4 : o.family === 6 || o.family === '6' ? 6 : 0;
      const list = found
        .map((r) => ({ address: r.address, family: isIP(r.address) }))
        .filter((r) => r.family !== 0 && (fam === 0 || r.family === fam));
      if (list.length === 0) throw new OaxError('egress_denied', UNCHECKED);
      // Validates the very addresses that are returned below.
      checkAddresses(
        hostname.replace(/^\[|\]$/g, ''),
        list.map((r) => r.address),
        opts.allow ?? [],
      );
      return list;
    })().then(
      (list) => (o.all ? cb(null, list) : cb(null, list[0]!.address, list[0]!.family)),
      (e: Error) => cb(e as NodeJS.ErrnoException, '', 0),
    );
  };
}
