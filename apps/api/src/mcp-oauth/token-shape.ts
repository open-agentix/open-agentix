import { OaxError } from '@openagentix/core';

/**
 * What a stored OAuth credential value may look like. The value is chosen by the authorization
 * server (and with it, by whoever controls that server for a tenant), and once stored it is
 * registered with process-wide redactors that rewrite it wherever it occurs. A hostile value must
 * therefore never be able to (a) change the structure of JSON it is substituted into, or (b)
 * match ordinary identifiers of other tenants.
 *
 * Accepted: RFC 6750 `b64token` (letters, digits and `-._~+/`, optional `=` padding), 20 to 4096
 * characters, not shaped like a UUID or a UUID without dashes, and with the entropy of a random
 * value.
 */
export const MIN_TOKEN_LENGTH = 20;
export const MAX_TOKEN_LENGTH = 4096;
const B64_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const DIGITS = /^[0-9]+$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** Shannon entropy (bits per character) and distinct characters below which a value is not random. */
const MIN_ENTROPY = 3;
const MIN_DISTINCT = 10;

const invalid = (why: string) => new OaxError('token_invalid', `the token ${why}`);

function entropyOf(value: string): { bits: number; distinct: number } {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return { bits, distinct: counts.size };
}

/** Throws `token_invalid` (never quoting the value) unless `value` may be stored and redacted. */
export function assertTokenShape(value: string, ids: readonly string[] = []): void {
  if (value.length < MIN_TOKEN_LENGTH || value.length > MAX_TOKEN_LENGTH)
    throw invalid(`must be ${MIN_TOKEN_LENGTH} to ${MAX_TOKEN_LENGTH} characters long`);
  if (!B64_TOKEN.test(value)) throw invalid('contains characters outside RFC 6750 b64token');
  if (UUID.test(value) || DIGITS.test(value)) throw invalid('looks like an identifier');
  for (const id of ids)
    if (id && value.toLowerCase().includes(id.toLowerCase()))
      throw invalid('contains an identifier');
  const { bits, distinct } = entropyOf(value);
  if (bits < MIN_ENTROPY || distinct < MIN_DISTINCT)
    throw invalid('is not random enough to be a credential');
}
