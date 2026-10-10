import {
  ContextGuard,
  sanitizeAttributes,
  sanitizeName,
  type DropClass,
  type SanitizedAttributes,
  type SpanKind,
} from '@openagentix/core';

/** Counters the telemetry pipeline reports (ADR 0015 section 8). All label values are closed sets. */
export interface TelemetryStats {
  attributesDropped(keyClass: DropClass, n: number): void;
  redactions(kind: string, n: number): void;
  spansDropped(n: number): void;
  exportFailed(reason: ExportFailureReason): void;
}

export type ExportFailureReason = 'timeout' | 'network' | 'http' | 'other';

export const NOOP_STATS: TelemetryStats = {
  attributesDropped: () => undefined,
  redactions: () => undefined,
  spansDropped: () => undefined,
  exportFailed: () => undefined,
};

export interface TelemetryRuntime {
  /** Guard for every free-text value; always both stages on, independent of the model-context env. */
  guard: ContextGuard;
  stats: TelemetryStats;
  /** `guarded`: `exception.message` (guarded, 256 chars) is recorded next to `exception.type`. */
  exceptionDetail: 'off' | 'guarded';
  /** Rate-limited sink for the pipeline's own diagnostics (reason codes only, never messages). */
  warn: (fields: Record<string, string | number>, message: string) => void;
}

const defaults = (): TelemetryRuntime => ({
  guard: new ContextGuard(),
  stats: NOOP_STATS,
  exceptionDetail: 'off',
  warn: () => undefined,
});

let runtime: TelemetryRuntime = defaults();

export const telemetryRuntime = (): TelemetryRuntime => runtime;

export function configureTelemetryRuntime(patch: Partial<TelemetryRuntime>): void {
  runtime = { ...runtime, ...patch };
}

/** Test helper: back to the defaults (fresh guard, no-op counters). */
export function resetTelemetryRuntime(): void {
  runtime = defaults();
}

/** Reports the outcome of a sanitiser call to the counters. */
export function recordSanitized(
  result: Pick<SanitizedAttributes, 'dropped' | 'redactions'>,
  stats: TelemetryStats = runtime.stats,
): void {
  for (const [c, n] of Object.entries(result.dropped)) stats.attributesDropped(c as DropClass, n);
  for (const [k, n] of Object.entries(result.redactions)) stats.redactions(k, n);
}

/** Sanitises attributes with the runtime guard and counts what was dropped or redacted. */
export function sanitizeForSpan(
  kind: SpanKind,
  raw: Record<string, unknown>,
  guard: ContextGuard = runtime.guard,
): SanitizedAttributes['attributes'] {
  const result = sanitizeAttributes(kind, raw, guard, {
    allowExceptionMessage: runtime.exceptionDetail === 'guarded',
  });
  recordSanitized(result);
  return result.attributes;
}

/** Sanitises a span name; `redacted` tells the caller to flag the span with `oax.redacted`. */
export function sanitizeSpanName(
  name: string,
  guard: ContextGuard = runtime.guard,
): { name: string; redacted: boolean } {
  const r = sanitizeName(name, guard, 'oax.span');
  recordSanitized({ dropped: {}, redactions: r.redactions });
  return { name: r.name, redacted: Object.keys(r.redactions).length > 0 };
}
