import { INVISIBLE_CLASSES, stripInvisible, type InvisibleReport } from './invisible-text.js';
import { SECRET_PATTERNS } from './secret-patterns.js';

/**
 * Guard for everything that enters a model's context or a stored step output: removes invisible
 * steering Unicode (`invisible-text.ts`) and replaces secret values with `[redacted:<kind>]`.
 *
 * Secrets are found in two ways: exact values the process knows to be in use (resolved secret
 * references, brokered credentials, run and model tokens; matched plain, URL-encoded, base64 and
 * hex) and common token shapes (`secret-patterns.ts`). Known values shorter than
 * {@link MIN_KNOWN_SECRET_LENGTH} are not matched exactly, because they would mangle ordinary text;
 * the token shapes still apply.
 *
 * Reports carry counts and class or kind names only, never the content, so they are safe to audit.
 */

export const MIN_KNOWN_SECRET_LENGTH = 8;
/** Longest block of a private key that is replaced when the END line is present. */
const PRIVATE_KEY_BLOCK_MAX = 16_384;
/** Replaced after a BEGIN line whose END line is missing (a truncated tool result). */
const PRIVATE_KEY_TRUNCATED_MAX = 4_096;

export interface GuardReport {
  invisible: InvisibleReport;
  secrets: { total: number; kinds: Record<string, number> };
}

export const emptyGuardReport = (): GuardReport => ({
  invisible: { total: 0, classes: {} },
  secrets: { total: 0, kinds: {} },
});

export const isGuardReportEmpty = (r: GuardReport): boolean =>
  r.invisible.total === 0 && r.secrets.total === 0;

export function mergeGuardReports(into: GuardReport, from: GuardReport): void {
  into.invisible.total += from.invisible.total;
  for (const [k, n] of Object.entries(from.invisible.classes))
    into.invisible.classes[k as keyof InvisibleReport['classes']] =
      (into.invisible.classes[k as keyof InvisibleReport['classes']] ?? 0) + (n ?? 0);
  into.secrets.total += from.secrets.total;
  for (const [k, n] of Object.entries(from.secrets.kinds))
    into.secrets.kinds[k] = (into.secrets.kinds[k] ?? 0) + n;
}

export interface ContextGuardOptions {
  /** Remove invisible steering Unicode. Default `true`. */
  stripInvisible?: boolean;
  /** Replace secret values. Default `true`. */
  redactSecrets?: boolean;
  /** Exact secret values in use at start (more can be added with {@link ContextGuard.addSecret}). */
  knownSecrets?: Iterable<string>;
}

// The private key pattern in the shared list only finds the header; for redaction the body goes too.
// Both branches are bounded, so a text full of BEGIN lines costs a constant per 4 KiB consumed.
const PRIVATE_KEY_BLOCK = new RegExp(
  '-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY(?: BLOCK)?-----' +
    `(?:[\\s\\S]{0,${PRIVATE_KEY_BLOCK_MAX}}?-----END [A-Z0-9 ]{0,64}PRIVATE KEY(?: BLOCK)?-----` +
    `|[\\s\\S]{0,${PRIVATE_KEY_TRUNCATED_MAX}})`,
  'g',
);

const GLOBAL_PATTERNS: readonly (readonly [string, RegExp])[] = SECRET_PATTERNS.map(
  ([kind, re]) => [kind, new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)],
);

/**
 * The base64 characters that encode only the secret's bits, for each of the three byte alignments
 * it can have inside a larger encoded blob (a docker `auth` field is base64 of `user:secret`, a
 * Kubernetes Secret or an encoded `.env` puts the value at any offset). The characters at either
 * end mix in neighbouring bits and are left out, so the core matches whatever surrounds it.
 */
function base64Cores(bytes: Buffer): string[] {
  const out: string[] = [];
  for (let shift = 0; shift < 3; shift++) {
    const enc = Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64');
    out.push(enc.slice(Math.ceil((shift * 8) / 6), Math.floor(((shift + bytes.length) * 8) / 6)));
  }
  return out;
}

