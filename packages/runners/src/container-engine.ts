import { realpathSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { OaxError } from '@openagentix/core';
import { HijackError, nodeHijack, type EngineHijack } from './container-hijack.js';

/**
 * Minimal client for the Docker Engine API (also served by Podman's compatible socket). The
 * runner only ever uses the calls below, so a socket proxy can allowlist exactly those
 * (containers: create/start/wait/stop/kill/remove/inspect/archive, networks: inspect) and deny
 * exec, build, volumes, images and everything else.
 */

export interface EngineEndpoint {
  /** Unix socket path (`unix:///run/podman/podman.sock`). */
  socketPath?: string;
  /** TCP endpoint (a socket proxy, `http://socket-proxy:2375`). */
  url?: URL;
}

export function parseEngineUrl(raw: string): EngineEndpoint {
  if (raw.startsWith('/')) return { socketPath: raw };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OaxError('config_invalid', `invalid container engine URL "${raw}"`);
  }
  if (url.protocol === 'unix:') {
    if (!url.pathname || url.pathname === '/')
      throw new OaxError('config_invalid', 'container engine URL has no socket path');
    return { socketPath: decodeURIComponent(url.pathname) };
  }
  if (url.protocol === 'tcp:') return { url: new URL(`http://${url.host}`) };
  if (url.protocol === 'http:' || url.protocol === 'https:') return { url };
  throw new OaxError('config_invalid', `unsupported container engine URL scheme "${url.protocol}"`);
}

const RAW_DOCKER_SOCKETS = new Set(['/var/run/docker.sock', '/run/docker.sock']);

/**
 * `true` for the Docker daemon's own socket. Handing it to a worker is equivalent to giving it root
 * on the host, so it is refused unless explicitly allowed (ADR 0008, section 3.5).
 */
export function isRawDockerSocket(endpoint: EngineEndpoint): boolean {
  const p = endpoint.socketPath;
  if (!p) return false;
  if (RAW_DOCKER_SOCKETS.has(p)) return true;
  try {
    return RAW_DOCKER_SOCKETS.has(realpathSync(p));
  } catch {
    return false;
  }
}

export interface EngineRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
  signal?: AbortSignal;
}
export interface EngineResponse {
  status: number;
  body: Buffer;
}
export type EngineTransport = (req: EngineRequest) => Promise<EngineResponse>;

/** Default transport: node's http(s) client over the unix socket or TCP endpoint. */
export function nodeTransport(endpoint: EngineEndpoint): EngineTransport {
  return (req) =>
    new Promise<EngineResponse>((resolve, reject) => {
      const lib = endpoint.url?.protocol === 'https:' ? https : http;
      const base = endpoint.socketPath
        ? { socketPath: endpoint.socketPath }
        : {
            hostname: endpoint.url!.hostname,
            port: endpoint.url!.port || (endpoint.url!.protocol === 'https:' ? 443 : 80),
          };
      const prefix = endpoint.url ? endpoint.url.pathname.replace(/\/$/, '') : '';
      const r = lib.request(
        {
          ...base,
          method: req.method,
          path: `${prefix}${req.path}`,
          headers: {
            ...req.headers,
            host: 'engine',
            ...(req.body ? { 'content-length': String(req.body.length) } : {}),
          },
          ...(req.signal ? { signal: req.signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          res.on('error', reject);
        },
      );
      r.on('error', reject);
      r.end(req.body);
    });
}

const API_VERSION = 'v1.43';

export interface EngineNetwork {
  Name?: string;
  Internal?: boolean;
}

export interface EngineContainerState {
  Status?: string;
  Running?: boolean;
  ExitCode?: number;
}

function engineMessage(body: Buffer): string {
  try {
    return String((JSON.parse(body.toString('utf8')) as { message?: unknown }).message ?? '');
  } catch {
    return '';
  }
}

export class EngineError extends OaxError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super('container_engine_error', message, { status });
  }
}

export interface StdinHandle {
  /** Writes the payload and closes stdin (EOF for the container process). */
  send(data: Buffer): Promise<void>;
  abort(): void;
}

