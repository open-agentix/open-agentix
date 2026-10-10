import { secretForms } from '@openagentix/core';
import { Automaton } from './automaton.js';

/**
 * Process-wide set of secret values in use right now (OAuth access tokens handed out by
 * `McpCredentials`), consulted by everything that writes text outside the model context: log
 * lines, audit payloads, HTTP bodies, run streams and span attributes. It is the "log redactor" of
 * ADR 0016 section 7.5; the per-run `ContextGuard` is the other registration target.
 *
 * Scoping: a value belongs to a tenant. Log lines (tenant unknown) are scrubbed with all values;
 * audit payloads, responses and streams are scrubbed with the values of the tenant they are
 * written or served for, so one tenant's token can never blank text of another tenant.
 *
 * Deviation from "not cached beyond one call" (ADR 0016 section 7.5), recorded there: the registry
 * keeps token values in memory so the redactors can recognise them. Entries leave when the token
 * expires (plus a grace period), when the connection's tokens are revoked or deleted
 * (`forgetOwner`, `forgetOwnerPrefix`), and when a limit is hit (per-tenant quota first, then the
 * tenant with the most entries; least recently used first; the eviction handler is told). It is
 * per process: a token read in the worker is not known to the api, and vice versa.
 *
 * Matching is Aho-Corasick over every spelling of every value: linear in the text, independent of
 * how many values there are or how much they share.
 */
export const MAX_KNOWN_SECRETS = 4096;
export const MAX_SECRETS_PER_TENANT = 256;
/** Total characters over all indexed spellings; bounds memory and rebuild time of the automata. */
export const MAX_FORM_CHARS = 2_000_000;
export const REDACTED = '[REDACTED]';
/** An expired token stays registered this long, for late log lines of in-flight calls. */
export const EXPIRY_GRACE_MS = 5 * 60_000;
const DEFAULT_TTL_MS = 60 * 60_000;
const MIN_FORM = 8;
const PRUNE_EVERY_MS = 1000;
const MAX_CACHED_AUTOMATA = 64;
/** Scope key of the automaton over all values. */
const ALL = '*';
/** Tenant of a value registered without one: only the global scope sees it. */
const UNSCOPED = '';

interface Entry {
  forms: string[];
  chars: number;
  owner: string | undefined;
  tenant: string;
  expiresAt: number;
}

export interface RegistryOptions {
  now?: () => number;
  maxEntries?: number;
  maxPerTenant?: number;
  maxFormChars?: number;
  /** Called with the number of still-valid entries dropped to stay within a limit. */
  onLiveEviction?: (count: number) => void;
}

/** Every spelling worth matching: the guard's forms, JSON-escaped, lower-case percent-encoding. */
function spellings(value: string): string[] {
  const pct = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  const escaped = JSON.stringify(value).slice(1, -1);
  return [...new Set([...secretForms(value), escaped, pct])].filter((f) => f.length >= MIN_FORM);
}

export class SecretRegistry {
  /** Least recently used first. */
  private readonly entries = new Map<string, Entry>();
  private readonly automata = new Map<string, Automaton | null>();
  private totalChars = 0;
  private lastPrune = 0;
  private readonly now: () => number;
  private readonly max: number;
  private readonly maxPerTenant: number;
  private readonly maxChars: number;
  onLiveEviction: ((count: number) => void) | undefined;

  constructor(opts: RegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.max = opts.maxEntries ?? MAX_KNOWN_SECRETS;
    this.maxPerTenant = opts.maxPerTenant ?? MAX_SECRETS_PER_TENANT;
    this.maxChars = opts.maxFormChars ?? MAX_FORM_CHARS;
    this.onLiveEviction = opts.onLiveEviction;
  }

