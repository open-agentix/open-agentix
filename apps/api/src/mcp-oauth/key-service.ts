import { randomBytes } from 'node:crypto';
import { OaxError } from '@openagentix/core';
import { and, eq, max, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tenantDataKeys } from '../db/schema.js';
import { KEY_BYTES, open, seal, type BindingContext, bindingAad } from './envelope.js';

/**
 * The minimal key service of ADR 0016 section 7.5 (slice S5): one platform key-encryption key
 * (KEK) from operator configuration, one data key per tenant, wrapped with the KEK and stored in
 * `tenant_data_keys`. ADR 0012 W12-2 (versioned tenant keys, customer-managed KMS) extends this
 * class; callers only see `seal` and `open`.
 *
 * Crypto-shredding limit: while the KEK is unchanged, a database backup (or WAL) taken before
 * `destroyTenantKeys` still holds the wrapped key, and the KEK unwraps it. Shredding is complete
 * only with a per-tenant key-encryption key or a KMS that deletes it (ADR 0012 W12-2).
 *
 * Data keys exist in memory only for the duration of one call. Without a configured KEK every
 * operation fails closed with `key_service_unconfigured`.
 */
export interface KekConfig {
  /** 32 raw bytes; `null` when the operator configured none. */
  key: Buffer | null;
  /** Identifier recorded with every wrapped key, so a later KEK rotation can find its rows. */
  id: string;
}

/** The second KEK slot (ADR 0017 section 13.6): opens keys wrapped before the current KEK. */
export interface PreviousKek {
  key: Buffer;
  id: string;
}

/**
 * What a sealed value is bound to when the caller builds the additional authenticated data itself
 * (secrets, ADR 0017 section 13.6): the owning node (whose data key seals it) and the AAD bytes.
 */
export interface SealTarget {
  tenantId: string;
  aad: Buffer;
}

export interface SealedSecret {
  keyVersion: number;
  ciphertext: string;
}

export class KeyService {
  constructor(
    private readonly db: Db,
    private readonly kek: KekConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly previous: PreviousKek | null = null,
  ) {}

  /** Id of the key-encryption key that wraps new data keys. */
  get kekId(): string {
    return this.kek.id;
  }

  get configured(): boolean {
    return this.kek.key !== null;
  }

  /** Seals secret values under the tenant's active data key (created on first use). */
  async seal(plaintext: string, binding: BindingContext, db: Db = this.db): Promise<SealedSecret> {
    const { keyVersion, ciphertexts } = await this.sealAll([plaintext], binding, db);
    return { keyVersion, ciphertext: ciphertexts[0] as string };
  }

  /**
   * Seals several values of one binding under the same key version (an access and a refresh token).
   * `db` lets a caller that holds a transaction keep every read inside it.
   */
  async sealAll(
    plaintexts: readonly string[],
    binding: BindingContext,
    db: Db = this.db,
  ): Promise<{ keyVersion: number; ciphertexts: string[] }> {
    const { version, key } = await this.activeKey(binding.tenantId, db);
    try {
      const aad = bindingAad(binding);
      return { keyVersion: version, ciphertexts: plaintexts.map((p) => seal(key, p, aad)) };
    } finally {
      key.fill(0);
    }
  }

  /** Seals values under the active data key of `target.tenantId` with the caller's AAD. */
  async sealTo(
    plaintexts: readonly string[],
    target: SealTarget,
    db: Db = this.db,
  ): Promise<{ keyVersion: number; ciphertexts: string[] }> {
    const { version, key } = await this.activeKey(target.tenantId, db);
    try {
      return { keyVersion: version, ciphertexts: plaintexts.map((p) => seal(key, p, target.aad)) };
    } finally {
      key.fill(0);
    }
  }

  /** Opens a value sealed with {@link sealTo}; fails for any other AAD, node or a destroyed key. */
  async openFrom(
    keyVersion: number,
    ciphertext: string,
    target: SealTarget,
    db: Db = this.db,
  ): Promise<string> {
    const key = await this.dataKey(target.tenantId, keyVersion, db);
    try {
      return open(key, ciphertext, target.aad).toString('utf8');
    } finally {
      key.fill(0);
    }
  }

