import { and, eq, sql } from 'drizzle-orm';
import {
  formatTraceparent,
  isSpanId,
  isTraceId,
  parseTraceparent,
  runTraceIdentity,
} from '@openagentix/core';
import type { AppContext } from '../context.js';
import { runNodeSessions, tenants } from '../db/schema.js';
import {
  activeSpanIdIn,
  startGuardedSpan,
  telemetryRuntime,
  tracingEnabled,
  type StoredSpanIds,
} from '../telemetry.js';

/**
 * Telemetry of run node sessions on the control node (ADR 0015 sections 3.3, 6.1 and 6.2).
 *
 * Trust rules, in one place:
 * - Every span is created by the control node, parented from the context it stored itself
 *   (`run_node_sessions.trace_context`). A `traceparent` a node sends is only compared and counted.
 * - A node report never creates a span and never lends a timestamp or a duration to one. It becomes,
 *   at most, one bounded event of `oax.node.session`, stamped with the control node's own clock.
 * - Of everything a report says, only values from fixed sets, numbers with a ceiling and a tool
 *   name that comes from the step's own grant list (never the name the node wrote) are kept. No
 *   free text: no message, no code, no argument, no result.
 */

/** Report kinds that can become events, with their span event names. */
const EVENT_NAMES = {
  tool_call: 'oax.node.tool_call',
  output: 'oax.node.output',
  error: 'oax.node.error',
  guard: 'oax.node.guard',
} as const;
export type NodeEventKind = keyof typeof EVENT_NAMES;

const STATUSES: ReadonlySet<string> = new Set<string>([
  'ok',
  'error',
  'denied',
  'pending',
  'approved',
  'rejected',
  'skipped',
]);
const GUARD_SOURCES: ReadonlySet<string> = new Set(['input', 'tool_result', 'tool_error']);
const KIND = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_KINDS = 8;
/** A node-claimed duration is kept below a day before the attribute cap (1 h) applies. */
const MAX_CLAIMED_MS = 86_400_000;
const MAX_COUNT = 1_000_000;
/** Hard ceiling of kept events per session, whatever `OAX_OTEL_NODE_EVENTS_MAX` says. */
export const NODE_EVENTS_CEILING = 1000;
const MAX_DROPPED = 1_000_000;
const SERVER = /^[a-z][a-z0-9_-]{0,62}$/;
const GRANT_TOOL = /^(?:[A-Za-z0-9_.-]+\*?|\*)$/;

/** What is kept of one accepted node report (stored in `run_node_sessions.otel_session`). */
export interface StoredNodeEvent {
  /** Report kind. */
  k: NodeEventKind;
  /** Receipt time (epoch ms of the control node's clock). */
  t: number;
  /** Claimed status (fixed set). */
  s?: string;
  /** Claimed duration in ms (finite, non-negative, below a day). */
  d?: number;
  /** Granted tool: the grant's own server and tool string. */
  srv?: string;
  tool?: string;
  /** Guard report: source (fixed set), counts and secret kinds (closed set of the guard). */
  src?: string;
  inv?: number;
  sec?: number;
  kinds?: string[];
}

export interface StoredNodeSession {
  runner: string | null;
  harness: string | null;
  dropped: number;
  events: StoredNodeEvent[];
}

/** Parent ids of a stored `traceparent`, or null (no context, malformed, or all zero). */
export function storedParent(traceContext: string | null | undefined): StoredSpanIds | null {
  const p = parseTraceparent(traceContext);
  return p && isTraceId(p.traceId) && isSpanId(p.spanId)
    ? { traceId: p.traceId, spanId: p.spanId }
    : null;
}

/**
 * The context to store for a session created now: the active span, when it is a span of the run's
 * own trace (the `invoke_agent` span of the dispatching step). Null while tracing is off or when
 * the run has no trace identity, so nothing changes without an SDK.
 */
export function dispatchTraceContext(run: {
  traceId?: string | null;
  traceRootSpanId?: string | null;
}): string | null {
  if (!tracingEnabled()) return null;
  const identity = runTraceIdentity(run);
  if (!identity) return null;
  const spanId = activeSpanIdIn(identity.traceId);
  return spanId ? formatTraceparent(identity.traceId, spanId) : null;
}

/** Run, tenant and organisation identity every span of a run carries. */
export async function spanIdentity(
  ctx: AppContext,
  runId: string,
  tenantId: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = { 'oax.run.id': runId, 'oax.tenant.id': tenantId };
  try {
    const [t] = await ctx.db
      .select({ rootId: tenants.rootId })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (t?.rootId) out['oax.tenant.root_id'] = t.rootId;
  } catch {
    // The identity is best effort: a span without the root id is better than no span.
  }
  return out;
}

