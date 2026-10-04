import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { InClusterKubeClient } from '../src/index.js';

let server: http.Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<string> {
  server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => handler(req, b, res));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('InClusterKubeClient default transport', () => {
  it('sends the bearer token and JSON, parses responses, handles non-JSON errors', async () => {
    const seen: { auth?: string; ct?: string; method?: string; url?: string; body: string }[] = [];
    const url = await start((req, body, res) => {
      seen.push({
        auth: req.headers.authorization,
        ct: req.headers['content-type'],
        method: req.method,
        url: req.url,
        body,
      });
      if (req.url!.includes('/secrets/')) {
        res.writeHead(502);
        return res.end('bad gateway');
      }
      if (req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ metadata: { uid: 'U1' } }));
      }
      res.writeHead(404);
      res.end();
    });
    const c = new InClusterKubeClient({ apiServer: url, token: 'tok' });
    await expect(
      c.createJob('runs', { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'j' } }),
    ).resolves.toEqual({ uid: 'U1' });
    expect(seen[0]).toMatchObject({
      auth: 'Bearer tok',
      ct: 'application/json',
      method: 'POST',
      url: '/apis/batch/v1/namespaces/runs/jobs',
    });
    expect(JSON.parse(seen[0]!.body).kind).toBe('Job');
    await expect(c.getJob('runs', 'x')).resolves.toBeNull();
    await expect(c.deleteSecret('runs', 's')).rejects.toThrow(/HTTP 502: bad gateway/);
  });

  it('fails on connection errors', async () => {
    const c = new InClusterKubeClient({ apiServer: 'http://127.0.0.1:1', token: 'x' });
    await expect(c.getJob('runs', 'j')).rejects.toThrow();
  });
});
