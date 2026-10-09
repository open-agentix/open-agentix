import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRelay } from '../../src/git/index.js';
import { lookup, makeDispatcher, makeTls, type Tls } from './fixtures.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir: string;
let cert: Tls;
let upstream: tls.Server;
let upstreamPort: number;
const received: Buffer[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'oax-relay-'));
  cert = makeTls(dir);
  upstream = tls.createServer({ key: cert.key, cert: cert.cert }, (s) => {
    s.on('data', (d) => {
      received.push(d);
      s.write(d.toString().includes('FLOOD') ? 'y'.repeat(50_000) : `echo:${d}`);
    });
    s.on('error', () => 0);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});

afterAll(() => {
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
});

const limits = { maxReceiveBytes: 10_000, maxSendBytes: 10_000, idleMs: 2000, maxTunnels: 2 };
const ctx = { purpose: 'git' as const, pin: { allow: ['127.0.0.1'], lookup } };

const rawRequest = (port: number, head: string) =>
  new Promise<string>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(head));
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
  });

describe('relay', () => {
  it('tunnels exactly the configured target and counts bytes', async () => {
    const relay = await startRelay({
      dispatcher: makeDispatcher(cert.cert),
      target: { host: 'localhost', port: upstreamPort },
      ctx,
      limits,
    });
    try {
      const sock = net.connect(relay.port, '127.0.0.1');
      await new Promise<void>((r) => sock.once('connect', r));
      sock.write(
        `CONNECT localhost:${upstreamPort} HTTP/1.1\r\nHost: localhost:${upstreamPort}\r\n\r\n`,
      );
      const first = await new Promise<string>((r) => sock.once('data', (d) => r(String(d))));
      expect(first).toMatch(/^HTTP\/1\.1 200/);
      const secure = tls.connect({ socket: sock, servername: 'localhost', ca: cert.cert });
      secure.write('hello');
      const echoed = await new Promise<string>((r) => secure.once('data', (d) => r(String(d))));
      expect(echoed).toBe('echo:hello');
      secure.destroy();
      expect(relay.stats.tunnels).toBe(1);
      expect(relay.stats.received).toBeGreaterThan(0);
      expect(relay.stats.sent).toBeGreaterThan(0);
    } finally {
      await relay.close();
    }
  });

  it('refuses other targets, other methods and oversized heads', async () => {
    const relay = await startRelay({
      dispatcher: makeDispatcher(cert.cert),
      target: { host: 'localhost', port: upstreamPort },
      ctx,
      limits,
    });
    try {
      expect(await rawRequest(relay.port, 'CONNECT evil.example.org:443 HTTP/1.1\r\n\r\n')).toMatch(
        /^HTTP\/1\.1 403/,
      );
      expect(
        await rawRequest(relay.port, `CONNECT localhost:${upstreamPort + 1} HTTP/1.1\r\n\r\n`),
      ).toMatch(/^HTTP\/1\.1 403/);
      expect(await rawRequest(relay.port, 'GET http://localhost/ HTTP/1.1\r\n\r\n')).toMatch(
        /^HTTP\/1\.1 403/,
      );
      expect(await rawRequest(relay.port, `${'X'.repeat(9000)}`)).toMatch(/^HTTP\/1\.1 431/);
      expect(relay.stats.refused).toBe(4);
      expect(relay.stats.tunnels).toBe(0);
    } finally {
      await relay.close();
    }
  });

  it('cuts the connection at the receive limit', async () => {
    const relay = await startRelay({
      dispatcher: makeDispatcher(cert.cert),
      target: { host: 'localhost', port: upstreamPort },
      ctx,
      limits,
    });
    try {
      const sock = net.connect(relay.port, '127.0.0.1');
      await new Promise<void>((r) => sock.once('connect', r));
      sock.write(`CONNECT localhost:${upstreamPort} HTTP/1.1\r\n\r\n`);
      await new Promise<string>((r) => sock.once('data', (d) => r(String(d))));
      const secure = tls.connect({ socket: sock, servername: 'localhost', ca: cert.cert });
      secure.on('error', () => 0);
      secure.write('FLOOD');
      await new Promise<void>((r) => secure.once('close', () => r()));
      expect(relay.stats.limitExceeded).toBe(true);
    } finally {
      await relay.close();
    }
  });

  it('answers 403 when the resolver denies the destination', async () => {
    const relay = await startRelay({
      dispatcher: makeDispatcher(cert.cert),
      target: { host: 'localhost', port: upstreamPort },
      ctx: { purpose: 'git', pin: { lookup } }, // loopback not listed: egress_denied
      limits,
    });
    try {
      expect(
        await rawRequest(relay.port, `CONNECT localhost:${upstreamPort} HTTP/1.1\r\n\r\n`),
      ).toMatch(/^HTTP\/1\.1 403/);
      expect(relay.stats.dialErrors).toEqual(['egress_denied']);
    } finally {
      await relay.close();
    }
  });
});
