import { randomBytes } from 'node:crypto';

/**
 * Trace and span identifiers of a run (ADR 0015 section 2).
 *
 * The ids are random 128-bit and 64-bit values from the operating system CSPRNG. They are never
 * derived from another identifier (a run id, a tenant id, a timestamp) and never taken from an
 * input: a header, a webhook body or a node report can neither choose nor predict them. Two
 * tenants' runs therefore cannot be correlated through their trace ids.
 */

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

/** A W3C trace id: 32 lower-case hex characters, not all zero. */
export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value) && value !== ZERO_TRACE_ID;
}

/** A W3C span id: 16 lower-case hex characters, not all zero. */
export function isSpanId(value: unknown): value is string {
  return typeof value === 'string' && SPAN_ID.test(value) && value !== ZERO_SPAN_ID;
}

function randomHex(bytes: number, zero: string): string {
  for (;;) {
    const hex = randomBytes(bytes).toString('hex');
    if (hex !== zero) return hex;
  }
}

/** A fresh trace id (16 random bytes, hex). */
export function newTraceId(): string {
  return randomHex(16, ZERO_TRACE_ID);
}

/** A fresh span id (8 random bytes, hex). */
export function newSpanId(): string {
  return randomHex(8, ZERO_SPAN_ID);
}

/** The identity a run carries from creation on: the trace and its root (admission) span. */
export interface RunTraceIdentity {
  traceId: string;
  rootSpanId: string;
}

export function newRunTraceIdentity(): RunTraceIdentity {
  return { traceId: newTraceId(), rootSpanId: newSpanId() };
}

/** Reads the identity of a `runs` row; a row without a well-formed pair has no trace. */
export function runTraceIdentity(row: {
  traceId?: string | null;
  traceRootSpanId?: string | null;
}): RunTraceIdentity | null {
  return isTraceId(row.traceId) && isSpanId(row.traceRootSpanId)
    ? { traceId: row.traceId, rootSpanId: row.traceRootSpanId }
    : null;
}

/**
 * Strict W3C `traceparent` parser (version 00 only, lower-case hex, no extra fields). Used to count
 * and, with `OAX_OTEL_INBOUND_CONTEXT=link`, to link an inbound context; the result is never used
 * as a parent. Returns null for anything that is not exactly well formed.
 */
export function parseTraceparent(
  header: unknown,
): { traceId: string; spanId: string; sampled: boolean } | null {
  if (typeof header !== 'string' || header.length !== 55) return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header);
  if (!m || !isTraceId(m[1]) || !isSpanId(m[2])) return null;
  return { traceId: m[1], spanId: m[2], sampled: (parseInt(m[3]!, 16) & 1) === 1 };
}

/** The `traceparent` form of a stored context (`run_node_sessions.trace_context`, later slices). */
export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

/**
 * Fills `{traceId}` of an operator-configured link template. Only a validated trace id is
 * substituted, so the value cannot change the URL's structure.
 */
export function traceUrl(template: string | undefined, traceId: string | null): string | null {
  if (!template || !isTraceId(traceId)) return null;
  return template.split('{traceId}').join(traceId);
}
