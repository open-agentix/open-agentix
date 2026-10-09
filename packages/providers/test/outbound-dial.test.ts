import net from 'node:net';
import { compileNetwork, parseNetworkConfig, type NetworkConfig } from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOutboundDispatcher } from '../src/index.js';

const listen = (s: net.Server) =>
  new Promise<number>((r) =>
    s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)),
  );
const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));
const netOf = (doc: Record<string, unknown>) =>
  compileNetwork(parseNetworkConfig(doc as unknown as NetworkConfig).config);
const lookup = async () => [{ address: '127.0.0.1' }];

let echo: net.Server;
let proxy: net.Server;
let echoPort: number;
let proxyPort: number;
const connects: { line: string; auth: string | undefined }[] = [];
let proxyAnswer = '200 Connection Established';

beforeAll(async () => {
  echo = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)).on('error', () => 0));
  proxy = net.createServer((s) => {
    s.once('data', (d) => {
      const head = d.toString('latin1');
      connects.push({
        line: head.split('\r\n')[0] ?? '',
        auth: /proxy-authorization: (.*)\r/i.exec(head)?.[1],
      });
      if (!proxyAnswer.startsWith('200')) return void s.end(`HTTP/1.1 ${proxyAnswer}\r\n\r\n`);
      const up = net.connect(echoPort, '127.0.0.1', () => {
        s.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        s.pipe(up);
        up.pipe(s);
      });
      up.on('error', () => s.destroy());
    });
    s.on('error', () => 0);
  });
  [echoPort, proxyPort] = await Promise.all([listen(echo), listen(proxy)]);
});

afterAll(async () => {
  await Promise.all([close(echo), close(proxy)]);
});

const roundTrip = (s: net.Socket) =>
  new Promise<string>((resolve) => {
    s.once('data', (d) => {
      resolve(String(d));
      s.destroy();
    });
    s.write('ping');
  });

describe('OutboundDispatcher.dial', () => {
  it('dials the pinned, checked address directly', async () => {
    const d = createOutboundDispatcher({});
    const sock = await d.dial(
      { host: 'git.example.org', port: echoPort },
      { purpose: 'git', pin: { allow: ['127.0.0.1'], lookup } },
    );
    expect(await roundTrip(sock)).toBe('echo:ping');
  });

  it('refuses a non-public address that the operator did not list', async () => {
    const d = createOutboundDispatcher({});
    await expect(
      d.dial({ host: 'git.example.org', port: echoPort }, { purpose: 'git', pin: { lookup } }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
  });

  it('refuses a denied route before any connection', async () => {
    const d = createOutboundDispatcher({
      network: netOf({ routes: [{ match: { hosts: ['git.example.org'] }, via: 'deny' }] }),
    });
    await expect(
      d.dial({ host: 'git.example.org', port: echoPort }, { purpose: 'git' }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
  });

  it('tunnels through the selected proxy with CONNECT and the proxy credential', async () => {
    connects.length = 0;
    proxyAnswer = '200 Connection Established';
    const d = createOutboundDispatcher({
      network: netOf({
        proxies: [{ name: 'corp', url: `http://127.0.0.1:${proxyPort}`, authSecret: 'proxy-auth' }],
        routes: [{ match: { hosts: ['git.example.org'] }, via: 'corp' }],
      }),
      secrets: (ref) => (ref === 'proxy-auth' ? 'user:pw' : undefined),
    });
    const sock = await d.dial({ host: 'git.example.org', port: 443 }, { purpose: 'git' });
    expect(await roundTrip(sock)).toBe('echo:ping');
    expect(connects[0]?.line).toBe('CONNECT git.example.org:443 HTTP/1.1');
    expect(connects[0]?.auth).toBe(`Basic ${Buffer.from('user:pw').toString('base64')}`);
  });

  it('reports a refused tunnel without proxy text', async () => {
    proxyAnswer = '403 Forbidden';
    const d = createOutboundDispatcher({
      network: netOf({
        proxies: [{ name: 'corp', url: `http://127.0.0.1:${proxyPort}` }],
        routes: [{ match: { hosts: ['git.example.org'] }, via: 'corp' }],
      }),
    });
    await expect(
      d.dial({ host: 'git.example.org', port: 443 }, { purpose: 'git' }),
    ).rejects.toMatchObject({ code: 'proxy_connect_refused' });
  });
});
