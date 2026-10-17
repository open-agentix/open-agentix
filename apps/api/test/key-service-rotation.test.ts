import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';
import { KeyService } from '../src/mcp-oauth/key-service.js';
import { testNode, type TestNode } from './helpers.js';

/** The second KEK slot, KEK rewrap, DEK rotation and the AAD-based sealing (ADR 0017 section 13.6). */

let n: TestNode;
beforeAll(async () => {
  n = await testNode();
});
afterAll(async () => n.close());

const slot = (id: string) => ({ key: randomBytes(32), id });
const aad = (s: string) => Buffer.from(s, 'utf8');

describe('sealTo / openFrom', () => {
  it('binds a value to the node and the AAD the caller chose', async () => {
    const keys = new KeyService(n.ctx.db, slot('k1'));
    const node = randomUUID();
    const sealed = await keys.sealTo(['secret-value-1'], { tenantId: node, aad: aad('row-a') });
    const [ct] = sealed.ciphertexts as [string];
    expect(ct).not.toContain('secret-value-1');
    await expect(
      keys.openFrom(sealed.keyVersion, ct, { tenantId: node, aad: aad('row-a') }),
    ).resolves.toBe('secret-value-1');
    // another AAD (another row)
    await expect(
      keys.openFrom(sealed.keyVersion, ct, { tenantId: node, aad: aad('row-b') }),
    ).rejects.toMatchObject({ code: 'mcp_oauth_decrypt_failed' });
    // another node: its own data key does not open it
    await expect(
      keys.openFrom(sealed.keyVersion, ct, { tenantId: randomUUID(), aad: aad('row-a') }),
    ).rejects.toMatchObject({ code: 'key_destroyed' });
  });
});

describe('KEK rotation with two slots', () => {
  it('opens keys of the previous KEK, rewraps them, and lets the previous slot go', async () => {
    const a = slot('kek-a');
    const b = slot('kek-b');
    const node = randomUUID();
    const target = { tenantId: node, aad: aad('row') };
    const old = new KeyService(n.ctx.db, a);
    const sealed = await old.sealTo(['value-under-a'], target);
    const [ct] = sealed.ciphertexts as [string];

    // Only the new KEK: the keys wrapped with A cannot be opened.
    const bOnly = new KeyService(n.ctx.db, b);
    await expect(bOnly.openFrom(sealed.keyVersion, ct, target)).rejects.toMatchObject({
      code: 'key_unavailable',
    });

    // New KEK plus the previous one: opens, and writes still use B.
    const both = new KeyService(n.ctx.db, b, undefined, a);
    await expect(both.openFrom(sealed.keyVersion, ct, target)).resolves.toBe('value-under-a');
    expect((await both.keysPerKek())['kek-a']).toBeGreaterThanOrEqual(1);
    expect(await both.rewrapKeys()).toBeGreaterThanOrEqual(1);
    expect((await both.keysPerKek())['kek-a'] ?? 0).toBe(0);
    expect(await both.rewrapKeys()).toBe(0); // idempotent

    // Previous slot removed: the same ciphertext still opens (only the wrapped key changed).
    await expect(bOnly.openFrom(sealed.keyVersion, ct, target)).resolves.toBe('value-under-a');
    // The old KEK alone no longer opens it.
    await expect(old.openFrom(sealed.keyVersion, ct, target)).rejects.toMatchObject({
      code: 'key_unavailable',
    });
  });

  it('does not rewrap with a previous KEK of the wrong key material', async () => {
    const a = slot('kek-x');
    const node = randomUUID();
    await new KeyService(n.ctx.db, a).sealTo(['v'], { tenantId: node, aad: aad('r') });
    const wrong = new KeyService(n.ctx.db, slot('kek-y'), undefined, { ...slot('kek-x') });
    await expect(wrong.rewrapKeys()).rejects.toMatchObject({ code: 'key_unavailable' });
  });
});

