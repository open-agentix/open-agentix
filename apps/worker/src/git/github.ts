import { createHash } from 'node:crypto';
import { redactString, type SecretResolver } from '@openagentix/core';
import {
  findOaxError,
  type OutboundContext,
  type OutboundDispatcher,
} from '@openagentix/providers';
import { GitError } from './errors.js';
import { scanForSecrets } from './secret-scan.js';
import { parseRepoUrl } from './validate.js';

/**
 * Minimal GitHub extension (ADR 0010 Amendment 1 A1.8 slice, dogfooding DOG-3b). It can do exactly
 * two things on exactly one repository: list the open pull requests (to count them) and open a
 * DRAFT pull request. There is no other endpoint in this module: nothing that closes, reviews,
 * labels or dispatches anything, and nothing that completes a pull request. The rules are code,
 * not prompt: the path is built from the configured repository only, `draft` is a constant, head
 * and base are checked, the open-PR limit is queried before every creation, and title, body are
 * scanned for credential-like text before they leave. The extension has its OWN credential
 * reference (A1.2: the sync/push credential, the PR-back credential and the extension credential
 * are separate code paths); responses are reduced to `{ number, url, state, draft }`.
 */
export interface GitHubExtensionOptions {
  dispatcher: OutboundDispatcher;
  secrets: SecretResolver;
  /** The extension's own secret reference (not the Git push credential's). */
  tokenRef: string;
  /** The configured repository URL (`https://github.com/owner/name`): the one allowed repository. */
  repositoryUrl: string;
  /** Default `main`. Callers cannot choose another base. */
  baseBranch?: string | undefined;
  /** Default `oax/bug-fix/`. Every head must start with it. */
  branchPrefix?: string | undefined;
  /** Open pull requests allowed under the prefix (default 2). */
  maxOpenPullRequests?: number | undefined;
  /** Pull request body cap in bytes (default 16 KiB). */
  maxBodyBytes?: number | undefined;
  privateAllow?: readonly string[] | undefined;
  lookup?: ((host: string) => Promise<{ address: string }[]>) | undefined;
  timeoutMs?: number | undefined;
  audit?: ((e: Record<string, unknown>) => void | Promise<void>) | undefined;
  now?: (() => Date) | undefined;
}

export interface PullRequestRef {
  number: number;
  url: string;
  state: 'open';
  draft: true;
}

export interface OpenDraftInput {
  head: string;
  /** Optional; must equal the configured base if given. */
  base?: string | undefined;
  title: string;
  body: string;
}

interface PullInfo {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean | undefined;
  headRef?: string | undefined;
  headRepo?: string | undefined;
}

/** Strict reduction of a host answer to the few fields used; anything else is dropped. */
function pull(v: unknown): PullInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.number !== 'number' || !Number.isSafeInteger(o.number) || o.number < 1) return null;
  if (typeof o.html_url !== 'string' || o.html_url.length > 500) return null;
  if (typeof o.state !== 'string') return null;
  const head =
    o.head && typeof o.head === 'object' ? (o.head as Record<string, unknown>) : undefined;
  const repo =
    head?.repo && typeof head.repo === 'object'
      ? (head.repo as Record<string, unknown>)
      : undefined;
  return {
    number: o.number,
    html_url: o.html_url,
    state: o.state,
    draft: typeof o.draft === 'boolean' ? o.draft : undefined,
    headRef: typeof head?.ref === 'string' && head.ref.length <= 300 ? head.ref : undefined,
    headRepo: typeof repo?.full_name === 'string' ? repo.full_name : undefined,
  };
}

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PAGES = 5;

/** `owner/name` of a `https://<host>/owner/name` URL and the API/HTML bases by fixed rules. */
export function githubRepository(url: string) {
  const u = parseRepoUrl(url);
  const parts = u.path.split('/');
  if (parts.length !== 2)
    throw new GitError('target_invalid', 'a GitHub repository URL is host/owner/name');
  const [owner, nameRaw] = parts as [string, string];
  const name = nameRaw.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name))
    throw new GitError('target_invalid', 'unusual GitHub repository name');
  const origin = `https://${u.host}${u.port === 443 ? '' : `:${u.port}`}`;
  return {
    owner,
    name,
    full: `${owner}/${name}`,
    apiBase: u.host === 'github.com' ? 'https://api.github.com' : `${origin}/api/v3`,
    htmlBase: origin,
  };
}

