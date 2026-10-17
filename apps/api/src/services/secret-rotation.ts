import { and, count, eq, gt, inArray, ne } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import {
  mcpOauthClients,
  mcpOauthPending,
  mcpOauthTokens,
  runSecretIssuances,
  secretVersions,
  secrets,
} from '../db/schema.js';
import type { KeyService } from '../mcp-oauth/key-service.js';
import type { AuditService } from './audit.js';
import type { SecretStore } from './secret-store.js';

/** What the operator tool reports after a rotation step. */
export interface RotationReport {
  /** Keys wrapped again, rows re-encrypted or key versions destroyed in this call. */
  changed: number;
  /** Work left for the next call (0 = done); includes the values that could not be re-encrypted. */
  remaining: number;
  /** Values that could not be opened or sealed (corrupt row, destroyed key); they are skipped, not fatal. */
  failed?: number;
}

const SYSTEM_ACTOR = 'system:key-rotation';

/**
 * Operator-driven key rotation (ADR 0017 section 13.6). Every step is idempotent and resumable, so
 * an interrupted run is finished by running it again:
 *
 * - KEK rotation: set the new key as `OAX_MCP_OAUTH_KEK` and the old one as the previous slot, then
 *   {@link rewrapKeys} until `remaining` is 0, then remove the previous slot. Only the small wrapped
 *   data keys change; no secret is re-encrypted.
 * - DEK rotation of a node: {@link rotateDataKey} (new writes use the new version), then
 *   {@link reencrypt} until `remaining` is 0, then {@link retire}, which destroys a retired version
 *   only when no sealed value of any store still uses it.
 */
export class SecretKeyRotation {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly keys: KeyService,
    private readonly store: SecretStore,
  ) {}

  async rewrapKeys(batch = 500): Promise<RotationReport> {
    const changed = await this.keys.rewrapKeys(batch);
    const perKek = await this.keys.keysPerKek();
    const remaining = Object.entries(perKek)
      .filter(([id]) => id !== this.keys.kekId)
      .reduce((sum, [, k]) => sum + k, 0);
    if (changed > 0)
      await this.record('keys.kek.rewrapped', 'platform', { count: changed, remaining });
    return { changed, remaining };
  }

  async rotateDataKey(tenantId: string): Promise<number> {
    const version = await this.keys.rotateDataKey(tenantId);
    await this.record('keys.dek.rotated', tenantId, { version });
    return version;
  }

  /** Seals the values of a node that are still under an older data key again under the active one. */
  async reencrypt(tenantId: string, batch = 200): Promise<RotationReport> {
    const active = await this.keys.activeVersionOf(tenantId);
    if (active === null) return { changed: 0, remaining: 0 };
    const stale = await this.ctx.db
      .select({ id: secretVersions.secretId })
      .from(secretVersions)
      .where(and(eq(secretVersions.tenantId, tenantId), ne(secretVersions.dekVersion, active)))
      .limit(batch);
    const rows = stale.length
      ? await this.ctx.db
          .select()
          .from(secrets)
          .where(
            inArray(
              secrets.id,
              stale.map((s) => s.id),
            ),
          )
      : [];
    let changed = 0;
    let failed = 0;
    for (const secret of rows) {
      try {
        if (await this.store.reseal(secret, active)) changed++;
      } catch {
        // One unreadable value must not stop the rest; the operator sees it in `failed`/`remaining`.
        failed++;
      }
    }
    const remaining = await this.unsealedUnder(tenantId, active);
    if (changed > 0 || failed > 0)
      await this.record('keys.dek.reencrypted', tenantId, { count: changed, failed, remaining });
    return { changed, remaining, failed };
  }

  private async unsealedUnder(tenantId: string, active: number): Promise<number> {
    const [row] = await this.ctx.db
      .select({ n: count() })
      .from(secretVersions)
      .where(and(eq(secretVersions.tenantId, tenantId), ne(secretVersions.dekVersion, active)));
    return Number(row?.n ?? 0);
  }

  /** Destroys the retired data key versions of a node that no sealed value uses any more. */
  async retire(tenantId: string): Promise<RotationReport> {
    let changed = 0;
    let remaining = 0;
    for (const version of await this.keys.retiredVersionsOf(tenantId)) {
      if ((await this.usesOf(tenantId, version)) > 0) remaining++;
      else if (await this.keys.destroyKeyVersion(tenantId, version)) changed++;
    }
    if (changed > 0) await this.record('keys.dek.destroyed', tenantId, { count: changed });
    return { changed, remaining };
  }

  /** Sealed values of any store (secrets and MCP OAuth) under a data key version of a node. */
  private async usesOf(tenantId: string, version: number): Promise<number> {
    const db = this.ctx.db;
    const counts = await Promise.all([
      // values issued to runs that may still be running (their sessions have not expired)
      db
        .select({ n: count() })
        .from(runSecretIssuances)
        .where(
          and(
            eq(runSecretIssuances.tenantId, tenantId),
            eq(runSecretIssuances.dekVersion, version),
            gt(runSecretIssuances.expiresAt, this.ctx.now()),
          ),
        ),
      db
        .select({ n: count() })
        .from(secretVersions)
        .where(and(eq(secretVersions.tenantId, tenantId), eq(secretVersions.dekVersion, version))),
      db
        .select({ n: count() })
        .from(mcpOauthTokens)
        .where(and(eq(mcpOauthTokens.tenantId, tenantId), eq(mcpOauthTokens.keyVersion, version))),
      db
        .select({ n: count() })
        .from(mcpOauthClients)
        .where(
          and(eq(mcpOauthClients.tenantId, tenantId), eq(mcpOauthClients.keyVersion, version)),
        ),
      db
        .select({ n: count() })
        .from(mcpOauthPending)
        .where(
          and(eq(mcpOauthPending.tenantId, tenantId), eq(mcpOauthPending.keyVersion, version)),
        ),
    ]);
    return counts.reduce((sum, [r]) => sum + Number(r?.n ?? 0), 0);
  }

  private record(action: string, tenantId: string, payload: Record<string, unknown>) {
    return this.audit.append({
      actor: SYSTEM_ACTOR,
      tenantId: tenantId === 'platform' ? null : tenantId,
      action,
      target: tenantId,
      payload,
    });
  }
}
