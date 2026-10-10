import { randomUUID } from 'node:crypto';
import type { OaxEvent, TenantActor } from '@openagentix/core';
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
import { and, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import { agents, changeChecks, eventSources, events, webhookDeliveries } from '../db/schema.js';
import { createProxyAwareFetch } from '@openagentix/providers';
import { HttpError, conflict, notFound } from '../errors.js';
import {
  decodeNameCursor,
  decodeTimeCursor,
  encodeNameCursor,
  encodeTimeCursor,
  page,
} from '../pagination.js';
import type { AuditService } from './audit.js';
import type { RunsService } from './runs.js';
import type { ResolvedScope } from './subtree-scope.js';

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
  /** Why no run was queued although an agent is bound: the event is stored all the same. */
  reason: 'agent_disabled' | null;
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

  async listSources(actor: TenantActor): Promise<SourceRow[]> {
    return this.ctx.db
      .select()
      .from(eventSources)
      .where(eq(eventSources.tenantId, actor.tenantId))
      .orderBy(eventSources.name);
  }

  /**
   * Sources of the nodes of a `scope=subtree` list, ordered by name and id and keyset-paged by
   * them (a name is unique per tenant only, so the id breaks ties).
   */
  async listSourcesIn(subtree: ResolvedScope, limit: number, cursor?: string) {
    if (subtree.isEmpty) return { items: [] as SourceRow[], nextCursor: null };
    const after = decodeNameCursor(cursor);
    const rows = await this.ctx.db
      .select()
      .from(eventSources)
      .where(
        and(
          subtree.nodePredicate(eventSources.tenantId),
          after === null
            ? undefined
            : or(
                gt(eventSources.name, after.key),
                and(eq(eventSources.name, after.key), gt(eventSources.id, after.id)),
              ),
        ),
      )
      .orderBy(eventSources.name, eventSources.id)
      .limit(limit + 1);
    return page(rows, limit, (r) => encodeNameCursor(r.name, r.id));
  }

  /** Every source of every tenant: for the worker's schedulers only, never for request handlers. */
  async listAllSources(): Promise<SourceRow[]> {
    return this.ctx.db.select().from(eventSources).orderBy(eventSources.name);
  }

  /** Pass the caller's tenant for request-facing lookups (a foreign source is "not found"). */
  async getSource(id: string, tenantId?: string): Promise<SourceRow> {
    const row = await cached(
      this.ctx.cache,
      `source:${id}`,
      30_000,
      async () => (await this.sourceQuery.execute({ id }))[0] ?? null,
    );
    if (!row || (tenantId && row.tenantId !== tenantId)) throw notFound('event source');
    return { ...row, createdAt: new Date(row.createdAt) };
  }

  /** The bound agent must belong to the same tenant as the source. */
  private async assertAgent(tenantId: string, agentId: string | null | undefined): Promise<void> {
    if (!agentId) return;
    const [a] = await this.ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
    if (!a) throw notFound('agent');
  }

  async createSource(actor: TenantActor, input: SourceInput): Promise<SourceRow> {
    await this.assertAgent(actor.tenantId, input.agentId);
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
      .where(and(eq(eventSources.name, input.name), eq(eventSources.tenantId, actor.tenantId)));
    if (exists) throw conflict(`event source "${input.name}" already exists`);
    const [row] = await this.ctx.db
      .insert(eventSources)
      .values({
        id: randomUUID(),
        tenantId: actor.tenantId,
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
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'source.created',
      target: row!.id,
      payload: { ...input },
    });
    return row!;
  }

  async updateSource(
    actor: TenantActor,
    id: string,
    patch: Partial<Omit<SourceInput, 'name' | 'kind'>>,
  ): Promise<SourceRow> {
    await this.getSource(id, actor.tenantId);
    await this.assertAgent(actor.tenantId, patch.agentId);
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
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'source.updated',
      target: id,
      payload: patch,
    });
    return row!;
  }

  /** Injectable probe dependencies (tests); defaults use the proxy-aware fetch and the file system. */
  probeDeps: ProbeDeps = { fetch: (u, i) => createProxyAwareFetch()(u, i) };

  /**
   * Deterministic change gate of a schedule source: returns null when the source has no
   * changeCheck; otherwise probes, stores the digest and audits the result. No tokens are used.
   */
  async changeGate(
    source: Pick<SourceRow, 'id' | 'name' | 'config' | 'tenantId'>,
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
      tenantId: source.tenantId,
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

  async deleteSource(actor: TenantActor, id: string): Promise<void> {
    await this.getSource(id, actor.tenantId);
    // Events keep their history; the source reference is cleared.
    await this.ctx.db.update(events).set({ sourceId: null }).where(eq(events.sourceId, id));
    await this.ctx.db.delete(eventSources).where(eq(eventSources.id, id));
    await this.ctx.cache.del(`source:${id}`);
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'source.deleted',
      target: id,
    });
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
    source: Pick<SourceRow, 'id' | 'name' | 'agentId' | 'tenantId'>,
    event: OaxEvent,
    triggeredBy: string,
    opts: { runId?: string } = {},
  ): Promise<IngestResult> {
    const eventId = randomUUID();
    await this.ctx.db.insert(events).values({
      id: eventId,
      tenantId: source.tenantId,
      sourceId: source.id,
      cloudEventId: event.id,
      type: event.type,
      subject: event.subject ?? null,
      payload: event as object,
      receivedAt: this.ctx.now(),
    });
    let runId: string | null = null;
    let reason: IngestResult['reason'] = null;
    if (source.agentId) {
      const latest = await this.runs
        .enqueue({
          agentId: source.agentId,
          event,
          eventRowId: eventId,
          triggeredBy,
          ...(opts.runId ? { id: opts.runId } : {}),
        })
        .catch((e: unknown) => {
          if (e instanceof HttpError && e.code === 'invalid_state') return null;
          // Stored, audited by enqueue (run.refused); the sender gets no error to retry on.
          if (e instanceof HttpError && e.code === 'agent_disabled') {
            reason = 'agent_disabled';
            return null;
          }
          throw e;
        });
      runId = latest?.id ?? null;
    }
    this.ctx.metrics.eventsIngested.inc({ source: source.name, outcome: 'accepted' });
    return { eventId, runId, reason, status: 'accepted' };
  }

  async listEvents(
    actor: TenantActor,
    filter: { sourceId?: string | undefined },
    limit: number,
    cursor?: string,
    subtree?: ResolvedScope,
  ) {
    const c = decodeTimeCursor(cursor);
    if (subtree?.isEmpty) return { items: [], nextCursor: null };
    const rows = await this.ctx.db
      .select()
      .from(events)
      .where(
        and(
          subtree ? subtree.nodePredicate(events.tenantId) : eq(events.tenantId, actor.tenantId),
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

  async getEvent(actor: TenantActor, id: string): Promise<EventRow> {
    const [row] = await this.ctx.db
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.tenantId, actor.tenantId)));
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
