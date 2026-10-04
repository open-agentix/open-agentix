import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import { OaxError } from '@openagentix/core';
import { cidrContains, parseCidr, type Cidr } from './cidr.js';
import {
  assertWithinCeiling,
  classifyAddress,
  normalizeAddress,
  parseEgressEntry,
  ruleAllows,
  type EgressRule,
} from './egress-rules.js';

/**
 * HTTP CONNECT allowlist proxy for run nodes (ADR 0008, section 3.5). It runs as its OWN service,
 * attached to the internal node network and to an egress network and to nothing else (never to the
 * engine socket network or the platform's network), so a compromised proxy or a lenient rule cannot
 * reach the control plane's neighbours.
 *
 * It is stateless: the node's proxy password is a signed grant minted by the container runner
 * (`mintEgressGrant`) that carries the node id, the step's egress entries and an expiry. The proxy
 * verifies the signature and applies, per connection:
 *   1. the operator ceiling (`OAX_CONTAINER_EGRESS_ALLOW`): grant entries outside it are refused,
 *   2. the grant's own rules for the target name or address and port,
 *   3. the resolved ADDRESS: loopback, link-local, metadata, private (RFC 1918, CGNAT, ULA, NAT64,
 *      benchmarking, multicast) destinations are refused unless an operator opened that range
 *      (`OAX_CONTAINER_EGRESS_PRIVATE_ALLOW`); metadata and loopback can never be opened,
 *   4. the process-wide air-gapped policy, when active.
 * Deny by default: no ceiling, no grant entries or no match means no connection.
 */
export interface EgressProxyOptions {
  /** HMAC key shared with the runner (at least 32 characters). */
  secret: string;
  /** Operator upper bound for step egress; empty means no step gets any egress. */
  ceiling?: readonly string[];
  /** Private ranges an operator allows steps to reach (still only where a rule matches). */
  privateAllow?: readonly string[];
  /** Process-wide air-gapped policy, checked in addition. */
  outer?: { isAllowed(host: string, port: number | null): boolean };
  resolve?: (host: string) => Promise<string[]>;
  connect?: (target: { host: string; port: number }) => net.Socket;
  idleTimeoutMs?: number;
  /** Time a client has to send its CONNECT request line and headers. */
  headersTimeoutMs?: number;
  maxConnections?: number;
  maxTunnelsPerNode?: number;
  now?: () => number;
}

export interface EgressDenial {
  nodeId: string;
  target: string;
  reason:
    | 'unauthenticated'
    | 'not_allowed'
    | 'forbidden_address'
    | 'private_address'
    | 'bad_target'
    | 'unresolvable'
    | 'too_many_tunnels'
    | 'outside_ceiling';
  at: number;
}