describe('DEK rotation', () => {
  it('opens old rows under the retired version, seals new ones under the new one, and shreds a version', async () => {
    const keys = new KeyService(n.ctx.db, slot('k1'));
    const node = randomUUID();
    const target = { tenantId: node, aad: aad('row') };
    const v1 = await keys.sealTo(['first-value'], target);
    expect(v1.keyVersion).toBe(1);
    expect(await keys.rotateDataKey(node)).toBe(2);
    const v2 = await keys.sealTo(['second-value'], target);
    expect(v2.keyVersion).toBe(2);
    // mixed versions open side by side
    await expect(keys.openFrom(1, v1.ciphertexts[0]!, target)).resolves.toBe('first-value');
    await expect(keys.openFrom(2, v2.ciphertexts[0]!, target)).resolves.toBe('second-value');
    // the active version cannot be destroyed, a retired one can
    expect(await keys.destroyKeyVersion(node, 2)).toBe(false);
    expect(await keys.destroyKeyVersion(node, 1)).toBe(true);
    expect(await keys.destroyKeyVersion(node, 1)).toBe(false);
    await expect(keys.openFrom(1, v1.ciphertexts[0]!, target)).rejects.toMatchObject({
      code: 'key_destroyed',
    });
    await expect(keys.openFrom(2, v2.ciphertexts[0]!, target)).resolves.toBe('second-value');
  });
});

describe('configuration of the second slot', () => {
  const base = { NODE_ENV: 'test', OAX_DATABASE_URL: 'memory://' };
  const key = () => randomBytes(32).toString('base64');

  it('needs its own id and a current key, and never prints a key', () => {
    const cur = key();
    const prev = key();
    expect(() =>
      loadConfig({ ...base, OAX_MCP_OAUTH_KEK: cur, OAX_MCP_OAUTH_KEK_PREVIOUS: prev }),
    ).toThrow(/PREVIOUS_ID/);
    expect(() =>
      loadConfig({
        ...base,
        OAX_MCP_OAUTH_KEK: cur,
        OAX_MCP_OAUTH_KEK_PREVIOUS: prev,
        OAX_MCP_OAUTH_KEK_PREVIOUS_ID: 'kek-1',
      }),
    ).toThrow(/different from/);
    expect(() =>
      loadConfig({
        ...base,
        OAX_MCP_OAUTH_KEK_PREVIOUS: prev,
        OAX_MCP_OAUTH_KEK_PREVIOUS_ID: 'old',
      }),
    ).toThrow(/needs a current/);
    let message = '';
    try {
      loadConfig({
        ...base,
        OAX_MCP_OAUTH_KEK: cur,
        OAX_MCP_OAUTH_KEK_PREVIOUS: 'bad-bad-bad',
        OAX_MCP_OAUTH_KEK_PREVIOUS_ID: 'old',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/32 random bytes/);
    expect(message).not.toContain('bad-bad-bad');
    const ok = loadConfig({
      ...base,
      OAX_MCP_OAUTH_KEK: cur,
      OAX_MCP_OAUTH_KEK_PREVIOUS: prev,
      OAX_MCP_OAUTH_KEK_PREVIOUS_ID: 'old',
    });
    expect(ok.mcp.oauth.kekPrevious?.id).toBe('old');
    expect(ok.mcp.oauth.kekPrevious?.key).toHaveLength(32);
    expect(JSON.stringify(ok)).not.toContain(prev);
    expect(JSON.stringify(ok)).not.toContain(cur);
    expect(loadConfig({ ...base, OAX_MCP_OAUTH_KEK: cur }).mcp.oauth.kekPrevious).toBeNull();
  });

  it('reads the previous key from a file and refuses one inside the secrets directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oax-kek-'));
    try {
      const file = join(dir, 'prev');
      writeFileSync(file, `${key()}\n`, { mode: 0o400 });
      const cfg = loadConfig({
        ...base,
        OAX_MCP_OAUTH_KEK: key(),
        OAX_MCP_OAUTH_KEK_PREVIOUS_FILE: file,
        OAX_MCP_OAUTH_KEK_PREVIOUS_ID: 'old',
      });
      expect(cfg.mcp.oauth.kekPrevious?.key).toHaveLength(32);
      expect(() =>
        loadConfig({
          ...base,
          OAX_MCP_OAUTH_KEK: key(),
          OAX_MCP_OAUTH_KEK_PREVIOUS_FILE: file,
          OAX_MCP_OAUTH_KEK_PREVIOUS_ID: 'old',
          OAX_SECRETS_DIR: dir,
        }),
      ).toThrow(/inside OAX_SECRETS_DIR/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
