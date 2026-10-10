import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bindingAad, open, seal, type BindingContext } from '../src/mcp-oauth/envelope.js';

const binding: BindingContext = {
  tenantId: 't-1',
  connectionId: 'c-1',
  issuer: 'https://auth.example.org',
  resource: 'https://mcp.example.org/mcp',
  credentialVersion: 1,
};
const key = () => randomBytes(32);

describe('AES-256-GCM envelope', () => {
  it('round-trips and never contains the plaintext', () => {
    const k = key();
    const sealed = seal(k, 'plain-secret-value-123', bindingAad(binding));
    expect(sealed).toMatch(/^oaxe1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain('plain-secret-value-123');
    expect(open(k, sealed, bindingAad(binding)).toString()).toBe('plain-secret-value-123');
  });

  it('uses a fresh nonce per seal', () => {
    const k = key();
    const a = seal(k, 'same', bindingAad(binding));
    expect(seal(k, 'same', bindingAad(binding))).not.toBe(a);
  });

  it.each([
    ['tenant', { tenantId: 't-2' }],
    ['connection', { connectionId: 'c-2' }],
    ['issuer', { issuer: 'https://evil.example.org' }],
    ['resource', { resource: 'https://other.example.org/mcp' }],
    ['credential version', { credentialVersion: 2 }],
  ])('does not open for another %s (the AAD binds the row)', (_label, change) => {
    const k = key();
    const sealed = seal(k, 'token-value-abcdef', bindingAad(binding));
    expect(() => open(k, sealed, bindingAad({ ...binding, ...change }))).toThrow(
      /cannot be decrypted/,
    );
  });

  it('does not open with another key, a changed value or a malformed one', () => {
    const k = key();
    const aad = bindingAad(binding);
    const sealed = seal(k, 'token-value-abcdef', aad);
    expect(() => open(key(), sealed, aad)).toThrow(/cannot be decrypted/);
    const parts = sealed.split('.');
    parts[2] = Buffer.from('tampered-bytes').toString('base64url');
    expect(() => open(k, parts.join('.'), aad)).toThrow(/cannot be decrypted/);
    for (const bad of ['', 'oaxe1', 'v2.a.b.c', 'oaxe1.a.b.c', 'oaxe1.a.b.c.d'])
      expect(() => open(k, bad, aad)).toThrow(/cannot be decrypted/);
  });

  it('refuses a key of the wrong size', () => {
    expect(() => seal(Buffer.alloc(16), 'x', bindingAad(binding))).toThrow(/256-bit/);
  });

  it('encodes the AAD unambiguously (no value can shift a field boundary)', () => {
    const a = bindingAad({ ...binding, tenantId: 'a|b', connectionId: 'c' });
    const b = bindingAad({ ...binding, tenantId: 'a', connectionId: 'b|c' });
    expect(a.equals(b)).toBe(false);
  });
});
