import type { ContextGuard } from '../context-guard.js';
import {
  ALLOWED_KEYS,
  ATTRIBUTE_SPECS,
  CONTENT_KEY_PATTERN,
  type AttributeSpec,
  type SpanKind,
  type StringSpec,
} from './attribute-specs.js';

/**
 * The single place where values become span attributes (ADR 0015 section 4.3). Pure: no
 * OpenTelemetry import, no I/O. A key that is not on the allowlist of the span kind is dropped and
 * counted; every string goes through `ContextGuard.text` (invisible Unicode and secret values or
 * token shapes) and the length caps before it can reach a span. Reports carry counts only.
 */

export type AttributeValue = string | number | boolean | string[];

/** Why an attribute was dropped. A closed set: it is a metric label. */
export type DropClass = 'unknown' | 'content' | 'wrong_span' | 'invalid' | 'overflow';

export interface SanitizeOptions {
  /** `OAX_OTEL_EXCEPTION_DETAIL=guarded`: `exception.message` is accepted (guarded, 256 chars). */
  allowExceptionMessage?: boolean;
}

export interface SanitizedAttributes {
  attributes: Record<string, AttributeValue>;
  dropped: Partial<Record<DropClass, number>>;
  /** Guard replacements by kind (secret kinds and `invisible`); a closed set, safe as a label. */
  redactions: Record<string, number>;
}

/** Strings are cut to this before the guard runs, so its cost is bounded by the input cap. */
export const MAX_INPUT_CHARS = 4096;
/** More attributes than this in one call are dropped (`overflow`). */
export const MAX_ATTRIBUTES_PER_CALL = 64;

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

class Tally {
  readonly dropped: Partial<Record<DropClass, number>> = {};
  readonly redactions: Record<string, number> = {};
  drop(c: DropClass, n = 1): void {
    this.dropped[c] = (this.dropped[c] ?? 0) + n;
  }
  guarded(guard: ContextGuard, input: string): string {
    const { text, report } = guard.text(input.slice(0, MAX_INPUT_CHARS));
    if (report.invisible.total > 0)
      this.redactions.invisible = (this.redactions.invisible ?? 0) + report.invisible.total;
    for (const [kind, n] of Object.entries(report.secrets.kinds))
      this.redactions[kind] = (this.redactions[kind] ?? 0) + n;
    return text;
  }
}

function sanitizeString(
  spec: StringSpec,
  v: unknown,
  guard: ContextGuard,
  tally: Tally,
): string | null {
  if (typeof v !== 'string') return null;
  // A fixed value set needs no guard: only the members themselves pass.
  if (spec.enum) return spec.enum.includes(v) ? v : null;
  let s = tally.guarded(guard, v.replace(CONTROL_CHARS, ''));
  if (spec.freeText) s = s.slice(0, spec.max);
  else if (s.length > spec.max) return null;
  if (spec.pattern && !spec.pattern.test(s)) return null;
  return s.length === 0 ? null : s;
}

function sanitizeValue(
  spec: AttributeSpec,
  v: unknown,
  guard: ContextGuard,
  tally: Tally,
): AttributeValue | null {
  switch (spec.t) {
    case 'string':
      return sanitizeString(spec, v, guard, tally);
    case 'bool':
      return typeof v === 'boolean' ? v : null;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max
        ? v
        : null;
    case 'int': {
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return null;
      if (spec.clamp) return Math.min(spec.max, Math.max(spec.min, v));
      return v >= spec.min && v <= spec.max ? v : null;
    }
    case 'string[]': {
      if (!Array.isArray(v)) return null;
      if (v.length > spec.maxItems) tally.drop('overflow');
      const items = v
        .slice(0, spec.maxItems)
        .map((item) => sanitizeString(spec.item, item, guard, tally))
        .filter((s): s is string => s !== null);
      return items.length > 0 ? items : null;
    }
  }
}

function classify(key: string): DropClass {
  if (CONTENT_KEY_PATTERN.test(key)) return 'content';
  return Object.hasOwn(ATTRIBUTE_SPECS, key) ? 'wrong_span' : 'unknown';
}

function isAllowed(key: string, kind: SpanKind, options: SanitizeOptions): boolean {
  if (!ALLOWED_KEYS[kind].has(key) || !Object.hasOwn(ATTRIBUTE_SPECS, key)) return false;
  return key !== 'exception.message' || options.allowExceptionMessage === true;
}

/**
 * Filters `raw` through the allowlist of `kind`. Never throws: whatever cannot be accepted is
 * dropped and counted. When the guard replaced anything, `oax.redacted=true` is added.
 */
export function sanitizeAttributes(
  kind: SpanKind,
  raw: Readonly<Record<string, unknown>>,
  guard: ContextGuard,
  options: SanitizeOptions = {},
): SanitizedAttributes {
  const tally = new Tally();
  const attributes: Record<string, AttributeValue> = {};
  let seen = 0;
  for (const key of Object.keys(raw)) {
    if (++seen > MAX_ATTRIBUTES_PER_CALL) {
      tally.drop('overflow');
      continue;
    }
    if (!isAllowed(key, kind, options)) {
      tally.drop(classify(key));
      continue;
    }
    const value = sanitizeValue(
      ATTRIBUTE_SPECS[key as keyof typeof ATTRIBUTE_SPECS],
      raw[key],
      guard,
      tally,
    );
    if (value === null) tally.drop('invalid');
    else attributes[key] = value;
  }
  if (Object.keys(tally.redactions).length > 0) attributes['oax.redacted'] = true;
  return { attributes, dropped: tally.dropped, redactions: tally.redactions };
}

const MAX_NAME_CHARS = 128;

/** Span and event names are text too: control characters out, guarded, capped. */
export function sanitizeName(
  name: string,
  guard: ContextGuard,
  fallback: string,
): { name: string; redactions: Record<string, number> } {
  const tally = new Tally();
  const s = tally
    .guarded(guard, typeof name === 'string' ? name.replace(CONTROL_CHARS, '') : '')
    .slice(0, MAX_NAME_CHARS)
    .trim();
  return { name: s.length > 0 ? s : fallback, redactions: tally.redactions };
}

const HTTP_METHOD_NAME = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \//;

/** Maps a span name (ADR 0015 3.2) to its kind; anything unrecognised gets the common keys only. */
export function spanKindFromName(name: string): SpanKind {
  if (name === 'oax.run') return 'run';
  if (name === 'oax.run.admit') return 'run_admit';
  if (name === 'oax.node.session') return 'node_session';
  if (name.startsWith('invoke_workflow')) return 'invoke_workflow';
  if (name.startsWith('invoke_agent')) return 'invoke_agent';
  if (name.startsWith('oax.handover')) return 'handover';
  if (name.startsWith('chat')) return 'chat';
  if (name.startsWith('oax.policy.check')) return 'policy_check';
  if (name.startsWith('oax.approval.wait')) return 'approval_wait';
  if (name.startsWith('execute_tool')) return 'execute_tool';
  if (HTTP_METHOD_NAME.test(name)) return 'http_server';
  return 'unknown';
}