const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Title: one line, printable, 72 characters at most. */
export function sanitizeTitle(raw: string): string {
  const t = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...t].slice(0, 72).join('').trim();
}

export class GitHubExtension {
  readonly provider = 'github' as const;
  readonly capabilities = {
    openChangeRequest: true,
    readChangeRequest: false,
    readBranchProtection: false,
  } as const;
  private readonly repo: ReturnType<typeof githubRepository>;
  private readonly base: string;
  private readonly prefix: string;
  private readonly maxOpen: number;
  private readonly maxBody: number;
  /** Count and creation are one critical section (single worker; see docs). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: GitHubExtensionOptions) {
    this.repo = githubRepository(o.repositoryUrl);
    this.base = o.baseBranch ?? 'main';
    this.prefix = o.branchPrefix ?? 'oax/bug-fix/';
    this.maxOpen = o.maxOpenPullRequests ?? 2;
    this.maxBody = o.maxBodyBytes ?? 16 * 1024;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(this.base) || this.base.includes('..'))
      throw new GitError('target_invalid', 'invalid base branch');
    if (!/^oax\/[a-z0-9][a-z0-9-]*\/$/.test(this.prefix))
      throw new GitError('branch_prefix_refused', 'the branch prefix must look like oax/<agent>/');
    if (!Number.isInteger(this.maxOpen) || this.maxOpen < 1 || this.maxOpen > 10)
      throw new GitError('target_invalid', 'invalid open pull request limit');
  }

  /** The one allowed API path; nothing else is ever requested. */
  private get pullsPath(): string {
    return `/repos/${this.repo.full}/pulls`;
  }

  private ctx(): OutboundContext {
    return {
      purpose: 'git',
      scope: { origin: 'platform' },
      pin: {
        allow: [...(this.o.privateAllow ?? [])],
        ...(this.o.lookup ? { lookup: this.o.lookup } : {}),
      },
      timeoutMs: this.o.timeoutMs ?? 20_000,
    };
  }

