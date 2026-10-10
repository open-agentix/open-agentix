import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { OaxError } from '@openagentix/core';

/**
 * AES-256-GCM sealing with additional authenticated data (ADR 0016 section 7.5). Pure functions;
 * keys come from the key service. Wire format: `oaxe1.<iv>.<ciphertext>.<tag>`, each part
 * base64url. Errors never carry key, plaintext or ciphertext.
 */
export const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT = 'oaxe1';

/** What a sealed token is bound to; a ciphertext copied to another row does not open. */
export interface BindingContext {
  tenantId: string;
  connectionId: string;
  issuer: string;
  resource: string;
  credentialVersion: number;
}

/**
 * Canonical AAD of a binding: tenant | connection | issuer | resource | credential version. The
 * parts are JSON-encoded as an array, so no value can shift a boundary (`a|b` + `c` versus `a` +
 * `b|c`).
 */
export function bindingAad(b: BindingContext): Buffer {
  return Buffer.from(
    JSON.stringify([b.tenantId, b.connectionId, b.issuer, b.resource, String(b.credentialVersion)]),
    'utf8',
  );
}

const b64 = (b: Buffer) => b.toString('base64url');

export function seal(key: Buffer, plaintext: Buffer | string, aad: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [FORMAT, b64(iv), b64(ct), b64(cipher.getAuthTag())].join('.');
}

/** Opens a sealed value; a wrong key, wrong AAD or any change to the value fails. */
export function open(key: Buffer, sealed: string, aad: Buffer): Buffer {
  assertKey(key);
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT) throw decryptFailed();
  const [iv, ct, tag] = parts.slice(1).map((p) => Buffer.from(p ?? '', 'base64url')) as [
    Buffer,
    Buffer,
    Buffer,
  ];
  if (iv.length !== IV_BYTES || tag.length !== 16) throw decryptFailed();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw decryptFailed();
  }
}

const decryptFailed = () =>
  new OaxError('mcp_oauth_decrypt_failed', 'the stored credential cannot be decrypted');

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new OaxError('key_invalid', 'a 256-bit key is required');
}
