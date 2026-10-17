import { randomUUID } from 'node:crypto';
import {
  MAX_SECRET_VALUE_BYTES,
  MIN_SECRET_VALUE_LENGTH,
  ancestorIds,
  canonicalSecretRef,
  parseDestinations,
  secretRefAllowed,
  type Principal,
  type SecretScope,
} from '@openagentix/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { secrets, tenants } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import { platformSecretRefs } from './platform-secrets.js';
import { assertSecrets } from './secret-access.js';
import { SecretPolicy } from './secret-policy.js';
import type { SecretResolution } from './secret-resolution.js';
import type { SecretRow, SecretStore } from './secret-store.js';
import { SecretViews, type SecretListInput, type SecretView } from './secret-views.js';
import { lockTreeShared } from './tree-lock.js';

export type { SecretListInput, SecretView };

export interface CreateSecretInput {
  scope: SecretScope;
  name: string;
  teamId?: string | undefined;
  value?: string | undefined;
  pointer?: string | undefined;
  description?: string | undefined;
  usage?: 'development' | 'production' | 'any' | undefined;
  allowedDestinations?: string[] | undefined;
  expiresAt?: string | undefined;
  inherit?: boolean | undefined;
  allowOverride?: boolean | undefined;
}

const unavailable = (e: unknown): HttpError | null =>
  (e as { code?: string })?.code === 'key_service_unconfigured'
    ? new HttpError(503, 'key_service_unconfigured', 'no key-encryption key is configured')
    : null;

/**
 * The secrets API (ADR 0017 section 13): create, rotate, revoke, delete and read **metadata**. No
 * method returns a value; values go into the encrypted store (`SecretStore`) and come out only in
 * the credential broker at run time.
 *
 * Authorisation per scope: `tenant` secrets are managed by `secrets:write` held node-wide at the
 * ACTING node, which is the owning node (a descendant sees inherited ones read-only); `team` secrets
 * by `secrets:write` on that team; `personal` secrets only by their owner (who needs `agents:write`
 * somewhere). A secret the caller may not see is `404`, indistinguishable from a missing one.
 */
