import { deflateRawSync } from 'node:zlib';
import { OaxError } from '@openagentix/core';

/**
 * What a stored OAuth credential value may look like. The value is chosen by the authorization
 * server (and with it, by whoever controls that server for a tenant), and once stored it is
 * registered with redactors that rewrite it wherever it occurs. A hostile value must therefore
 * never be able to (a) change the structure of JSON it is substituted into, (b) match ordinary
 * text (paths, host names, error codes, identifiers of other tenants), or (c) make matching slow
 * (long periodic strings). The registry additionally scopes audit and response scrubbing to the
 * tenant that owns the token; these rules are what protects the process-wide log scrubbing.
 *
 * Accepted: RFC 6750 `b64token` (letters, digits and `-._~+/`, optional `=` padding), 20 to
 * {@link MAX_TOKEN_LENGTH} characters, and random-looking: enough estimated bits for the alphabet
 * it uses, not compressible, not word-like, not built from identifiers. Hex strings of 20 or more
 * characters (opaque API keys) are fine; a UUID is not.
 */
export const MIN_TOKEN_LENGTH = 20;
export const MAX_TOKEN_LENGTH = 2048;
/** Estimated entropy below which a value is guessable or not credential-like. */
export const MIN_TOKEN_BITS = 80;
const B64_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
const DIGITS = /^[0-9]+$/;
/** A dashed UUID of a real version and variant, alone or inside a longer value. */
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
/** Runs of lower-case letters long enough to be words; random b64 text has few of them. */
const WORD_RUN = /[a-z]{4,}/g;
const MAX_WORD_SHARE = 0.4;
/** Deflated size must be at least this share of the estimated entropy, from this length up. */
const MIN_COMPRESSED_SHARE = 0.75;
const COMPRESSION_CHECK_FROM = 32;
const MIN_DISTINCT = 6;

const invalid = (why: string) => new OaxError('token_invalid', `the token ${why}`);

/** log2 of the alphabet the value draws from, judged by the character classes it uses. */
function alphabetBits(value: string): number {
  if (HEX_ONLY.test(value)) return 4;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length;
  const symbols = /[-._~+/=]/.test(value);
  const size = classes === 1 ? 26 : classes === 2 ? 36 : 62;
  return Math.log2(size + (symbols ? 4 : 0));
}

function wordShare(value: string): number {
  let inWords = 0;
  for (const m of value.matchAll(WORD_RUN)) inWords += m[0].length;
  return inWords / value.length;
}

/** Throws `token_invalid` (never quoting the value) unless `value` may be stored and redacted. */
export function assertTokenShape(value: string, ids: readonly string[] = []): void {
  if (value.length < MIN_TOKEN_LENGTH || value.length > MAX_TOKEN_LENGTH)
    throw invalid(`must be ${MIN_TOKEN_LENGTH} to ${MAX_TOKEN_LENGTH} characters long`);
  if (!B64_TOKEN.test(value)) throw invalid('contains characters outside RFC 6750 b64token');
  if (UUID_ANYWHERE.test(value) || DIGITS.test(value)) throw invalid('looks like an identifier');
  const lower = value.toLowerCase();
  for (const id of ids)
    if (
      id &&
      (lower.includes(id.toLowerCase()) || lower.includes(id.replace(/-/g, '').toLowerCase()))
    )
      throw invalid('contains an identifier');
  if (new Set(value).size < MIN_DISTINCT) throw invalid('is not random enough to be a credential');
  const bits = value.length * alphabetBits(value);
  if (bits < MIN_TOKEN_BITS) throw invalid('is not random enough to be a credential');
  if (!HEX_ONLY.test(value)) {
    // One alphanumeric class only (an upper-case code, a lower-case path) is not a random token.
    if (!hasTwoClasses(value)) throw invalid('is not random enough to be a credential');
    if (wordShare(value) > MAX_WORD_SHARE) throw invalid('looks like text, not a credential');
  }
  if (value.length >= COMPRESSION_CHECK_FROM) {
    const compressedBits = deflateRawSync(value, { level: 9 }).length * 8;
    if (compressedBits < MIN_COMPRESSED_SHARE * bits)
      throw invalid('is repetitive and not random enough to be a credential');
  }
}

function hasTwoClasses(value: string): boolean {
  return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length >= 2;
}
