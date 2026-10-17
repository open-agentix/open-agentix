import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { OaxError } from '@openagentix/core';
import { and, eq, lt } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { runSecretIssuances, secretVersions, type secrets } from '../db/schema.js';
import type { KeyService } from '../mcp-oauth/key-service.js';

export type SecretRow = typeof secrets.$inferSelect;

/** The columns that make up the identity of a secret (and so the AAD of its values). */
export type SecretIdentity = Pick<SecretRow, 'id' | 'tenantId' | 'scope' | 'scopeId' | 'name'>;

/**
 * Canonical AAD of a secret value (ADR 0017 section 13.6): the owning node, scope, owner, name, the
 * secret id and the version, JSON-encoded as an array so that no value can shift a field boundary.
 * A ciphertext copied to another row, secret, node or version does not open. The secret id makes the
 * binding stronger than the ADR's list: a deleted and re-created secret of the same name cannot be
 * served an old value from a backup.
 */
export function secretAad(identity: SecretIdentity, version: number): Buffer {
  return Buffer.from(
    JSON.stringify([
      'secret',
      identity.tenantId,
      identity.scope,
      identity.scopeId,
      identity.name,
      identity.id,
      String(version),
    ]),
    'utf8',
  );
}

/** One day after a session expired its issued values are no longer needed for redaction. */
const ISSUED_RETENTION_MS = 24 * 3_600_000;

function issuedAad(
  owner: string,
  runId: string,
  sessionId: string,
  secretId: string,
  version: number,
) {
  return Buffer.from(
    JSON.stringify(['issued', owner, runId, sessionId, secretId, String(version)]),
    'utf8',
  );
}

const digestOf = (aad: Buffer) => createHash('sha256').update(aad).digest('hex');

/** Constant-time equality of two hex digests of equal length. */
function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The encrypted store of secret values: the ONLY place that seals and opens them. Nothing here
 * returns a value to an API route; `open` is called by the credential broker and by the redaction of
 * a run, both inside trusted processes. Plaintext lives in a local variable for one call: it is not
 * cached, logged, or put into an error. (A JavaScript string cannot be zeroed; the data key is.)
 */
export class SecretStore {
  constructor(
    private readonly ctx: AppContext,
    private readonly keys: KeyService,
  ) {}

  get configured(): boolean {
    return this.keys.configured;
  }

  /** Seals `value` as version `version` of the secret and inserts the row. */
  async put(
    db: Db,
    secret: SecretIdentity,
    version: number,
    value: string,
    createdBy: string | null,
  ): Promise<void> {
    const aad = secretAad(secret, version);
    const sealed = await this.keys.sealTo([value], { tenantId: secret.tenantId, aad }, db);
    await db.insert(secretVersions).values({
      secretId: secret.id,
      version,
      tenantId: secret.tenantId,
      ciphertext: sealed.ciphertexts[0]!,
      dekVersion: sealed.keyVersion,
      aadDigest: digestOf(aad),
      createdBy,
      createdAt: this.ctx.now(),
    });
  }

  /**
   * The current value of an internal secret. Fails with `secret_unavailable` (no detail: not for a
   * missing row, a destroyed key, a moved ciphertext or a changed identity) so a caller can neither
   * learn which of them happened nor distinguish them by timing of the message.
   */
  async open(secret: SecretRow, db: Db = this.ctx.db): Promise<string> {
    try {
      const [row] = await db
        .select()
        .from(secretVersions)
        .where(
          and(
            eq(secretVersions.secretId, secret.id),
            eq(secretVersions.version, secret.currentVersion),
            eq(secretVersions.tenantId, secret.tenantId),
          ),
        );
      if (!row) throw new Error('no value');
      const aad = secretAad(secret, row.version);
      if (!sameDigest(digestOf(aad), row.aadDigest)) throw new Error('identity changed');
      return await this.keys.openFrom(
        row.dekVersion,
        row.ciphertext,
        {
          tenantId: secret.tenantId,
          aad,
        },
        db,
      );
    } catch {
      throw new OaxError('secret_unavailable', 'the secret value is not available');
    }
  }