function forms(secret: string): string[] {
  const bytes = Buffer.from(secret);
  const b64 = base64Cores(bytes);
  const hex = bytes.toString('hex');
  return [
    secret,
    encodeURIComponent(secret),
    ...b64,
    ...b64.map((c) => c.replace(/\+/g, '-').replace(/\//g, '_')),
    hex,
    hex.toUpperCase(),
  ].filter((f, i, all) => f.length >= MIN_KNOWN_SECRET_LENGTH && all.indexOf(f) === i);
}

export class ContextGuard {
  readonly stripInvisible: boolean;
  readonly redactSecrets: boolean;
  /** Longest first, so a secret that contains another one is replaced as a whole. */
  private known: string[] = [];

  constructor(opts: ContextGuardOptions = {}) {
    this.stripInvisible = opts.stripInvisible ?? true;
    this.redactSecrets = opts.redactSecrets ?? true;
    for (const s of opts.knownSecrets ?? []) this.addSecret(s);
  }

  /** Registers a secret value that is in use (resolved reference, brokered credential, token). */
  addSecret(value: string): void {
    if (value.length < MIN_KNOWN_SECRET_LENGTH) return;
    for (const f of forms(value)) {
      if (this.known.includes(f)) continue;
      this.known.push(f);
    }
    this.known.sort((a, b) => b.length - a.length);
  }

  private redactText(text: string, report: GuardReport['secrets']): string {
    let out = text;
    const count = (kind: string, n: number) => {
      if (n === 0) return;
      report.total += n;
      report.kinds[kind] = (report.kinds[kind] ?? 0) + n;
    };
    for (const k of this.known) {
      if (!out.includes(k)) continue;
      const parts = out.split(k);
      count('known-secret', parts.length - 1);
      out = parts.join('[redacted:known-secret]');
    }
    let n = 0;
    out = out.replace(PRIVATE_KEY_BLOCK, () => {
      n++;
      return '[redacted:private-key]';
    });
    count('private-key', n);
    for (const [kind, re] of GLOBAL_PATTERNS) {
      if (kind === 'private-key') continue;
      let hits = 0;
      out = out.replace(re, () => {
        hits++;
        return `[redacted:${kind}]`;
      });
      count(kind, hits);
    }
    return out;
  }

  /** Guards one string. Returns the input unchanged (same string) when nothing was found. */
  text(input: string): { text: string; report: GuardReport } {
    const report = emptyGuardReport();
    let out = input;
    if (this.stripInvisible) {
      const r = stripInvisible(out);
      out = r.text;
      report.invisible = r.report;
    }
    if (this.redactSecrets) out = this.redactText(out, report.secrets);
    return { text: out, report };
  }

  /**
   * Guards every string of a JSON-like value, keys included (a JSON schema's property names reach
   * the model as much as its descriptions do). Cycles are not followed.
   */
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
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [walk(k) as string, walk(val)]));
    };
    return { value: walk(input) as T, report };
  }
}

const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Builds the guard from the environment. Both stages are ON unless explicitly turned off with one
 * of `0`, `false`, `off`, `no` (anything else, including a typo, keeps the stage on: fail safe):
 * `OAX_STRIP_INVISIBLE_UNICODE` and `OAX_REDACT_MODEL_CONTEXT`. Turning a stage off is meant for
 * diagnostics only.
 */
export function contextGuardFromEnv(
  env: Record<string, string | undefined> = process.env,
  knownSecrets: Iterable<string> = [],
): ContextGuard {
  const off = (name: string) => OFF.has((env[name] ?? '').trim().toLowerCase());
  return new ContextGuard({
    stripInvisible: !off('OAX_STRIP_INVISIBLE_UNICODE'),
    redactSecrets: !off('OAX_REDACT_MODEL_CONTEXT'),
    knownSecrets,
  });
}

/** Every secret kind a report can contain. */
export const SECRET_KINDS: ReadonlySet<string> = new Set([
  'known-secret',
  ...SECRET_PATTERNS.map(([kind]) => kind),
]);
const CLASS_NAMES: ReadonlySet<string> = new Set(INVISIBLE_CLASSES);
const MAX_AUDIT_COUNT = 1_000_000_000;

/**
 * The only shape of a guard report that is recorded in an audit entry: counts and the names this
 * guard can produce (invisible classes, secret kinds), nothing else. Used for node-reported reports
 * too, so a node cannot carry text in made-up names or out-of-range numbers.
 */
export function auditShapeOfReport(r: unknown): GuardReport {
  const out = emptyGuardReport();
  const rec = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? Math.min(Math.floor(v), MAX_AUDIT_COUNT)
      : 0;
  const pick = (v: unknown, known: ReadonlySet<string>, into: Record<string, number>) => {
    for (const [k, n] of Object.entries(rec(v))) {
      if (known.has(k)) into[k] = num(n);
    }
  };
  const inv = rec(rec(r).invisible);
  const sec = rec(rec(r).secrets);
  out.invisible.total = num(inv.total);
  pick(inv.classes, CLASS_NAMES, out.invisible.classes as Record<string, number>);
  out.secrets.total = num(sec.total);
  pick(sec.kinds, SECRET_KINDS, out.secrets.kinds);
  return out;
}
