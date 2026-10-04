import { randomUUID } from 'node:crypto';
import type { OaxEvent } from '@openagentix/core';
import {
  ChangeCheckSchema,
  decideChange,
  probeDigest,
  type ChangeDecision,
  type ProbeDeps,
  WebhookError,
  validateCronExpression,
  mailToEvent,
  verifyWebhook,
  webhookToEvent,
  type HeaderBag,
  type ReplayGuard,
  type WebhookScheme,
} from '@openagentix/events';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import { changeChecks, eventSources, events, webhookDeliveries } from '../db/schema.js';
import { createProxyAwareFetch } from '@openagentix/providers';
import { HttpError, conflict, notFound } from '../errors.js';
import { decodeTimeCursor, encodeTimeCursor, page } from '../pagination.js';
import type { AuditService } from './audit.js';
import type { RunsService } from './runs.js';

export type SourceRow = typeof eventSources.$inferSelect;
export type EventRow = typeof events.$inferSelect;

/** Replay protection shared by all API replicas (primary key on source + delivery id). */
export class DbReplayGuard implements ReplayGuard {
  constructor(
    private readonly ctx: AppContext,
    private readonly sourceId: string,
  ) {}

  async checkAndRemember(key: string, ttlMs: number): Promise<boolean> {
    const now = this.ctx.now();
    const inserted = await this.ctx.db
      .insert(webhookDeliveries)
      .values({
        sourceId: this.sourceId,
        deliveryId: key,
        expiresAt: new Date(now.getTime() + ttlMs),
      })
      .onConflictDoUpdate({
        target: [webhookDeliveries.sourceId, webhookDeliveries.deliveryId],
        set: { expiresAt: new Date(now.getTime() + ttlMs) },
        setWhere: lt(webhookDeliveries.expiresAt, now),
      })
      .returning({ id: webhookDeliveries.deliveryId });
    return inserted.length === 1;
  }
}

export interface SourceInput {
  name: string;
  kind: 'webhook' | 'mail' | 'kafka' | 'cron';
  scheme?: WebhookScheme | undefined;
  secretRefs?: string[] | undefined;
  agentId?: string | null | undefined;
  config?: Record<string, unknown> | undefined;
  enabled?: boolean | undefined;
}

export interface IngestResult {
  eventId: string;
  runId: string | null;
  status: 'accepted';
}