export class SecretsService {
  private readonly views: SecretViews;
  private readonly blocking: SecretPolicy;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly store: SecretStore,
    resolution: SecretResolution,
  ) {
    this.views = new SecretViews(ctx, resolution);
    this.blocking = new SecretPolicy(ctx, audit, resolution);
  }

  // Reading and the node policy live in `SecretViews` and `SecretPolicy`.
  list(p: Principal, q: SecretListInput) {
    return this.views.list(p, q);
  }

  get(p: Principal, id: string) {
    return this.views.get(p, id);
  }

  policy(p: Principal) {
    return this.blocking.policy(p);
  }

  setPolicy(p: Principal, input: { blockInherited: string[] }) {
    return this.blocking.setPolicy(p, input);
  }

  /** The row if the caller may manage it (it is owned by the acting node), else `404`/`403`. */
  private async managed(tx: Db, p: Principal, id: string): Promise<SecretRow> {
    const [row] = await tx.select().from(secrets).where(eq(secrets.id, id)).for('update');
    if (!row || row.tenantId !== p.tenantId) throw notFound('secret');
    if (row.scope === 'personal' && row.scopeId !== p.userId) throw notFound('secret');
    assertSecrets(p, 'write', row.scope as SecretScope, row.scope === 'team' ? row.scopeId : null);
    return row;
  }

  // ------------------------------------------------------------------ writing

  async create(p: Principal, input: CreateSecretInput): Promise<SecretView> {
    const teamId = input.scope === 'team' ? (input.teamId ?? null) : null;
    assertSecrets(p, 'write', input.scope, teamId);
    const value = await this.checkedValue(p, input);
    const expiresAt = this.checkedExpiry(input.expiresAt);
    const id = await this.insert(p, input, value, expiresAt);
    return this.views.get(p, id);
  }

  private async checkedValue(p: Principal, input: CreateSecretInput): Promise<string | null> {
    if (input.pointer !== undefined) {
      if (input.value !== undefined || input.scope === 'personal')
        throw new HttpError(400, 'validation_failed', 'give a value or a pointer, not both');
      await this.checkPointer(p, input.pointer);
      return null;
    }
    const v = input.value;
    if (v === undefined || v.length < MIN_SECRET_VALUE_LENGTH)
      throw new HttpError(
        400,
        'validation_failed',
        `a secret value has at least ${MIN_SECRET_VALUE_LENGTH} characters`,
      );
    if (Buffer.byteLength(v, 'utf8') > MAX_SECRET_VALUE_BYTES)
      throw new HttpError(
        400,
        'validation_failed',
        `a secret value has at most ${MAX_SECRET_VALUE_BYTES} bytes`,
      );
    return v;
  }

  /**
   * The import helper: a pointer may name only a reference the acting tenant's `secret_refs` opens
   * and that is not a platform secret, and it must resolve now (no value is read into the store).
   */
  private async checkPointer(p: Principal, pointer: string): Promise<void> {
    const [t] = await this.ctx.db
      .select({ refs: tenants.secretRefs })
      .from(tenants)
      .where(eq(tenants.id, p.tenantId));
    const platform = await platformSecretRefs(this.ctx);
    if (!t || !secretRefAllowed(t.refs, pointer) || platform.has(canonicalSecretRef(pointer)))
      throw new HttpError(
        422,
        'secret_pointer_not_allowed',
        'the tenant may not point at this reference',
      );
    try {
      await this.ctx.secrets.resolve(pointer);
    } catch {
      throw new HttpError(
        422,
        'secret_not_found',
        'the referenced operator secret is not configured',
      );
    }
  }

  private checkedExpiry(raw: string | null | undefined): Date | null {
    if (!raw) return null;
    const at = new Date(raw);
    if (Number.isNaN(at.getTime()) || at.getTime() <= this.ctx.now().getTime())
      throw new HttpError(400, 'validation_failed', 'expiresAt must be in the future');
    return at;
  }

  private async insert(
    p: Principal,
    input: CreateSecretInput,
    value: string | null,
    expiresAt: Date | null,
  ): Promise<string> {
    const destinations = parseDestinations(input.allowedDestinations ?? []);
    if (!destinations)
      throw new HttpError(
        400,
        'validation_failed',
        'allowedDestinations are host names or "*.suffix"',
      );
    const id = randomUUID();
    try {
      await this.ctx.db.transaction(async (t) => {
        const tx = t as unknown as Db;
        const [node] = await tx.select().from(tenants).where(eq(tenants.id, p.tenantId));
        if (!node) throw notFound('tenant');
        await lockTreeShared(tx, node.rootId);
        const scopeId = await this.scopeIdOf(tx, p, input);
        const tenantScope = input.scope === 'tenant';
        const shadowed = tenantScope ? await this.checkShadowing(tx, node, input.name) : null;
        const row = {
          id,
          tenantId: node.id,
          scope: input.scope,
          scopeId,
          name: input.name,
        };
        await tx.insert(secrets).values({
          ...row,
          backend: value === null ? 'env' : 'internal',
          pointer: value === null ? (input.pointer ?? null) : null,
          description: input.description ?? null,
          usage: input.usage ?? 'any',
          allowedDestinations: destinations,
          inherit: tenantScope ? (input.inherit ?? true) : false,
          // Follow-up decision F4: a root's secret cannot be shadowed unless its managers allow it.
          allowOverride: tenantScope ? (input.allowOverride ?? node.parentId !== null) : false,
          createdBy: p.userId,
          createdAt: this.ctx.now(),
          expiresAt,
        });
        if (value !== null) await this.store.put(tx, row, 1, value, p.userId);
        await this.auditWrite(
          tx,
          p,
          'secret.created',
          row,
          1,
          value === null ? 'env' : 'internal',
          input.inherit ?? tenantScope,
        );
        if (shadowed)
          await this.audit.append(
            {
              actor: p.userId,
              tenantId: shadowed.tenantId,
              action: 'secret.shadowed',
              target: id,
              payload: { name: input.name, ownerNode: shadowed.tenantId, shadowedNode: node.id },
            },
            tx,
          );
      });
    } catch (e) {
      throw unavailable(e) ?? duplicate(e) ?? e;
    }
    return id;
  }

  private async scopeIdOf(tx: Db, p: Principal, input: CreateSecretInput): Promise<string> {
    if (input.scope === 'tenant') return p.tenantId;
    if (input.scope === 'personal') return p.userId;
    await this.views.assertTeam(tx, p.tenantId, input.teamId);
    return input.teamId!;
  }

  /**
   * `allowOverride: false` on an inheritable ancestor secret reserves its name for the whole subtree
   * (`422 secret_name_reserved`). Returns the nearest ancestor secret that this one shadows, if any.
   */
  private async checkShadowing(
    tx: Db,
    node: typeof tenants.$inferSelect,
    name: string,
  ): Promise<SecretRow | null> {
    const ids = ancestorIds(node.path);
    if (ids.length === 0) return null;
    const rows = await tx
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.scope, 'tenant'),
          eq(secrets.name, name),
          eq(secrets.inherit, true),
          inArray(secrets.tenantId, ids),
        ),
      );
    if (rows.some((r) => !r.allowOverride))
      throw new HttpError(
        422,
        'secret_name_reserved',
        `the name "${name}" is reserved by a secret of an ancestor node that does not allow overriding`,
      );
    const nearest = [...ids].reverse().map((id) => rows.find((r) => r.tenantId === id));
    return nearest.find((r) => r !== undefined) ?? null;
  }

  async rotate(
    p: Principal,
    id: string,
    input: { value: string; expiresAt?: string | null | undefined },
  ): Promise<SecretView> {
    if (
      input.value.length < MIN_SECRET_VALUE_LENGTH ||
      Buffer.byteLength(input.value, 'utf8') > MAX_SECRET_VALUE_BYTES
    )
      throw new HttpError(400, 'validation_failed', 'the secret value has an invalid length');
    const expiry = input.expiresAt === undefined ? undefined : this.checkedExpiry(input.expiresAt);
    try {
      await this.ctx.db.transaction(async (t) => {
        const tx = t as unknown as Db;
        const row = await this.managed(tx, p, id);
        if (row.revokedAt)
          throw new HttpError(
            409,
            'secret_revoked',
            'a revoked secret cannot be rotated; create it again',
          );
        if (row.backend !== 'internal')
          throw new HttpError(409, 'secret_not_rotatable', 'a pointer has no value to rotate');
        const version = row.currentVersion + 1;
        await this.store.put(tx, row, version, input.value, p.userId);
        await tx
          .update(secrets)
          .set({
            currentVersion: version,
            rotatedAt: this.ctx.now(),
            ...(expiry === undefined ? {} : { expiresAt: expiry }),
          })
          .where(eq(secrets.id, row.id));
        await this.store.dropOlderThan(tx, row.id, version);
        await this.auditWrite(tx, p, 'secret.rotated', row, version, 'internal', row.inherit);
      });
    } catch (e) {
      throw unavailable(e) ?? e;
    }
    return this.views.get(p, id);
  }

  /** Blocks new issuances at once and drops the values; the row stays so the name stays taken. */
  async revoke(p: Principal, id: string): Promise<SecretView> {
    await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const row = await this.managed(tx, p, id);
      if (row.revokedAt)
        throw new HttpError(409, 'secret_revoked', 'the secret is already revoked');
      await tx
        .update(secrets)
        .set({ revokedAt: this.ctx.now(), revokedBy: p.userId })
        .where(eq(secrets.id, row.id));
      await this.store.dropValues(tx, row.id);
      await this.auditWrite(
        tx,
        p,
        'secret.revoked',
        row,
        row.currentVersion,
        row.backend,
        row.inherit,
      );
    });
    return this.views.get(p, id);
  }

  async remove(p: Principal, id: string): Promise<void> {
    await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const row = await this.managed(tx, p, id);
      await tx.delete(secrets).where(eq(secrets.id, row.id));
      await this.auditWrite(
        tx,
        p,
        'secret.deleted',
        row,
        row.currentVersion,
        row.backend,
        row.inherit,
      );
    });
  }

  private auditWrite(
    tx: Db,
    p: Principal,
    action: string,
    row: Pick<SecretRow, 'id' | 'scope' | 'scopeId' | 'name'>,
    version: number,
    backend: string,
    inherit: boolean,
  ) {
    return this.audit.append(
      {
        actor: p.userId,
        tenantId: p.tenantId,
        action,
        target: row.id,
        payload: {
          scope: row.scope,
          scopeId: row.scopeId,
          name: row.name,
          version,
          backend,
          inherit,
        },
      },
      tx,
    );
  }
}

const duplicate = (e: unknown): HttpError | null => {
  const text = `${(e as Error)?.message ?? ''} ${(e as { cause?: Error })?.cause?.message ?? ''}`;
  return text.includes('secrets_identity_uq')
    ? new HttpError(409, 'secret_exists', 'a secret with this scope and name already exists')
    : null;
};
