import { ancestorIds, parseSlugPath, subtreePrefix } from '@openagentix/core';
import { and, asc, count, eq, inArray, isNull, like, ne } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { tenants } from '../db/schema.js';
import type { TenantRow } from './identity.js';

/**
 * Repository for tenant tree queries (ADR 0013 section 2). These are plain structural lookups
 * without any permission check: callers (services, later the role layer of W13-6) decide who may
 * see which node. Nothing here widens what a principal can read.
 */
export class TenantTree {
  constructor(private readonly ctx: AppContext) {}

  async node(id: string): Promise<TenantRow | undefined> {
    const [row] = await this.ctx.db.select().from(tenants).where(eq(tenants.id, id));
    return row;
  }

  /** Direct children, ordered by slug. */
  children(id: string): Promise<TenantRow[]> {
    return this.ctx.db
      .select()
      .from(tenants)
      .where(eq(tenants.parentId, id))
      .orderBy(asc(tenants.slug));
  }

  /** All roots (organisations), ordered by slug. */
  roots(): Promise<TenantRow[]> {
    return this.ctx.db
      .select()
      .from(tenants)
      .where(isNull(tenants.parentId))
      .orderBy(asc(tenants.slug));
  }

  /** Ancestors of a node, root first, excluding the node (the ids come from its own path). */
  async ancestors(node: Pick<TenantRow, 'path'>): Promise<TenantRow[]> {
    const ids = ancestorIds(node.path);
    if (ids.length === 0) return [];
    const rows = await this.ctx.db.select().from(tenants).where(inArray(tenants.id, ids));
    return rows.sort((a, b) => a.depth - b.depth);
  }

  /** Every node below `node` (not the node itself), parents before children, one prefix lookup. */
  descendants(node: Pick<TenantRow, 'id' | 'path'>): Promise<TenantRow[]> {
    return this.ctx.db
      .select()
      .from(tenants)
      .where(and(like(tenants.path, subtreePrefix(node.path)), ne(tenants.id, node.id)))
      .orderBy(asc(tenants.depth), asc(tenants.slug));
  }

  /** The node and everything below it. */
  subtree(node: Pick<TenantRow, 'path'>): Promise<TenantRow[]> {
    return this.ctx.db
      .select()
      .from(tenants)
      .where(like(tenants.path, subtreePrefix(node.path)))
      .orderBy(asc(tenants.depth), asc(tenants.slug));
  }

  /** Number of nodes of an organisation, the root included. */
  async sizeOf(rootId: string): Promise<number> {
    const [row] = await this.ctx.db
      .select({ n: count() })
      .from(tenants)
      .where(eq(tenants.rootId, rootId));
    return Number(row?.n ?? 0);
  }

  /** Resolves `acme/div-a/team-a` level by level; undefined when any segment does not exist. */
  async resolveSlugPath(slugPath: string): Promise<TenantRow | undefined> {
    const [first, ...rest] = parseSlugPath(slugPath);
    let [current] = await this.ctx.db
      .select()
      .from(tenants)
      .where(and(isNull(tenants.parentId), eq(tenants.slug, first!)));
    for (const slug of rest) {
      if (!current) return undefined;
      [current] = await this.ctx.db
        .select()
        .from(tenants)
        .where(and(eq(tenants.parentId, current.id), eq(tenants.slug, slug)));
    }
    return current;
  }
}