  /**
   * Registers (or refreshes) a value. `tenant` scopes audit/response scrubbing, `owner` groups the
   * values of one credential so that revocation can forget them, `ttlMs` is how long the value
   * stays valid for the caller.
   */
  register(value: string, opts: { owner?: string; tenant?: string; ttlMs?: number } = {}): void {
    if (value.length < MIN_FORM) return;
    this.prune(true);
    this.remove(value);
    const forms = spellings(value);
    const entry: Entry = {
      forms,
      chars: forms.reduce((n, f) => n + f.length, 0),
      owner: opts.owner,
      tenant: opts.tenant ?? UNSCOPED,
      expiresAt: this.now() + (opts.ttlMs ?? DEFAULT_TTL_MS) + EXPIRY_GRACE_MS,
    };
    // Re-adding moves the entry to the most recently used end of the map.
    this.entries.set(value, entry);
    this.totalChars += entry.chars;
    this.invalidate(entry.tenant);
    this.enforceLimits(entry.tenant);
  }

  /** Forgets every value registered for `owner` (a revoked or deleted credential). */
  forgetOwner(owner: string): void {
    this.forgetWhere((e) => e.owner === owner);
  }

  /** Forgets every value whose owner starts with `prefix` (all versions of a connection). */
  forgetOwnerPrefix(prefix: string): void {
    this.forgetWhere((e) => e.owner?.startsWith(prefix) === true);
  }

  get size(): number {
    return this.entries.size;
  }

  has(value: string): boolean {
    return this.entries.has(value);
  }

  clear(): void {
    this.entries.clear();
    this.automata.clear();
    this.totalChars = 0;
  }

  /**
   * Replaces every registered spelling in `text` with {@link REDACTED}. With `tenant` only that
   * tenant's values are used; without, all of them (log lines, where the tenant is unknown).
   */
  scrub(text: string, tenant?: string): string {
    if (this.entries.size === 0 || text.length < MIN_FORM) return text;
    this.prune(false);
    return this.automaton(tenant ?? ALL)?.replaceAll(text, REDACTED) ?? text;
  }

  private automaton(scope: string): Automaton | null {
    if (this.automata.has(scope)) return this.automata.get(scope) ?? null;
    const forms: string[] = [];
    for (const e of this.entries.values())
      if (scope === ALL || e.tenant === scope) forms.push(...e.forms);
    const built = forms.length === 0 ? null : new Automaton(forms);
    if (this.automata.size >= MAX_CACHED_AUTOMATA) {
      const oldest = this.automata.keys().next().value;
      if (oldest !== undefined) this.automata.delete(oldest);
    }
    this.automata.set(scope, built);
    return built;
  }

  private invalidate(tenant: string): void {
    this.automata.delete(ALL);
    this.automata.delete(tenant);
  }

  private remove(value: string): void {
    const e = this.entries.get(value);
    if (!e) return;
    this.entries.delete(value);
    this.totalChars -= e.chars;
    this.invalidate(e.tenant);
  }

  private forgetWhere(match: (e: Entry) => boolean): void {
    for (const [value, e] of [...this.entries]) if (match(e)) this.remove(value);
  }

  private prune(force: boolean): void {
    const now = this.now();
    if (!force && now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    this.forgetWhere((e) => e.expiresAt <= now);
  }

  /** Per-tenant quota first (a tenant can only push out its own values), then the global limits. */
  private enforceLimits(tenant: string): void {
    let live = 0;
    while (this.countOf(tenant) > this.maxPerTenant && this.evictOldest(tenant)) live++;
    while (
      (this.entries.size > this.max || this.totalChars > this.maxChars) &&
      this.evictOldest(this.busiestTenant())
    )
      live++;
    if (live > 0) this.onLiveEviction?.(live);
  }

  private countOf(tenant: string): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.tenant === tenant) n++;
    return n;
  }

  private busiestTenant(): string {
    const chars = new Map<string, number>();
    for (const e of this.entries.values())
      chars.set(e.tenant, (chars.get(e.tenant) ?? 0) + e.chars);
    let best = UNSCOPED;
    let most = -1;
    for (const [t, n] of chars)
      if (n > most) {
        best = t;
        most = n;
      }
    return best;
  }

  private evictOldest(tenant: string): boolean {
    for (const [value, e] of this.entries)
      if (e.tenant === tenant) {
        this.remove(value);
        return true;
      }
    return false;
  }
}

/** The registry of this process. Tests that need isolation create their own. */
export const processSecrets = new SecretRegistry();
