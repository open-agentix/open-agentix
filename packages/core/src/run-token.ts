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
  /**
   * Run node session id (ADR 0008). Present only on step-scoped tokens handed to an isolated run
   * node; the control node then checks the session on every call. Tokens without `sid` belong to
   * the trusted worker that holds the run's lease.
   */
  sid?: string;
  /** Agent ids this token may act for (with `sid`; the credential broker checks them). */
  steps?: string[];
}

const MAX_STEPS = 16;

const PREFIX = 'oaxrt';

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`${PREFIX}.${payload}`).digest();
}

export function issueRunToken(
  secret: string,
  claims: {
    runId: string;
    workerId: string;
    ttlSeconds: number;
    sid?: string;
    steps?: readonly string[];
  },
  now: number = Date.now(),
): string {
  if (secret.length < 32)
    throw new OaxError('config_invalid', 'run token secret must have at least 32 characters');
  if ((claims.sid === undefined) !== (claims.steps === undefined))
    throw new OaxError('config_invalid', 'a step-scoped run token needs both sid and steps');
  if (claims.steps && (claims.steps.length === 0 || claims.steps.length > MAX_STEPS))
    throw new OaxError('config_invalid', `a step-scoped run token covers 1-${MAX_STEPS} steps`);
  const iat = Math.floor(now / 1000);
  const body: RunTokenClaims = {
    runId: claims.runId,
    workerId: claims.workerId,
    iat,
    exp: iat + claims.ttlSeconds,
    ...(claims.sid !== undefined ? { sid: claims.sid, steps: [...(claims.steps ?? [])] } : {}),
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
  // Fail closed on a half-scoped token (signed by us, but never issued in this shape).
  const scoped = claims.sid !== undefined || claims.steps !== undefined;
  if (
    scoped &&
    (typeof claims.sid !== 'string' ||
      claims.sid === '' ||
      !Array.isArray(claims.steps) ||
      claims.steps.length === 0 ||
      claims.steps.length > MAX_STEPS ||
      !claims.steps.every((x) => typeof x === 'string'))
  )
    throw new OaxError('run_token_invalid', 'run token scope is invalid');
  return claims;
}
