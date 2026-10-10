import {
  appliedAt,
  homeTenantOf,
  parseSlugPath,
  type AppliedBinding,
  type Principal,
} from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { tenants } from '../db/schema.js';
import type { TenantRow } from './identity.js';
import { TenantTree } from './tenant-tree.js';
import { TenantSnapshots, type SnapNode, type TreeSnapshot } from './tenant-snapshot.js';

/**
 * Which nodes of the tenant tree a principal may see and act in (ADR 0013 section 7.4, read with
 * ADR 0014).
 *
 * - `all`: platform admins, every node of every organisation.
 * - `node`: the home node only. Everybody else while the read path is `legacy`
 *   (`OAX_ROLE_BINDINGS_READ`), and every principal whose grants cannot be evaluated.
 * - `nodes`: the read path is `bindings` (ADR 0014 S2). The nodes of the home organisation where
 *   the tenant role resolver gives the principal at least one permission (a direct binding, an
 *   inheriting binding on an ancestor, a team or agent binding), plus the home node itself.
 *   Inheritance is opt-in per binding (`inherit = true`, default `false`), so a tenant admin with
 *   only non-inheriting bindings still reaches nothing below its home node.
 *
 * Siblings, cousins, ancestors, descendants without an inheriting binding and other organisations
 * are indistinguishable from a tenant that does not exist. This class is the single place that
 * decides it; callers must not re-derive it.
 */
export type TenantReach =
  | { kind: 'all' }
  | { kind: 'node'; home: TenantRow }
  | {
      kind: 'nodes';
      home: TenantRow;
      /** Visible node ids, the home node included. */
      ids: ReadonlySet<string>;
      snapshot: TreeSnapshot;
      /** What the principal holds at a node of the snapshot (the resolver, read-only clamp on). */
      appliedAt: (node: SnapNode) => AppliedBinding[];
    };

/** Hard ceiling for the length of an `X-OAX-Tenant` value (a uuid or a slug path). */
const MAX_REF_LENGTH = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantAccess {
  private readonly tree: TenantTree;
  private readonly snapshots: TenantSnapshots;

  constructor(private readonly ctx: AppContext) {
    this.tree = new TenantTree(ctx);
    this.snapshots = new TenantSnapshots(ctx);
  }

  /** The reach of the principal, or `undefined` when its home tenant no longer exists. */
  async reach(p: Principal): Promise<TenantReach | undefined> {
    if (p.platformAdmin) return { kind: 'all' };
    const [home] = await this.ctx.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, homeTenantOf(p)));
    if (!home) return undefined;
    const grants = p.grants;
    // Read path `legacy` (no grants on the principal): the home node only.
    if (!grants || p.authzEpoch === undefined) return { kind: 'node', home };
    // Grants of another user or another home are never evaluated (fail closed to the home node).
    if (grants.raw.userId !== p.userId || grants.home.id !== home.id) return { kind: 'node', home };
    const snapshot = await this.snapshots.get(home.rootId, p.authzEpoch);
    if (!snapshot || home.rootId !== grants.home.rootId) return { kind: 'node', home };
    const now = this.ctx.now();
    const applied = (node: SnapNode) =>
      appliedAt(grants.raw, node, { now, implicitPlatformAdmin: false });
    const ids = new Set<string>([home.id]);
    for (const n of snapshot.nodes)
      if (applied(n).some((b) => b.permissions.length > 0)) ids.add(n.id);
    return { kind: 'nodes', home, ids, snapshot, appliedAt: applied };
  }

  /** Pure check of a node against a reach; `undefined` (no home) reaches nothing. */
  static allows(reach: TenantReach | undefined, node: Pick<TenantRow, 'id' | 'path'>): boolean {
    if (!reach) return false;
    switch (reach.kind) {
      case 'all':
        return true;
      case 'nodes':
        return reach.ids.has(node.id);
      case 'node':
        return node.id === reach.home.id;
    }
  }

  /**
   * Resolves `<id | slug | slug path>` to a node (`acme/security/blue`); `undefined` when the
   * reference is malformed or names nothing. Pure lookup: no permission check, and its cost
   * depends on which nodes exist, so only callers that may see every node use it directly.
   */
  async resolve(ref: string): Promise<TenantRow | undefined> {
    if (ref.length === 0 || ref.length > MAX_REF_LENGTH) return undefined;
    if (UUID.test(ref)) return this.tree.node(ref.toLowerCase());
    try {
      parseSlugPath(ref);
    } catch {
      return undefined;
    }
    if (ref.includes('/')) return this.tree.resolveSlugPath(ref);
    // A bare slug is globally unique until secret names are node-aware (W13-7).
    const [row] = await this.ctx.db.select().from(tenants).where(eq(tenants.slug, ref));
    return row;
  }

  /**
   * The node the principal asked for, as far as the acting-node logic needs it (`id`, `rootId`,
   * `path`), if it may see it. Missing and forbidden look the same, also in cost:
   *
   * - platform admins resolve the whole value first (they may see everything anyway);
   * - a caller limited to its home node is matched against that node only;
   * - a caller with a `nodes` reach is matched against the cached snapshot of its own organisation
   *   in memory, then against its visible set. A reference to a node of another organisation, to
   *   an invisible node and to nothing at all all end at the same `undefined` after the same
   *   queries (home node, epoch-keyed snapshot), so neither the status, the body nor the number
   *   of queries can tell them apart (ADR 0014 3.4, the review of #197).
   */
  async resolveActing(p: Principal, ref: string): Promise<SnapNode | TenantRow | undefined> {
    const reach = await this.reach(p);
    if (!reach) return undefined;
    if (reach.kind === 'nodes') {
      if (ref.length === 0 || ref.length > MAX_REF_LENGTH) return undefined;
      const found = reach.snapshot.find(ref);
      return found && reach.ids.has(found.id) ? found : undefined;
    }
    return this.resolveIn(reach, ref);
  }

  /** Like {@link resolveActing} but returns the full row (one more query, visible nodes only). */
  async resolveVisible(p: Principal, ref: string): Promise<TenantRow | undefined> {
    const reach = await this.reach(p);
    if (!reach) return undefined;
    if (reach.kind === 'nodes') {
      if (ref.length === 0 || ref.length > MAX_REF_LENGTH) return undefined;
      const found = reach.snapshot.find(ref);
      return found && reach.ids.has(found.id) ? this.tree.node(found.id) : undefined;
    }
    return this.resolveIn(reach, ref);
  }

  private async resolveIn(
    reach: Exclude<TenantReach, { kind: 'nodes' }>,
    ref: string,
  ): Promise<TenantRow | undefined> {
    if (reach.kind !== 'node') {
      const row = await this.resolve(ref);
      return row && TenantAccess.allows(reach, row) ? row : undefined;
    }
    const home = reach.home;
    if (ref.length === 0 || ref.length > MAX_REF_LENGTH) return undefined;
    if (UUID.test(ref)) return ref.toLowerCase() === home.id ? home : undefined;
    if (!ref.includes('/')) return ref === home.slug ? home : undefined;
    const slugPath = (await this.tree.slugPaths([home])).get(home.id);
    return ref === slugPath ? home : undefined;
  }
}