export { nodeHijack };

export class EngineClient {
  constructor(
    private readonly transport: EngineTransport,
    private readonly hijack?: EngineHijack,
  ) {}

  private async call(
    method: EngineRequest['method'],
    path: string,
    opts: { body?: unknown; raw?: Buffer; type?: string; signal?: AbortSignal; ok?: number[] } = {},
  ): Promise<EngineResponse> {
    const json = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;
    const body = opts.raw ?? json;
    const res = await this.transport({
      method,
      path: `/${API_VERSION}${path}`,
      headers: {
        ...(body ? { 'content-type': opts.type ?? 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res.status >= 200 && res.status < 300) return res;
    if (opts.ok?.includes(res.status)) return res;
    // The engine's message can quote request details; keep it short and never echo bodies we sent.
    const msg = engineMessage(res.body);
    throw new EngineError(
      res.status,
      `container engine returned HTTP ${res.status} for ${method} ${path.split('?')[0]}${msg ? `: ${msg.slice(0, 200)}` : ''}`,
    );
  }

  async inspectNetwork(name: string): Promise<EngineNetwork> {
    const r = await this.call('GET', `/networks/${encodeURIComponent(name)}`);
    return JSON.parse(r.body.toString('utf8')) as EngineNetwork;
  }

  async createContainer(name: string, body: unknown): Promise<string> {
    const r = await this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, {
      body,
    });
    const id = (JSON.parse(r.body.toString('utf8')) as { Id?: unknown }).Id;
    if (typeof id !== 'string' || !/^[a-f0-9]{12,64}$/.test(id))
      throw new EngineError(502, 'container engine returned no container id');
    return id;
  }

  async startContainer(id: string): Promise<void> {
    await this.call('POST', `/containers/${id}/start`, { ok: [304] });
  }

  /**
   * Attaches to the container's stdin (before it starts). The returned handle writes the payload
   * once and half-closes the stream, which the container sees as EOF on its stdin.
   */
  async attachStdin(id: string, signal?: AbortSignal): Promise<StdinHandle> {
    if (!this.hijack) throw new EngineError(0, 'this engine client cannot attach to containers');
    let sock;
    try {
      sock = await this.hijack({
        path: `/${API_VERSION}/containers/${id}/attach?stream=1&stdin=1`,
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (e instanceof HijackError) throw new EngineError(e.status, e.message);
      throw e;
    }
    sock.on('error', () => undefined); // a dead container surfaces through wait(), not here
    return {
      send: (data: Buffer) =>
        new Promise<void>((resolve, reject) => {
          sock.once('error', reject);
          sock.end(data, () => resolve());
        }),
      abort: () => sock.destroy(),
    };
  }

  async waitContainer(id: string, signal?: AbortSignal): Promise<number> {
    const r = await this.call('POST', `/containers/${id}/wait`, signal ? { signal } : {});
    return Number((JSON.parse(r.body.toString('utf8')) as { StatusCode?: unknown }).StatusCode);
  }

  async stopContainer(id: string, graceSeconds: number): Promise<void> {
    await this.call('POST', `/containers/${id}/stop?t=${graceSeconds}`, { ok: [304, 404] });
  }

  async killContainer(id: string): Promise<void> {
    await this.call('POST', `/containers/${id}/kill`, { ok: [404, 409] });
  }

  async removeContainer(id: string): Promise<void> {
    await this.call('DELETE', `/containers/${id}?force=true&v=true`, { ok: [404] });
  }

  /** Containers (running or not) that carry the label. */
  async listContainers(label: string): Promise<{ Id: string; Labels?: Record<string, string> }[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    const r = await this.call('GET', `/containers/json?all=1&filters=${filters}`);
    return JSON.parse(r.body.toString('utf8')) as { Id: string; Labels?: Record<string, string> }[];
  }

  async inspectContainer(id: string): Promise<{ State?: EngineContainerState }> {
    const r = await this.call('GET', `/containers/${id}/json`);
    return JSON.parse(r.body.toString('utf8')) as { State?: EngineContainerState };
  }
}
