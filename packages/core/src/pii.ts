/**
 * Built-in personal data detectors of the ADR 0012 section 7.3 redactor chain: e-mail address,
 * IBAN (mod 97), payment card number (Luhn), IP address and phone number. Detection is
 * best effort and pattern based (it finds common shapes, not every personal datum); callers that
 * export free text to a destination outside the platform apply it on top of the secret guard.
 *
 * Every pattern is bounded (no nested quantifiers, fixed maximum lengths), so the cost is linear
 * in the input. Replacements are `[pii:<kind>]`; the report carries counts per kind only.
 */

export const PII_KINDS = ['email', 'iban', 'card', 'ip', 'phone'] as const;
export type PiiKind = (typeof PII_KINDS)[number];

export interface PiiResult {
  text: string;
  /** Number of replacements per kind (only kinds that were found). */
  counts: Partial<Record<PiiKind, number>>;
}

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;
// Compact (`DE89370400440532013000`) or in groups of four (`DE89 3704 0044 0532 0130 00`); a word that
// follows the number is never absorbed because every group after the first is exactly four characters
// except the last one.
const IBAN_CANDIDATE =
  /\b[A-Za-z]{2}\d{2}(?:(?:[\s-][A-Za-z0-9]{4}){2,7}(?:[\s-][A-Za-z0-9]{1,4})?|[A-Za-z0-9]{11,30})\b/g;
const CARD_CANDIDATE = /\b\d(?:[\s-]?\d){12,18}\b/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
// Eight groups, or a compressed form with at least one `::`; hex groups of 1-4 digits.
const IPV6 =
  /(?<![0-9A-Fa-f:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?|::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6}))(?![0-9A-Fa-f:])/g;
// International (+CC ...) or national numbers with a leading 0 and separators; 8-15 digits in all.
const PHONE =
  /(?<![\w.])(?:(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?|0)\d{1,4}(?:[\s./-]?\d{2,5}){1,4}|\(0\d{1,4}\)[\s./-]?\d{2,5}(?:[\s./-]?\d{2,5}){0,3})(?!\w)/g;

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

/** Luhn checksum of a digit string. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** ISO 13616 mod 97 check of an IBAN without separators. */
export function ibanValid(iban: string): boolean {
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 && code <= 90 ? String(code - 55) : ch;
    if (!/^[0-9]+$/.test(chunk)) return false;
    for (const c of chunk) remainder = (remainder * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Replaces detected personal data. Order matters: longer, more specific shapes first. */
export function redactPii(input: string): PiiResult {
  const counts: Partial<Record<PiiKind, number>> = {};
  const hit = (kind: PiiKind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    return `[pii:${kind}]`;
  };
  // NFKC first: fullwidth digits and letters, no-break spaces, U+2024 and similar look-alikes become
  // their ASCII forms, so the patterns below see what a reader sees.
  let out = input.normalize('NFKC');
  out = out.replace(EMAIL, () => hit('email'));
  out = out.replace(IBAN_CANDIDATE, (m) =>
    ibanValid(m.replace(/[\s-]/g, '').toUpperCase()) ? hit('iban') : m,
  );
  out = out.replace(CARD_CANDIDATE, (m) => {
    const d = digitsOf(m);
    return d.length >= 13 && d.length <= 19 && luhnValid(d) ? hit('card') : m;
  });
  out = out.replace(IPV4, () => hit('ip'));
  out = out.replace(IPV6, () => hit('ip'));
  out = out.replace(PHONE, (m) => {
    const n = digitsOf(m).length;
    return n >= 8 && n <= 15 ? hit('phone') : m;
  });
  return { text: out, counts };
}
