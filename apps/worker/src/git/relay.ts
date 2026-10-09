import { createServer, type Server, type Socket } from 'node:net';
import type { OutboundContext, OutboundDispatcher } from '@openagentix/providers';

/**
 * Local relay for the `git` child (ADR 0010 Amendment 1 A1.5). Git never resolves names or opens
 * sockets to the outside: it is told `http.proxy=http://127.0.0.1:<port>` and sends one `CONNECT
 * host:port`. The relay accepts exactly the configured target and nothing else, asks the
 * outbound dispatcher to dial it (ADR 0011 resolver: route decision, air-gapped allowlist, DNS
 * pinning, operator proxy with its credentials, which never reach Git) and then copies bytes. TLS
 * stays end to end between Git and the host. The relay counts bytes and cuts the connection at
 * the limits.
 */
export interface RelayLimits {
  /** Bytes accepted from the upstream in total (the transfer limit). */
  maxReceiveBytes: number;
  /** Bytes sent to the upstream in total (push size). */
  maxSendBytes: number;
  /** Idle time without data in either direction (ms). */
  idleMs: number;
  /** Open tunnels at the same time. */
  maxTunnels: number;
}

export interface RelayStats {
  received: number;
  sent: number;
  tunnels: number;
  /** Requests for another target, another method or malformed requests. */
  refused: number;
  /** Dial failures, with the (credential-free) error code. */
  dialErrors: string[];
  limitExceeded: boolean;
}

export interface Relay {
  readonly port: number;
  readonly stats: RelayStats;
  /** Remaining time the relay stays useful: closes the listener and all tunnels. */
  close(): Promise<void>;
}

export interface RelayOptions {
  dispatcher: OutboundDispatcher;
  target: { host: string; port: number };
  ctx: OutboundContext;
  limits: RelayLimits;
}

export function startRelay(opts: RelayOptions): Promise<Relay> {
  const { dispatcher, target, ctx, limits } = opts;
  const authority = `${target.host}:${target.port}`.toLowerCase();
  const stats: RelayStats = {
    received: 0,
    sent: 0,
    tunnels: 0,
    refused: 0,
    dialErrors: [],
    limitExceeded: false,
  };
  const sockets = new Set<Socket>();
  let open = 0;

  const server: Server = createServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    client.setTimeout(limits.idleMs, () => client.destroy());
    const refuse = (status: string) => {
      stats.refused++;
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    let buf = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 8192) {
          client.off('data', onHead);
          refuse('431 Request Header Fields Too Large');
        }
        return;
      }
      client.off('data', onHead);
      client.pause();
      const first = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
      const rest = buf.subarray(end + 4);
      const m = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(first);
      if (!m || m[1]!.toLowerCase() !== authority) return refuse('403 Forbidden');
      if (open >= limits.maxTunnels) return refuse('503 Service Unavailable');
      open++;
      stats.tunnels++;
      dispatcher
        .dial(target, ctx)
        .then(
          (up) => {
            sockets.add(up);
            up.once('close', () => {
              sockets.delete(up);
              open--;
              client.destroy();
            });
            up.on('error', () => up.destroy());
            up.setTimeout(limits.idleMs, () => up.destroy());
            client.once('close', () => up.destroy());
            const cut = () => {
              stats.limitExceeded = true;
              up.destroy();
              client.destroy();
            };
            up.on('data', (d: Buffer) => {
              stats.received += d.length;
              if (stats.received > limits.maxReceiveBytes) cut();
            });
            client.on('data', (d: Buffer) => {
              stats.sent += d.length;
              if (stats.sent > limits.maxSendBytes) cut();
            });
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (rest.length > 0) {
              stats.sent += rest.length;
              up.write(rest);
            }
            client.pipe(up);
            up.pipe(client);
            client.resume();
          },
          (e: unknown) => {
            open--;
            const code = (e as { code?: unknown })?.code;
            stats.dialErrors.push(typeof code === 'string' ? code : 'connect_failed');
            refuse(code === 'egress_denied' ? '403 Forbidden' : '502 Bad Gateway');
          },
        )
        .catch(() => client.destroy());
    };
    client.on('data', onHead);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('relay has no port'));
      resolve({
        port: addr.port,
        stats,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
