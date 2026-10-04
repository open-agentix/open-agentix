import { isIP } from 'node:net';
import { OaxError } from './errors.js';

/**
 * Egress policy. In air-gapped mode (`OAX_AIRGAPPED=true`) the process may only talk to loopback
 * and to hosts or CIDR ranges that the operator listed explicitly in `OAX_AIRGAPPED_ALLOW`
 * (plus the infrastructure the process itself is configured with, e.g. its database).
 * Outside air-gapped mode the policy allows everything and costs nothing.
 */
export type AllowEntry =
  | { kind: 'host'; host: string; port: number | null }
  | { kind: 'suffix'; suffix: string; port: number | null }
  | {
      kind: 'cidr';
      version: 4 | 6;
      base: bigint;
      bits: number;
      total: number;
      port: number | null;
    };

interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

function parseIp(host: string): ParsedIp | null {
  const h = host.replace(/^\[|\]$/g, '');
  const v = isIP(h);
  if (v === 4) {
    const value = h.split('.').reduce((acc, p) => (acc << 8n) + BigInt(Number(p)), 0n);
    return { version: 4, value };
  }
  if (v === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) is treated as the embedded IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
    if (mapped) return parseIp(mapped[1]!);
    const [head = '', tail = ''] = h.split('::') as [string?, string?];
    const hasGap = h.includes('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const fill = hasGap ? 8 - headParts.length - tailParts.length : 0;
    const groups = [...headParts, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tailParts];
    return {
      version: 6,
      value: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n),
    };
  }
  return null;
}

function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function splitPort(raw: string): { host: string; port: number | null } {
  const bracket = /^(\[[^\]]+\]):(\d+)$/.exec(raw);
  if (bracket) return { host: bracket[1]!, port: Number(bracket[2]) };
  if (/^[^:]+:\d+$/.test(raw)) {
    const i = raw.lastIndexOf(':');
    return { host: raw.slice(0, i), port: Number(raw.slice(i + 1)) };
  }
  return { host: raw, port: null };
}

/**
 * Parses a comma/space separated allowlist: hostnames (`ollama.internal`), domain suffixes
 * (`.corp.example`, `*.corp.example`), IPs, CIDR ranges (`10.0.0.0/8`, `fd00::/8`), each with an
 * optional port (`host:11434`, `[fd00::1]:443`).
 */
export function parseAllowlist(raw: string | undefined): AllowEntry[] {
  const out: AllowEntry[] = [];
  for (const token of (raw ?? '').split(/[,\s]+/)) {
    const t = token.trim().toLowerCase();
    if (!t) continue;
    if (t === '*' || t === '0.0.0.0/0' || t === '::/0') {
      throw new OaxError(
        'config_invalid',
        `OAX_AIRGAPPED_ALLOW must not contain the wildcard "${t}"; list explicit internal hosts or CIDRs`,
      );
    }
    const { host, port } = splitPort(t);
    const slash = host.indexOf('/');
    if (slash > 0) {
      const ip = parseIp(host.slice(0, slash));
      const bits = Number(host.slice(slash + 1));
      const total = ip?.version === 6 ? 128 : 32;
      if (!ip || !Number.isInteger(bits) || bits < 0 || bits > total) {
        throw new OaxError('config_invalid', `OAX_AIRGAPPED_ALLOW: invalid CIDR "${t}"`);
      }
      const shift = BigInt(total - bits);
      out.push({
        kind: 'cidr',
        version: ip.version,
        base: (ip.value >> shift) << shift,
        bits,
        total,
        port,
      });
      continue;
    }
    if (host.startsWith('*.') || host.startsWith('.')) {
      const suffix = host.replace(/^\*?\./, '');
      if (!suffix.includes('.') && suffix.length < 2) {
        throw new OaxError('config_invalid', `OAX_AIRGAPPED_ALLOW: invalid suffix "${t}"`);
      }
      out.push({ kind: 'suffix', suffix, port });
      continue;
    }
    if (!/^[a-z0-9_.:\-[\]]+$/.test(host)) {
      throw new OaxError('config_invalid', `OAX_AIRGAPPED_ALLOW: invalid entry "${t}"`);
    }
    out.push({ kind: 'host', host: normalizeHost(host), port });
  }
  return out;
}

