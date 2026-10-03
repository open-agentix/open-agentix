import { describe, expect, it } from 'vitest';
import { REDACTED, createRedactor, isSensitiveKey, redact, redactString } from '../src/index.js';

describe('redact', () => {
  it('redacts sensitive keys recursively', () => {
    const out = redact({
      user: 'alice',
      password: 'hunter2',
      nested: { apiKey: 'abc', 'x-api-key': 'def', list: [{ client_secret: 's' }] },
      token: null,
      empty: { secret: '' },
      when: new Date(0),
    });
    expect(out).toEqual({
      user: 'alice',
      password: REDACTED,
      nested: { apiKey: REDACTED, 'x-api-key': REDACTED, list: [{ client_secret: REDACTED }] },
      token: null,
      empty: { secret: '' },
      when: new Date(0),
    });
  });

  it.each([
    ['aws key AKIAABCDEFGHIJKLMNOP here', 'aws key [REDACTED] here'],
    ['ghp_' + 'a'.repeat(36), REDACTED],
    ['github_pat_' + 'b'.repeat(30), REDACTED],
    ['glpat-' + 'c'.repeat(20), REDACTED],
    ['xoxb-1234567890-abc', REDACTED],
    ['key sk-ant-' + 'd'.repeat(30), 'key [REDACTED]'],
    ['sk-proj-' + 'e'.repeat(30), REDACTED],
    ['oax_abcdefgh_' + 'f'.repeat(32), REDACTED],
    ['Authorization: Bearer abc.def.ghi-123', 'Authorization: Bearer [REDACTED]'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl', REDACTED],
    ['postgres://app:s3cret@db:5432/x', 'postgres://[REDACTED]@db:5432/x'],
    ['-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----', REDACTED],
  ])('redacts value pattern %#', (input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  it('redacts known secrets and extra keys', () => {
    const r = createRedactor({ knownSecrets: ['my-very-secret', 'abc'], extraKeys: ['pin'] });
    expect(r({ note: 'value my-very-secret!', pin: '1234', short: 'abc' })).toEqual({
      note: `value ${REDACTED}!`,
      pin: REDACTED,
      short: 'abc',
    });
  });

  it('handles cycles and primitives', () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    expect(redact(a)).toEqual({ n: 1, self: '[Circular]' });
    expect(redact(42)).toBe(42);
    expect(redact(undefined)).toBeUndefined();
  });

  it('classifies keys', () => {
    expect(isSensitiveKey('DB_PASSWORD')).toBe(true);
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('tokens_used')).toBe(false);
    expect(isSensitiveKey('author')).toBe(false);
  });
});
