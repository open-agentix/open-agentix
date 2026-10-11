import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Helpers of the opt-in real-engine abuse suite (ADR 0016 S8, extends W1-3b-10). Everything the
 * suite creates is throwaway and named `oax-s8-<pid>-*`: networks, containers started with
 * `--rm`, and hosts-file entries. `cleanup()` removes exactly those and nothing else.
 *
 *   OAX_TEST_DOCKER=1 OAX_TEST_ALLOW_RAW_SOCKET=1 \
 *   OAX_TEST_IMAGE=node@sha256:<digest of a local node:22-alpine image> \
 *   [OAX_TEST_OPENSSL_IMAGE=node:22-bookworm] [OAX_TEST_SELF=<this container's name>] \
 *   pnpm vitest run apps/api/test/mcp-abuse-*.integration.test.ts
 *
 * The tests must run inside a container that can reach the engine socket (they attach it to the
 * throwaway networks to talk to the servers and to host the egress proxy), see docs/mcp.md.
 * No image is ever pulled; the images must exist locally.
 */
export const ENABLED = process.env.OAX_TEST_DOCKER === '1' && !!process.env.OAX_TEST_IMAGE;
export const IMAGE = process.env.OAX_TEST_IMAGE ?? '';
const OPENSSL_IMAGE = process.env.OAX_TEST_OPENSSL_IMAGE ?? 'node:22-bookworm';
export const ENGINE_URL = process.env.OAX_TEST_ENGINE_URL ?? 'unix:///var/run/docker.sock';
export const RAW_SOCKET = process.env.OAX_TEST_ALLOW_RAW_SOCKET === '1';
const SELF = process.env.OAX_TEST_SELF ?? (existsSync('/.dockerenv') ? hostname() : undefined);
const LABEL = 'io.openagentix.s8-suite';

const scriptOf = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

export const docker = (...args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

export interface Tls {
  ca: string;
  cert: string;
  key: string;
}

export interface LabServer {
  name: string;
  ip: string;
  control(path: string, body?: unknown): Promise<unknown>;
  hits(): Promise<
    { method: string; url: string; host: string; authorization: string | null; bytes: number }[]
  >;
}

export class Lab {
  readonly prefix = `oax-s8-${process.pid}`;
  private readonly containers: string[] = [];
  private readonly networks: string[] = [];
  private readonly attached: string[] = [];
  private hostsBefore: string | undefined;

  get self(): string {
    if (!SELF)
      throw new Error(
        'run the suite inside a container (set OAX_TEST_SELF to its name): it must be attached to the lab networks',
      );
    return SELF;
  }

  /** Creates a throwaway network and attaches this container to it; returns this container's address. */
  network(suffix: string, opts: { internal?: boolean } = {}): { name: string; selfIp: string } {
    const name = `${this.prefix}-${suffix}`;
    docker(
      'network',
      'create',
      ...(opts.internal ? ['--internal'] : []),
      '--label',
      `${LABEL}=${this.prefix}`,
      name,
    );
    this.networks.push(name);
    docker('network', 'connect', name, this.self);
    this.attached.push(name);
    return { name, selfIp: this.ipOf(this.self, name) };
  }

  ipOf(container: string, network: string): string {
    return docker(
      'inspect',
      '-f',
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      container,
    ).trim();
  }

  /** The lab server (fixtures/lab-server.mjs) in a container on `network`. */
  async server(
    suffix: string,
    network: string,
    opts: { tls?: Tls; dataPort?: number } = {},
  ): Promise<LabServer> {
    const name = `${this.prefix}-${suffix}`;
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--network',
      network,
      '--label',
      `${LABEL}=${this.prefix}`,
      '--memory',
      '128m',
      '--pids-limit',
      '64',
      '-e',
      `DATA_PORT=${opts.dataPort ?? 443}`,
      ...(opts.tls
        ? ['-e', `LAB_TLS_CERT=${opts.tls.cert}`, '-e', `LAB_TLS_KEY=${opts.tls.key}`]
        : []),
      IMAGE,
      'node',
      '--input-type=module',
      '-e',
      scriptOf('lab-server.mjs'),
    );
    this.containers.push(name);
    const ip = this.ipOf(name, network);
    const control = async (path: string, body?: unknown) => {
      const res = await fetch(`http://${ip}:9000${path}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(5000),
      });
      return res.json();
    };
    for (let i = 0; ; i++) {
      try {
        await control('/ready');
        break;
      } catch (e) {
        if (i > 60) throw new Error(`lab server ${name} did not start: ${String(e)}`, { cause: e });
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return {
      name,
      ip,
      control,
      hits: async () => (await control('/hits')) as Awaited<ReturnType<LabServer['hits']>>,
    };
  }

  /** A real UDP resolver whose answers advance per query (DNS rebinding). */
  dns(
    suffix: string,
    network: string,
    records: Record<string, string[]>,
  ): { name: string; ip: string } {
    const name = `${this.prefix}-${suffix}`;
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--network',
      network,
      '--label',
      `${LABEL}=${this.prefix}`,
      '--memory',
      '64m',
      '-e',
      `LAB_DNS_RECORDS=${JSON.stringify(records)}`,
      IMAGE,
      'node',
      '--input-type=module',
      '-e',
      scriptOf('lab-dns.mjs'),
    );
    this.containers.push(name);
    return { name, ip: this.ipOf(name, network) };
  }

  /** Lookups a lab resolver has answered, from its log. */
  dnsQueries(name: string, host: string): number {
    return docker('logs', name)
      .split('\n')
      .filter((l) => l.startsWith(`Q ${host} `)).length;
  }

  /** Maps a name to an address for this process (getaddrinfo reads the hosts file). */
  addHost(ip: string, ...names: string[]): void {
    if (this.hostsBefore === undefined) this.hostsBefore = readFileSync('/etc/hosts', 'utf8');
    appendFileSync('/etc/hosts', `${ip} ${names.join(' ')}\n`);
  }

  /** A throwaway CA and one server certificate for `names`, generated inside a container. */
  tls(names: string[]): Tls {
    const sans = names.map((n) => `DNS:${n}`).join(',');
    const out = docker(
      'run',
      '--rm',
      '--network',
      'none',
      '-e',
      `SANS=${sans}`,
      OPENSSL_IMAGE,
      'sh',
      '-c',
      [
        'set -e; cd /tmp',
        'openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -subj "/CN=oax-s8-lab-ca" -days 1 >/dev/null 2>&1',
        'openssl req -newkey rsa:2048 -nodes -keyout s.key -out s.csr -subj "/CN=oax-s8-lab" >/dev/null 2>&1',
        'printf "subjectAltName=%s" "$SANS" > ext',
        'openssl x509 -req -in s.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out s.pem -days 1 -extfile ext >/dev/null 2>&1',
        'echo "###CA"; cat ca.pem; echo "###CERT"; cat s.pem; echo "###KEY"; cat s.key',
      ].join('; '),
    );
    const part = (a: string, b?: string) =>
      out.slice(out.indexOf(a) + a.length, b ? out.indexOf(b) : undefined).trim() + '\n';
    return {
      ca: part('###CA\n', '###CERT'),
      cert: part('###CERT\n', '###KEY'),
      key: part('###KEY\n'),
    };
  }

  /** Removes exactly what this instance created. Safe to call twice. */
  cleanup(): void {
    for (const c of this.containers.splice(0))
      try {
        docker('rm', '-f', c);
      } catch {
        // already gone (--rm)
      }
    for (const n of this.attached.splice(0))
      try {
        docker('network', 'disconnect', '-f', n, this.self);
      } catch {
        // already gone
      }
    for (const n of this.networks.splice(0))
      try {
        docker('network', 'rm', n);
      } catch {
        // already gone
      }
    if (this.hostsBefore !== undefined) {
      try {
        writeFileSync('/etc/hosts', this.hostsBefore);
      } catch {
        // read-only hosts file: nothing was added either
      }
      this.hostsBefore = undefined;
    }
  }
}
