import { OaxError } from '../errors.js';
import { entryMatches, parseAllowlist, type AllowEntry } from '../egress.js';
import { parseIp, type ParsedIp } from './ip.js';

/** A destination reduced to what route matching needs. Userinfo, path and query are dropped. */
export interface NormalizedTarget {
  scheme: string;
  /** Lower-case ASCII (punycode) host, no brackets, no trailing dot. IPv6 in canonical form. */
  host: string;
  port: number;
  ip: ParsedIp | null;
}

const DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
  'ws:': 80,
  'wss:': 443,
  'ldap:': 389,
  'ldaps:': 636,
};

/**
 * Normalises a destination URL for matching: scheme and host lower-case, IDN to punycode, one
 * trailing dot removed, IPv6 brackets removed, the default port filled in, userinfo ignored
 * (it is never matched and never echoed). Returns `null` for anything that is not a usable
 * http(s)/ws(s)/ldap(s) destination, so callers deny instead of guessing.
 */
export function normalizeTarget(input: string | URL): NormalizedTarget | null {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    return null;
  }
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (defaultPort === undefined) return null;
  let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.endsWith('.') || host.startsWith('.')) return null;
  const ip = parseIp(host);
  // Canonical text for IP literals so that every spelling compares equal.
  if (ip) host = formatIp(ip);
  const port = url.port ? Number(url.port) : defaultPort;
  return { scheme: url.protocol.slice(0, -1), host, port, ip };
}

function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) {
    const v = ip.value;
    return [24n, 16n, 8n, 0n].map((s) => String((v >> s) & 0xffn)).join('.');
  }
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((ip.value >> BigInt(i * 16)) & 0xffffn).toString(16));
  return groups.join(':');
}

/** A host pattern of the route grammar: the allowlist grammar plus `*` (every destination). */
export type HostPattern = (AllowEntry | { kind: 'any'; port: number | null }) & { raw: string };

function bad(token: string, why: string): never {
  throw new OaxError('network_config_invalid', `invalid host pattern "${token}": ${why}`);
}

/**
 * Parses one host pattern: `host`, `.suffix`, `*.suffix`, an IP, a CIDR (`10.0.0.0/8`, `fd00::/8`,
 * also `0.0.0.0/0`), each with an optional `:port` (`[fd00::1]:443`), or `*` / `*:port`.
 * It is the grammar of `OAX_AIRGAPPED_ALLOW` (same parser) with the explicit wildcard added.
 */
export function parseHostPattern(token: string): HostPattern {
  const t = token.trim().toLowerCase();
  if (!t) bad(token, 'empty');
  if (/[\s,]/.test(t)) bad(token, 'one pattern per entry (no spaces or commas)');
  const any = /^\*(?::(\d+))?$/.exec(t);
  if (any) return { kind: 'any', port: portOf(any[1], token), raw: t };
  const all = /^(0\.0\.0\.0\/0|::\/0)(?::(\d+))?$/.exec(t);
  if (all) {
    const v6 = all[1] === '::/0';
    return {
      kind: 'cidr',
      version: v6 ? 6 : 4,
      base: 0n,
      bits: 0,
      total: v6 ? 128 : 32,
      port: portOf(all[2], token),
      raw: t,
    };
  }
  if (t.includes('*') && !/^\*\.[^*]+$/.test(t.replace(/:\d+$/, '')))
    bad(token, 'a wildcard is only allowed as a leading "*." or as the whole pattern "*"');
  let entries: AllowEntry[];
  try {
    entries = parseAllowlist(t);
  } catch (e) {
    return bad(token, (e as Error).message.replace(/^OAX_AIRGAPPED_ALLOW: /, ''));
  }
  const e = entries[0];
  if (entries.length !== 1 || !e) return bad(token, 'not a valid pattern');
  portOf(e.port === null ? undefined : String(e.port), token);
  return { ...e, raw: t };
}

function portOf(raw: string | undefined, token: string): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) bad(token, `port ${raw} is out of range`);
  return n;
}

/** True when the pattern matches every destination (so it is a catch-all). */
export function isWildcardAll(p: HostPattern): boolean {
  return p.kind === 'any' || (p.kind === 'cidr' && p.bits === 0);
}

export function matchesPattern(p: HostPattern, target: NormalizedTarget): boolean {
  if (p.port !== null && p.port !== target.port) return false;
  if (p.kind === 'any') return true;
  return entryMatches(p, target.host, target.port);
}

export function matchesAny(patterns: readonly HostPattern[], target: NormalizedTarget): boolean {
  return patterns.some((p) => matchesPattern(p, target));
}

/**
 * Parses a `NO_PROXY` value. Like curl and Go it is lenient (an entry that does not parse is
 * skipped) and a bare name also covers its subdomains (`example.com` matches `a.example.com`).
 * Supported: `*`, host, `.suffix`, `*.suffix`, `host:port`, IPv4/IPv6 literals, CIDR ranges.
 */
export function parseNoProxy(raw: string | undefined): HostPattern[] {
  const out: HostPattern[] = [];
  for (const piece of (raw ?? '').split(/[,\s]+/)) {
    const token = piece
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    if (!token) continue;
    let p: HostPattern;
    try {
      p = parseHostPattern(token.replace(/\.(?=$|:\d+$)/, ''));
    } catch {
      continue;
    }
    if (p.kind === 'host' && !parseIp(p.host)) {
      out.push({ kind: 'suffix', suffix: p.host, port: p.port, raw: p.raw });
    } else out.push(p);
  }
  return out;
}
