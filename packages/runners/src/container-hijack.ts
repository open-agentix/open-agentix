import * as http from 'node:http';
import * as https from 'node:https';
import type { Duplex } from 'node:stream';

/**
 * Connection hijacking for the engine's `attach` endpoint: after the request the HTTP connection
 * turns into a raw duplex stream (the container's stdin). It uses nothing but node builtins so that
 * it can be exercised on its own against a real engine.
 *
 * Why stdin: the engine refuses to copy files into a container with a read-only root filesystem
 * (`docker cp` fails with "container rootfs is marked read-only", also for tmpfs mounts), and
 * environment variables, command lines and create options are all readable through `inspect`.
 * Stdin is none of those, so the run token travels there.
 */
export interface HijackEndpoint {
  socketPath?: string;
  url?: URL;
}

export interface HijackRequest {
  path: string;
  signal?: AbortSignal;
}

export type EngineHijack = (req: HijackRequest) => Promise<Duplex>;

export class HijackError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function nodeHijack(endpoint: HijackEndpoint): EngineHijack {
  return (req) =>
    new Promise<Duplex>((resolve, reject) => {
      const lib = endpoint.url?.protocol === 'https:' ? https : http;
      const target = endpoint.socketPath
        ? { socketPath: endpoint.socketPath }
        : {
            hostname: endpoint.url!.hostname,
            port: endpoint.url!.port || (endpoint.url!.protocol === 'https:' ? 443 : 80),
          };
      const prefix = endpoint.url ? endpoint.url.pathname.replace(/\/$/, '') : '';
      const r = lib.request({
        ...target,
        method: 'POST',
        path: `${prefix}${req.path}`,
        headers: { host: 'engine', connection: 'Upgrade', upgrade: 'tcp' },
        ...(req.signal ? { signal: req.signal } : {}),
      });
      // Docker answers `101 UPGRADED`; Podman's compatible API may answer `200` with a raw stream.
      r.once('upgrade', (_res, socket) => resolve(socket));
      r.once('response', (res) => {
        if (res.statusCode === 200 && res.socket) return resolve(res.socket);
        res.resume();
        reject(
          new HijackError(res.statusCode ?? 0, `engine refused attach (HTTP ${res.statusCode})`),
        );
      });
      r.once('error', reject);
      r.end();
    });
}
