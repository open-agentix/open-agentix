import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  StaticSecretResolver,
  compileNetwork,
  parseNetworkConfig,
  type NetworkConfig,
} from '@openagentix/core';
import { createOutboundDispatcher, type OutboundDispatcher } from '@openagentix/providers';

export const GIT_TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}gitTOKEN`;
export const API_TOKEN = `ghp_${'Z9y8X7w6V5u4T3s2R1q0'.repeat(2)}apiTOKEN`;
export const OWNER = 'open-agentix';
export const NAME = 'dogfood-sandbox';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.org',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.org',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();

export interface Tls {
  dir: string;
  key: string;
  cert: string;
}

/** Self-signed certificate (CA:TRUE, SAN localhost/127.0.0.1) that the tests pin as the only CA. */
export function makeTls(dir: string): Tls {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      path.join(dir, 'k.pem'),
      '-out',
      path.join(dir, 'c.pem'),
    ],
    { stdio: 'ignore' },
  );
  return {
    dir,
    key: readFileSync(path.join(dir, 'k.pem'), 'utf8'),
    cert: readFileSync(path.join(dir, 'c.pem'), 'utf8'),
  };
}

export const lookup = async () => [{ address: '127.0.0.1' }];

export function makeDispatcher(
  caPem: string,
  extra: Record<string, unknown> = {},
): OutboundDispatcher {
  const network = compileNetwork(
    parseNetworkConfig({
      trust: { mode: 'extra-only', bundles: [{ name: 'test-ca', secret: 'test-ca' }] },
      ...extra,
    } as unknown as NetworkConfig).config,
  );
  return createOutboundDispatcher({
    network,
    secrets: (ref) => (ref === 'test-ca' ? caPem : undefined),
  });
}

export const secretsFor = () =>
  new StaticSecretResolver({ 'git-token': GIT_TOKEN, 'api-token': API_TOKEN });

export interface SeenRequest {
  method: string;
  url: string;
  auth: string | undefined;
}

export interface FakeServer {
  port: number;
  url: string;
  root: string;
  seen: SeenRequest[];
  /** Pull requests returned by the fake API. */
  pulls: { number: number; head: string; repo?: string; draft: boolean }[];
  posted: unknown[];
  mode: {
    redirect: boolean;
    hang: boolean;
    apiStatus: number | undefined;
    apiNonDraft: boolean;
    apiRedirect: boolean;
    apiBigBody: boolean;
    pageSize: number | undefined;
  };
  bare: string;
  close(): Promise<void>;
}

/** Git smart-HTTP server (real `git http-backend`) plus a tiny GitHub-like REST API, over TLS. */
export async function startFakeServer(
  tls: Tls,
  expect: { git: string; api: string },
): Promise<FakeServer> {
  const root = mkdtempSync(path.join(tmpdir(), 'oax-fake-'));
  const bare = path.join(root, OWNER, `${NAME}.git`);
  mkdirSync(path.dirname(bare), { recursive: true });
  git(root, 'init', '--bare', '-q', bare);
  git(bare, 'config', 'http.receivepack', 'true');
  git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const seen: SeenRequest[] = [];
  const pulls: FakeServer['pulls'] = [];
  const posted: unknown[] = [];
  const mode: FakeServer['mode'] = {
    redirect: false,
    hang: false,
    apiStatus: undefined,
    apiNonDraft: false,
    apiRedirect: false,
    apiBigBody: false,
    pageSize: undefined,
  };
  const basic = `Basic ${Buffer.from(`x-access-token:${expect.git}`).toString('base64')}`;
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const u = new URL(req.url ?? '/', 'https://localhost');
    const auth = req.headers.authorization;
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth });
    if (u.pathname.startsWith('/api/v3/')) return api(req, res, u, auth);
    if (u.pathname === '/elsewhere') return void res.writeHead(200).end('elsewhere');
    if (mode.hang) return;
    if (mode.redirect) return void res.writeHead(302, { location: '/elsewhere' }).end();
    if (auth !== basic) {
      return void res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end('denied');
    }
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH ?? '',
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: u.pathname,
        QUERY_STRING: u.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'x-access-token',
        REMOTE_ADDR: '127.0.0.1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ...(req.headers['git-protocol']
          ? { GIT_PROTOCOL: String(req.headers['git-protocol']) }
          : {}),
        ...(req.headers['content-encoding']
          ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) }
          : {}),
      },
    });
    req.pipe(cgi.stdin);
    cgi.stdin.on('error', () => undefined);
    let head = Buffer.alloc(0);
    let sent = false;
    cgi.stdout.on('data', (d: Buffer) => {
      if (sent) return void res.write(d);
      head = Buffer.concat([head, d]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      sent = true;
      res.write(head.subarray(end + 4));
    });
    cgi.on('close', () => res.end());
  });

  function api(req: IncomingMessage, res: ServerResponse, u: URL, auth: string | undefined) {
    if (mode.apiRedirect) return void res.writeHead(302, { location: '/elsewhere' }).end();
    if (auth !== `Bearer ${expect.api}`) return void res.writeHead(401).end('{}');
    if (mode.apiStatus)
      return void res.writeHead(mode.apiStatus).end('{"message":"boom ghp_leaky"}');
    const pullsPath = `/api/v3/repos/${OWNER}/${NAME}/pulls`;
    if (u.pathname !== pullsPath) return void res.writeHead(404).end('{}');
    const html = (n: number) => `https://localhost:${port}/${OWNER}/${NAME}/pull/${n}`;
    const shape = (p: FakeServer['pulls'][number]) => ({
      number: p.number,
      html_url: html(p.number),
      state: 'open',
      draft: p.draft,
      title: 'x',
      body: 'y',
      user: { login: 'leak' },
      head: { ref: p.head, repo: { full_name: p.repo ?? `${OWNER}/${NAME}` } },
    });
    if (req.method === 'GET') {
      const page = Number(u.searchParams.get('page') ?? '1');
      const size = mode.pageSize ?? 100;
      const slice = pulls.slice((page - 1) * size, page * size);
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(slice.map(shape)));
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { head: string; draft: boolean };
        posted.push(parsed);
        const n = 100 + posted.length;
        const rec = {
          number: n,
          head: parsed.head,
          draft: mode.apiNonDraft ? false : parsed.draft,
        };
        pulls.push(rec);
        const out = mode.apiBigBody ? { ...shape(rec), pad: 'x'.repeat(2_000_000) } : shape(rec);
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      });
      return;
    }
    res.writeHead(405).end('{}');
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `https://localhost:${port}/${OWNER}/${NAME}`,
    root,
    seen,
    pulls,
    posted,
    mode,
    bare,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(root, { recursive: true, force: true });
          r();
        });
      }),
  };
}

