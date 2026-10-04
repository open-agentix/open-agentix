import dgram from 'node:dgram';
import dns from 'node:dns';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import {
  EgressPolicy,
  parseAllowlist,
  resetEgressPolicy,
  setEgressPolicy,
} from '@openagentix/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGuardedFetch,
  createProxyAwareFetch,
  installNetworkGuard,
  type NetworkGuard,
} from '../src/index.js';

let guard: NetworkGuard;
let policy: EgressPolicy;
let server: Server;
let port: number;

beforeEach(async () => {
  policy = new EgressPolicy({ airgapped: true, allow: parseAllowlist('ollama.internal') });
  setEgressPolicy(policy);
  guard = installNetworkGuard(policy);
  server = createServer((_req, res) => res.end('hello')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = (server.address() as net.AddressInfo).port;
});

afterEach(async () => {
  guard.uninstall();
  resetEgressPolicy();
  await new Promise((r) => server.close(r));
});

describe('network guard (no outbound traffic can leave)', () => {
  it('still allows loopback traffic', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('hello');
    expect(policy.status().blocked).toBe(0);
  });

  it('blocks TCP connects to non-allowlisted IPs and hosts without any DNS or packet', async () => {
    const err = await new Promise<Error>((resolve) => {
      const s = net.connect({ host: '203.0.113.7', port: 443 });
      s.once('error', resolve);
    });
    expect(err).toMatchObject({ code: 'egress_denied' });
    const err2 = await new Promise<Error>((resolve) => {
      net.connect(443, 'example.com').once('error', resolve);
    });
    expect(err2).toMatchObject({ code: 'egress_denied' });
    expect(policy.recorded().map((v) => v.host)).toEqual(['203.0.113.7', 'example.com']);
  });

  it('blocks fetch (global fetch/undici) to the internet', async () => {
    await expect(fetch('https://api.openai.com/v1/models')).rejects.toThrow();
    expect(policy.recorded().some((v) => v.host === 'api.openai.com')).toBe(true);
  });

  it('blocks DNS lookups (callback and promise form) for non-allowlisted names', async () => {
    await expect(dns.promises.lookup('example.com')).rejects.toMatchObject({
      code: 'egress_denied',
    });
    await new Promise<void>((resolve) =>
      dns.lookup('example.org', (e) => {
        expect(e).toMatchObject({ code: 'egress_denied' });
        resolve();
      }),
    );
    // loopback names resolve normally
    expect((await dns.promises.lookup('localhost')).address).toMatch(/127\.0\.0\.1|::1/);
  });

  it('blocks UDP sends to non-allowlisted hosts', () => {
    const s = dgram.createSocket('udp4');
    expect(() => s.send(Buffer.from('x'), 53, '198.51.100.1')).toThrow(/UDP/);
    s.close();
    // loopback UDP and path-only sockets are untouched
    const s2 = dgram.createSocket('udp4');
    expect(() => s2.send(Buffer.from('x'), 9, '127.0.0.1')).not.toThrow();
    s2.close();
  });

  it('allows unix sockets and restores everything on uninstall', async () => {
    guard.uninstall();
    const lookup = dns.lookup;
    const connect = net.Socket.prototype.connect;
    guard = installNetworkGuard(policy);
    expect(dns.lookup).not.toBe(lookup);
    expect(net.Socket.prototype.connect).not.toBe(connect);
    const err = await new Promise<Error>((resolve) => {
      net.connect('/nonexistent/socket.sock').once('error', resolve);
    });
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
    guard.uninstall();
    expect(dns.lookup).toBe(lookup);
    expect(net.Socket.prototype.connect).toBe(connect);
  });

  it('proxy-aware and guarded fetch consult the policy before sending', async () => {
    let sent = 0;
    const direct = async () => {
      sent++;
      return new Response('ok');
    };
    const f = createProxyAwareFetch({ directFetch: direct });
    await expect(f('https://evil.example/x')).rejects.toThrow(/OAX_AIRGAPPED_ALLOW/);
    await expect(f('http://ollama.internal:11434/api')).resolves.toBeInstanceOf(Response);
    const g = createGuardedFetch({
      allowedOrigins: ['https://evil.example'],
      fetchImpl: async () => {
        sent++;
        return new Response('ok');
      },
    });
    await expect(g('https://evil.example/x')).rejects.toThrow(/OAX_AIRGAPPED_ALLOW/);
    expect(sent).toBe(1);
  });
});
