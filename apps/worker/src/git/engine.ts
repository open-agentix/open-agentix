import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { OaxError, readConfigFile, redactString, type SecretResolver } from '@openagentix/core';
import type { OutboundContext, OutboundDispatcher } from '@openagentix/providers';
import { GitError, type GitErrorCode } from './errors.js';
import {
  checkPatch,
  DEFAULT_PATH_ALLOW,
  type CheckedPatch,
  type PatchPolicy,
} from './patch-check.js';
import { startRelay, type Relay, type RelayLimits } from './relay.js';
import { scanForSecrets } from './secret-scan.js';
import { packSeed, type SeedFile, type SeedSkip } from './seed.js';
import {
  assertBranchRef,
  assertIdentity,
  assertMessage,
  assertNewBranch,
  assertSha,
  parseRepoUrl,
  type Identity,
  type RepoUrl,
} from './validate.js';

/**
 * Minimal Git engine for the trusted worker (dogfooding DOG-3a, ADR 0010 Amendment 1 A1.3/A1.5):
 * clone/fetch one commit over https with a token, read the tree without a checkout, apply a
 * node-computed patch in a temporary index, commit and push a NEW branch. The `git` binary runs as
 * a child process of the worker with an allowlisted environment, forced `-c` options, no system or
 * global configuration, no hooks, filters, submodules or LFS, and reaches the network only through
 * a one-target local relay that dials via the outbound dispatcher (ADR 0011).
 */
export interface GitLimits {
  /** Wall clock per Git process (ms). */
  timeoutMs: number;
  /** Bytes received from the host per operation. */
  maxReceiveBytes: number;
  /** Bytes sent to the host per operation (push). */
  maxSendBytes: number;
  /** Objects in the throwaway repository after a fetch. */
  maxObjects: number;
  /** Size of the throwaway repository after a fetch (inflated-size proxy). */
  maxRepoBytes: number;
  /** Files, bytes per file and total bytes of the exported seed. */
  maxSeedFiles: number;
  maxSeedFileBytes: number;
  maxSeedBytes: number;
  maxTreeDepth: number;
  maxPathBytes: number;
  /** Idle time of a relayed connection (ms). */
  idleMs: number;
}

export const DEFAULT_GIT_LIMITS: GitLimits = {
  timeoutMs: 30_000,
  maxReceiveBytes: 64 * 1024 * 1024,
  maxSendBytes: 8 * 1024 * 1024,
  maxObjects: 100_000,
  maxRepoBytes: 256 * 1024 * 1024,
  maxSeedFiles: 5_000,
  maxSeedFileBytes: 1024 * 1024,
  maxSeedBytes: 5 * 1024 * 1024,
  maxTreeDepth: 32,
  maxPathBytes: 4_096,
  idleMs: 20_000,
};

export interface GitCredential {
  /** Secret reference (ADR 0012: names, never values). Used by this engine only. */
  tokenRef: string;
  /** Pre-filled from the provider hint, e.g. `x-access-token`; default `git`. */
  username?: string;
  scheme?: 'basic' | 'bearer';
}

/** Audit record with digests and counts only: no content, no credential, no host text. */
export interface GitAuditEvent {
  action: 'git.clone' | 'git.apply' | 'git.push' | 'git.refused';
  ok: boolean;
  code?: string;
  repo: string;
  at: string;
  [k: string]: unknown;
}

export interface GitEngineOptions {
  dispatcher: OutboundDispatcher;
  secrets: SecretResolver;
  /** Sync secret reader for trust bundles given as secrets (same contract as the dispatcher's). */
  secretReader?: ((ref: string) => string | undefined) | undefined;
  readFile?: ((path: string) => string) | undefined;
  gitBinary?: string | undefined;
  tmpRoot?: string | undefined;
  limits?: Partial<GitLimits> | undefined;
  /** Hosts/CIDRs of private addresses the operator allows as Git destinations (pinning allowlist). */
  privateAllow?: readonly string[] | undefined;
  /** Test seam for DNS (names to addresses). */
  lookup?: ((host: string) => Promise<{ address: string }[]>) | undefined;
  maxConcurrent?: number | undefined;
  minGitVersion?: string | undefined;
  audit?: ((e: GitAuditEvent) => void | Promise<void>) | undefined;
  now?: (() => Date) | undefined;
}

