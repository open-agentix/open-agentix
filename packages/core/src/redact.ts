/**
 * Secret redaction for logs, audit payloads and API responses.
 * Key-based (sensitive field names) + value-based (well-known token formats) + exact known secrets.
 */

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /^(?:.*[_-])?(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth|cookie|set-cookie|credentials?|client[_-]?secret|session)$/i;

const VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\boax_[A-Za-z0-9]{8,}_[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s/@]+@/gi,
];

export interface RedactorOptions {
  /** Exact secret values (e.g. resolved secret references) that must never appear in output. */
  knownSecrets?: readonly string[];
  /** Additional key names to treat as sensitive. */
  extraKeys?: readonly string[];
}

export function isSensitiveKey(key: string, extraKeys: readonly string[] = []): boolean {
  return SENSITIVE_KEY.test(key) || extraKeys.some((k) => k.toLowerCase() === key.toLowerCase());
}

export function redactString(value: string, knownSecrets: readonly string[] = []): string {
  let out = value;
  for (const s of knownSecrets) {
    if (s.length >= 4) out = out.split(s).join(REDACTED);
  }
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, (_match, group: unknown) => {
      const scheme = typeof group === 'string' ? group : '';
      if (/^(Bearer|Basic)$/i.test(scheme)) return `${scheme} ${REDACTED}`;
      if (scheme.includes('://')) return `${scheme}${REDACTED}@`;
      return REDACTED;
    });
  }
  return out;
}

/** Returns a deep copy of `value` with secrets replaced. Cycles are replaced by `[Circular]`. */
export function redact<T>(value: T, opts: RedactorOptions = {}): T {
  const known = opts.knownSecrets ?? [];
  const extra = opts.extraKeys ?? [];
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v, known);
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return v;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] =
        isSensitiveKey(k, extra) && val !== null && val !== undefined && val !== ''
          ? REDACTED
          : walk(val);
    }
    return out;
  };
  return walk(value) as T;
}

export function createRedactor(opts: RedactorOptions = {}): <T>(value: T) => T {
  return (value) => redact(value, opts);
}