/**
 * The grant of the step that covers `server`/`tool`, or null. `grants` is the tool list of the
 * step's published spec (stored in the handover). Only the grant's own strings are returned, so a
 * name a node invented (or the part a `*` grant leaves open) never leaves this function.
 */
export function matchGrant(
  grants: unknown,
  server: string,
  tool: string,
): { server: string; tool: string } | null {
  if (!Array.isArray(grants) || tool.length === 0 || tool.length > 128) return null;
  for (const g of grants as unknown[]) {
    if (g === null || typeof g !== 'object') continue;
    const gs = (g as { server?: unknown }).server;
    const gt = (g as { tool?: unknown }).tool;
    if (typeof gs !== 'string' || typeof gt !== 'string') continue;
    if (!SERVER.test(gs) || !GRANT_TOOL.test(gt) || gs !== server) continue;
    const ok = gt.endsWith('*') ? tool.startsWith(gt.slice(0, -1)) : gt === tool;
    if (ok) return { server: gs, tool: gt };
  }
  return null;
}

/** Splits a reported step name `server/tool`; null for anything else. */
export function splitToolName(name: unknown): { server: string; tool: string } | null {
  if (typeof name !== 'string' || name.length > 200) return null;
  const i = name.indexOf('/');
  if (i <= 0) return null;
  return { server: name.slice(0, i), tool: name.slice(i + 1) };
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.min(Math.floor(v), MAX_COUNT)
    : undefined;

/**
 * The event for an accepted (already sanitised and scrubbed) node report, or null when the kind has
 * none. Only fixed-set and bounded values are copied; `grants` decides whether a tool name may
 * appear at all.
 */
export function nodeEventOf(
  step: { kind: string; name: string; status: string; durationMs?: number; output?: unknown },
  grants: unknown,
  at: number,
): StoredNodeEvent | null {
  const isGuard = step.kind === 'control' && step.name === 'input_guard';
  const k: NodeEventKind | null = isGuard
    ? 'guard'
    : step.kind === 'tool_call' || step.kind === 'output' || step.kind === 'error'
      ? step.kind
      : null;
  if (!k) return null;
  const ev: StoredNodeEvent = { k, t: at };
  if (STATUSES.has(step.status)) ev.s = step.status;
  const d = step.durationMs;
  if (typeof d === 'number' && Number.isFinite(d) && d >= 0)
    ev.d = Math.min(Math.floor(d), MAX_CLAIMED_MS);
  if (k === 'tool_call') {
    const parts = splitToolName(step.name);
    const grant = parts ? matchGrant(grants, parts.server, parts.tool) : null;
    if (grant) {
      ev.srv = grant.server;
      ev.tool = grant.tool;
    }
  }
  if (k === 'guard') {
    const o = (step.output ?? {}) as {
      source?: unknown;
      invisible?: { total?: unknown };
      secrets?: { total?: unknown; kinds?: unknown };
    };
    if (typeof o.source === 'string' && GUARD_SOURCES.has(o.source)) ev.src = o.source;
    const inv = count(o.invisible?.total);
    const sec = count(o.secrets?.total);
    if (inv !== undefined) ev.inv = inv;
    if (sec !== undefined) ev.sec = sec;
    const kinds =
      o.secrets?.kinds !== null && typeof o.secrets?.kinds === 'object'
        ? Object.keys(o.secrets.kinds as object)
            .filter((x) => KIND.test(x))
            .slice(0, MAX_KINDS)
        : [];
    if (kinds.length > 0) ev.kinds = kinds;
  }
  return ev;
}

/** Span event attributes of a stored event: keys of the `node_session` allowlist only. */
function eventAttributes(ev: StoredNodeEvent): Record<string, unknown> {
  return {
    'oax.claim': 'node',
    ...(ev.s !== undefined ? { 'oax.claimed.status': ev.s } : {}),
    ...(ev.d !== undefined ? { 'oax.claimed.duration_ms': ev.d } : {}),
    ...(ev.tool !== undefined ? { 'gen_ai.tool.name': ev.tool } : {}),
    ...(ev.srv !== undefined ? { 'oax.mcp.server': ev.srv } : {}),
    ...(ev.src !== undefined ? { 'oax.guard.source': ev.src } : {}),
    ...(ev.inv !== undefined ? { 'oax.guard.invisible': ev.inv } : {}),
    ...(ev.sec !== undefined ? { 'oax.guard.secrets': ev.sec } : {}),
    ...(ev.kinds ? { 'oax.guard.secret_kinds': ev.kinds } : {}),
  };
}

/** Reads the stored bounded state defensively (the column is written by us, but never trusted blind). */
export function readNodeSession(value: unknown): StoredNodeSession | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<StoredNodeSession>;
  const events = Array.isArray(v.events) ? v.events : [];
  return {
    runner: typeof v.runner === 'string' ? v.runner : null,
    harness: typeof v.harness === 'string' ? v.harness : null,
    dropped: count(v.dropped) ?? 0,
    events: events
      .filter(
        (e): e is StoredNodeEvent =>
          e !== null &&
          typeof e === 'object' &&
          typeof (e as StoredNodeEvent).k === 'string' &&
          (e as StoredNodeEvent).k in EVENT_NAMES &&
          typeof (e as StoredNodeEvent).t === 'number',
      )
      .slice(0, NODE_EVENTS_CEILING),
  };
}