/** Creates commits in a work clone and pushes them to the fake server's bare repository. */
export function seedRepo(
  srv: FakeServer,
  files: Record<string, string | Buffer>,
  opts: { symlinks?: Record<string, string>; extra?: (work: string) => void; branch?: string } = {},
): string {
  const work = mkdtempSync(path.join(tmpdir(), 'oax-work-'));
  git(work, 'init', '-q', '-b', opts.branch ?? 'main');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(work, p)), { recursive: true });
    writeFileSync(path.join(work, p), c);
    if (p.endsWith('.sh')) chmodSync(path.join(work, p), 0o755);
  }
  for (const [l, target] of Object.entries(opts.symlinks ?? {}))
    symlinkSync(target, path.join(work, l));
  git(work, 'add', '-A');
  opts.extra?.(work);
  git(work, 'commit', '-q', '-m', 'seed');
  const sha = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', srv.bare, `HEAD:refs/heads/${opts.branch ?? 'main'}`);
  rmSync(work, { recursive: true, force: true });
  return sha;
}

/** `git diff` output between two contents of one file, in the format the engine accepts. */
export function diffOf(file: string, before: string, after: string): string {
  const d = mkdtempSync(path.join(tmpdir(), 'oax-diff-'));
  git(d, 'init', '-q');
  mkdirSync(path.dirname(path.join(d, file)), { recursive: true });
  writeFileSync(path.join(d, file), before);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'a');
  writeFileSync(path.join(d, file), after);
  const out = execFileSync('git', ['diff', '--no-color', '--no-ext-diff'], {
    cwd: d,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  });
  rmSync(d, { recursive: true, force: true });
  return out;
}
