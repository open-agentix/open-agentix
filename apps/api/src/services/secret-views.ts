import { scopedRef, type Principal, type SecretScope } from '@openagentix/core';
import { and, asc, eq, gt, inArray, or, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { secrets, teams, tenants } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import { decodeNameCursor, encodeNameCursor } from '../pagination.js';
import { assertSecrets, canSecrets } from './secret-access.js';
import { stateOf, type SecretResolution } from './secret-resolution.js';
import type { SecretRow } from './secret-store.js';
import { TenantTree } from './tenant-tree.js';

/** Metadata of a secret as the API returns it: never a value (ADR 0017 section 13.4). */
export interface SecretView {
  id: string;
  scope: SecretScope;
  name: string;
  reference: string;
  ownerNode: { id: string; slugPath: string };
  teamId: string | null;
  backend: 'internal' | 'env';
  pointer: string | null;
  version: number;
  description: string | null;
  usage: 'development' | 'production' | 'any';
  allowedDestinations: string[];
  inherit: boolean;
  allowOverride: boolean;
  state: 'active' | 'expired' | 'revoked';
  inherited: boolean;
  createdBy: string | null;
  createdAt: Date;
  rotatedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface SecretListInput {
  scope: SecretScope;
  teamId?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

/**
 * Reading secrets: metadata only, never a value (ADR 0017 section 13.4). A secret the caller may not
 * see is `404`, indistinguishable from a missing one; a descendant sees the inheritable secrets of its
 * ancestors without the creator.
 */
export class SecretViews {
  private readonly tree: TenantTree;

  constructor(
    private readonly ctx: AppContext,
    private readonly resolution: SecretResolution,
  ) {
    this.tree = new TenantTree(ctx);
  }

  async list(
    p: Principal,
    q: SecretListInput,
  ): Promise<{ items: SecretView[]; nextCursor: string | null }> {
    assertSecrets(p, 'read', q.scope, q.teamId ?? null);
    const where = await this.listFilter(p, q);
    const cur = decodeNameCursor(q.cursor);
    const after = cur
      ? or(gt(secrets.name, cur.key), and(eq(secrets.name, cur.key), gt(secrets.id, cur.id)))
      : undefined;
    const rows = await this.ctx.db
      .select()
      .from(secrets)
      .where(and(where, after))
      .orderBy(asc(secrets.name), asc(secrets.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: await this.views(p, page),
      nextCursor: rows.length > q.limit && last ? encodeNameCursor(last.name, last.id) : null,
    };
  }

  private async listFilter(p: Principal, q: SecretListInput): Promise<SQL | undefined> {
    if (q.scope === 'personal')
      return and(
        eq(secrets.scope, 'personal'),
        eq(secrets.scopeId, p.userId),
        eq(secrets.tenantId, p.tenantId),
      );
    if (q.scope === 'team') {
      await this.assertTeam(this.ctx.db, p.tenantId, q.teamId);
      return and(
        eq(secrets.scope, 'team'),
        eq(secrets.scopeId, q.teamId!),
        eq(secrets.tenantId, p.tenantId),
      );
    }
    // Own tenant secrets and the inheritable ones of the ancestors (metadata only). Names that a
    // node blocks (`blockInherited`) stay listed, flagged by the policy, so an owner can see why a
    // reference does not resolve there.
    const chain = await this.resolution.chainOf(this.ctx.db, p.tenantId);
    if (!chain) throw notFound('tenant');
    const ancestors = chain.nodes.slice(1).map((n) => n.id);
    const own = and(eq(secrets.tenantId, p.tenantId), eq(secrets.scope, 'tenant'));
    if (ancestors.length === 0) return own;
    return or(
      own,
      and(
        eq(secrets.scope, 'tenant'),
        eq(secrets.inherit, true),
        inArray(secrets.tenantId, ancestors),
      ),
    );
  }

  async get(p: Principal, id: string): Promise<SecretView> {
    const [row] = await this.ctx.db.select().from(secrets).where(eq(secrets.id, id));
    if (!row || !(await this.visible(p, row))) throw notFound('secret');
    return (await this.views(p, [row]))[0]!;
  }

  private async visible(p: Principal, row: SecretRow): Promise<boolean> {
    const scope = row.scope as SecretScope;
    if (row.tenantId === p.tenantId) {
      if (scope === 'personal' && row.scopeId !== p.userId) return false;
      return canSecrets(p, 'read', scope, scope === 'team' ? row.scopeId : null);
    }
    if (scope !== 'tenant' || !row.inherit || !canSecrets(p, 'read', 'tenant', null)) return false;
    const chain = await this.resolution.chainOf(this.ctx.db, p.tenantId);
    return !!chain && chain.ids.has(row.tenantId);
  }

  private async views(p: Principal, rows: readonly SecretRow[]): Promise<SecretView[]> {
    if (rows.length === 0) return [];
    const nodes = await this.ctx.db
      .select()
      .from(tenants)
      .where(inArray(tenants.id, [...new Set(rows.map((r) => r.tenantId))]));
    const paths = await this.tree.slugPaths(nodes);
    const now = this.ctx.now();
    return rows.map((r) => {
      const own = r.tenantId === p.tenantId;
      return {
        id: r.id,
        scope: r.scope as SecretScope,
        name: r.name,
        reference: scopedRef(r.scope as SecretScope, r.name),
        ownerNode: { id: r.tenantId, slugPath: paths.get(r.tenantId) ?? r.tenantId },
        teamId: r.scope === 'team' ? r.scopeId : null,
        backend: r.backend as 'internal' | 'env',
        pointer: own ? r.pointer : null,
        version: r.currentVersion,
        description: r.description,
        usage: r.usage as SecretView['usage'],
        allowedDestinations: r.allowedDestinations,
        inherit: r.inherit,
        allowOverride: r.allowOverride,
        state: stateOf(r, now),
        inherited: !own,
        createdBy: own ? r.createdBy : null,
        createdAt: r.createdAt,
        rotatedAt: r.rotatedAt,
        expiresAt: r.expiresAt,
        revokedAt: r.revokedAt,
      };
    });
  }

  async assertTeam(db: Db, tenantId: string, teamId: string | undefined): Promise<void> {
    if (!teamId) throw new HttpError(400, 'validation_failed', 'teamId is required');
    const [t] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)));
    if (!t) throw notFound('team');
  }
}
