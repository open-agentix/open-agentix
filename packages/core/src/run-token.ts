import { createHmac, timingSafeEqual } from 'node:crypto';
import { OaxError } from './errors.js';

/**
 * Signed, short-lived run tokens: the credential a worker node uses to talk to the control node
 * (policy gate, step reporting, approvals) for exactly one run. Format:
 * `oaxrt.<base64url(json claims)>.<base64url(hmac-sha256)>`.
 */
export interface RunTokenClaims {
  runId: string;
  workerId: string;
  /** Expiry, unix seconds. */
  exp: number;
  /** Issued at, unix seconds. */
  iat: number;
}

const PREFIX = 'oaxrt';

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`${PREFIX}.${payload}`).digest();
}

export function issueRunToken(
  secret: string,
  claims: { runId: string; workerId: string; ttlSeconds: number },
  now: number = Date.now(),
): string {
  if (secret.length < 32)
    throw new OaxError('config_invalid', 'run token secret must have at least 32 characters');
  const iat = Math.floor(now / 1000);
  const body: RunTokenClaims = {
    runId: claims.runId,
    workerId: claims.workerId,
    iat,
    exp: iat + claims.ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${PREFIX}.${payload}.${mac(secret, payload).toString('base64url')}`;
}

export function verifyRunToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): RunTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX)
    throw new OaxError('run_token_invalid', 'malformed run token');
  const [, payload = '', sig = ''] = parts;
  const expected = mac(secret, payload);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new OaxError('run_token_invalid', 'run token signature is invalid');
  }
  let claims: RunTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RunTokenClaims;
  } catch {
    throw new OaxError('run_token_invalid', 'run token payload is invalid');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) {
    throw new OaxError('run_token_expired', 'run token has expired');
  }
  return claims;
}
