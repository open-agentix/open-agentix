import { isValidPath, pathIds, type RoleNode } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { tenants } from '../db/schema.js';

/**
 * Tree snapshot of one organisation (ADR 0014 section 3.6): the nodes of a root with the little the
 * acting-node logic needs (`id`, `parentId`, `path`, `depth`, `slug`), loaded with one query and
 * cached under `tree:<rootId>:<authz epoch>`, so a bumped epoch (node created, renamed, moved or
 * deleted; see migration 0021) is a different key and a stale snapshot is never read.
 *
 * Why it exists: a caller who may act in more than its home node must be matched against the nodes
 * it can see **without** a lookup per slug segment and without a query whose count or timing
 * depends on whether a foreign slug exists (the #197 review). Everything after the load is in
 * memory, so an unknown reference and an invisible one cost exactly the same.
 */
export interface SnapNode extends RoleNode {
  parentId: string | null;
  depth: number;
  slug: string;
}

/** Entries live this long; the epoch in the key is the real invalidation. */
export const SNAPSHOT_TTL_MS = 10 * 60_000;
/** Hard ceiling (fail closed): a root with more nodes than this is not snapshotted. */
export const SNAPSHOT_MAX_NODES = 20_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A snapshot with the lookups built from it. Immutable after construction. */
export class TreeSnapshot {
  readonly byId = new Map<string, SnapNode>();
  /** Slug path (`acme/security/blue`) to node id; nodes whose chain is incomplete have none. */
  private readonly bySlugPath = new Map<string, string>();
  private readonly slugPathOf = new Map<string, string>();
  private readonly bySlug = new Map<string, string[]>();

  constructor(
    readonly rootId: string,
    readonly nodes: readonly SnapNode[],
  ) {
    for (const n of nodes) this.byId.set(n.id, n);
    for (const n of nodes) {
      const slugs: string[] = [];
      let complete = isValidPath(n.path);
      if (complete)
        for (const id of pathIds(n.path)) {
          const a = this.byId.get(id);
          if (!a) {
            complete = false;
            break;
          }
          slugs.push(a.slug);
        }
      if (complete) {
        const sp = slugs.join('/');
        this.slugPathOf.set(n.id, sp);
        this.bySlugPath.set(sp, n.id);
      }
      const list = this.bySlug.get(n.slug);
      if (list) list.push(n.id);
      else this.bySlug.set(n.slug, [n.id]);
    }
  }

  slugPath(id: string): string | undefined {
    return this.slugPathOf.get(id);
  }

  /**
   * The node an `X-OAX-Tenant` value names: a node id, a slug path or a bare slug (unique in the
   * installation until secret names are node-aware, W13-7). Pure lookup in memory.
   */
  find(ref: string): SnapNode | undefined {
    if (UUID.test(ref)) return this.byId.get(ref.toLowerCase());
    if (!ref.includes('/')) {
      const ids = this.bySlug.get(ref);
      return ids && ids.length === 1 ? this.byId.get(ids[0]!) : undefined;
    }
    const id = this.bySlugPath.get(ref);
    return id ? this.byId.get(id) : undefined;
  }
}

function validNodes(value: unknown, rootId: string): SnapNode[] | undefined {
  if (!Array.isArray(value) || value.length > SNAPSHOT_MAX_NODES) return undefined;
  const out: SnapNode[] = [];
  for (const v of value as Record<string, unknown>[]) {
    if (typeof v !== 'object' || v === null) return undefined;
    if (!isStr(v.id) || !isStr(v.slug) || typeof v.path !== 'string' || !isValidPath(v.path))
      return undefined;
    if (v.rootId !== rootId || typeof v.depth !== 'number') return undefined;
    if (v.parentId !== null && !isStr(v.parentId)) return undefined;
    out.push({
      id: v.id,
      rootId,
      path: v.path,
      parentId: v.parentId as string | null,
      depth: v.depth,
      slug: v.slug,
    });
  }
  return out;
}

export class TenantSnapshots {
  constructor(private readonly ctx: AppContext) {}

  /**
   * The snapshot of `rootId` as of `epoch`; `undefined` when it cannot be built or is too large
   * (callers then fall back to the home node: fail closed). One query on a miss, none on a hit.
   */
  async get(rootId: string, epoch: number): Promise<TreeSnapshot | undefined> {
    const key = `tree:${rootId}:${epoch}`;
    const hit = await this.ctx.cache.get<unknown>(key);
    const cachedNodes = hit === undefined ? undefined : validNodes(hit, rootId);
    if (cachedNodes) return new TreeSnapshot(rootId, cachedNodes);
    const rows = await this.ctx.db
      .select({
        id: tenants.id,
        parentId: tenants.parentId,
        path: tenants.path,
        depth: tenants.depth,
        slug: tenants.slug,
      })
      .from(tenants)
      .where(eq(tenants.rootId, rootId))
      .limit(SNAPSHOT_MAX_NODES + 1);
    if (rows.length > SNAPSHOT_MAX_NODES) return undefined;
    const nodes: SnapNode[] = rows.map((r) => ({
      id: r.id,
      rootId,
      path: r.path,
      parentId: r.parentId,
      depth: r.depth,
      slug: r.slug,
    }));
    const checked = validNodes(nodes, rootId);
    if (!checked) return undefined;
    await this.ctx.cache.set(key, checked, SNAPSHOT_TTL_MS);
    return new TreeSnapshot(rootId, checked);
  }
}