  private async call(method: 'GET' | 'POST', query: string, body?: unknown): Promise<unknown> {
    let token: string;
    try {
      token = await this.o.secrets.resolve(this.o.tokenRef);
    } catch {
      throw new GitError('credential_unavailable', 'the extension credential is not available');
    }
    const url = `${this.repo.apiBase}${this.pullsPath}${query}`;
    try {
      const res = await this.o.dispatcher.fetch(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'openagentix-pr-delivery',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        this.ctx(),
      );
      const text = await readCapped(res);
      if (res.status === 401 || res.status === 403)
        throw new GitError('auth_failed', 'the host refused the credential');
      if (res.status === 404) throw new GitError('not_found', 'the repository was not found');
      if (res.status < 200 || res.status >= 300)
        throw new GitError('host_request_failed', `the host answered ${res.status}`);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new GitError('host_response_invalid', 'the host answer is not JSON');
      }
    } catch (e) {
      if (e instanceof GitError) throw e;
      const code = findOaxError(e)?.code ?? (e as { code?: unknown })?.code;
      if (code === 'egress_denied')
        throw new GitError('egress_denied', 'the connection to the Git host is not allowed');
      if (code === 'response_too_large')
        throw new GitError('host_response_invalid', 'the host answer is too large');
      throw new GitError(
        'host_request_failed',
        redactString('the request to the host failed', [token]),
      );
    }
  }

  /** Open pull requests of this repository whose head branch starts with `headPrefix`. */
  async countOpenPullRequests(headPrefix: string = this.prefix): Promise<number> {
    if (!headPrefix.startsWith('oax/') || !/^[A-Za-z0-9/._-]{4,100}$/.test(headPrefix))
      throw new GitError('branch_prefix_refused', 'the head prefix is not acceptable');
    let n = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = await this.call('GET', `?state=open&per_page=100&page=${page}`);
      if (!Array.isArray(raw) || raw.length > 100)
        throw new GitError('host_response_invalid', 'unexpected pull request list');
      for (const item of raw) {
        const p = pull(item);
        if (!p) throw new GitError('host_response_invalid', 'unexpected pull request list');
        const sameRepo = !p.headRepo || p.headRepo.toLowerCase() === this.repo.full.toLowerCase();
        if (sameRepo && p.headRef?.startsWith(headPrefix)) n++;
      }
      if (raw.length < 100) return n;
    }
    // more than 500 open pull requests: certainly over any limit
    return Number.MAX_SAFE_INTEGER;
  }

  /** Opens a DRAFT pull request from `head` into the configured base. Nothing else. */
  openDraftPullRequest(input: OpenDraftInput): Promise<PullRequestRef> {
    const run = this.chain.then(() => this.open(input));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async open(input: OpenDraftInput): Promise<PullRequestRef> {
    const at = (this.o.now?.() ?? new Date()).toISOString();
    const log = (e: Record<string, unknown>) =>
      Promise.resolve(
        this.o.audit?.({ action: 'git.pr_open', at, repo: this.repo.full, ...e }),
      ).catch(() => undefined);
    const bodyBytes = Buffer.byteLength(input.body ?? '');
    try {
      const head = input.head;
      if (
        typeof head !== 'string' ||
        !head.startsWith(this.prefix) ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(head) ||
        head.length === this.prefix.length ||
        head.includes('..') ||
        head.endsWith('/') ||
        head.endsWith('.') ||
        head.split('/').some((s) => s === '' || s.startsWith('.') || s.endsWith('.lock'))
      )
        throw new GitError(
          'branch_prefix_refused',
          'the head branch is outside the allowed prefix',
        );
      if (input.base !== undefined && input.base !== this.base)
        throw new GitError('target_invalid', 'the base branch is fixed by the configuration');
      const title = sanitizeTitle(input.title);
      if (title.length === 0) throw new GitError('target_invalid', 'the title is empty');
      if (bodyBytes > this.maxBody)
        throw new GitError('pr_body_too_large', 'the pull request body is too large');
      const token = await this.o.secrets.resolve(this.o.tokenRef).catch(() => '');
      const hits = scanForSecrets(`${title}\n${input.body}`, token ? [token] : []);
      if (hits.length > 0)
        throw new GitError(
          'secret_detected',
          'the pull request text contains credential-like content',
          {
            hits: hits.map((h) => ({ pattern: h.pattern, digest: h.digest, via: h.via })),
          },
        );
      const open = await this.countOpenPullRequests(this.prefix);
      if (open >= this.maxOpen)
        throw new GitError('pr_limit_reached', 'too many open pull requests');
      const raw = await this.call('POST', '', {
        title,
        head,
        base: this.base,
        body: input.body,
        draft: true,
        maintainer_can_modify: false,
      });
      const parsed = pull(raw);
      const htmlPrefix = `${this.repo.htmlBase}/${this.repo.full}/pull/`;
      if (
        !parsed ||
        !parsed.html_url.startsWith(htmlPrefix) ||
        parsed.state !== 'open' ||
        parsed.draft !== true
      ) {
        await log({ ok: false, code: 'host_response_invalid', head, number: parsed?.number });
        throw new GitError('host_response_invalid', 'unexpected answer for the new pull request', {
          number: parsed?.number,
        });
      }
      const ref: PullRequestRef = {
        number: parsed.number,
        url: parsed.html_url,
        state: 'open',
        draft: true,
      };
      await log({
        ok: true,
        head,
        base: this.base,
        number: ref.number,
        titleDigest: digest(title),
        bodyDigest: digest(input.body),
        bodyBytes,
      });
      return ref;
    } catch (e) {
      const err =
        e instanceof GitError
          ? e
          : new GitError('host_request_failed', 'the pull request could not be opened');
      if (err.code !== 'host_response_invalid')
        await log({
          ok: false,
          code: err.code,
          head: input.head,
          bodyBytes,
          ...(err.code === 'secret_detected'
            ? { hits: (err.details as { hits?: unknown })?.hits }
            : {}),
        });
      throw err;
    }
  }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw Object.assign(new Error('too large'), { code: 'response_too_large' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
