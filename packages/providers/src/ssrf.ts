import { lookup as dnsLookup } from 'node:dns/promises';
import { EgressPolicy, OaxError, isLoopback, parseAllowlist } from '@openagentix/core';
import { isIP } from 'node:net';

export type HostLookup = (host: string) => Promise<{ address: string }[]>;

const defaultLookup: HostLookup = (host) => dnsLookup(host, { all: true });

/** `::ffff:7f00:1` (as URL parsers print it) and `::ffff:127.0.0.1` are the IPv4 address inside. */
function unmap(address: string): string {
  const a = address.replace(/^\[|\]$/g, '').toLowerCase();
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return dotted ? dotted[1]! : a;
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
  const allow = new EgressPolicy({
    airgapped: true,
    allow: parseAllowlist((opts.allow ?? []).join(',')),
  });
  const denied = () =>
    new OaxError('egress_denied', 'the endpoint resolves to a non-public address');
  let addresses: string[];
  if (isIP(h)) addresses = [h];
  else {
    try {
      addresses = (await (opts.lookup ?? defaultLookup)(h)).map((r) => r.address);
    } catch {
      // unresolvable: the request fails by itself, nothing was sent
      return;
    }
  }
  const listed = new Set((opts.allow ?? []).map((x) => x.trim().toLowerCase()));
  for (const raw of addresses) {
    const addr = unmap(raw);
    if (!isPrivateAddress(addr)) continue;
    // The egress policy treats loopback as always allowed; here only an explicit entry counts.
    const ok = isLoopback(addr)
      ? listed.has(addr.toLowerCase()) || listed.has(h.toLowerCase())
      : allow.isAllowed(addr) || allow.isAllowed(h);
    if (!ok) throw denied();
  }
}
