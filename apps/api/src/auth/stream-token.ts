import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../errors.js';

/**
 * Short-lived, single-run tokens for EventSource (which cannot send an Authorization header):
 * `oaxst.<base64url claims>.<hmac>`, passed as `?access_token=` on the stream URL only.
 */
export interface StreamTokenClaims {
  userId: string;
  runId: string;
  exp: number;
}

const sign = (secret: string, payload: string) =>
  createHmac('sha256', `stream:${secret}`).update(payload).digest('base64url');

export function issueStreamToken(
  secret: string,
  userId: string,
  runId: string,
  ttlSeconds: number,
  now = Date.now(),
): { token: string; expiresAt: Date } {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ userId, runId, exp })).toString('base64url');
  return { token: `oaxst.${payload}.${sign(secret, payload)}`, expiresAt: new Date(exp * 1000) };
}

export function verifyStreamToken(
  secret: string,
  token: string,
  runId: string,
  now = Date.now(),
): StreamTokenClaims {
  const [prefix, payload = '', sig = ''] = token.split('.');
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(sig);
  if (prefix !== 'oaxst' || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(401, 'unauthenticated', 'invalid stream token');
  }
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as StreamTokenClaims;
  if (claims.exp * 1000 <= now) throw new HttpError(401, 'unauthenticated', 'stream token expired');
  if (claims.runId !== runId)
    throw new HttpError(403, 'forbidden', 'stream token is for another run');
  return claims;
}
