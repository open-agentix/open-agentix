import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultSecretResolver, StaticSecretResolver, envNameForSecret } from '../src/index.js';

describe('secrets', () => {
  it('maps references to env names', () => {
    expect(envNameForSecret('github-token.v2')).toBe('OAX_SECRET_GITHUB_TOKEN_V2');
  });

  it('resolves from env first, then from a directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oax-secrets-'));
    writeFileSync(join(dir, 'from-file'), 'file-value\n');
    const r = new DefaultSecretResolver({ OAX_SECRET_FROM_ENV: 'env-value' }, dir);
    await expect(r.resolve('from-env')).resolves.toBe('env-value');
    await expect(r.resolve('from-file')).resolves.toBe('file-value');
    await expect(r.resolve('missing')).rejects.toThrow(/not configured/);
    await expect(r.resolve('../etc/passwd')).rejects.toThrow(/invalid secret reference/);
  });

  it('works without a directory', async () => {
    const r = new DefaultSecretResolver({ OAX_SECRETS_DIR: undefined });
    await expect(r.resolve('nope')).rejects.toThrow(/not configured/);
    expect(new DefaultSecretResolver()).toBeInstanceOf(DefaultSecretResolver);
  });

  it('static resolver', async () => {
    const r = new StaticSecretResolver({ a: '1' });
    await expect(r.resolve('a')).resolves.toBe('1');
    await expect(r.resolve('b')).rejects.toThrow();
  });
});
