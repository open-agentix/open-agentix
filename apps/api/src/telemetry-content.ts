import { and, eq } from 'drizzle-orm';
import {
  ContextGuard,
  buildContentAttributes,
  type Classification,
  type ContentMessage,
} from '@openagentix/core';
import type { Db } from './db/client.js';
import { connections } from './db/schema.js';
import type { OtelConfig } from './telemetry-config.js';
import { TelemetryConnectionConfigSchema } from './telemetry-connection.js';
import { telemetryRuntime } from './telemetry-runtime.js';

/**
 * Hand-over of captured model content (ADR 0015 section 5.4, slice S10) from the model proxy to the
 * exporters of the tenant that opted in.
 *
 * Content is never a span attribute: the platform pipeline (the shared collector) cannot see it by
 * construction. The proxy builds the redacted, capped text and parks it here, keyed by the `chat`
 * span that it belongs to; only the tenant exporter stage takes it when that span ends, checks the
 * gates again for each exporter and attaches it to the copy that goes to that exporter alone.
 * Entries are small, bounded in number and age, and consumed once.
 */

export interface CapturedContent {
  tenantId: string;
  /** Classification of the run (the published one), checked against each exporter's clearance. */
  classification: Classification;
  /** `gen_ai.input.messages` / `gen_ai.output.messages`, already guarded, redacted and capped. */
  attributes: Readonly<Record<string, string>>;
  truncated: boolean;
  /** Connections whose tenant opt-in was seen when the content was captured. */
  optIns: ReadonlySet<string>;
  at: number;
}

const MAX_ENTRIES = 512;
const MAX_AGE_MS = 60_000;
const channel = new Map<string, CapturedContent>();

const keyOf = (c: { traceId: string; spanId: string }) => `${c.traceId}/${c.spanId}`;

function prune(now: number): void {
  for (const [k, v] of channel) {
    if (now - v.at <= MAX_AGE_MS && channel.size <= MAX_ENTRIES) break;
    channel.delete(k);
  }
}

export function putCapturedContent(
  span: { traceId: string; spanId: string },
  entry: CapturedContent,
): void {
  prune(entry.at);
  channel.set(keyOf(span), entry);
  // Map keeps insertion order: the oldest entries go first when the bound is exceeded.
  while (channel.size > MAX_ENTRIES) {
    const oldest = channel.keys().next().value;
    if (oldest === undefined) break;
    channel.delete(oldest);
  }
}

/** Removes and returns the content parked for a span (consumed once). */
export function takeCapturedContent(span: {
  traceId: string;
  spanId: string;
}): CapturedContent | undefined {
  const k = keyOf(span);
  const v = channel.get(k);
  if (v) channel.delete(k);
  return v;
}

/** Test helper. */
export function resetCapturedContent(): void {
  channel.clear();
}

export function capturedContentSize(): number {
  return channel.size;
}

interface CaptureDeps {
  db: Db;
  config: Pick<OtelConfig, 'content' | 'tenantExporters' | 'allowedRegions'>;
  now?: () => number;
}

export interface CaptureInput {
  tenantId: string;
  span: { traceId: string; spanId: string };
  classification: Classification;
  system?: string | undefined;
  /** The messages of the call. Messages of the `tool` role and tool calls are never read. */
  messages: readonly ContentMessage[];
  outputText: string;
  /** Secret values in use for this call (resolved provider keys). */
  secrets: readonly string[];
}

/**
 * The connections of a tenant that opted in to content right now (fresh read, never cached: an
 * opt-out must stop the capture on the next call).
 */
export async function contentOptIns(
  db: Db,
  tenantId: string,
  allowedRegions: readonly string[],
): Promise<Set<string>> {
  const rows = await db
    .select({ id: connections.id, config: connections.config })
    .from(connections)
    .where(
      and(
        eq(connections.kind, 'telemetry'),
        eq(connections.tenantId, tenantId),
        eq(connections.scope, 'tenant'),
      ),
    );
  const out = new Set<string>();
  for (const r of rows) {
    const parsed = TelemetryConnectionConfigSchema.safeParse(r.config);
    if (!parsed.success) continue;
    const c = parsed.data;
    if (!c.enabled || c.content !== 'redacted') continue;
    if (allowedRegions.length > 0 && (!c.region || !allowedRegions.includes(c.region))) continue;
    out.add(r.id);
  }
  return out;
}

/**
 * Builds and parks the content of one model call. Returns what happened for tests; the counters
 * are fed here. Never throws.
 */
export async function captureModelContent(
  deps: CaptureDeps,
  input: CaptureInput,
): Promise<'captured' | 'off' | 'no_opt_in' | 'error'> {
  const { config } = deps;
  // The operator allow, twice: capture is impossible without it, whatever a tenant stored.
  if (config.content !== 'redacted' || config.tenantExporters !== 'allow') return 'off';
  const rt = telemetryRuntime();
  try {
    const optIns = await contentOptIns(deps.db, input.tenantId, config.allowedRegions);
    if (optIns.size === 0) {
      rt.stats.contentResult?.('dropped_opt_out', 1);
      return 'no_opt_in';
    }
    const guard = new ContextGuard({ knownSecrets: input.secrets });
    const built = buildContentAttributes(
      {
        system: input.system,
        messages: input.messages,
        outputText: input.outputText,
      },
      guard,
    );
    if (Object.keys(built.attributes).length === 0) return 'captured';
    if (built.redactions.secrets > 0)
      rt.stats.redactions('content-secret', built.redactions.secrets);
    for (const [kind, n] of Object.entries(built.redactions.pii))
      rt.stats.redactions(`pii-${kind}`, n);
    putCapturedContent(input.span, {
      tenantId: input.tenantId,
      classification: input.classification,
      attributes: built.attributes,
      truncated: built.truncated,
      optIns,
      at: (deps.now ?? Date.now)(),
    });
    return 'captured';
  } catch {
    return 'error';
  }
}
