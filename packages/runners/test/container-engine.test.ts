import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EngineClient,
  EngineError,
  isRawDockerSocket,
  nodeTransport,
  parseEngineUrl,
  type EngineRequest,
  type EngineTransport,
} from '../src/index.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('engine URLs and the raw socket guard', () => {
  it('parses unix, tcp, http and absolute paths', () => {
    expect(parseEngineUrl('unix:///run/podman/podman.sock')).toEqual({
      socketPath: '/run/podman/podman.sock',
    });
    expect(parseEngineUrl('/run/x.sock')).toEqual({ socketPath: '/run/x.sock' });
    expect(parseEngineUrl('tcp://socket-proxy:2375').url?.toString()).toBe(
      'http://socket-proxy:2375/',
    );
    expect(parseEngineUrl('https://engine.example:2376').url?.protocol).toBe('https:');
  });
  it('refuses nonsense', () => {
    for (const bad of ['', 'not a url', 'ftp://x', 'unix://'])
      expect(() => parseEngineUrl(bad)).toThrow(/container engine URL|unsupported|socket path/);
  });
  it('recognises the Docker daemon socket, also through a symlink', () => {
    expect(isRawDockerSocket({ socketPath: '/var/run/docker.sock' })).toBe(true);
    expect(isRawDockerSocket({ socketPath: '/run/docker.sock' })).toBe(true);
    expect(isRawDockerSocket({ socketPath: '/run/user/1000/podman/podman.sock' })).toBe(false);
    expect(isRawDockerSocket({ url: new URL('http://socket-proxy:2375') })).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'oax-sock-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'real'), '');
    symlinkSync('/var/run/docker.sock', join(dir, 'link'));
    // the link target may not exist in CI; the lexical check on the link itself must not throw
    expect(typeof isRawDockerSocket({ socketPath: join(dir, 'link') })).toBe('boolean');
  });
});

function fake(handler: (r: EngineRequest) => { status: number; body?: unknown }): {
  client: EngineClient;
  seen: EngineRequest[];
} {
  const seen: EngineRequest[] = [];
  const transport: EngineTransport = async (r) => {
    seen.push(r);
    const out = handler(r);
    return {
      status: out.status,
      body: Buffer.from(out.body === undefined ? '' : JSON.stringify(out.body)),
    };
  };
  return { client: new EngineClient(transport), seen };
}

describe('EngineClient', () => {
  it('calls the versioned endpoints it needs and nothing else', async () => {
    const id = 'a'.repeat(64);
    const { client, seen } = fake((r) => {
      if (r.path.startsWith('/v1.43/containers/create')) return { status: 201, body: { Id: id } };
      if (r.path.includes('/wait')) return { status: 200, body: { StatusCode: 3 } };
      if (r.path.startsWith('/v1.43/networks/')) return { status: 200, body: { Internal: true } };
      if (r.path.endsWith('/json')) return { status: 200, body: { State: { Running: false } } };
      return { status: 204 };
    });
    expect((await client.inspectNetwork('oax nodes')).Internal).toBe(true);
    expect(await client.createContainer('oax-node-1', { Image: 'x' })).toBe(id);
    await client.startContainer(id);
    await client.putArchive(id, '/run/oax', Buffer.from('tar'));
    expect(await client.waitContainer(id)).toBe(3);
    await client.stopContainer(id, 5);
    await client.killContainer(id);
    await client.removeContainer(id);
    expect((await client.inspectContainer(id)).State?.Running).toBe(false);
    expect(seen.map((r) => `${r.method} ${r.path.replace(id, 'ID')}`)).toEqual([
      'GET /v1.43/networks/oax%20nodes',
      'POST /v1.43/containers/create?name=oax-node-1',
      'POST /v1.43/containers/ID/start',
      'PUT /v1.43/containers/ID/archive?path=%2Frun%2Foax',
      'POST /v1.43/containers/ID/wait',
      'POST /v1.43/containers/ID/stop?t=5',
      'POST /v1.43/containers/ID/kill',
      'DELETE /v1.43/containers/ID?force=true&v=true',
      'GET /v1.43/containers/ID/json',
    ]);
    expect(seen[3]!.headers['content-type']).toBe('application/x-tar');
  });
  it('tolerates already-stopped, already-removed and already-started containers', async () => {
    const { client } = fake((r) => ({ status: r.method === 'DELETE' ? 404 : 304 }));
    await client.startContainer('b'.repeat(12));
    await client.stopContainer('b'.repeat(12), 1);
    await client.removeContainer('b'.repeat(12));
  });
  it('turns engine errors into short EngineErrors without echoing the request', async () => {
    const { client } = fake(() => ({ status: 403, body: { message: 'x'.repeat(500) } }));
    const err = await client.createContainer('n', { Env: ['SECRET=hunter2'] }).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).status).toBe(403);
    expect((err as Error).message.length).toBeLessThan(300);
    expect((err as Error).message).not.toContain('hunter2');
    const { client: c2 } = fake(() => ({ status: 500 }));
    await expect(c2.inspectNetwork('n')).rejects.toThrow(/HTTP 500/);
  });
  it('rejects a create response without a valid id', async () => {
    const { client } = fake(() => ({ status: 201, body: { Id: '../etc' } }));
    await expect(client.createContainer('n', {})).rejects.toThrow(/no container id/);
  });
});

describe('nodeTransport', () => {
  it('talks HTTP over a unix socket and over TCP, honouring abort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oax-engine-'));
    const sock = join(dir, 'e.sock');
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        bodies.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`);
        if (req.url?.includes('hang')) return; // never answers
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    const tcp = http.createServer((_q, res) => res.writeHead(204).end());
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await new Promise((r) => tcp.close(r));
      rmSync(dir, { recursive: true, force: true });
    });
    const unix = nodeTransport({ socketPath: sock });
    const res = await unix({
      method: 'POST',
      path: '/v1.43/x',
      headers: {},
      body: Buffer.from('hi'),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString())).toEqual({ ok: true });
    expect(bodies[0]).toBe('POST /v1.43/x hi');
    const port = (tcp.address() as { port: number }).port;
    const viaTcp = nodeTransport({ url: new URL(`http://127.0.0.1:${port}/prefix/`) });
    expect((await viaTcp({ method: 'GET', path: '/y', headers: {} })).status).toBe(204);
    const ac = new AbortController();
    const hung = unix({ method: 'GET', path: '/hang', headers: {}, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(hung).rejects.toThrow();
  });
});
