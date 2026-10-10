import { randomBytes } from 'node:crypto';
import { OaxError } from '@openagentix/core';
import { and, eq, max } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tenantDataKeys } from '../db/schema.js';
import { KEY_BYTES, open, seal, type BindingContext, bindingAad } from './envelope.js';

/**
 * The minimal key service of ADR 0016 section 7.5 (slice S5): one platform key-encryption key
 * (KEK) from operator configuration, one data key per tenant, wrapped with the KEK and stored in
 * `tenant_data_keys`. ADR 0012 W12-2 (versioned tenant keys, customer-managed KMS) extends this
 * class; callers only see `seal` and `open`.
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

export interface SealedSecret {
  keyVersion: number;
  ciphertext: string;
}

export class KeyService {
  constructor(
    private readonly db: Db,
    private readonly kek: KekConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get configured(): boolean {
    return this.kek.key !== null;
  }

  /** Seals secret values under the tenant's active data key (created on first use). */
  async seal(plaintext: string, binding: BindingContext): Promise<SealedSecret> {
    const { keyVersion, ciphertexts } = await this.sealAll([plaintext], binding);
    return { keyVersion, ciphertext: ciphertexts[0] as string };
  }

  /** Seals several values of one binding under the same key version (an access and a refresh token). */
  async sealAll(
    plaintexts: readonly string[],
    binding: BindingContext,
  ): Promise<{ keyVersion: number; ciphertexts: string[] }> {
    const { version, key } = await this.activeKey(binding.tenantId);
    try {
      const aad = bindingAad(binding);
      return { keyVersion: version, ciphertexts: plaintexts.map((p) => seal(key, p, aad)) };
    } finally {
      key.fill(0);
    }
  }

  /** Opens a value sealed under `keyVersion`; fails for another binding or a destroyed key. */
  async open(keyVersion: number, ciphertext: string, binding: BindingContext): Promise<string> {
    const key = await this.dataKey(binding.tenantId, keyVersion);
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

  private async activeKey(tenantId: string): Promise<{ version: number; key: Buffer }> {
    const kek = this.kekKey();
    for (let attempt = 0; attempt < 2; attempt++) {
      const [row] = await this.db
        .select()
        .from(tenantDataKeys)
        .where(and(eq(tenantDataKeys.tenantId, tenantId), eq(tenantDataKeys.status, 'active')));
      if (row) return { version: row.version, key: this.unwrap(kek, row) };
      await this.createKey(kek, tenantId);
    }
    throw new OaxError('key_unavailable', 'no active data key for the tenant');
  }

  private async createKey(kek: Buffer, tenantId: string): Promise<void> {
    const [latest] = await this.db
      .select({ v: max(tenantDataKeys.version) })
      .from(tenantDataKeys)
      .where(eq(tenantDataKeys.tenantId, tenantId));
    const version = (latest?.v ?? 0) + 1;
    const dataKey = randomBytes(KEY_BYTES);
    const wrapped = seal(kek, dataKey, this.wrapAad(tenantId, version, this.kek.id));
    dataKey.fill(0);
    // A concurrent creator wins on the unique active-key index; the loser rereads.
    await this.db
      .insert(tenantDataKeys)
      .values({ tenantId, version, wrappedKey: wrapped, kekId: this.kek.id, createdAt: this.now() })
      .onConflictDoNothing();
  }

  private async dataKey(tenantId: string, version: number): Promise<Buffer> {
    const kek = this.kekKey();
    const [row] = await this.db
      .select()
      .from(tenantDataKeys)
      .where(and(eq(tenantDataKeys.tenantId, tenantId), eq(tenantDataKeys.version, version)));
    if (!row || row.status === 'destroyed' || !row.wrappedKey)
      throw new OaxError('key_unavailable', 'the data key of this credential no longer exists');
    return this.unwrap(kek, row);
  }

  private unwrap(kek: Buffer, row: typeof tenantDataKeys.$inferSelect): Buffer {
    if (!row.wrappedKey || row.kekId !== this.kek.id)
      throw new OaxError(
        'key_unavailable',
        'the data key was wrapped with a different key-encryption key',
      );
    return open(kek, row.wrappedKey, this.wrapAad(row.tenantId, row.version, row.kekId));
  }
}
