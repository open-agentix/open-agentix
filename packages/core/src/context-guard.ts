import { stripInvisible, type InvisibleReport } from './invisible-text.js';

/**
 * Guard for everything that enters a model's context or a stored step output: removes invisible
 * steering Unicode (`invisible-text.ts`). One place, so every stage that cleans model input is
 * configured, reported and audited the same way.
 *
 * Reports carry counts and class names only, never the content, so they are safe to audit.
 */

export interface GuardReport {
  invisible: InvisibleReport;
}

export const emptyGuardReport = (): GuardReport => ({ invisible: { total: 0, classes: {} } });

export const isGuardReportEmpty = (r: GuardReport): boolean => r.invisible.total === 0;

export function mergeGuardReports(into: GuardReport, from: GuardReport): void {
  into.invisible.total += from.invisible.total;
  for (const [k, n] of Object.entries(from.invisible.classes))
    into.invisible.classes[k as keyof InvisibleReport['classes']] =
      (into.invisible.classes[k as keyof InvisibleReport['classes']] ?? 0) + (n ?? 0);
}

export interface ContextGuardOptions {
  /** Remove invisible steering Unicode. Default `true`. */
  stripInvisible?: boolean;
}

export class ContextGuard {
  readonly stripInvisible: boolean;

  constructor(opts: ContextGuardOptions = {}) {
    this.stripInvisible = opts.stripInvisible ?? true;
  }

  /** Guards one string. Returns the input unchanged (same string) when nothing was found. */
  text(input: string): { text: string; report: GuardReport } {
    const report = emptyGuardReport();
    if (!this.stripInvisible) return { text: input, report };
    const r = stripInvisible(input);
    report.invisible = r.report;
    return { text: r.text, report };
  }

  /** Guards every string value of a JSON-like value (keys are left alone). Cycles are not followed. */
  value<T>(input: T): { value: T; report: GuardReport } {
    const report = emptyGuardReport();
    const seen = new WeakSet<object>();
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const r = this.text(v);
        mergeGuardReports(report, r.report);
        return r.text;
      }
      if (v === null || typeof v !== 'object' || v instanceof Date) return v;
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.map(walk);
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    };
    return { value: walk(input) as T, report };
  }
}

const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Builds the guard from the environment. A stage is ON unless explicitly turned off with one of
 * `0`, `false`, `off`, `no` (anything else, including a typo, keeps it on: fail safe):
 * `OAX_STRIP_INVISIBLE_UNICODE`. Turning a stage off is meant for diagnostics only.
 */
export function contextGuardFromEnv(
  env: Record<string, string | undefined> = process.env,
): ContextGuard {
  const off = (name: string) => OFF.has((env[name] ?? '').trim().toLowerCase());
  return new ContextGuard({ stripInvisible: !off('OAX_STRIP_INVISIBLE_UNICODE') });
}

/**
 * The only shape of a guard report that is recorded in an audit entry: counts and names, bounded.
 * Used for node-reported reports too, so a node cannot smuggle content through the report.
 */
export function auditShapeOfReport(r: unknown): GuardReport {
  const out = emptyGuardReport();
  const rec = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const inv = rec(rec(r).invisible);
  out.invisible.total = num(inv.total);
  for (const [k, n] of Object.entries(rec(inv.classes)).slice(0, 64)) {
    if (/^[a-z0-9_-]{1,40}$/.test(k)) (out.invisible.classes as Record<string, number>)[k] = num(n);
  }
  return out;
}
