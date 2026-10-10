import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultSecretResolver, StaticSecretResolver } from '../src/index.js';

describe('hasEntriesUnder', () => {
  it('sees env, file and static secrets by canonical prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oax-secrets-'));
    await writeFile(join(dir, 'acme.api-key'), 'x');
    const r = new DefaultSecretResolver({ OAX_SECRET_BETA_TOKEN: 'y' }, dir);
    expect(await r.hasEntriesUnder('acme_')).toBe(true);
    expect(await r.hasEntriesUnder('beta_')).toBe(true);
    expect(await r.hasEntriesUnder('gamma_')).toBe(false);
    expect(await new StaticSecretResolver({ 'delta.key': 'z' }).hasEntriesUnder('delta_')).toBe(
      true,
    );
  });

  it('fails closed when the secrets directory cannot be listed', async () => {
    const r = new DefaultSecretResolver({}, join(tmpdir(), 'oax-no-such-dir-xyz'));
    expect(await r.hasEntriesUnder('anything_')).toBe(true);
  });
});
