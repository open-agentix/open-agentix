import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HARNESS_KINDS } from './agents/schema.js';
import { OaxError } from './errors.js';

/**
 * Model tokens (ADR 0009, section 2.2): the only credential a run node or a harness child process
 * holds for model access. It opens the model endpoints of exactly one step in one run-node
 * session and nothing else (no gate, approvals, credentials or handover endpoints).
 *
 * Format: `oaxmt.<base64url(json claims)>.<base64url(hmac-sha256)>`.
 *
 * Security properties:
 * - Domain separation: the MAC key is `HMAC-SHA256(secret, "openagentix/model-token/v1")`, never the
 *   run token secret itself, and the MAC input carries the `oaxmt` prefix. A model token can never
 *   verify as a run token (`oaxrt`, other key) and the other way round.
 * - Single purpose: `aud` is fixed to `model`; claims are bound to run, session, node, step agent
 *   and one `jti` (the session stores the issued `jti`, so there is at most one valid token).
 * - Expiring: `exp` is mandatory and capped by the session expiry (`notAfterMs`).
 * - Constant-time signature comparison, canonical encodings only, signature checked before the
 *   payload is parsed, claims validated by a strict schema.
 *
 * This module only checks the token itself. The session, run and step checks of ADR 0009 section
 * 2.2 (revocation, `jti` equals the stored one, run running) belong to the control node.
 */
export const MODEL_TOKEN_PREFIX = 'oaxmt';
export const MODEL_TOKEN_KEY_LABEL = 'openagentix/model-token/v1';
export const MODEL_TOKEN_AUDIENCE = 'model';

/** Tolerated clock difference for `iat` (seconds). */
const IAT_SKEW_SECONDS = 60;
/** Tokens are bearer credentials in headers; keep them small. */
const MAX_TOKEN_LENGTH = 2048;

const Id = z.string().min(1).max(200);

export const ModelTokenClaimsSchema = z.strictObject({
  v: z.literal(1),
  aud: z.literal(MODEL_TOKEN_AUDIENCE),
  runId: Id,
  sid: Id,
  nodeId: Id,
  agentId: Id,
  /**
   * Which endpoint family the token opens: `native` (the built-in step loop, `POST .../model`) or
   * `harness` (the pass-through surfaces of an external harness). Tokens without the claim are
   * native. The endpoints refuse the other surface (ADR 0009 section 10).
   */
  surface: z.enum(['native', 'harness']).default('native'),
  /** The harness a `harness` token was issued for. */
  harness: z.enum(HARNESS_KINDS).optional(),
  jti: Id,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type ModelTokenClaims = z.infer<typeof ModelTokenClaimsSchema>;

export interface IssueModelTokenInput {
  runId: string;
  sid: string;
  nodeId: string;
  agentId: string;
  /** Defaults to `native`; `harness` needs `harness`. */
  surface?: 'native' | 'harness';
  harness?: (typeof HARNESS_KINDS)[number];
  /** Token lifetime in seconds (the caller passes at most `OAX_RUN_TOKEN_TTL_SECONDS`). */
  ttlSeconds: number;
  /** Hard upper bound for `exp` in unix milliseconds: the session expiry. */
  notAfterMs?: number;
  /** Defaults to a random UUID. */
  jti?: string;
}

export interface IssuedModelToken {
  token: string;
  claims: ModelTokenClaims;
}

/** Bindings a caller expects; every given field must equal the claim exactly. */
export interface ModelTokenExpectation {
  runId?: string;
  sid?: string;
  nodeId?: string;
  agentId?: string;
  jti?: string;
}

function requireSecret(secret: string): void {
  if (secret.length < 32)
    throw new OaxError('config_invalid', 'run token secret must have at least 32 characters');
}

function modelKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(MODEL_TOKEN_KEY_LABEL).digest();
}

function mac(secret: string, payload: string): Buffer {
  return createHmac('sha256', modelKey(secret)).update(`${MODEL_TOKEN_PREFIX}.${payload}`).digest();
}

export function issueModelToken(
  secret: string,
  input: IssueModelTokenInput,
  now: number = Date.now(),
): IssuedModelToken {
  requireSecret(secret);
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0)
    throw new OaxError('model_token_ttl_invalid', 'model token ttl must be a positive integer');
  const iat = Math.floor(now / 1000);
  let exp = iat + input.ttlSeconds;
  if (input.notAfterMs !== undefined) exp = Math.min(exp, Math.floor(input.notAfterMs / 1000));
  if (exp <= iat)
    throw new OaxError('model_token_ttl_invalid', 'model token would be expired when issued');
  if ((input.surface === 'harness') !== (input.harness !== undefined))
    throw new OaxError('model_token_invalid', 'a harness token names its harness, others do not');
  const claims = ModelTokenClaimsSchema.parse({
    v: 1,
    aud: MODEL_TOKEN_AUDIENCE,
    runId: input.runId,
    sid: input.sid,
    nodeId: input.nodeId,
    agentId: input.agentId,
    surface: input.surface ?? 'native',
    ...(input.harness ? { harness: input.harness } : {}),
    jti: input.jti ?? randomUUID(),
    iat,
    exp,
  });
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return {
    token: `${MODEL_TOKEN_PREFIX}.${payload}.${mac(secret, payload).toString('base64url')}`,
    claims,
  };
}

const invalid = (message: string) => new OaxError('model_token_invalid', message);

/** Strict base64url: decodes only when the text is the canonical encoding of its bytes. */
function decodeCanonical(text: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const buf = Buffer.from(text, 'base64url');
  return buf.toString('base64url') === text ? buf : undefined;
}

export function verifyModelToken(
  secret: string,
  token: string,
  now: number = Date.now(),
  expect: ModelTokenExpectation = {},
): ModelTokenClaims {
  requireSecret(secret);
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH)
    throw invalid('malformed model token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== MODEL_TOKEN_PREFIX) throw invalid('malformed model token');
  const [, payload = '', sig = ''] = parts;
  const given = decodeCanonical(sig);
  const expected = mac(secret, payload);
  if (!given || given.length !== expected.length || !timingSafeEqual(given, expected))
    throw invalid('model token signature is invalid');
  const raw = decodeCanonical(payload);
  let claims: ModelTokenClaims;
  try {
    if (!raw) throw new Error('not canonical');
    claims = ModelTokenClaimsSchema.parse(JSON.parse(raw.toString('utf8')));
  } catch {
    throw invalid('model token payload is invalid');
  }
  const nowSeconds = Math.floor(now / 1000);
  if (claims.iat > nowSeconds + IAT_SKEW_SECONDS) throw invalid('model token is not yet valid');
  if (claims.exp <= nowSeconds || claims.exp <= claims.iat)
    throw new OaxError('model_token_expired', 'model token has expired');
  for (const key of ['runId', 'sid', 'nodeId', 'agentId', 'jti'] as const) {
    const want = expect[key];
    if (want !== undefined && want !== claims[key])
      throw new OaxError('model_token_binding', `model token is not valid for this ${key}`);
  }
  return claims;
}