/** Event sources and ingest (webhook + mail-in); kafka/cron feed `ingestEvent` from the worker. */
export class IngestService {
  private readonly sourceQuery;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly runs: RunsService,
  ) {
    this.sourceQuery = ctx.db
      .select()
      .from(eventSources)
      .where(eq(eventSources.id, sql.placeholder('id')))
      .prepare('oax_get_source');
  }

  async listSources(): Promise<SourceRow[]> {
    return this.ctx.db.select().from(eventSources).orderBy(eventSources.name);
  }

  async getSource(id: string): Promise<SourceRow> {
    const row = await cached(
      this.ctx.cache,
      `source:${id}`,
      30_000,
      async () => (await this.sourceQuery.execute({ id }))[0] ?? null,
    );
    if (!row) throw notFound('event source');
    return { ...row, createdAt: new Date(row.createdAt) };
  }

  async createSource(actor: string, input: SourceInput): Promise<SourceRow> {
    if (input.config?.changeCheck !== undefined) {
      if (input.kind !== 'cron')
        throw new HttpError(
          400,
          'validation_failed',
          'changeCheck is only supported on cron sources',
        );
      ChangeCheckSchema.parse(input.config.changeCheck);
    }
    if (input.kind === 'cron') {
      const schedule = input.config?.schedule;
      if (typeof schedule !== 'string')
        throw new HttpError(400, 'validation_failed', 'cron sources need config.schedule');
      validateCronExpression(
        schedule,
        typeof input.config?.timezone === 'string' ? input.config.timezone : undefined,
      );
    }
    const [exists] = await this.ctx.db
      .select({ id: eventSources.id })
      .from(eventSources)
      .where(eq(eventSources.name, input.name));
    if (exists) throw conflict(`event source "${input.name}" already exists`);
    const [row] = await this.ctx.db
      .insert(eventSources)
      .values({
        id: randomUUID(),
        name: input.name,
        kind: input.kind,
        scheme: input.scheme ?? 'oax-v1',
        secretRefs: input.secretRefs ?? [],
        agentId: input.agentId ?? null,
        config: input.config ?? {},
        enabled: input.enabled ?? true,
      })
      .returning();
    await this.audit.append({
      actor,
      action: 'source.created',
      target: row!.id,
      payload: { ...input },
    });
    return row!;
  }

  async updateSource(
    actor: string,
    id: string,
    patch: Partial<Omit<SourceInput, 'name' | 'kind'>>,
  ): Promise<SourceRow> {
    await this.getSource(id);
    const set: Partial<SourceRow> = {};
    if (patch.scheme !== undefined) set.scheme = patch.scheme;
    if (patch.secretRefs !== undefined) set.secretRefs = patch.secretRefs;
    if (patch.agentId !== undefined) set.agentId = patch.agentId;
    if (patch.config !== undefined) set.config = patch.config;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const [row] = await this.ctx.db
      .update(eventSources)
      .set(set)
      .where(eq(eventSources.id, id))
      .returning();
    await this.ctx.cache.del(`source:${id}`);
    await this.audit.append({ actor, action: 'source.updated', target: id, payload: patch });
    return row!;
  }

  /** Injectable probe dependencies (tests); defaults use the proxy-aware fetch and the file system. */
  probeDeps: ProbeDeps = { fetch: (u, i) => createProxyAwareFetch()(u, i) };

  /**
   * Deterministic change gate of a schedule source: returns null when the source has no
   * changeCheck; otherwise probes, stores the digest and audits the result. No tokens are used.
   */
  async changeGate(
    source: Pick<SourceRow, 'id' | 'name' | 'config'>,
  ): Promise<ChangeDecision | null> {
    const raw = (source.config as { changeCheck?: unknown }).changeCheck;
    if (raw === undefined) return null;
    const { probe } = ChangeCheckSchema.parse(raw);
    const digest = await probeDigest(probe, this.probeDeps);
    const [prev] = await this.ctx.db
      .select()
      .from(changeChecks)
      .where(eq(changeChecks.sourceId, source.id));
    const decision = decideChange(digest, prev?.digest ?? null);
    const now = this.ctx.now();
    await this.ctx.db
      .insert(changeChecks)
      .values({ sourceId: source.id, digest, checkedAt: now, changedAt: now })
      .onConflictDoUpdate({
        target: changeChecks.sourceId,
        set: decision.changed ? { digest, checkedAt: now, changedAt: now } : { checkedAt: now },
      });
    await this.audit.append({
      actor: `source:${source.name}`,
      action: decision.changed ? 'change_check.changed' : 'change_check.unchanged',
      target: source.id,
      payload: {
        probe:
          probe.type === 'http'
            ? { type: 'http', url: probe.url }
            : { type: 'file', path: probe.path },
        ...decision,
      },
    });
    return decision;
  }

  async deleteSource(actor: string, id: string): Promise<void> {
    await this.getSource(id);
    // Events keep their history; the source reference is cleared.
    await this.ctx.db.update(events).set({ sourceId: null }).where(eq(events.sourceId, id));
    await this.ctx.db.delete(eventSources).where(eq(eventSources.id, id));
    await this.ctx.cache.del(`source:${id}`);
    await this.audit.append({ actor, action: 'source.deleted', target: id });
  }

  /** Verifies, normalises and stores an HTTP-delivered event, then queues the bound agent. */
  async ingestHttp(
    sourceId: string,
    kind: 'webhook' | 'mail',
    headers: HeaderBag,
    rawBody: Buffer,
    contentType: string | undefined,
  ): Promise<IngestResult> {
    const source = await this.getSource(sourceId);
    if (!source.enabled || source.kind !== kind) throw notFound('event source');
    if (source.secretRefs.length === 0)
      throw new HttpError(401, 'signature_invalid', 'source has no signing secret configured');
    const secrets = await Promise.all(source.secretRefs.map((r) => this.ctx.secrets.resolve(r)));
    let deliveryId: string;
    try {
      ({ deliveryId } = await verifyWebhook({
        scheme: source.scheme as WebhookScheme,
        secrets,
        headers,
        rawBody,
        replayGuard: new DbReplayGuard(this.ctx, source.id),
        toleranceSeconds: this.ctx.config.webhook.toleranceSeconds,
        now: () => this.ctx.now().getTime(),
      }));
    } catch (e) {
      this.ctx.metrics.eventsIngested.inc({
        source: source.name,
        outcome: e instanceof WebhookError ? e.code : 'error',
      });
      throw e;
    }
    let event: OaxEvent;
    if (kind === 'mail') {
      let json: unknown;
      try {
        json = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new HttpError(400, 'payload_invalid', 'mail payload must be JSON');
      }
      event = mailToEvent(source.name, json);
    } else {
      event = webhookToEvent({
        sourceName: source.name,
        rawBody,
        contentType,
        deliveryId,
        maxBytes: this.ctx.config.webhook.maxBytes,
      });
    }
    return this.ingestEvent(source, event, `${kind}:${source.name}`);
  }

  /** Stores a normalised event for a source and queues a run when an agent is bound. */
  async ingestEvent(
    source: Pick<SourceRow, 'id' | 'name' | 'agentId'>,
    event: OaxEvent,
    triggeredBy: string,
  ): Promise<IngestResult> {
    const eventId = randomUUID();
    await this.ctx.db.insert(events).values({
      id: eventId,
      sourceId: source.id,
      cloudEventId: event.id,
      type: event.type,
      subject: event.subject ?? null,
      payload: event as object,
      receivedAt: this.ctx.now(),
    });
    let runId: string | null = null;
    if (source.agentId) {
      const latest = await this.runs
        .enqueue({ agentId: source.agentId, event, eventRowId: eventId, triggeredBy })
        .catch((e: unknown) => {
          if (e instanceof HttpError && e.code === 'invalid_state') return null;
          throw e;
        });
      runId = latest?.id ?? null;
    }
    this.ctx.metrics.eventsIngested.inc({ source: source.name, outcome: 'accepted' });
    return { eventId, runId, status: 'accepted' };
  }

  async listEvents(filter: { sourceId?: string | undefined }, limit: number, cursor?: string) {
    const c = decodeTimeCursor(cursor);
    const rows = await this.ctx.db
      .select()
      .from(events)
      .where(
        and(
          filter.sourceId ? eq(events.sourceId, filter.sourceId) : undefined,
          c
            ? or(lt(events.receivedAt, c.t), and(eq(events.receivedAt, c.t), lt(events.id, c.id)))
            : undefined,
        ),
      )
      .orderBy(desc(events.receivedAt), desc(events.id))
      .limit(limit + 1);
    return page(rows, limit, (r) => encodeTimeCursor(r.receivedAt, r.id));
  }

  async getEvent(id: string): Promise<EventRow> {
    const [row] = await this.ctx.db.select().from(events).where(eq(events.id, id));
    if (!row) throw notFound('event');
    return row;
  }

  /** Housekeeping: drops expired replay-protection rows. */
  async pruneDeliveries(): Promise<number> {
    const rows = await this.ctx.db
      .delete(webhookDeliveries)
      .where(lt(webhookDeliveries.expiresAt, this.ctx.now()))
      .returning();
    return rows.length;
  }
}
