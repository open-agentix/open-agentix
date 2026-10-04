import { OaxError } from '@openagentix/core';
import { ALWAYS_DENIED_CIDRS, cidrContains, minPrefix, parseCidr, type Cidr } from './cidr.js';

/**
 * Egress rules of run nodes (ADR 0008, section 3.5). One grammar for pipeline authors, the operator
 * ceiling and the proxy:
 *
 *   `jira.example.com`       a host name (default port 443)
 *   `jira.example.com:8443`  a host name with one explicit port
 *   `*.example.com`          a suffix, at least two labels after the `*.`
 *   `203.0.113.7`, `[2001:db8::1]:443`, `203.0.113.0/24`   addresses and CIDRs (no wider than /8, /32)
 *
 * Whatever the rules say, the proxy checks the ADDRESS it is about to connect to: private,
 * shared-address, metadata, loopback and link-local destinations are never reachable for a step
 * author, only an operator can open private ranges (`OAX_CONTAINER_EGRESS_PRIVATE_ALLOW`).
 */
export type EgressRule =
  | { kind: 'host'; host: string; port: number | null }
  | { kind: 'suffix'; suffix: string; port: number | null }
  | { kind: 'cidr'; cidr: Cidr };

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function bad(message: string): OaxError {
  return new OaxError('egress_invalid', message);
}

function addrToCidr(addr: string): Cidr | undefined {
  return parseCidr(`${addr}/${addr.includes(':') ? 128 : 32}`);
}

export function parseEgressEntry(raw: string): EgressRule {
  const e = raw.trim().toLowerCase();
  if (!e || e.length > 253) throw bad('empty or oversized egress entry');
  if (e.includes('/')) {
    const c = parseCidr(e);
    if (!c) throw bad(`egress entry "${raw}" is not a valid CIDR`);
    if (c.bits < minPrefix(c.version))
      throw bad(`egress entry "${raw}" is too broad (minimum prefix /${minPrefix(c.version)})`);
    return { kind: 'cidr', cidr: c };
  }
  let host = e;
  let port: number | null = null;
  const m6 = /^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/.exec(e);
  if (m6) {
    host = m6[1]!;
    port = m6[2] ? Number(m6[2]) : null;
  } else if (!e.includes('::') && (e.match(/:/g) ?? []).length === 1) {
    const i = e.indexOf(':');
    host = e.slice(0, i);
    const p = e.slice(i + 1);
    if (!/^\d{1,5}$/.test(p)) throw bad(`egress entry "${raw}" has an invalid port`);
    port = Number(p);
  }
  if (port !== null && (port < 1 || port > 65535))
    throw bad(`egress entry "${raw}" has an invalid port`);
  if (host.includes(':') || /^[0-9.]+$/.test(host)) {
    const c = addrToCidr(host);
    if (!c) throw bad(`egress entry "${raw}" is not a valid address`);
    if (port !== null) {
      // An address with a port: keep the port by encoding it as a host rule on the literal.
      return { kind: 'host', host, port };
    }
    return { kind: 'cidr', cidr: c };
  }
  if (host.startsWith('*.')) {
    const suffix = host.slice(2);
    if (!HOST.test(suffix) || !suffix.includes('.'))
      throw bad(`egress suffix "${raw}" needs at least two labels after "*."`);
    return { kind: 'suffix', suffix, port };
  }
  if (!HOST.test(host)) throw bad(`egress entry "${raw}" is not a host name, address or CIDR`);
  return { kind: 'host', host, port };
}

export function parseEgressEntries(entries: readonly string[]): EgressRule[] {
  return entries.map(parseEgressEntry);
}

function covers(outer: EgressRule, inner: EgressRule): boolean {
  if (outer.kind === 'cidr') return inner.kind === 'cidr' && cidrContains(outer.cidr, inner.cidr);
  if (inner.kind === 'cidr') return false;
  // No port means 443 on both sides: a ceiling entry never silently opens other ports.
  if ((outer.port ?? 443) !== (inner.port ?? 443)) return false;
  if (outer.kind === 'host') return inner.kind === 'host' && inner.host === outer.host;
  if (inner.kind === 'suffix')
    return inner.suffix === outer.suffix || inner.suffix.endsWith(`.${outer.suffix}`);
  return inner.host.endsWith(`.${outer.suffix}`);
}

/**
 * The operator ceiling is an UPPER BOUND (intersection, never a union): every entry of a step must
 * be covered by some ceiling entry. An empty ceiling means steps get no egress at all.
 */
