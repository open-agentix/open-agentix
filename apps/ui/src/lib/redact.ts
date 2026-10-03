/**
 * Display-side redaction (defence in depth; the control node redacts audit payloads and logs
 * already). Never shows secret-looking values in the UI.
 */
export const REDACTED = '[redacted]';

const SECRET_KEY =
  /(secret|token|passw(or)?d|authorization|api[-_]?key|cookie|credential|private[-_]?key)/i;
const SECRET_VALUE: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\boax(rt)?_[A-Za-z0-9._-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9-]{16,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Keys whose value is a reference to a secret (not the secret itself) stay visible. */
function isReferenceKey(key: string): boolean {
  return /(ref|refs|secretname|envsecrets|headersecrets)$/i.test(key);
}

export function redactString(value: string): string {
  return SECRET_VALUE.reduce((s, re) => s.replace(re, REDACTED), value);
}

export function redact(value: unknown, depth = 0, referenceMap = false): unknown {
  if (depth > 20) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, referenceMap));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const reference = referenceMap || isReferenceKey(k);
      out[k] =
        !reference && SECRET_KEY.test(k) && v !== null && typeof v !== 'object'
          ? REDACTED
          : redact(v, depth + 1, reference);
    }
    return out;
  }
  return value;
}