export interface GitTarget {
  url: string;
  credential: GitCredential;
  /** Allowed prefix of branches the engine may create (default `oax/`). */
  branchPrefix?: string | undefined;
}

export interface Snapshot {
  sha: string;
  treeSha: string;
  files: SeedFile[];
  skipped: SeedSkip[];
  /** Sum of file sizes. */
  bytes: number;
}

export interface FetchReport {
  sha: string;
  objects: number;
  repoBytes: number;
  receivedBytes: number;
}

export interface PushReport {
  branch: string;
  commit: string;
  treeSha: string;
  baseSha: string;
  patchSha256: string;
  changedFiles: number;
  sentBytes: number;
  /** False in dry-run mode: nothing was pushed. */
  pushed: boolean;
}

const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';

class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

function versionAtLeast(have: string, want: string): boolean {
  const a = have.split('.').map((x) => parseInt(x, 10) || 0);
  const b = want.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  capped: boolean;
}

export class GitEngine {
  readonly limits: GitLimits;
  private readonly sem: Semaphore;
  private readonly git: string;
  private versionChecked = false;

  constructor(private readonly opts: GitEngineOptions) {
    this.limits = { ...DEFAULT_GIT_LIMITS, ...stripUndefined(opts.limits) };
    this.sem = new Semaphore(Math.max(1, opts.maxConcurrent ?? 4));
    this.git = opts.gitBinary ?? 'git';
  }

  /** Opens a throwaway session (own directory, own `HOME`). Always `dispose()` it. */
  async openSession(target: GitTarget): Promise<GitSession> {
    await this.checkVersion();
    const repo = parseRepoUrl(target.url);
    const dir = await mkdtemp(join(this.opts.tmpRoot ?? tmpdir(), 'oax-git-'));
    await mkdir(join(dir, 'home'), { mode: 0o700 });
    await mkdir(join(dir, 'capath'), { mode: 0o700 });
    return new GitSession(this, repo, target, dir);
  }

  /** @internal */
  get internals() {
    return {
      opts: this.opts,
      sem: this.sem,
      git: this.git,
      run: this.run.bind(this),
    };
  }

  private async checkVersion(): Promise<void> {
    if (this.versionChecked) return;
    const r = await this.run(['--version'], { cwd: tmpdir(), env: {}, maxStdout: 256 });
    const m = /git version (\d+\.\d+\.\d+)/.exec(r.stdout.toString('utf8'));
    const min = this.opts.minGitVersion ?? '2.39.5';
    if (!m || !versionAtLeast(m[1]!, min))
      throw new GitError('git_version_unsupported', `git ${min} or newer is required`);
    this.versionChecked = true;
  }

  /**
   * One `git` child: allowlisted environment, own process group, wall clock, output cap. The
   * caller passes the `git` arguments after the hardening options.
   * @internal
   */
  async run(
    args: string[],
    o: {
      cwd: string;
      env: Record<string, string>;
      stdin?: string | Buffer | undefined;
      maxStdout?: number;
      timeoutMs?: number;
      hardened?: string[];
    },
  ): Promise<RunResult> {
    const release = await this.sem.acquire();
    try {
      return await new Promise<RunResult>((resolve, reject) => {
        const child = spawn(this.git, [...(o.hardened ?? []), ...args], {
          cwd: o.cwd,
          env: o.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
          shell: false,
          windowsHide: true,
        });
        const out: Buffer[] = [];
        let outLen = 0;
        let errText = '';
        let timedOut = false;
        let capped = false;
        const max = o.maxStdout ?? 1024 * 1024;
        const killGroup = () => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killGroup();
        }, o.timeoutMs ?? this.limits.timeoutMs);
        child.stdout.on('data', (d: Buffer) => {
          outLen += d.length;
          if (outLen > max) {
            capped = true;
            killGroup();
            return;
          }
          out.push(d);
        });
        child.stderr.on('data', (d: Buffer) => {
          if (errText.length < 16_384) errText += d.toString('utf8');
        });
        child.on('error', () => {
          clearTimeout(timer);
          reject(new GitError('git_failed', 'the git binary could not be started'));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          killGroup(); // stray children of this git call
          resolve({
            code: code ?? -1,
            stdout: Buffer.concat(out),
            stderr: errText,
            timedOut,
            capped,
          });
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(o.stdin);
      });
    } finally {
      release();
    }
  }
}