  /**
   * DEK rotation: seals the current value again under the active data key of the owning node (same
   * AAD, new `dek_version`). Returns `false` when the value is already under that version.
   */
  async reseal(secret: SecretRow, activeVersion: number): Promise<boolean> {
    const db = this.ctx.db;
    const [row] = await db
      .select()
      .from(secretVersions)
      .where(
        and(
          eq(secretVersions.secretId, secret.id),
          eq(secretVersions.version, secret.currentVersion),
        ),
      );
    if (!row || row.dekVersion === activeVersion) return false;
    const value = await this.open(secret);
    const aad = secretAad(secret, row.version);
    const sealed = await this.keys.sealTo([value], { tenantId: secret.tenantId, aad });
    const updated = await db
      .update(secretVersions)
      .set({ ciphertext: sealed.ciphertexts[0]!, dekVersion: sealed.keyVersion })
      .where(
        and(
          eq(secretVersions.secretId, secret.id),
          eq(secretVersions.version, row.version),
          eq(secretVersions.dekVersion, row.dekVersion),
        ),
      )
      .returning({ v: secretVersions.version });
    return updated.length > 0;
  }

  /**
   * Remembers a value that was issued to a run, sealed under the owner's data key, so that the run's
   * redaction keeps covering it after a rotation, revocation or deletion of the secret. Expired rows
   * (a day after the session) are purged here.
   */
  async recordIssued(
    db: Db,
    issued: { runId: string; sessionId: string; expiresAt: Date; secret: SecretRow },
    value: string,
  ): Promise<void> {
    const { runId, sessionId, secret } = issued;
    const aad = issuedAad(secret.tenantId, runId, sessionId, secret.id, secret.currentVersion);
    const sealed = await this.keys.sealTo([value], { tenantId: secret.tenantId, aad }, db);
    const now = this.ctx.now();
    await db
      .delete(runSecretIssuances)
      .where(lt(runSecretIssuances.expiresAt, new Date(now.getTime() - ISSUED_RETENTION_MS)));
    await db.insert(runSecretIssuances).values({
      id: randomUUID(),
      runId,
      sessionId,
      tenantId: secret.tenantId,
      secretId: secret.id,
      version: secret.currentVersion,
      ciphertext: sealed.ciphertexts[0]!,
      dekVersion: sealed.keyVersion,
      createdAt: now,
      expiresAt: issued.expiresAt,
    });
  }

  /** Every value issued to a run (best effort: a row whose key is gone is skipped). */
  async issuedValues(runId: string): Promise<string[]> {
    const rows = await this.ctx.db
      .select()
      .from(runSecretIssuances)
      .where(eq(runSecretIssuances.runId, runId));
    const out: string[] = [];
    for (const r of rows) {
      try {
        out.push(
          await this.keys.openFrom(r.dekVersion, r.ciphertext, {
            tenantId: r.tenantId,
            aad: issuedAad(r.tenantId, r.runId, r.sessionId, r.secretId, r.version),
          }),
        );
      } catch {
        // the owner's key was destroyed: the value is gone for good
      }
    }
    return out;
  }

  /** Removes the values of a secret (revocation); the metadata row stays. */
  async dropValues(db: Db, secretId: string): Promise<void> {
    await db.delete(secretVersions).where(eq(secretVersions.secretId, secretId));
  }

  /** Removes the values below `version` (rotation keeps only the current one). */
  async dropOlderThan(db: Db, secretId: string, version: number): Promise<void> {
    const rows = await db
      .select({ v: secretVersions.version })
      .from(secretVersions)
      .where(eq(secretVersions.secretId, secretId));
    for (const r of rows)
      if (r.v < version)
        await db
          .delete(secretVersions)
          .where(and(eq(secretVersions.secretId, secretId), eq(secretVersions.version, r.v)));
  }
}