  /** Opens a value sealed under `keyVersion`; fails for another binding or a destroyed key. */
  async open(
    keyVersion: number,
    ciphertext: string,
    binding: BindingContext,
    db: Db = this.db,
  ): Promise<string> {
    const key = await this.dataKey(binding.tenantId, keyVersion, db);
    try {
      return open(key, ciphertext, bindingAad(binding)).toString('utf8');
    } finally {
      key.fill(0);
    }
  }

  /**
   * Crypto-shredding: drops the wrapped keys of a tenant. Everything sealed under them becomes
   * unreadable for good. Returns the number of keys destroyed.
   */
  async destroyTenantKeys(tenantId: string): Promise<number> {
    const rows = await this.db
      .update(tenantDataKeys)
      .set({ status: 'destroyed', wrappedKey: null, destroyedAt: this.now() })
      .where(eq(tenantDataKeys.tenantId, tenantId))
      .returning({ v: tenantDataKeys.version });
    return rows.length;
  }

  /**
   * KEK rotation (ADR 0017 section 13.6): wraps every data key that is wrapped with the previous
   * KEK again with the current one. Only the small wrapped keys change, no data is re-encrypted.
   * Idempotent and resumable; returns how many keys were rewrapped in this call (at most `limit`).
   */
  async rewrapKeys(limit = 500): Promise<number> {
    const kek = this.kekKey();
    if (!this.previous) return 0;
    const rows = await this.db
      .select()
      .from(tenantDataKeys)
      .where(
        and(eq(tenantDataKeys.kekId, this.previous.id), ne(tenantDataKeys.status, 'destroyed')),
      )
      .limit(limit);
    let done = 0;
    for (const row of rows) {
      const dataKey = this.unwrap(kek, row);
      try {
        const wrapped = seal(kek, dataKey, this.wrapAad(row.tenantId, row.version, this.kek.id));
        const updated = await this.db
          .update(tenantDataKeys)
          .set({ wrappedKey: wrapped, kekId: this.kek.id })
          .where(
            and(
              eq(tenantDataKeys.tenantId, row.tenantId),
              eq(tenantDataKeys.version, row.version),
              eq(tenantDataKeys.kekId, this.previous.id),
            ),
          )
          .returning({ v: tenantDataKeys.version });
        done += updated.length;
      } finally {
        dataKey.fill(0);
      }
    }
    return done;
  }

