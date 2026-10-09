import { homeTenantOf, parseSlugPath, type Principal } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { tenants } from '../db/schema.js';
import type { TenantRow } from './identity.js';
import { TenantTree } from './tenant-tree.js';

/**
 * Which nodes of the tenant tree a principal may see and act in (ADR 0013 section 7.4, read with
 * ADR 0014).
 *
 * - `all`: platform admins, every node of every organisation.
 * - `node`: every other user, tenant admins included, the home node only.
 *
 * ADR 0014 makes inheritance down the tree **opt-in per binding** (`inherit = true`, default
 * `false`) and lets inherited bindings write only after its slice S5. The roles a user holds today
 * (`users.global_roles`, team and agent bindings) become non-inheriting bindings on the home node,
 * so none of them reaches a descendant: an `admin` of a parent node does not act in its children
 * until an inheriting binding exists (S1/S2). Siblings, cousins, ancestors, descendants and other
 * organisations are indistinguishable from a tenant that does not exist. This class is the single
 * place that decides it; callers must not re-derive it.
 */
export type TenantReach =
  | { kind: 'all' }
  | { kind: 'node'; home: TenantRow }
  /**
   * The home node and everything below it. Reserved for inheriting bindings (ADR 0014 S2, read
   * only until S5); {@link TenantAccess.reach} does not produce it before those slices land.
   */
  | { kind: 'subtree'; home: TenantRow };

/** Hard ceiling for the length of an `X-OAX-Tenant` value (a uuid or a slug path). */
const MAX_REF_LENGTH = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantAccess {
  private readonly tree: TenantTree;

  constructor(private readonly ctx: AppContext) {
    this.tree = new TenantTree(ctx);
  }

  /** The reach of the principal, or `undefined` when its home tenant no longer exists. */
  async reach(p: Principal): Promise<TenantReach | undefined> {
    if (p.platformAdmin) return { kind: 'all' };
    const [home] = await this.ctx.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, homeTenantOf(p)));
    if (!home) return undefined;
    return { kind: 'node', home };
  }

  /** Pure check of a node against a reach; `undefined` (no home) reaches nothing. */
  static allows(reach: TenantReach | undefined, node: Pick<TenantRow, 'id' | 'path'>): boolean {
    if (!reach) return false;
    switch (reach.kind) {
      case 'all':
        return true;
      case 'subtree':
        return node.path.startsWith(reach.home.path);
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
   * The node the principal asked for, if it may see it. Missing and forbidden look the same, also
   * in timing: a caller limited to its home node is matched against that node only (id, slug or
   * slug path), so the value it sends never causes a lookup of another node and the number of
   * queries cannot tell whether a foreign slug or slug-path segment exists (ADR 0014 3.4).
   */
  async resolveVisible(p: Principal, ref: string): Promise<TenantRow | undefined> {
    const reach = await this.reach(p);
    if (!reach) return undefined;
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
