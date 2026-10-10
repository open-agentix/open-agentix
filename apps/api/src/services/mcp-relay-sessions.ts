import type { ToolGateway } from '@openagentix/mcp';
import { HttpError } from '../errors.js';

/**
 * Relay sessions of the control-node MCP relay (ADR 0016 section 6): one connection to one HTTP MCP
 * server, keyed by `(tenant, connection, credential version, run)`. A rotated secret or an edited
 * connection changes the key, so the old session (and the credentials it connected with) is never
 * used again. Everything here is bounded: sessions, calls in flight and calls per minute.
 */
export interface RelayLimits {
  /** Calls in flight per session. */
  concurrency: number;
  /** Calls per minute per session. */
  ratePerMinute: number;
  /** Open sessions per replica. */
  maxSessions: number;
  /** A session nobody used for this long is closed. */
  idleMs: number;
}

export interface RelaySession {
  readonly key: string;
  readonly runId: string;
  readonly gateway: ToolGateway;
  inflight: number;
  /** Start times (ms) of the calls of the last minute. */
  hits: number[];
  lastUsed: number;
}

const WINDOW_MS = 60_000;

/** Key of a session: the four values ADR 0012 section 4 names, nothing a node controls. */
export const relaySessionKey = (
  tenantId: string,
  connectionId: string,
  credentialVersion: string,
  runId: string,
): string => `${tenantId}:${connectionId}:${credentialVersion}:${runId}`;

export class RelaySessions {
  private readonly sessions = new Map<string, RelaySession>();
  private readonly creating = new Map<string, Promise<RelaySession>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly limits: RelayLimits,
    private readonly now: () => number,
    private readonly onSize: (open: number) => void,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  /** The session of `key`, created once even when requests race. Throws `mcp_relay_busy` when full. */
  async getOrCreate(
    key: string,
    runId: string,
    create: () => Promise<ToolGateway>,
  ): Promise<RelaySession> {
    this.sweep();
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const pending = this.creating.get(key);
    if (pending) return pending;
    if (this.sessions.size + this.creating.size >= this.limits.maxSessions && !this.evictOne())
      throw new HttpError(503, 'mcp_relay_busy', 'the MCP relay has no free session');
    const made = (async () => {
      const session: RelaySession = {
        key,
        runId,
        gateway: await create(),
        inflight: 0,
        hits: [],
        lastUsed: this.now(),
      };
      this.sessions.set(key, session);
      this.onSize(this.sessions.size);
      this.arm();
      return session;
    })().finally(() => this.creating.delete(key));
    this.creating.set(key, made);
    return made;
  }

  /**
   * Takes a slot for one call: refuses when the session already runs `concurrency` calls or has
   * made `ratePerMinute` calls in the last minute. The returned function gives the slot back.
   */
  acquire(session: RelaySession): () => void {
    const now = this.now();
    session.lastUsed = now;
    session.hits = session.hits.filter((t) => now - t < WINDOW_MS);
    if (session.inflight >= this.limits.concurrency)
      throw new HttpError(429, 'mcp_relay_busy', 'too many concurrent MCP calls in this session');
    if (session.hits.length >= this.limits.ratePerMinute)
      throw new HttpError(429, 'rate_limited', 'too many MCP calls in this session');
    session.hits.push(now);
    session.inflight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.inflight--;
      session.lastUsed = this.now();
    };
  }

  /** Closes every session of a run (its node session was revoked). */
  dropRun(runId: string): void {
    for (const s of [...this.sessions.values()]) if (s.runId === runId) this.drop(s);
  }

  async closeAll(): Promise<void> {
    this.disarm();
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.onSize(0);
    await Promise.allSettled(all.map((s) => s.gateway.close()));
  }

  private drop(s: RelaySession): void {
    if (this.sessions.get(s.key) !== s) return;
    this.sessions.delete(s.key);
    this.onSize(this.sessions.size);
    void s.gateway.close().catch(() => undefined);
  }

  /** Closes the sessions that have been idle for too long and have nothing in flight. */
  sweep(): void {
    const now = this.now();
    for (const s of this.sessions.values())
      if (s.inflight === 0 && now - s.lastUsed > this.limits.idleMs) this.drop(s);
    if (this.sessions.size === 0) this.disarm();
  }

  /**
   * Idle sessions are closed even when no request comes in: the node session that used them may
   * have been revoked by another process (the worker), which this replica never hears about.
   */
  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), Math.min(this.limits.idleMs, 30_000));
    this.timer.unref();
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Makes room by closing the least recently used idle session; false when all are busy. */
  private evictOne(): boolean {
    let oldest: RelaySession | undefined;
    for (const s of this.sessions.values())
      if (s.inflight === 0 && (!oldest || s.lastUsed < oldest.lastUsed)) oldest = s;
    if (!oldest) return false;
    this.drop(oldest);
    return true;
  }
}
