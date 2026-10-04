import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import { EgressPolicy, isLoopback, parseAllowlist, type AllowEntry } from '@openagentix/core';

/**
 * HTTP CONNECT allowlist proxy for run nodes (ADR 0008, section 3.5). Run nodes sit on an
 * `internal` container network without a route to anything but the control node and this proxy.
 * Every node authenticates with its own ephemeral credentials and may only reach the hosts of its
 * step's `runtime.egress`. Deny by default: a node without entries (or an unknown node) reaches
 * nothing. Loopback, link-local and unspecified targets are never reachable, not even when listed,
 * so a node cannot use the proxy to reach services on the proxy host or cloud metadata endpoints.
 * When the process is air-gapped, the process-wide egress policy applies on top.
 */

export interface EgressProxyOptions {
  /** Outer policy (the process's air-gapped allowlist); checked in addition to the node's own. */
  outer?: Pick<EgressPolicy, 'isAllowed'>;
  /** Name resolution; defaults to `dns.lookup(all)`. Injectable for tests. */
  resolve?: (host: string) => Promise<string[]>;
  /** Opens the upstream connection; defaults to `net.connect`. Injectable for tests. */
  connect?: (target: { host: string; port: number }) => net.Socket;
  idleTimeoutMs?: number;
  now?: () => number;
}

interface Entry {
  digest: Buffer;
  policy: EgressPolicy;
}

export interface EgressDenial {
  nodeId: string;
  target: string;
  reason: 'unauthenticated' | 'not_allowed' | 'forbidden_address' | 'bad_target' | 'unresolvable';
  at: number;
}

const digestOf = (s: string) => createHash('sha256').update(s).digest();

/** Addresses that are never reachable through the proxy. */
export function isForbiddenAddress(address: string): boolean {
  if (isLoopback(address)) return true;
  const v = net.isIP(address);
  if (v === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  if (v === 6) {
    const h = address.toLowerCase();
    return (
      h === '::' ||
      /^fe[89ab]/.test(h) ||
      h.startsWith('ff') ||
      (/^::ffff:/.test(h) && isForbiddenAddress(h.slice(7)))
    );
  }
  return true;
}

export class EgressProxy {
  private readonly nodes = new Map<string, Entry>();
  private readonly denials: EgressDenial[] = [];
  private server: http.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly opts: EgressProxyOptions = {}) {}

  /**
   * Registers a node with its allowed hosts and returns the proxy password the node must present.
   * An empty list is valid and means "no egress at all".
   */
  register(nodeId: string, hosts: readonly string[]): { password: string } {
    const allow: AllowEntry[] = parseAllowlist(hosts.join(' '));
    const password = randomBytes(24).toString('base64url');
    this.nodes.set(nodeId, {
      digest: digestOf(password),
      policy: new EgressPolicy({ airgapped: true, allow }),
    });
    return { password };
  }

  unregister(nodeId: string): void {
    this.nodes.delete(nodeId);
  }

  get registered(): number {
    return this.nodes.size;
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

  private authenticate(header: string | undefined): string | null {
    if (!header?.startsWith('Basic ')) return null;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i <= 0) return null;
    const nodeId = decoded.slice(0, i);
    const entry = this.nodes.get(nodeId);
    // Compare against a dummy when the node is unknown so timing does not reveal registrations.
    const expected = entry?.digest ?? digestOf('unknown-node');
    const ok = timingSafeEqual(expected, digestOf(decoded.slice(i + 1)));
    return entry && ok ? nodeId : null;
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
    const nodeId = this.authenticate(req.headers['proxy-authorization']);
    if (!nodeId) {
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
    const entry = this.nodes.get(nodeId)!;
    if (!entry.policy.isAllowed(host, port) || this.opts.outer?.isAllowed(host, port) === false) {
      this.deny(nodeId, target, 'not_allowed');
      return refuse('403 Forbidden');
    }
    // Names that mean "this machine" are refused before any lookup, whatever DNS would answer.
    if (isLoopback(host)) {
      this.deny(nodeId, target, 'forbidden_address');
      return refuse('403 Forbidden');
    }
    let addresses: string[];
    try {
      addresses = await this.resolve(host);
    } catch {
      this.deny(nodeId, target, 'unresolvable');
      return refuse('502 Bad Gateway');
    }
    // Every resolved address must be acceptable (no DNS answer mixing a public and a local one).
    if (addresses.length === 0 || addresses.some(isForbiddenAddress)) {
      this.deny(nodeId, target, 'forbidden_address');
      return refuse('403 Forbidden');
    }
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
    const close = () => {
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
    server.on('connect', (req, socket: net.Socket, head) => {
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
    this.nodes.clear();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
}
