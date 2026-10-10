import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * PKCE (RFC 7636) and state helpers for the authorization-code flow (ADR 0016 section 7.2). The
 * method is always S256: the platform never sends `plain`, and refuses an authorization server
 * that does not list S256.
 */

/** 256 bits of CSPRNG output, base64url (43 characters): the verifier alphabet and length are valid. */
export const newSecretToken = (): string => randomBytes(32).toString('base64url');

export const challengeOf = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

/** What is stored for a state: the state itself is only ever in the authorization URL. */
export const stateHash = (state: string): string =>
  createHash('sha256').update(state, 'utf8').digest('hex');

/** The shape of a state the platform issued (43 base64url characters); anything else is refused early. */
export const STATE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const sameString = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