/** Forced `-c` options (A1.3): the repository cannot override them. */
export function hardenedConfig(extra: { proxy?: string; caInfo?: string; caPath?: string }) {
  const c: Record<string, string> = {
    'core.hooksPath': '/dev/null',
    'core.fsmonitor': 'false',
    'core.attributesFile': '/dev/null',
    'core.excludesFile': '/dev/null',
    'core.askPass': '',
    'core.symlinks': 'false',
    'core.protectNTFS': 'true',
    'core.protectHFS': 'true',
    'safe.bareRepository': 'explicit',
    'protocol.allow': 'never',
    'protocol.https.allow': 'always',
    'protocol.version': '2',
    'transfer.fsckObjects': 'true',
    'fetch.fsckObjects': 'true',
    'receive.fsckObjects': 'true',
    'fetch.recurseSubmodules': 'false',
    'submodule.recurse': 'false',
    'push.recurseSubmodules': 'no',
    'push.followTags': 'false',
    'fetch.writeCommitGraph': 'false',
    'fetch.prune': 'false',
    'gc.auto': '0',
    'maintenance.auto': 'false',
    'credential.helper': '',
    'commit.gpgsign': 'false',
    'tag.gpgsign': 'false',
    'http.followRedirects': 'false',
    'http.sslVerify': 'true',
    'http.proxyAuthMethod': 'basic',
    'http.lowSpeedLimit': '1000',
    'http.lowSpeedTime': '15',
    'diff.external': '',
    'filter.lfs.required': 'false',
    ...(extra.proxy ? { 'http.proxy': extra.proxy } : {}),
    ...(extra.caInfo ? { 'http.sslCAInfo': extra.caInfo } : {}),
    ...(extra.caPath ? { 'http.sslCAPath': extra.caPath } : {}),
  };
  return Object.entries(c).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(o ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

async function dirStats(root: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await stat(p)).size;
    }
  };
  await walk(root);
  return total;
}

export class GitSession {
  private fetched: string | undefined;
  private disposed = false;
  private readonly bare: string;
  private readonly knownSecrets: string[] = [];

  /** @internal */
  constructor(
    private readonly engine: GitEngine,
    readonly repo: RepoUrl,
    private readonly target: GitTarget,
    private readonly dir: string,
  ) {
    this.bare = join(dir, 'repo.git');
  }

  private get o() {
    return this.engine.internals.opts;
  }

  private get limits(): GitLimits {
    return this.engine.limits;
  }

  private audit(e: Omit<GitAuditEvent, 'at' | 'repo'>): Promise<void> {
    const ev = {
      ...e,
      repo: `${this.repo.host}/${this.repo.path}`,
      at: (this.o.now?.() ?? new Date()).toISOString(),
    };
    return Promise.resolve(this.o.audit?.(ev as GitAuditEvent)).catch(() => undefined);
  }

  private ctx(): OutboundContext {
    return {
      purpose: 'git',
      scope: { origin: 'platform' },
      pin: {
        allow: [...(this.o.privateAllow ?? [])],
        ...(this.o.lookup ? { lookup: this.o.lookup } : {}),
      },
      timeoutMs: this.limits.timeoutMs,
    };
  }

  /** Trust store for Git: the ADR 0011 bundles of the route (empty: Git's own defaults). */
  private async trustFile(bundles: readonly string[]): Promise<string | undefined> {
    const net = this.o.dispatcher.network;
    const read = this.o.readFile ?? readConfigFile;
    const extra: string[] = [];
    for (const name of bundles) {
      const b = net.config.trust.bundles.find((x) => x.name === name);
      if (!b) throw new GitError('tls_failed', 'unknown trust bundle');
      if (b.file) extra.push(read(b.file));
      else {
        const v = this.o.secretReader?.(b.secret ?? '');
        if (!v) throw new GitError('tls_failed', 'trust bundle unavailable');
        extra.push(v);
      }
    }
    if (net.trust.mode === 'system+extra' && extra.length === 0) return undefined;
    const pem = (net.trust.mode === 'system+extra' ? [...rootCertificates, ...extra] : extra).join(
      '\n',
    );
    const file = join(this.dir, 'ca.pem');
    await writeFile(file, pem, { mode: 0o600 });
    return file;
  }