export function isLoopback(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const ip = parseIp(h);
  if (!ip) return false;
  return ip.version === 4 ? ip.value >> 24n === 127n : ip.value === 1n;
}

export interface EgressViolation {
  host: string;
  port: number | null;
  purpose: string;
  at: string;
}

export interface EgressStatus {
  airgapped: boolean;
  allowlist: number;
  blocked: number;
}

export interface EgressPolicyOptions {
  airgapped: boolean;
  allow?: readonly AllowEntry[];
  /** Hosts the process is configured to use anyway (database, cache): allowed without listing. */
  implicit?: readonly AllowEntry[];
  now?: () => Date;
}

export class EgressPolicy {
  readonly airgapped: boolean;
  private readonly entries: readonly AllowEntry[];
  private readonly violations: EgressViolation[] = [];
  private blockedCount = 0;
  private readonly now: () => Date;

  constructor(opts: EgressPolicyOptions) {
    this.airgapped = opts.airgapped;
    this.entries = [...(opts.allow ?? []), ...(opts.implicit ?? [])];
    this.now = opts.now ?? (() => new Date());
  }

  isAllowed(host: string, port: number | null = null): boolean {
    if (!this.airgapped) return true;
    if (isLoopback(host)) return true;
    const h = normalizeHost(host);
    const ip = parseIp(h);
    for (const e of this.entries) {
      if (e.port !== null && port !== null && e.port !== port) continue;
      if (e.kind === 'host') {
        if (e.host === h) return true;
        const eip = parseIp(e.host);
        if (ip && eip && ip.version === eip.version && ip.value === eip.value) return true;
      } else if (e.kind === 'suffix') {
        if (!ip && (h === e.suffix || h.endsWith(`.${e.suffix}`))) return true;
      } else if (ip && ip.version === e.version) {
        const shift = BigInt(e.total - e.bits);
        if ((ip.value >> shift) << shift === e.base) return true;
      }
    }
    return false;
  }

  /** Throws `egress_denied` (and records the attempt) when the target is not allowed. */
  assert(target: string | URL, purpose = 'request'): void {
    if (!this.airgapped) return;
    let url: URL;
    try {
      url = typeof target === 'string' ? new URL(target) : target;
    } catch {
      throw new OaxError(
        'egress_denied',
        `air-gapped: refusing malformed target "${String(target)}"`,
      );
    }
    const port = url.port
      ? Number(url.port)
      : ((
          {
            'https:': 443,
            'http:': 80,
            'ldaps:': 636,
            'ldap:': 389,
            'wss:': 443,
            'ws:': 80,
          } as Record<string, number>
        )[url.protocol] ?? null);
    this.assertHost(url.hostname, port, purpose);
  }

  assertHost(host: string, port: number | null, purpose = 'connect'): void {
    if (this.isAllowed(host, port)) return;
    this.record(host, port, purpose);
    throw new OaxError(
      'egress_denied',
      `air-gapped: outbound ${purpose} to ${host}${port ? `:${port}` : ''} is not on OAX_AIRGAPPED_ALLOW`,
    );
  }

  record(host: string, port: number | null, purpose: string): void {
    this.blockedCount += 1;
    if (this.violations.length < 100)
      this.violations.push({ host, port, purpose, at: this.now().toISOString() });
  }

  recorded(): readonly EgressViolation[] {
    return this.violations;
  }

  status(): EgressStatus {
    return {
      airgapped: this.airgapped,
      allowlist: this.entries.length,
      blocked: this.blockedCount,
    };
  }
}

let active: EgressPolicy = new EgressPolicy({ airgapped: false });

/** The process-wide policy consulted by every outbound client. Default: allow everything. */
export function getEgressPolicy(): EgressPolicy {
  return active;
}

export function setEgressPolicy(policy: EgressPolicy): void {
  active = policy;
}

export function resetEgressPolicy(): void {
  active = new EgressPolicy({ airgapped: false });
}
