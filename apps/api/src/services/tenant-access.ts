import { homeTenantOf, parseSlugPath, type Principal } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { tenants } from '../db/schema.js';
import type { TenantRow } from './identity.js';
import { TenantTree } from './tenant-tree.js';

/**
 * Which nodes of the tenant tree a principal may see and act in (ADR 0013 sections 7.1 and 7.4).
 *
 * - `all`: platform admins, every node of every organisation.
 * - `subtree`: a tenant admin (global `admin` binding), the home node and everything below it.
 * - `node`: every other user, the home node only.
 *
 * Until per-node role bindings arrive (W13-6) the global roles of a user are the bindings on the
 * home node, so this is the conservative reading of ADR 0013 7.3: only the `admin` role reaches
 * below the home node; the other roles stay on their own node. Siblings, cousins, ancestors and
 * other organisations are never reachable; they are indistinguishable from a tenant that does not
 * exist. This class is the single place that decides it; callers must not re-derive it.
 */
export type TenantReach =
  { kind: 'all' } | { kind: 'subtree'; home: TenantRow } | { kind: 'node'; home: TenantRow };

/** Hard ceiling for the length of an `X-OAX-Tenant` value (a uuid or a slug path). */
const MAX_REF_LENGTH = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a binding of the `admin` role on the whole node (not a team or an agent). */
export function isTenantAdmin(p: Pick<Principal, 'bindings'>): boolean {
  return p.bindings.some((b) => b.role === 'admin' && b.teamId === null && !b.agentId);
}

export class TenantAccess {
  private readonly tree: TenantTree;

  constructor(private readonly ctx: AppContext) {
    this.tree = new TenantTree(ctx);
  }

  /** The reach of the principal, or `none` when its home tenant no longer exists. */
  async reach(p: Principal): Promise<TenantReach | undefined> {
    if (p.platformAdmin) return { kind: 'all' };
    const [home] = await this.ctx.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, homeTenantOf(p)));
    if (!home) return undefined;
    return { kind: isTenantAdmin(p) ? 'subtree' : 'node', home };
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
   * reference is malformed or names nothing. Pure lookup: no permission check.
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

  /** The node the principal asked for, if it may see it. Missing and forbidden look the same. */
  async resolveVisible(p: Principal, ref: string): Promise<TenantRow | undefined> {
    const [row, reach] = await Promise.all([this.resolve(ref), this.reach(p)]);
    return row && TenantAccess.allows(reach, row) ? row : undefined;
  }
}