  /** Live data keys per KEK id: the previous slot may be removed when its count is 0. */
  async keysPerKek(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ id: tenantDataKeys.kekId, n: sql<number>`count(*)::int` })
      .from(tenantDataKeys)
      .where(ne(tenantDataKeys.status, 'destroyed'))
      .groupBy(tenantDataKeys.kekId);
    return Object.fromEntries(rows.map((r) => [r.id, r.n]));
  }

  /**
   * DEK rotation: retires the active data key of a tenant and creates the next version. New writes
   * use it; rows sealed under older versions open until they are re-encrypted and the old version
   * is destroyed ({@link destroyKeyVersion}). Returns the new version.
   */
  async rotateDataKey(tenantId: string): Promise<number> {
    const kek = this.kekKey();
    return this.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await tx
        .update(tenantDataKeys)
        .set({ status: 'retired' })
        .where(and(eq(tenantDataKeys.tenantId, tenantId), eq(tenantDataKeys.status, 'active')));
      await this.createKey(kek, tenantId, tx);
      const [row] = await tx
        .select({ v: max(tenantDataKeys.version) })
        .from(tenantDataKeys)
        .where(eq(tenantDataKeys.tenantId, tenantId));
      return row?.v ?? 0;
    });
  }

  /** The version new writes of a tenant use, or `null` when the tenant has no data key yet. */
  async activeVersionOf(tenantId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ v: tenantDataKeys.version })
      .from(tenantDataKeys)
      .where(and(eq(tenantDataKeys.tenantId, tenantId), eq(tenantDataKeys.status, 'active')));
    return row?.v ?? null;
  }

  /** Retired (not yet destroyed) data key versions of a tenant. */
  async retiredVersionsOf(tenantId: string): Promise<number[]> {
    const rows = await this.db
      .select({ v: tenantDataKeys.version })
      .from(tenantDataKeys)
      .where(and(eq(tenantDataKeys.tenantId, tenantId), eq(tenantDataKeys.status, 'retired')));
    return rows.map((r) => r.v).sort((a, b) => a - b);
  }

  /** Destroys one RETIRED data key version; the caller checked that nothing is sealed under it. */
  async destroyKeyVersion(tenantId: string, version: number): Promise<boolean> {
    const rows = await this.db
      .update(tenantDataKeys)
      .set({ status: 'destroyed', wrappedKey: null, destroyedAt: this.now() })
      .where(
        and(
          eq(tenantDataKeys.tenantId, tenantId),
          eq(tenantDataKeys.version, version),
          eq(tenantDataKeys.status, 'retired'),
        ),
      )
      .returning({ v: tenantDataKeys.version });
    return rows.length > 0;
  }

  private kekKey(): Buffer {
    if (!this.kek.key)
      throw new OaxError(
        'key_service_unconfigured',
        'no key-encryption key is configured (OAX_MCP_OAUTH_KEK or OAX_MCP_OAUTH_KEK_FILE)',
      );
    return this.kek.key;
  }

  private wrapAad(tenantId: string, version: number, kekId: string): Buffer {
    return Buffer.from(JSON.stringify(['data-key', tenantId, String(version), kekId]), 'utf8');
  }

  private async activeKey(tenantId: string, db: Db): Promise<{ version: number; key: Buffer }> {
    const kek = this.kekKey();
    for (let attempt = 0; attempt < 2; attempt++) {
      const [row] = await db
        .select()
        .from(tenantDataKeys)
        .where(and(eq(tenantDataKeys.tenantId, tenantId), eq(tenantDataKeys.status, 'active')));
      if (row) return { version: row.version, key: this.unwrap(kek, row) };
      await this.createKey(kek, tenantId, db);
    }
    throw new OaxError('key_unavailable', 'no active data key for the tenant');
  }

  private async createKey(kek: Buffer, tenantId: string, db: Db): Promise<void> {
    const [latest] = await db
      .select({ v: max(tenantDataKeys.version) })
      .from(tenantDataKeys)
      .where(eq(tenantDataKeys.tenantId, tenantId));
    const version = (latest?.v ?? 0) + 1;
    const dataKey = randomBytes(KEY_BYTES);
    const wrapped = seal(kek, dataKey, this.wrapAad(tenantId, version, this.kek.id));
    dataKey.fill(0);
    // A concurrent creator wins on the unique active-key index; the loser rereads.
    await db
      .insert(tenantDataKeys)
      .values({ tenantId, version, wrappedKey: wrapped, kekId: this.kek.id, createdAt: this.now() })
      .onConflictDoNothing();
  }

  private async dataKey(tenantId: string, version: number, db: Db): Promise<Buffer> {
    const kek = this.kekKey();
    const [row] = await db
      .select()
      .from(tenantDataKeys)
      .where(and(eq(tenantDataKeys.tenantId, tenantId), eq(tenantDataKeys.version, version)));
    if (!row || row.status === 'destroyed' || !row.wrappedKey)
      throw new OaxError('key_destroyed', 'the data key of this credential no longer exists');
    return this.unwrap(kek, row);
  }

  private unwrap(kek: Buffer, row: typeof tenantDataKeys.$inferSelect): Buffer {
    const wrapper = this.wrapperFor(kek, row.kekId);
    if (!row.wrappedKey || !wrapper)
      throw new OaxError(
        'key_unavailable',
        'the data key was wrapped with a different key-encryption key',
      );
    try {
      return open(wrapper, row.wrappedKey, this.wrapAad(row.tenantId, row.version, row.kekId));
    } catch {
      // Same key id, different key material: the operator replaced the KEK without a rotation.
      throw new OaxError(
        'key_unavailable',
        'the data key cannot be unwrapped: the key-encryption key differs from the one that wrapped it',
      );
    }
  }

  /** The key that wraps rows of this KEK id: the current KEK or, during a rotation, the previous one. */
  private wrapperFor(kek: Buffer, kekId: string): Buffer | null {
    if (kekId === this.kek.id) return kek;
    if (this.previous && kekId === this.previous.id) return this.previous.key;
    return null;
  }
}