interface GrantClaims {
  /** node id */
  n: string;
  /** egress entries */
  e: string[];
  /** expiry, unix seconds */
  x: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const mac = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(`oax-egress.${payload}`).digest();

/** Mints the node's proxy password: `<claims>.<hmac>`; usable as the password of Basic auth. */
export function mintEgressGrant(
  secret: string,
  grant: { nodeId: string; egress: readonly string[]; ttlSeconds: number },
  now: number = Date.now(),
): string {
  if (secret.length < 32)
    throw new OaxError('config_invalid', 'the egress grant secret needs at least 32 characters');
  const claims: GrantClaims = {
    n: grant.nodeId,
    e: [...grant.egress],
    x: Math.floor(now / 1000) + grant.ttlSeconds,
  };
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${b64(mac(secret, payload))}`;
}

export function verifyEgressGrant(
  secret: string,
  nodeId: string,
  password: string,
  now: number = Date.now(),
): GrantClaims | null {
  const [payload = '', sig = '', extra] = password.split('.');
  if (extra !== undefined || !payload || !sig) return null;
  const expected = mac(secret, payload);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GrantClaims;
    if (
      c.n !== nodeId ||
      typeof c.x !== 'number' ||
      c.x * 1000 <= now ||
      !Array.isArray(c.e) ||
      !c.e.every((x) => typeof x === 'string')
    )
      return null;
    return c;
  } catch {
    return null;
  }
}

/** Addresses of a resolved name that count as "inside" one of the allowed private ranges. */
function privateAllowed(address: string, allowed: readonly Cidr[]): boolean {
  const c = normalizeAddress(address);
  return !!c && allowed.some((a) => cidrContains(a, c));
}

export class EgressProxy {
  private readonly denials: EgressDenial[] = [];
  private server: http.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly tunnels = new Map<string, number>();
  private readonly ceiling: EgressRule[];
  private readonly privateRanges: Cidr[];

  constructor(private readonly opts: EgressProxyOptions) {
    if (opts.secret.length < 32)
      throw new OaxError('config_invalid', 'the egress grant secret needs at least 32 characters');
    this.ceiling = (opts.ceiling ?? []).map(parseEgressEntry);
    this.privateRanges = (opts.privateAllow ?? []).map((c) => {
      const p = parseCidr(c);
      if (!p) throw new OaxError('config_invalid', `invalid private egress range "${c}"`);
      return p;
    });
  }

  /** Recent refused attempts (bounded); names only, never credentials. */
  recentDenials(): readonly EgressDenial[] {
    return this.denials;
  }

  private deny(nodeId: string, target: string, reason: EgressDenial['reason']): void {
    if (this.denials.length >= 100) this.denials.shift();
    this.denials.push({
      nodeId,
      target: target.slice(0, 200),
      reason,
      at: (this.opts.now ?? Date.now)(),
    });
  }

  private async resolve(host: string): Promise<string[]> {
    if (net.isIP(host)) return [host];
    if (this.opts.resolve) return this.opts.resolve(host);
    return (await lookup(host, { all: true })).map((r) => r.address);
  }

  private async onConnect(
    req: http.IncomingMessage,
    client: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const refuse = (status: string) => {
      client.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    };
    const target = req.url ?? '';
    const auth = req.headers['proxy-authorization'];
    let nodeId = '';
    let claims: GrantClaims | null = null;
    if (auth?.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) {
        nodeId = decoded.slice(0, i);
        claims = verifyEgressGrant(
          this.opts.secret,
          nodeId,
          decoded.slice(i + 1),
          this.opts.now?.(),
        );
      }
    }
    if (!claims) {
      this.deny('?', target, 'unauthenticated');
      return refuse('407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="oax"');
    }
    const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/.exec(target);
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535) {
      this.deny(nodeId, target, 'bad_target');
      return refuse('400 Bad Request');
    }
    const host = m[1]!.replace(/^\[|\]$/g, '').toLowerCase();
    let rules: EgressRule[];
    try {
      // The ceiling is applied again here: a grant minted with a wider list than this proxy's
      // operator allows (or by a compromised runner) is still bounded.
      rules = assertWithinCeiling(claims.e, this.ceiling);
    } catch {
      this.deny(nodeId, target, 'outside_ceiling');
      return refuse('403 Forbidden');
    }
    const literal = net.isIP(host) ? normalizeAddress(host) : undefined;
    if (
      !rules.some((r) => ruleAllows(r, host, literal, port)) ||
      this.opts.outer?.isAllowed(host, port) === false
    ) {
      this.deny(nodeId, target, 'not_allowed');
      return refuse('403 Forbidden');
    }
    let addresses: string[];
    try {
      addresses = await this.resolve(host);
    } catch {
      this.deny(nodeId, target, 'unresolvable');
      return refuse('502 Bad Gateway');
    }
    if (host === 'localhost' || host.endsWith('.localhost')) {
      this.deny(nodeId, target, 'forbidden_address');
      return refuse('403 Forbidden');
    }
    // Every address the name resolves to must be acceptable (no mixing a public and a local one).
    const verdicts = addresses.map((a) => ({ a, v: classifyAddress(a) }));
    if (addresses.length === 0 || verdicts.some((x) => x.v === 'denied')) {
      this.deny(nodeId, target, 'forbidden_address');
      return refuse('403 Forbidden');
    }
    if (verdicts.some((x) => x.v === 'private' && !privateAllowed(x.a, this.privateRanges))) {
      this.deny(nodeId, target, 'private_address');
      return refuse('403 Forbidden');
    }
    const open = this.tunnels.get(nodeId) ?? 0;
    if (open >= (this.opts.maxTunnelsPerNode ?? 8)) {
      this.deny(nodeId, target, 'too_many_tunnels');
      return refuse('429 Too Many Requests');
    }
    this.tunnels.set(nodeId, open + 1);
    const upstream = (this.opts.connect ?? net.connect)({ host: addresses[0]!, port });
    this.sockets.add(upstream);
    const idle = this.opts.idleTimeoutMs ?? 300_000;
    for (const s of [client, upstream]) s.setTimeout(idle, () => s.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.tunnels.set(nodeId, Math.max(0, (this.tunnels.get(nodeId) ?? 1) - 1));
      if (this.tunnels.get(nodeId) === 0) this.tunnels.delete(nodeId);
      this.sockets.delete(upstream);
      upstream.destroy();
      client.destroy();
    };
    upstream.once('error', () => {
      if (!client.destroyed && !client.writableEnded) refuse('502 Bad Gateway');
      close();
    });
    upstream.once('close', close);
    client.once('error', close);
    client.once('close', close);
  }

  async listen(port: number, host: string): Promise<net.AddressInfo> {
    if (this.server) throw new Error('egress proxy is already listening');
    const server = http.createServer((_req, res) => {
      // Only CONNECT is supported: no plain HTTP forwarding, no request smuggling surface.
      res.writeHead(405, { allow: 'CONNECT', 'content-length': '0' }).end();
    });
    server.maxConnections = this.opts.maxConnections ?? 512;
    server.headersTimeout = this.opts.headersTimeoutMs ?? 10_000;
    server.requestTimeout = this.opts.headersTimeoutMs ?? 10_000;
    server.maxHeadersCount = 32;
    // A client that connects and then stays silent is dropped after the header timeout (the HTTP
    // parser's own check only runs every 30 s).
    const timers = new WeakMap<net.Socket, NodeJS.Timeout>();
    server.on('connection', (socket: net.Socket) => {
      const timer = setTimeout(() => socket.destroy(), this.opts.headersTimeoutMs ?? 10_000);
      timer.unref();
      timers.set(socket, timer);
      socket.once('close', () => clearTimeout(timer));
    });
    server.on('connect', (req, socket: net.Socket, head) => {
      clearTimeout(timers.get(socket));
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      void this.onConnect(req, socket, head).catch(() => socket.destroy());
    });
    server.on('clientError', (_e, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    this.server = server;
    return server.address() as net.AddressInfo;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.tunnels.clear();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
}