  private baseEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: SAFE_PATH,
      HOME: join(this.dir, 'home'),
      XDG_CONFIG_HOME: join(this.dir, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_ALLOC_LIMIT: '512m',
      GIT_NO_REPLACE_OBJECTS: '1',
      LC_ALL: 'C',
      LANG: 'C',
      ...extra,
    };
  }

  private async authEnv(): Promise<Record<string, string>> {
    let token: string;
    try {
      token = await this.o.secrets.resolve(this.target.credential.tokenRef);
    } catch {
      throw new GitError('credential_unavailable', 'the Git credential is not available');
    }
    if (!token || /[\r\n\0]/.test(token))
      throw new GitError('credential_unavailable', 'the Git credential is not usable');
    this.knownSecrets.push(token);
    const header =
      (this.target.credential.scheme ?? 'basic') === 'bearer'
        ? `Bearer ${token}`
        : `Basic ${Buffer.from(`${this.target.credential.username ?? 'git'}:${token}`).toString('base64')}`;
    this.knownSecrets.push(header.replace(/^(Basic|Bearer) /, ''));
    const origin = `https://${this.repo.host}${this.repo.port === 443 ? '' : `:${this.repo.port}`}/`;
    // Scoped to this origin and carried only in the environment of this one child (A1.2).
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${origin}.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: ${header}`,
    };
  }

  private map(code: GitErrorCode): GitError {
    const messages: Partial<Record<GitErrorCode, string>> = {
      auth_failed: 'the Git host refused the credential',
      not_found: 'the repository or revision was not found',
      redirect_refused: 'the Git host answered with a redirect, which is refused',
      tls_failed: 'the TLS connection to the Git host failed',
      egress_denied: 'the connection to the Git host is not allowed',
      transfer_limit: 'the transfer exceeded its limit',
      timeout: 'the Git operation timed out',
      push_rejected: 'the Git host rejected the push',
      protocol_error: 'the Git host answered unexpectedly',
    };
    return new GitError(code, messages[code] ?? 'the Git operation failed');
  }

  private classify(r: RunResult, relay: Relay | undefined): GitError {
    if (relay?.stats.limitExceeded || r.capped) return this.map('transfer_limit');
    if (r.timedOut) return this.map('timeout');
    if (relay?.stats.dialErrors.includes('egress_denied')) return this.map('egress_denied');
    const s = r.stderr;
    if (/error: 30[1278]|redirect/i.test(s)) return this.map('redirect_refused');
    if (
      /error: 40[13]|Authentication failed|could not read (?:Username|Password)|Access denied/i.test(
        s,
      )
    )
      return this.map('auth_failed');
    if (
      /error: 404|not found|does not appear to be a git repository|couldn't find remote ref|not our ref|unadvertised object/i.test(
        s,
      )
    )
      return this.map('not_found');
    if (/rejected|failed to push|already exists|stale info|cannot lock ref/i.test(s))
      return this.map('push_rejected');
    if (/SSL|certificate|TLS|schannel/i.test(s)) return this.map('tls_failed');
    if (/CONNECT tunnel failed|proxy/i.test(s)) return this.map('egress_denied');
    if (/protocol|fatal: bad|invalid|unexpected|malformed|fsck|corrupt/i.test(s))
      return this.map('protocol_error');
    return this.map('git_failed');
  }

  /** Runs a command that talks to the host: relay, credential and trust are set up around it. */
  private async network(
    args: string[],
    o: { stdin?: string; maxStdout?: number; cwd?: string; env?: Record<string, string> } = {},
  ): Promise<{ r: RunResult; relay: Relay }> {
    const url = this.repo.url;
    const plan = this.o.dispatcher.plan(url, this.ctx()); // throws egress_denied on deny
    const relayLimits: RelayLimits = {
      maxReceiveBytes: this.limits.maxReceiveBytes,
      maxSendBytes: this.limits.maxSendBytes,
      idleMs: this.limits.idleMs,
      maxTunnels: 4,
    };
    const caInfo = await this.trustFile(plan.route.ca.bundles);
    const auth = await this.authEnv();
    const relay = await startRelay({
      dispatcher: this.o.dispatcher,
      target: { host: this.repo.host, port: this.repo.port },
      ctx: this.ctx(),
      limits: relayLimits,
    });
    try {
      const r = await this.engine.run(args, {
        cwd: o.cwd ?? this.dir,
        env: this.baseEnv({ ...auth, ...(o.env ?? {}) }),
        stdin: o.stdin,
        maxStdout: o.maxStdout ?? 1024 * 1024,
        hardened: hardenedConfig({
          proxy: `http://127.0.0.1:${relay.port}`,
          ...(caInfo ? { caInfo } : {}),
          caPath: join(this.dir, 'capath'),
        }),
      });
      if (r.code !== 0 || r.timedOut || r.capped || relay.stats.limitExceeded) {
        const err = this.classify(r, relay);
        throw err;
      }
      return { r, relay };
    } catch (e) {
      throw this.redactError(e);
    } finally {
      await relay.close();
    }
  }

  private redactError(e: unknown): unknown {
    if (e instanceof GitError) return e;
    if (e instanceof OaxError) {
      return new GitError(
        e.code === 'egress_denied' ? 'egress_denied' : 'git_failed',
        redactString(e.message, this.knownSecrets),
      );
    }
    return new GitError('git_failed', 'the Git operation failed');
  }

  /** Local (offline) git call in the bare repository. */
  private async local(
    args: string[],
    o: { stdin?: string | Buffer; maxStdout?: number; env?: Record<string, string> } = {},
  ): Promise<RunResult> {
    return this.engine.run(['--git-dir', this.bare, ...args], {
      cwd: this.dir,
      env: this.baseEnv(o.env),
      stdin: o.stdin,
      maxStdout: o.maxStdout ?? 1024 * 1024,
      hardened: hardenedConfig({}),
    });
  }

  private async localOk(
    args: string[],
    o: Parameters<GitSession['local']>[1] = {},
  ): Promise<Buffer> {
    const r = await this.local(args, o);
    if (r.code !== 0 || r.timedOut || r.capped) throw this.classify(r, undefined);
    return r.stdout;
  }

  /** `refs/heads/<branch>` advertisement: the commit id or null when the ref does not exist. */
  async lsRemote(ref: string): Promise<string | null> {
    assertBranchRef(ref);
    const { r } = await this.network(['ls-remote', '--refs', '--', this.repo.url, ref]);
    const lines = r.stdout.toString('utf8').split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const m = lines.length === 1 ? /^([0-9a-f]{40})\t(\S+)$/.exec(lines[0]!) : null;
    if (!m || m[2] !== ref) throw new GitError('protocol_error', 'unexpected ref advertisement');
    return m[1]!;
  }

  /** Shallow fetch (depth 1) of one commit into the session's bare repository. */
  async fetchCommit(sha: string): Promise<FetchReport> {
    assertSha(sha);
    try {
      const init = await this.engine.run(['init', '--bare', '--quiet', '--template=', this.bare], {
        cwd: this.dir,
        env: this.baseEnv(),
        hardened: hardenedConfig({}),
      });
      if (init.code !== 0) throw this.map('git_failed');
      const { relay } = await this.network([
        '--git-dir',
        this.bare,
        'fetch',
        '--depth=1',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--no-auto-gc',
        '--quiet',
        '--',
        this.repo.url,
        `${sha}:refs/oax/base`,
      ]);
      const head = (
        await this.localOk(['rev-parse', '--verify', '--end-of-options', 'refs/oax/base^{commit}'])
      )
        .toString('utf8')
        .trim();
      if (head !== sha) throw new GitError('protocol_error', 'the host returned another commit');
      const count = (await this.localOk(['count-objects', '-v'])).toString('utf8');
      const num = (k: string) => Number(new RegExp(`^${k}: (\\d+)$`, 'm').exec(count)?.[1] ?? 0);
      const objects = num('count') + num('in-pack');
      const repoBytes = await dirStats(this.bare);
      if (objects > this.limits.maxObjects || repoBytes > this.limits.maxRepoBytes)
        throw new GitError('sync_limit', 'the fetched repository exceeds its limit');
      this.fetched = sha;
      const report = { sha, objects, repoBytes, receivedBytes: relay.stats.received };
      await this.audit({
        action: 'git.clone',
        ok: true,
        sha,
        objects,
        repoBytes,
        receivedBytes: relay.stats.received,
      });
      return report;
    } catch (e) {
      const err = this.redactError(e) as GitError;
      await this.audit({ action: 'git.clone', ok: false, code: err.code, sha });
      throw err;
    }
  }

  /**
   * Clean source tree of a fetched commit, read with `ls-tree` and `cat-file --batch` (no checkout,
   * so no filters, attributes, hooks or LFS run). Links, gitlinks, LFS pointers, oversized and
   * unsafe-path files are left out and listed in `skipped`.
   */
  async snapshot(sha: string): Promise<Snapshot> {
    assertSha(sha);
    if (this.fetched !== sha) throw new GitError('not_found', 'the commit has not been fetched');
    const lim = this.limits;
    const tree = (
      await this.localOk(['rev-parse', '--verify', '--end-of-options', `${sha}^{tree}`])
    )
      .toString('utf8')
      .trim();
    const raw = await this.localOk(['ls-tree', '-r', '-z', '-l', '--full-tree', sha], {
      maxStdout: 16 * 1024 * 1024,
    });
    const skipped: SeedSkip[] = [];
    const wanted: { path: string; mode: '100644' | '100755'; id: string; size: number }[] = [];
    for (const entry of raw.toString('utf8').split('\0')) {
      if (!entry) continue;
      const m = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40}) +(\d+|-)\t([\s\S]+)$/.exec(entry);
      if (!m) throw new GitError('protocol_error', 'unexpected tree listing');
      const [, mode, type, id, size, path] = m as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const unsafe =
        Buffer.byteLength(path) > lim.maxPathBytes ||
        path.split('/').length > lim.maxTreeDepth ||
        // control characters, backslash, and U+FFFD (a name that is not valid UTF-8)
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f\\\ufffd]/.test(path) ||
        path.startsWith('/') ||
        path
          .split('/')
          .some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git');
      if (unsafe) skipped.push({ path: path.slice(0, 200), reason: 'unsafe_path' });
      else if (mode === '120000') skipped.push({ path, reason: 'symlink' });
      else if (type === 'commit' || mode === '160000') skipped.push({ path, reason: 'gitlink' });
      else if (mode !== '100644' && mode !== '100755')
        skipped.push({ path, reason: 'special_mode' });
      else if (Number(size) > lim.maxSeedFileBytes) skipped.push({ path, reason: 'too_large' });
      else wanted.push({ path, mode, id, size: Number(size) });
      if (wanted.length > lim.maxSeedFiles)
        throw new GitError('sync_limit', 'the tree has too many files');
    }
    const total = wanted.reduce((n, f) => n + f.size, 0);
    if (total > lim.maxSeedBytes)
      throw new GitError('sync_limit', 'the tree is larger than the seed limit');
    const ids = [...new Set(wanted.map((f) => f.id))];
    const blobs = new Map<string, Buffer>();
    if (ids.length > 0) {
      const out = await this.localOk(['cat-file', '--batch'], {
        stdin: `${ids.join('\n')}\n`,
        maxStdout: total + ids.length * 100 + 4096,
      });
      let at = 0;
      for (const id of ids) {
        const nl = out.indexOf(0x0a, at);
        const head =
          nl < 0
            ? null
            : /^([0-9a-f]{40}) blob (\d+)$/.exec(out.subarray(at, nl).toString('latin1'));
        if (!head || head[1] !== id)
          throw new GitError('protocol_error', 'unexpected object stream');
        const len = Number(head[2]);
        blobs.set(id, out.subarray(nl + 1, nl + 1 + len));
        at = nl + 1 + len + 1;
      }
    }
    const files: SeedFile[] = [];
    let bytes = 0;
    for (const f of wanted) {
      const content = blobs.get(f.id)!;
      if (
        content.length < 1024 &&
        content
          .subarray(0, 40)
          .toString('latin1')
          .startsWith('version https://git-lfs.github.com/spec/')
      ) {
        skipped.push({ path: f.path, reason: 'lfs_pointer' });
        continue;
      }
      files.push({ path: f.path, mode: f.mode, content });
      bytes += content.length;
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { sha, treeSha: tree, files, skipped, bytes };
  }

  /** Seed for the run node: deterministic ustar archive and its SHA-256 (interface for DOG-4). */
  async exportSeed(sha: string): Promise<{ archive: Buffer; sha256: string; snapshot: Snapshot }> {
    const snapshot = await this.snapshot(sha);
    const archive = packSeed(snapshot.files);
    return { archive, sha256: createHash('sha256').update(archive).digest('hex'), snapshot };
  }

  /**
   * Applies the node-computed patch to the fetched commit in a temporary index (`git apply
   * --cached`: no working tree, so no filters or attributes can run), commits with the platform
   * identity on a new branch and pushes it (create-only, never forced).
   */
  async applyAndPushBranch(input: {
    sha: string;
    patch: string;
    patchSha256: string;
    branch: string;
    message: string;
    identity: Identity;
    policy?: Partial<PatchPolicy> | undefined;
    /** Extra exact secret values that must not appear in the delivered text. */
    knownSecrets?: readonly string[] | undefined;
    dryRun?: boolean | undefined;
  }): Promise<PushReport> {
    let checked: CheckedPatch | undefined;
    try {
      assertSha(input.sha);
      const prefix = this.target.branchPrefix ?? 'oax/';
      assertNewBranch(input.branch, prefix);
      assertIdentity(input.identity);
      assertMessage(input.message);
      checked = checkPatch(input.patch, input.patchSha256, {
        pathAllow: DEFAULT_PATH_ALLOW,
        maxBytes: 65_536,
        maxFiles: 20,
        ...stripUndefined(input.policy),
      });
      if (this.fetched !== input.sha)
        throw new GitError('not_found', 'the commit has not been fetched');
      let token: string | undefined;
      try {
        token = await this.o.secrets.resolve(this.target.credential.tokenRef);
      } catch {
        throw new GitError('credential_unavailable', 'the Git credential is not available');
      }
      const known = [token, ...(input.knownSecrets ?? [])];
      const hits = scanForSecrets(`${input.patch}\n${input.message}`, known);
      if (hits.length > 0)
        throw new GitError(
          'secret_detected',
          'the patch or message contains credential-like content',
          {
            hits: hits.map((h) => ({ pattern: h.pattern, digest: h.digest, via: h.via })),
          },
        );
      const message = /^Signed-off-by: /m.test(input.message)
        ? input.message
        : `${input.message.replace(/\s+$/, '')}\n\nSigned-off-by: ${input.identity.name} <${input.identity.email}>\n`;
      const index = join(this.dir, 'index');
      const idxEnv = { GIT_INDEX_FILE: index };
      await this.localOk(['read-tree', input.sha], { env: idxEnv });
      const apply = ['apply', '--cached', '-p1', '--whitespace=nowarn', '-'];
      const chk = await this.local([...apply.slice(0, 1), '--check', ...apply.slice(1)], {
        stdin: input.patch,
        env: idxEnv,
      });
      if (chk.code !== 0)
        throw new GitError('patch_apply_failed', 'the patch does not apply to the base commit');
      await this.localOk(apply, { stdin: input.patch, env: idxEnv });
      const treeSha = (await this.localOk(['write-tree'], { env: idxEnv })).toString('utf8').trim();
      const baseTree = (
        await this.localOk(['rev-parse', '--verify', '--end-of-options', `${input.sha}^{tree}`])
      )
        .toString('utf8')
        .trim();
      if (treeSha === baseTree)
        throw new GitError('patch_apply_failed', 'the patch changes nothing');
      await this.verifyResult(input.sha, treeSha, checked);
      const when = Math.floor((this.o.now?.() ?? new Date()).getTime() / 1000);
      const idEnv = {
        GIT_AUTHOR_NAME: input.identity.name,
        GIT_AUTHOR_EMAIL: input.identity.email,
        GIT_AUTHOR_DATE: `${when} +0000`,
        GIT_COMMITTER_NAME: input.identity.name,
        GIT_COMMITTER_EMAIL: input.identity.email,
        GIT_COMMITTER_DATE: `${when} +0000`,
      };
      const commit = (
        await this.localOk(['commit-tree', treeSha, '-p', input.sha, '-F', '-'], {
          stdin: message,
          env: idEnv,
        })
      )
        .toString('utf8')
        .trim();
      if (!/^[0-9a-f]{40}$/.test(commit))
        throw new GitError('git_failed', 'the commit could not be created');
      await this.audit({
        action: 'git.apply',
        ok: true,
        baseSha: input.sha,
        treeSha,
        commit,
        patchSha256: checked.sha256,
        files: checked.files.length,
      });
      const report: PushReport = {
        branch: input.branch,
        commit,
        treeSha,
        baseSha: input.sha,
        patchSha256: checked.sha256,
        changedFiles: checked.files.length,
        sentBytes: 0,
        pushed: false,
      };
      if (input.dryRun) return report;

      const ref = `refs/heads/${input.branch}`;
      if ((await this.lsRemote(ref)) !== null)
        throw new GitError('branch_exists', 'the branch already exists');
      const { relay } = await this.network(
        [
          '--git-dir',
          this.bare,
          'push',
          '--porcelain',
          '--no-verify',
          '--no-follow-tags',
          '--no-signed',
          '--no-recurse-submodules',
          '--',
          this.repo.url,
          // create-only refspec without a leading plus sign; the host also checks the old value (zero id)
          `${commit}:${ref}`,
        ],
        {},
      );
      const remote = await this.lsRemote(ref);
      if (remote !== commit)
        throw new GitError('push_rejected', 'the pushed branch could not be verified');
      report.pushed = true;
      report.sentBytes = relay.stats.sent;
      await this.audit({
        action: 'git.push',
        ok: true,
        branch: input.branch,
        commit,
        baseSha: input.sha,
        patchSha256: checked.sha256,
        sentBytes: relay.stats.sent,
      });
      return report;
    } catch (e) {
      const err = this.redactError(e) as GitError;
      await this.audit({
        action:
          err.code === 'secret_detected' || err.code.startsWith('patch_')
            ? 'git.refused'
            : 'git.push',
        ok: false,
        code: err.code,
        ...(checked ? { patchSha256: checked.sha256 } : {}),
        ...(err.code === 'secret_detected'
          ? { hits: (err.details as { hits?: unknown })?.hits }
          : {}),
      });
      throw err;
    }
  }

  /** The resulting tree differs from the base exactly by the files of the patch, regular modes. */
  private async verifyResult(base: string, tree: string, checked: CheckedPatch): Promise<void> {
    const raw = (
      await this.localOk([
        'diff-tree',
        '-r',
        '-z',
        '--raw',
        '--no-renames',
        '--no-abbrev',
        base,
        tree,
      ])
    ).toString('utf8');
    const parts = raw.split('\0').filter(Boolean);
    const seen = new Map<string, string>();
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const m = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([A-Z])\d*$/.exec(parts[i]!);
      if (!m) throw new GitError('patch_apply_failed', 'unexpected result of the patch');
      const [, oldMode, newMode, status] = m as unknown as [string, string, string, string];
      const regular = (x: string) => x === '100644' || x === '100755' || x === '000000';
      if (!regular(oldMode) || !regular(newMode) || (status === 'M' && oldMode !== newMode))
        throw new GitError('patch_apply_failed', 'the patch changes modes or special files');
      seen.set(parts[i + 1]!, status);
    }
    const want = new Set(checked.files.map((f) => f.path));
    if (seen.size !== want.size || [...seen.keys()].some((p) => !want.has(p)))
      throw new GitError('patch_apply_failed', 'the result differs from the declared files');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
