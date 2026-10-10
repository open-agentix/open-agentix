import { secretForms } from '@openagentix/core';

/**
 * Process-wide set of secret values in use right now (OAuth access tokens handed out by
 * `McpCredentials`), consulted by everything that writes text outside the model context: log
 * lines, audit payloads, HTTP bodies and run streams. It is the "log redactor" of ADR 0016
 * section 7.5; the per-run `ContextGuard` and the telemetry guard are the other targets.
 *
 * Deviation from "not cached beyond one call" (ADR 0016 section 7.5), recorded there: the registry
 * keeps token values in memory so the redactors can recognise them. Entries leave when the token
 * expires (plus a grace period), when the connection's tokens are revoked or deleted
 * (`forgetOwner`), and when the registry is full (least recently used first). It is per process:
 * a token read in the worker is not known to the api, and vice versa.
 *
 * Matching is by an index of the first {@link PREFIX} characters of every spelling of every
 * secret, so the cost of `scrub` grows with the text, not with the number of secrets.
 */
export const MAX_KNOWN_SECRETS = 4096;
export const REDACTED = '[REDACTED]';
/** An expired token stays registered this long, for late log lines of in-flight calls. */
export const EXPIRY_GRACE_MS = 5 * 60_000;
const DEFAULT_TTL_MS = 60 * 60_000;
const PREFIX = 8;
const PRUNE_EVERY_MS = 1000;

interface Entry {
  forms: string[];
  owner: string | undefined;
  expiresAt: number;
}

export interface RegistryOptions {
  now?: () => number;
  maxEntries?: number;
  /** Called with the number of still-valid entries dropped because the registry was full. */
  onLiveEviction?: (count: number) => void;
}

export class SecretRegistry {
  private readonly entries = new Map<string, Entry>();
  private index = new Map<string, string[]>();
  private firstChars = new Set<string>();
  private dirty = false;
  private lastPrune = 0;
  private readonly now: () => number;
  private readonly max: number;
  private readonly onLiveEviction: ((count: number) => void) | undefined;

  constructor(opts: RegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.max = opts.maxEntries ?? MAX_KNOWN_SECRETS;
    this.onLiveEviction = opts.onLiveEviction;
  }

  /**
   * Registers (or refreshes) a value. `owner` groups the values of one credential so that
   * revocation can forget them; `ttlMs` is how long the value stays valid for the caller.
   */
  register(value: string, opts: { owner?: string; ttlMs?: number } = {}): void {
    if (value.length < PREFIX) return;
    const now = this.now();
    const expiresAt = now + (opts.ttlMs ?? DEFAULT_TTL_MS) + EXPIRY_GRACE_MS;
    // Re-adding moves the entry to the most recently used end of the map.
    this.entries.delete(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    const forms = [...new Set([...secretForms(value), escaped])].filter((f) => f.length >= PREFIX);
    this.entries.set(value, { forms, owner: opts.owner, expiresAt });
    this.dirty = true;
    this.prune(true);
    this.evictOverflow();
  }

  /** Forgets every value registered for `owner` (a revoked or deleted credential). */
  forgetOwner(owner: string): void {
    for (const [value, e] of this.entries)
      if (e.owner === owner) {
        this.entries.delete(value);
        this.dirty = true;
      }
  }

  get size(): number {
    return this.entries.size;
  }

  has(value: string): boolean {
    return this.entries.has(value);
  }

  clear(): void {
    this.entries.clear();
    this.dirty = true;
  }

  /** Replaces every registered spelling in `text` with {@link REDACTED}. */
  scrub(text: string): string {
    if (this.entries.size === 0 && !this.dirty) return text;
    this.prune(false);
    this.rebuild();
    if (this.index.size === 0 || text.length < PREFIX) return text;
    let out = '';
    let last = 0;
    let i = 0;
    const end = text.length - PREFIX;
    while (i <= end) {
      if (this.firstChars.has(text[i] as string)) {
        const hit = this.match(text, i);
        if (hit > 0) {
          out += text.slice(last, i) + REDACTED;
          i += hit;
          last = i;
          continue;
        }
      }
      i++;
    }
    return last === 0 ? text : out + text.slice(last);
  }

  private match(text: string, at: number): number {
    const candidates = this.index.get(text.slice(at, at + PREFIX));
    if (!candidates) return 0;
    for (const f of candidates) if (text.startsWith(f, at)) return f.length;
    return 0;
  }

  private prune(force: boolean): void {
    const now = this.now();
    if (!force && now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    for (const [value, e] of this.entries)
      if (e.expiresAt <= now) {
        this.entries.delete(value);
        this.dirty = true;
      }
  }

  /** Least recently used first; expired entries are already gone (see {@link prune}). */
  private evictOverflow(): void {
    let live = 0;
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      live++;
    }
    if (live > 0) this.onLiveEviction?.(live);
  }

  private rebuild(): void {
    if (!this.dirty) return;
    const index = new Map<string, string[]>();
    for (const e of this.entries.values())
      for (const f of e.forms) {
        const key = f.slice(0, PREFIX);
        const list = index.get(key);
        if (list) list.push(f);
        else index.set(key, [f]);
      }
    // Longest first, so a secret that contains another one is replaced as a whole.
    for (const list of index.values()) list.sort((a, b) => b.length - a.length);
    this.index = index;
    this.firstChars = new Set([...index.keys()].map((k) => k[0] as string));
    this.dirty = false;
  }
}

/** The registry of this process. Tests that need isolation create their own. */
export const processSecrets = new SecretRegistry();