/**
 * Appends the event to the session, or counts it as dropped when the cap is reached. The cap is
 * enforced in the statement itself, so concurrent reports cannot exceed it. Returns whether the
 * event was kept. A session without telemetry state (tracing was off at dispatch) is left alone.
 */
export async function appendNodeEvent(
  ctx: AppContext,
  sessionId: string,
  ev: StoredNodeEvent,
  max: number,
  currentLength: number,
): Promise<boolean> {
  const cap = Math.max(0, Math.min(max, NODE_EVENTS_CEILING));
  const t = runNodeSessions;
  if (currentLength < cap) {
    const kept = await ctx.db
      .update(t)
      .set({
        otelSession: sql`jsonb_set(${t.otelSession}, '{events}', (${t.otelSession}->'events') || ${JSON.stringify(ev)}::jsonb)`,
      })
      .where(
        and(
          eq(t.id, sessionId),
          sql`${t.otelSession} is not null`,
          sql`${t.revokedAt} is null`,
          sql`jsonb_array_length(${t.otelSession}->'events') < ${cap}`,
        ),
      )
      .returning({ id: t.id });
    if (kept.length > 0) return true;
  }
  await ctx.db
    .update(t)
    .set({
      otelSession: sql`jsonb_set(${t.otelSession}, '{dropped}', to_jsonb(least((${t.otelSession}->>'dropped')::bigint + 1, ${MAX_DROPPED})))`,
    })
    .where(
      and(eq(t.id, sessionId), sql`${t.otelSession} is not null`, sql`${t.revokedAt} is null`),
    );
  telemetryRuntime().stats.nodeEventsDropped(1);
  return false;
}

/**
 * Counts a `traceparent` header of a run node that is not the stored context of its session. The
 * header is never used for anything else.
 */
export function noteInboundContext(traceContext: string | null | undefined, header: unknown): void {
  if (header === undefined) return;
  const given = typeof header === 'string' ? parseTraceparent(header) : null;
  const stored = parseTraceparent(traceContext);
  if (!given || !stored || given.traceId !== stored.traceId)
    telemetryRuntime().stats.nodeContextMismatch(1);
}

/**
 * Emits `oax.node.session` for a session that just ended: from the stored context, spanning
 * creation to revocation, with the kept reports as events at their receipt times. Never throws.
 */
export async function emitNodeSessionSpan(
  ctx: AppContext,
  row: {
    runId: string;
    tenantId: string;
    traceContext: string | null;
    otelSession: unknown;
    createdAt: Date;
    revokedAt: Date | null;
    revokeReason: string | null;
  },
): Promise<void> {
  try {
    const parent = storedParent(row.traceContext);
    const stored = readNodeSession(row.otelSession);
    if (!parent || !stored) return;
    const end = row.revokedAt ?? ctx.now();
    const open = startGuardedSpan(
      { name: 'oax.node.session', kind: 'node_session', parent, startTime: row.createdAt },
      {
        ...(await spanIdentity(ctx, row.runId, row.tenantId)),
        ...(stored.runner ? { 'oax.node.runner': stored.runner } : {}),
        ...(stored.harness ? { 'oax.node.harness': stored.harness } : {}),
        ...(row.revokeReason ? { 'oax.node.revoke_reason': row.revokeReason } : {}),
        'oax.node.events_dropped': stored.dropped,
      },
    );
    for (const ev of stored.events)
      open.span.addEvent(EVENT_NAMES[ev.k], eventAttributes(ev), new Date(ev.t));
    open.end(undefined, end);
  } catch {
    // Telemetry never affects the end of a session.
  }
}
