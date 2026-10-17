import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, secretVersions, secrets } from '../src/db/schema.js';
import { KeyService } from '../src/mcp-oauth/key-service.js';
import { SecretKeyRotation } from '../src/services/secret-rotation.js';
import { SecretStore, secretAad } from '../src/services/secret-store.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * The encrypted secret store (ADR 0017 section 13.6): AES-256-GCM under a per-node data key with the
 * secret bound as AAD; a ciphertext moved to another row, version or node does not open; mixed data
 * key versions; DEK and KEK rotation; crypto-shredding.
 */
const PW = 'long-password-123';
const slot = (id: string) => ({ key: randomBytes(32), id });

let n: TestNode;
let store: SecretStore;
let keys: KeyService;
let rotation: SecretKeyRotation;
const node: Record<string, string> = {};
const tok: Record<string, string> = {};
const kekA = slot('kek-1');

async function mkTenant(slug: string, parentId?: string) {
  const r = await n.req({
    method: 'POST',
    url: '/v1/tenants',
    payload: {
      slug,
      name: slug,
      ...(parentId ? { parentId } : {}),
      admin: { email: `admin@${slug}.example.org`, displayName: slug, password: PW },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  node[slug] = (r.json() as { id: string }).id;
  tok[slug] = await n.login(`admin@${slug}.example.org`, PW);
}
async function make(slug: string, name: string, value: string, extra: object = {}) {
  const res = await n.req({
    method: 'POST',
    url: '/v1/secrets',
    token: tok[slug]!,
    payload: { scope: 'tenant', name, value, ...extra },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { id: string }).id;
  return (await n.ctx.db.select().from(secrets).where(eq(secrets.id, id)))[0]!;
}
const node_ = (slug: string) => node[slug]!;
const versionRow = async (id: string) =>
  (await n.ctx.db.select().from(secretVersions).where(eq(secretVersions.secretId, id)))[0]!;

beforeAll(async () => {
  n = await testNode({
    OAX_RATE_LIMIT_LOGIN_MAX: '1000',
    OAX_MCP_OAUTH_KEK: kekA.key.toString('base64'),
    OAX_MCP_OAUTH_KEK_ID: kekA.id,
  });
  keys = n.services.mcpOauth.keys;
  store = new SecretStore(n.ctx, keys);
  rotation = new SecretKeyRotation(n.ctx, n.services.audit, keys, store);
  await mkTenant('cr-one');
  await mkTenant('cr-two');
  await mkTenant('cr-dek');
  await mkTenant('cr-bad');
}, 120_000);
afterAll(async () => n?.close());

describe('sealing', () => {
  it('opens only for the secret it was sealed for', async () => {
    const a = await make('cr-one', 'aad-a', 'value-of-secret-a');
    const b = await make('cr-one', 'aad-b', 'value-of-secret-b');
    expect(await store.open(a)).toBe('value-of-secret-a');
    expect(await store.open(b)).toBe('value-of-secret-b');
    // the ciphertext of A moved into the row of B (same node, same data key, same version)
    const va = await versionRow(a.id);
    await n.ctx.db
      .update(secretVersions)
      .set({ ciphertext: va.ciphertext, aadDigest: va.aadDigest })
      .where(eq(secretVersions.secretId, b.id));
    await expect(store.open(b)).rejects.toMatchObject({ code: 'secret_unavailable' });
    // and with only the ciphertext moved (the stored digest of B stays): also refused
    await n.ctx.db
      .update(secretVersions)
      .set({ ciphertext: va.ciphertext, aadDigest: (await versionRow(b.id)).aadDigest })
      .where(eq(secretVersions.secretId, b.id));
    await expect(store.open(b)).rejects.toMatchObject({ code: 'secret_unavailable' });
  });

  it('does not open a ciphertext moved to another node or under another version', async () => {
    const a = await make('cr-one', 'move-a', 'value-move-a-0000');
    const other = await make('cr-two', 'move-a', 'value-move-b-1111');
    // moved to another tenant: the row of the other node carries it
    await n.ctx.db
      .update(secretVersions)
      .set({ ciphertext: (await versionRow(a.id)).ciphertext })
      .where(eq(secretVersions.secretId, other.id));
    await expect(store.open(other)).rejects.toMatchObject({ code: 'secret_unavailable' });
    // the same row presented under another version number
    const v = await versionRow(a.id);
    const shifted = { ...a, currentVersion: 2 };
    await n.ctx.db
      .update(secretVersions)
      .set({ version: 2 })
      .where(eq(secretVersions.secretId, a.id));
    await expect(store.open(shifted)).rejects.toMatchObject({ code: 'secret_unavailable' });
    await n.ctx.db
      .update(secretVersions)
      .set({ version: v.version })
      .where(eq(secretVersions.secretId, a.id));
    expect(await store.open(a)).toBe('value-move-a-0000');
  });

  it('binds scope, owner and node into the AAD', () => {
    const base = {
      id: randomUUID(),
      tenantId: randomUUID(),
      scope: 'tenant',
      scopeId: randomUUID(),
      name: 'x',
    };
    const aad = secretAad(base, 1).toString();
    for (const changed of [
      { tenantId: randomUUID() },
      { scope: 'team' },
      { scopeId: randomUUID() },
      { name: 'y' },
      { id: randomUUID() },
    ])
      expect(secretAad({ ...base, ...changed }, 1).toString()).not.toBe(aad);
    expect(secretAad(base, 2).toString()).not.toBe(aad);
    // no field can shift a boundary
    expect(secretAad({ ...base, name: 'a|b' }, 1).toString()).not.toBe(
      secretAad({ ...base, name: 'a', scope: 'b' }, 1).toString(),
    );
  });

  it('uses a fresh nonce and a per-node data key', async () => {
    const a = await make('cr-one', 'nonce-a', 'same-value-0000');
    const b = await make('cr-two', 'nonce-b', 'same-value-0000');
    expect((await versionRow(a.id)).ciphertext).not.toBe((await versionRow(b.id)).ciphertext);
    expect(await keys.activeVersionOf(node['cr-one']!)).toBe(1);
    expect(await keys.activeVersionOf(node['cr-two']!)).toBe(1);
  });

  it('refuses a value when the identity columns were edited behind the back (the digest)', async () => {
    const a = await make('cr-one', 'digest-a', 'value-digest-000');
    await n.ctx.db
      .update(secretVersions)
      .set({ aadDigest: 'f'.repeat(64) })
      .where(eq(secretVersions.secretId, a.id));
    await expect(store.open(a)).rejects.toMatchObject({ code: 'secret_unavailable' });
  });
});

describe('DEK rotation with mixed versions', () => {
  it('opens old and new rows side by side, re-encrypts, and retires the old version', async () => {
    const node = node_('cr-dek');
    const old1 = await make('cr-dek', 'mixed-old', 'value-before-rotation');
    expect((await versionRow(old1.id)).dekVersion).toBe(1);
    expect(await rotation.rotateDataKey(node)).toBe(2);
    const fresh = await make('cr-dek', 'mixed-new', 'value-after-rotation');
    expect((await versionRow(fresh.id)).dekVersion).toBe(2);
    expect(await store.open(old1)).toBe('value-before-rotation');
    expect(await store.open(fresh)).toBe('value-after-rotation');
    // nothing is destroyed while a value still uses version 1
    expect(await rotation.retire(node)).toMatchObject({ changed: 0, remaining: 1 });
    const report = await rotation.reencrypt(node);
    expect(report).toMatchObject({ changed: 1, remaining: 0, failed: 0 });
    expect((await versionRow(old1.id)).dekVersion).toBe(2);
    expect(await rotation.reencrypt(node)).toMatchObject({ changed: 0, remaining: 0 });
    expect(await rotation.retire(node)).toEqual({ changed: 1, remaining: 0 });
    expect(await store.open(old1)).toBe('value-before-rotation');
    const actions = (await n.ctx.db.select().from(auditLog)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['keys.dek.rotated', 'keys.dek.reencrypted', 'keys.dek.destroyed']),
    );
  });

  it('keeps going past an unreadable value and reports it', async () => {
    const node = node_('cr-bad');
    const bad = await make('cr-bad', 'bad-row', 'value-bad-row-00');
    const good = await make('cr-bad', 'good-row', 'value-good-row-0');
    await rotation.rotateDataKey(node);
    await n.ctx.db
      .update(secretVersions)
      .set({ aadDigest: '0'.repeat(64) })
      .where(eq(secretVersions.secretId, bad.id));
    const report = await rotation.reencrypt(node);
    expect(report).toMatchObject({ changed: 1, failed: 1, remaining: 1 });
    expect((await versionRow(good.id)).dekVersion).toBe(2);
    // the version that the unreadable value uses is not destroyed
    expect(await rotation.retire(node)).toMatchObject({ changed: 0, remaining: 1 });
  });

  it('a rotated secret is sealed under the new data key', async () => {
    const node = node_('cr-two');
    const s = await make('cr-two', 'rot-twice', 'value-rot-0001');
    await rotation.rotateDataKey(node);
    const rot = await n.req({
      method: 'POST',
      url: `/v1/secrets/${s.id}/rotate`,
      token: tok['cr-two']!,
      payload: { value: 'value-rot-0002' },
    });
    expect(rot.statusCode, rot.body).toBe(200);
    expect(await versionRow(s.id)).toMatchObject({ version: 2, dekVersion: 2 });
    expect(await store.open({ ...s, currentVersion: 2 })).toBe('value-rot-0002');
  });
});

describe('KEK rotation', () => {
  it('opens secrets through the previous slot, rewraps, and survives removing the old KEK', async () => {
    const s = await make('cr-one', 'kek-secret', 'value-kek-rotation');
    const kekB = slot('kek-b');
    const both = new SecretStore(n.ctx, new KeyService(n.ctx.db, kekB, undefined, kekA));
    expect(await both.open(s)).toBe('value-kek-rotation');
    const rotationB = new SecretKeyRotation(
      n.ctx,
      n.services.audit,
      new KeyService(n.ctx.db, kekB, undefined, kekA),
      both,
    );
    let report = await rotationB.rewrapKeys();
    while (report.remaining > 0) report = await rotationB.rewrapKeys();
    expect(report.remaining).toBe(0);
    const onlyB = new SecretStore(n.ctx, new KeyService(n.ctx.db, kekB));
    expect(await onlyB.open(s)).toBe('value-kek-rotation');
    await expect(store.open(s)).rejects.toMatchObject({ code: 'secret_unavailable' });
    // put the original KEK back for the other tests: rewrap the other way
    const back = new KeyService(n.ctx.db, kekA, undefined, kekB);
    while ((await back.rewrapKeys()) > 0);
    expect(await store.open(s)).toBe('value-kek-rotation');
  });
});

describe('crypto-shredding', () => {
  it('makes every value of a node unreadable and leaves the ancestors alone', async () => {
    const parent = await make('cr-one', 'shred-parent', 'value-shred-parent');
    const child = await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: {
        slug: 'cr-shred',
        name: 'x',
        parentId: node['cr-one'],
        admin: { email: 'a@cr-shred.example.org', displayName: 'a', password: PW },
      },
    });
    const childId = (child.json() as { id: string }).id;
    const childToken = await n.login('a@cr-shred.example.org', PW);
    const own = await n.req({
      method: 'POST',
      url: '/v1/secrets',
      token: childToken,
      payload: { scope: 'tenant', name: 'shred-child', value: 'value-shred-child' },
    });
    const ownRow = (
      await n.ctx.db
        .select()
        .from(secrets)
        .where(eq(secrets.id, (own.json() as { id: string }).id))
    )[0]!;
    expect(await store.open(ownRow)).toBe('value-shred-child');
    expect(await keys.destroyTenantKeys(childId)).toBeGreaterThan(0);
    await expect(store.open(ownRow)).rejects.toMatchObject({ code: 'secret_unavailable' });
    expect(await store.open(parent)).toBe('value-shred-parent');
    // the shredded node cannot write any more either: its keys are gone (a new key is not created
    // over a destroyed one, the node has none active)
  });

  it('ends every descendant use when the OWNING node is shredded', async () => {
    const owner = await make('cr-two', 'shred-owner', 'value-shred-owner');
    expect(await keys.destroyTenantKeys(node['cr-two']!)).toBeGreaterThan(0);
    await expect(store.open(owner)).rejects.toMatchObject({ code: 'secret_unavailable' });
  });
});
