import {
  createAuditEntry,
  loadPrivateKey,
  publicKeyFrom,
  signCheckpoint,
  verifyAuditChain,
  type AuditCheckpoint,
  type AuditEntry,
  type AuditEntryInput,
  type VerifyResult,
  isSpanId,
  isTraceId,
  runTraceIdentity,
} from '@openagentix/core';
import type { KeyObject } from 'node:crypto';
import { and, asc, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { auditCheckpoints, auditLog, runs } from '../db/schema.js';
import { decodeSeqCursor, encodeSeqCursor, page } from '../pagination.js';
import { activeGuardedSpan, activeSpanIdIn } from '../telemetry.js';

const AUDIT_LOCK = 734_201;

type Row = typeof auditLog.$inferSelect;

export function rowToEntry(r: Row): AuditEntry {
  return {
    seq: r.seq,
    ts: r.ts.toISOString(),
    actor: r.actor,
    action: r.action,
    target: r.target,
    runId: r.runId,
    payload: r.payload ?? null,
    payloadDigest: r.payloadDigest,
    prevHash: r.prevHash,
    hash: r.hash,
  };
}

/** What services append; `tenantId` is the partition key (resolved from the run when omitted). */
export type AuditAppend = AuditEntryInput & {
  tenantId?: string | null;
  /**
   * The entry documents the span that is active now (ADR 0015 section 11): `payload.otel.spanId` is
   * that span, and, once the entry is committed, the span gets `oax.audit.seq`. Without it (or when
   * the active span is not part of the run's trace) `spanId` is the root span of the run's trace.
   */
  linkSpan?: boolean;
};

/** What an audit entry of a run records about the run's trace (ids only, set by the server). */
export interface AuditOtel {
  traceId: string;
  spanId: string;
}

/** Immutable per run: the tenant and the trace identity written at creation. */
interface RunIdentity {
  tenantId: string;
  traceId: string | null;
  rootSpanId: string | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Sets the reserved `otel` key of a payload. A caller-supplied `otel` is always removed (the field
 * is only ever written here, from the run row), so neither a node report nor a service can forge a
 * link. A payload that is not a plain object (an array, a string) cannot carry the field and stays
 * as it is.
 */
export function withOtel(payload: unknown, otel: AuditOtel | null): unknown {
  if (payload === undefined || payload === null) return otel ? { otel } : (payload ?? null);
  if (!isPlainObject(payload)) return payload;
  const { otel: _forged, ...rest } = payload;
  void _forged;
  return otel ? { ...rest, otel } : rest;
}

export interface AuditListFilter {
  /** Restricts the view to one tenant; `'all'` is for platform operators only. */
  tenantId: string | 'all';
  runId?: string | undefined;
  action?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

const tenantCondition = (tenantId: string | 'all') =>
  tenantId === 'all' ? undefined : eq(auditLog.tenantId, tenantId);

/** Appends to the hash-chained audit log (serialised via an advisory lock) and verifies it. */
export class AuditService {
  private readonly signingKey: KeyObject | null;
  private readonly publicKeys: Record<string, KeyObject>;

  constructor(private readonly ctx: AppContext) {
    this.signingKey = ctx.config.audit.signingKey
      ? loadPrivateKey(ctx.config.audit.signingKey)
      : null;
    this.publicKeys = Object.fromEntries(
      Object.entries(ctx.config.audit.publicKeys).map(([k, pem]) => [k, publicKeyFrom(pem)]),
    );
    if (this.signingKey)
      this.publicKeys[ctx.config.audit.signingKeyId] ??= publicKeyFrom(this.signingKey);
  }

  /** Tenant and trace identity of a run (immutable, so cached for a long time). */
  private async identityOfRun(runId: string, db: Db = this.ctx.db): Promise<RunIdentity | null> {
    const key = `run-ident:${runId}`;
    const hit = await this.ctx.cache.get<RunIdentity>(key);
    if (hit) return hit;
    const [r] = await db
      .select({ t: runs.tenantId, traceId: runs.traceId, root: runs.traceRootSpanId })
      .from(runs)
      .where(sql`${runs.id} = ${runId}`);
    if (!r) return null;
    const trace = runTraceIdentity({ traceId: r.traceId, traceRootSpanId: r.root });
    const identity: RunIdentity = {
      tenantId: r.t,
      traceId: trace?.traceId ?? null,
      rootSpanId: trace?.rootSpanId ?? null,
    };
    // Not cached inside a caller's transaction: the run row may still roll back.
    if (db === this.ctx.db) await this.ctx.cache.set(key, identity, 3_600_000);
    return identity;
  }

  /** Appends one entry; pass `tx` to make it part of a surrounding transaction. */
  async append(input: AuditAppend, tx?: Db): Promise<AuditEntry> {
    const { tenantId: explicit, linkSpan, ...entryInput } = input;
    const identity = input.runId ? await this.identityOfRun(input.runId, tx ?? this.ctx.db) : null;
    const tenantId = explicit ?? identity?.tenantId ?? null;
    // payload.otel = { traceId, spanId } from the run row (ADR 0015 section 11). Part of the hashed
    // payload, present with or without an exporter; absent for runs created before the trace
    // identity existed (their entries and hashes are untouched).
    let otel: AuditOtel | null = null;
    // Only when the entry belongs to the run's own tenant: an `access.denied` entry that a principal
    // of another tenant causes for a foreign run id lands in the caller's audit view and must not
    // carry the foreign run's trace id.
    const ownTenant =
      identity !== null &&
      (explicit === undefined || explicit === null || explicit === identity.tenantId);
    if (ownTenant && identity.traceId && identity.rootSpanId) {
      const active = linkSpan ? activeSpanIdIn(identity.traceId) : undefined;
      const spanId = active ?? identity.rootSpanId;
      if (isTraceId(identity.traceId) && isSpanId(spanId))
        otel = { traceId: identity.traceId, spanId };
    }
    const run = async (db: Db) => {
      await db.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK})`);
      const [prev] = await db
        .select({ seq: auditLog.seq, hash: auditLog.hash })
        .from(auditLog)
        .orderBy(desc(auditLog.seq))
        .limit(1);
      const entry = createAuditEntry(prev ?? null, {
        ...entryInput,
        payload: withOtel(entryInput.payload, otel),
        ts: input.ts ?? this.ctx.now(),
      });
      await db.insert(auditLog).values({
        seq: entry.seq,
        tenantId,
        ts: new Date(entry.ts),
        actor: entry.actor,
        action: entry.action,
        target: entry.target,
        runId: entry.runId,
        payload: entry.payload as object,
        payloadDigest: entry.payloadDigest,
        prevHash: entry.prevHash,
        hash: entry.hash,
      });
      if (this.signingKey && entry.seq % this.ctx.config.audit.checkpointEvery === 0) {
        await this.insertCheckpoint(db, entry);
      }
      return entry;
    };
    const entry = tx
      ? await run(tx)
      : await this.ctx.db.transaction((t) => run(t as unknown as Db));
    // Reverse link, only once the entry is committed (inside a caller's transaction it may still
    // roll back, so the caller links after its own commit).
    if (linkSpan && !tx && otel)
      activeGuardedSpan(otel.traceId)?.setAttributes({ 'oax.audit.seq': entry.seq });
    return entry;
  }

  private async insertCheckpoint(
    db: Db,
    head: Pick<AuditEntry, 'seq' | 'hash'>,
  ): Promise<AuditCheckpoint> {
    const cp = signCheckpoint(
      head,
      this.signingKey!,
      this.ctx.config.audit.signingKeyId,
      this.ctx.now(),
    );
    await db
      .insert(auditCheckpoints)
      .values({
        seq: cp.seq,
        hash: cp.hash,
        ts: new Date(cp.ts),
        keyId: cp.keyId,
        signature: cp.signature,
      })
      .onConflictDoNothing();
    return cp;
  }

  /** Signs the current head of the chain. */
  async checkpoint(): Promise<AuditCheckpoint | null> {
    if (!this.signingKey) return null;
    const [head] = await this.ctx.db
      .select({ seq: auditLog.seq, hash: auditLog.hash })
      .from(auditLog)
      .orderBy(desc(auditLog.seq))
      .limit(1);
    if (!head) return null;
    return this.insertCheckpoint(this.ctx.db, head);
  }

  async listCheckpoints(): Promise<AuditCheckpoint[]> {
    const rows = await this.ctx.db
      .select()
      .from(auditCheckpoints)
      .orderBy(desc(auditCheckpoints.seq))
      .limit(1000);
    return rows.map((r) => ({
      seq: r.seq,
      hash: r.hash,
      ts: r.ts.toISOString(),
      keyId: r.keyId,
      signature: r.signature,
    }));
  }

  async list(
    filter: AuditListFilter,
    limit: number,
    cursor?: string,
  ): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
    const before = decodeSeqCursor(cursor);
    const conds = [
      tenantCondition(filter.tenantId),
      filter.runId ? eq(auditLog.runId, filter.runId) : undefined,
      filter.action ? eq(auditLog.action, filter.action) : undefined,
      filter.from ? gte(auditLog.ts, filter.from) : undefined,
      filter.to ? lte(auditLog.ts, filter.to) : undefined,
      before !== null ? lt(auditLog.seq, before) : undefined,
    ].filter(Boolean);
    const rows = await this.ctx.db
      .select()
      .from(auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.seq))
      .limit(limit + 1);
    return page(rows.map(rowToEntry), limit, (e) => encodeSeqCursor(e.seq));
  }

  /** Verifies the chain between two sequence numbers (streaming in batches). */
  async verify(fromSeq = 1, toSeq?: number, batch = 5000): Promise<VerifyResult> {
    let anchor: { seq: number; hash: string } | null = null;
    if (fromSeq > 1) {
      const [a] = await this.ctx.db
        .select({ seq: auditLog.seq, hash: auditLog.hash })
        .from(auditLog)
        .where(eq(auditLog.seq, fromSeq - 1));
      anchor = a ?? null;
    }
    const checkpoints = await this.listCheckpoints();
    const total: VerifyResult = {
      valid: true,
      checkedEntries: 0,
      checkedCheckpoints: 0,
      headSeq: anchor?.seq ?? 0,
      headHash: anchor?.hash ?? '0'.repeat(64),
      issues: [],
    };
    let next = fromSeq;
    for (;;) {
      const rows = await this.ctx.db
        .select()
        .from(auditLog)
        .where(
          and(gte(auditLog.seq, next), toSeq !== undefined ? lte(auditLog.seq, toSeq) : undefined),
        )
        .orderBy(asc(auditLog.seq))
        .limit(batch);
      if (rows.length === 0) break;
      const r = verifyAuditChain(rows.map(rowToEntry), {
        anchor: total.headSeq > 0 || anchor ? { seq: total.headSeq, hash: total.headHash } : null,
        checkpoints,
        publicKeys: this.publicKeys,
      });
      total.checkedEntries += r.checkedEntries;
      total.checkedCheckpoints += r.checkedCheckpoints;
      total.issues.push(...r.issues);
      total.headSeq = r.headSeq;
      total.headHash = r.headHash;
      next = r.headSeq + 1;
      if (rows.length < batch) break;
    }
    total.valid = total.issues.length === 0;
    return total;
  }

  /**
   * Chain verification for a tenant. The chain itself is global, so the whole chain is verified,
   * but only issues that concern the tenant's own entries are reported and no other tenant's
   * entry counts or head hashes are revealed (the head is the tenant's own latest entry).
   */
  async verifyForTenant(tenantId: string): Promise<VerifyResult> {
    const full = await this.verify();
    const own = await this.ctx.db
      .select({ seq: auditLog.seq, hash: auditLog.hash })
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantId));
    const seqs = new Set(own.map((r) => r.seq));
    // The head reported to a tenant is the tenant's own latest entry (its sequence number and
    // real hash), never the global head, which would reveal how much other tenants write.
    const head = own.reduce<{ seq: number; hash: string } | null>(
      (h, r) => (h === null || r.seq > h.seq ? r : h),
      null,
    );
    const issues = full.issues.filter((i) => seqs.has(i.seq));
    return {
      valid: full.valid,
      checkedEntries: own.length,
      checkedCheckpoints: 0,
      headSeq: head?.seq ?? 0,
      headHash: head?.hash ?? '0'.repeat(64),
      issues,
    };
  }

  /** Async iterator over all entries (NDJSON export). */
  async *export(filter: AuditListFilter, batch = 1000): AsyncGenerator<AuditEntry> {
    let after = 0;
    for (;;) {
      const conds = [
        tenantCondition(filter.tenantId),
        sql`${auditLog.seq} > ${after}`,
        filter.runId ? eq(auditLog.runId, filter.runId) : undefined,
        filter.action ? eq(auditLog.action, filter.action) : undefined,
        filter.from ? gte(auditLog.ts, filter.from) : undefined,
        filter.to ? lte(auditLog.ts, filter.to) : undefined,
      ].filter(Boolean);
      const rows = await this.ctx.db
        .select()
        .from(auditLog)
        .where(and(...conds))
        .orderBy(asc(auditLog.seq))
        .limit(batch);
      for (const r of rows) yield rowToEntry(r);
      if (rows.length < batch) return;
      after = rows.at(-1)!.seq;
    }
  }
}
