import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque bearer tokens `oax_<id>_<secret>`; only SHA-256(secret) is stored. */
export interface NewToken {
  id: string;
  secret: string;
  token: string;
  secretHash: string;
}

export function newToken(): NewToken {
  const id = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { id, secret, token: `oax_${id}_${secret}`, secretHash: hashSecret(secret) };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function parseToken(token: string): { id: string; secret: string } | null {
  const m = /^oax_([0-9a-f]{16})_([A-Za-z0-9_-]{20,})$/.exec(token);
  return m?.[1] && m[2] ? { id: m[1], secret: m[2] } : null;
}

export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