export function assertWithinCeiling(
  entries: readonly string[],
  ceiling: readonly EgressRule[],
): EgressRule[] {
  const rules = parseEgressEntries(entries);
  rules.forEach((r, i) => {
    if (!ceiling.some((c) => covers(c, r)))
      throw bad(
        `egress entry "${entries[i]}" is outside the operator egress allowlist (OAX_CONTAINER_EGRESS_ALLOW)`,
      );
  });
  return rules;
}

/** Destinations that are not public: only an operator can open them. */
export const PRIVATE_CIDRS: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10', // shared address space (CGNAT, some clouds' internal ranges)
  '172.16.0.0/12', // includes the Docker bridge networks and their gateways
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15', // benchmarking, also used by some resolvers/proxies
  '224.0.0.0/3', // multicast and reserved
  '::/128',
  'fc00::/7', // unique local addresses
  '::/96', // IPv4-compatible (deprecated); the embedded address is judged separately
  '::ffff:0:0:0/96', // SIIT; the embedded address is judged separately
  '64:ff9b::/96', // NAT64: embeds any IPv4 address, including private ones
  '64:ff9b:1::/48',
  '2002::/16', // 6to4: embeds an IPv4 address
  'ff00::/8',
];

const PARSED = (list: readonly string[]) =>
  list.map((c) => parseCidr(c)).filter((c): c is Cidr => c !== undefined);
const DENIED = PARSED(ALWAYS_DENIED_CIDRS);
const PRIVATE = PARSED(PRIVATE_CIDRS);

/**
 * Parses an address into a CIDR-style value. A dotted IPv4 tail (`::ffff:1.2.3.4`, `::1.2.3.4`) is
 * rewritten to two hex groups first, so every spelling of an IPv6 address reaches the numeric checks.
 */
function parseAddress(address: string): Cidr | undefined {
  const a = address
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!;
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    if (o.some((x) => x > 255)) return undefined;
    return addrToCidr(
      `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`,
    );
  }
  return addrToCidr(a);
}

/** IPv6 prefixes that carry an IPv4 address in their low 32 bits (checked numerically). */
const V4_EMBEDDING_PREFIXES: readonly bigint[] = [
  0xffffn, // ::ffff:0:0/96   IPv4-mapped
  0n, //        ::/96           IPv4-compatible (deprecated)
  0xffff0000n, // ::ffff:0:0:0/96 SIIT (IPv4-translated)
];

/** The IPv4 address inside an IPv6 one, whatever its spelling, or `undefined`. */
function embeddedV4(c: Cidr): Cidr | undefined {
  if (c.version !== 6) return undefined;
  const high = c.base >> 32n;
  if (!V4_EMBEDDING_PREFIXES.includes(high)) return undefined;
  const v = c.base & 0xffffffffn;
  return addrToCidr([24n, 16n, 8n, 0n].map((sh) => Number((v >> sh) & 255n)).join('.'));
}

/** Normalises an address; IPv4 embedded in IPv6 (any spelling) becomes IPv4. */
export function normalizeAddress(address: string): Cidr | undefined {
  const c = parseAddress(address);
  if (!c) return undefined;
  return embeddedV4(c) ?? c;
}

export type AddressVerdict = 'ok' | 'denied' | 'private';

const RANK: Record<AddressVerdict, number> = { ok: 0, private: 1, denied: 2 };

function verdictOf(c: Cidr): AddressVerdict {
  if (DENIED.some((d) => cidrContains(d, c))) return 'denied';
  if (PRIVATE.some((p) => cidrContains(p, c))) return 'private';
  return 'ok';
}

/**
 * Never reachable (`denied`), reachable only with an operator allowance (`private`), or `ok`. An
 * IPv6 address that embeds an IPv4 one is judged as BOTH (the stricter verdict wins), so no
 * spelling of `10.0.0.1` or `169.254.169.254` gets through.
 */
export function classifyAddress(address: string): AddressVerdict {
  const c = parseAddress(address);
  if (!c) return 'denied';
  const inner = embeddedV4(c);
  const verdicts = [verdictOf(c), ...(inner ? [verdictOf(inner)] : [])];
  return verdicts.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/** Does a rule allow this target (host name or address literal) and port? Ports default to 443. */
export function ruleAllows(
  rule: EgressRule,
  host: string,
  addr: Cidr | undefined,
  port: number,
): boolean {
  const h = host.toLowerCase();
  if (rule.kind === 'cidr') return !!addr && cidrContains(rule.cidr, addr) && port === 443;
  if ((rule.port ?? 443) !== port) return false;
  if (rule.kind === 'host') return h === rule.host;
  return !addr && h.endsWith(`.${rule.suffix}`);
}
