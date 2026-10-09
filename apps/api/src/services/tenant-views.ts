import {
  ancestorIds,
  hasPermission,
  homeTenantOf,
  subtreePrefix,
  type Permission,
  type Principal,
} from '@openagentix/core';
import { and, asc, count, eq, gte, like, lte, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { agents, approvals, costLedger, runs, tenants } from '../db/schema.js';
import { notFound } from '../errors.js';
import type { TenantRow } from './identity.js';
import { monthOf } from './runs.js';
import { TenantAccess, type TenantReach } from './tenant-access.js';
import { TenantTree } from './tenant-tree.js';

const MICROS_PER_USD = 1_000_000;
const DAY_MS = 86_400_000;

/** Technical limits of the tree and search endpoints. */
export const TREE_DEFAULT_LIMIT = 1000;
export const TREE_MAX_LIMIT = 5000;
export const SEARCH_MAX_LIMIT = 20;

export interface TreeCounts {
  agents: number | null;
  agentsSubtree: number | null;
  runs30d: number | null;
  pendingApprovals: number | null;
  spendMonthUsd: number | null;
  spendMonthSubtreeUsd: number | null;
  capUsd: number | null;
  capSource: 'tenant' | null;
}

export interface TreeNode {
  node: TenantRow;
  slugPath: string;
  /** False for the ancestors of the caller's node that are only shown as path stubs. */
  visible: boolean;
  hasChildren: boolean;
  /** Roles the caller holds on this node itself. */
  myRoles: string[];
  /** Roles the caller holds on an ancestor that reach this node. */
  inheritedRoles: string[];
  counts: TreeCounts | null;
}

export interface TreeOptions {
  /** Start node (`id | slug path`); defaults to everything the caller may see. */
  root?: string | undefined;
  /** Levels below the start node (0 = the start node only); unlimited when omitted. */
  depth?: number | undefined;
  counts: boolean;
  limit: number;
}

export interface TreeResult {
  items: TreeNode[];
  /** True when more nodes matched than `limit`; the shallowest nodes are returned first. */
  truncated: boolean;
}

export interface ActingContext {
  acting: TenantRow;
  /** Root first, the acting node last. */
  path: TenantRow[];
  slugPath: string;
  home: TenantRow;
  homeSlugPath: string;
  visibleTenantCount: number;
}

interface Grouped {
  id: string;
  path: string;
  n: number;
}

/** Roles bound on the whole node (not on a team or an agent). */
const nodeRoles = (p: Principal): string[] =>
  [...new Set(p.bindings.filter((b) => b.teamId === null && !b.agentId).map((b) => b.role))].sort();

/**
 * Does the caller hold `permission` on the whole node? Only bindings that cover the node count (a
 * role bound on a team or an agent never lets a count of the node through), and API token scopes
 * still apply.
 */
function holdsOnNode(p: Principal, permission: Permission): boolean {
  return hasPermission(
    { ...p, bindings: p.bindings.filter((b) => b.teamId === null && !b.agentId) },
    permission,
  );
}

/**
 * Read models over the tenant tree for the console: the acting-tenant context of `GET /v1/me`,
 * the visible tree with counts (`GET /v1/tenants/tree`) and the switcher search. Every query is
 * scoped by {@link TenantAccess} first; counts are fixed-size aggregates (one query per metric
 * for the whole tree), never one query per node.
 */
export class TenantViews {
  private readonly tree: TenantTree;
  private readonly access: TenantAccess;

  constructor(private readonly ctx: AppContext) {
    this.tree = new TenantTree(ctx);
    this.access = new TenantAccess(ctx);
  }

  /** Condition that limits a query on `tenants` to what the reach allows. */
  private scope(reach: TenantReach): SQL | undefined {
    switch (reach.kind) {
      case 'all':
        return undefined;
      case 'subtree':
        return like(tenants.path, subtreePrefix(reach.home.path));
      case 'node':
        return eq(tenants.id, reach.home.id);
    }
  }

  async reachOf(p: Principal): Promise<TenantReach | undefined> {
    return this.access.reach(p);
  }

  /** Number of nodes the caller can act in. */
  async visibleCount(reach: TenantReach | undefined): Promise<number> {
    if (!reach) return 0;
    if (reach.kind === 'node') return 1;
    const [row] = await this.ctx.db.select({ n: count() }).from(tenants).where(this.scope(reach));
    return Number(row?.n ?? 0);
  }

  /** The acting tenant, its breadcrumb and the visible node count for `GET /v1/me`. */
  async actingContext(p: Principal): Promise<ActingContext> {
    const acting = await this.tree.node(p.tenantId);
    if (!acting) throw notFound('tenant');
    const homeId = homeTenantOf(p);
    const [ancestors, home, reach] = await Promise.all([
      this.tree.ancestors(acting),
      homeId === acting.id ? Promise.resolve(acting) : this.tree.node(homeId),
      this.access.reach(p),
    ]);
    if (!home) throw notFound('tenant');
    const homeAncestors = home.id === acting.id ? ancestors : await this.tree.ancestors(home);
    const slugs = await this.tree.slugPaths([...ancestors, acting, ...homeAncestors, home]);
    return {
      acting,
      path: [...ancestors, acting],
      slugPath: slugs.get(acting.id)!,
      home,
      homeSlugPath: slugs.get(home.id)!,
      visibleTenantCount: await this.visibleCount(reach),
    };
  }

  /** Visible nodes matching `q` in name or slug, shallowest first. */
  async search(
    p: Principal,
    q: string,
    limit: number,
  ): Promise<{ node: TenantRow; slugPath: string }[]> {
    const reach = await this.access.reach(p);
    if (!reach) return [];
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = await this.ctx.db
      .select()
      .from(tenants)
      .where(
        and(
          this.scope(reach),
          sql`(${tenants.name} ilike ${pattern} escape '\\' or ${tenants.slug} ilike ${pattern} escape '\\')`,
        ),
      )
      .orderBy(asc(tenants.depth), asc(tenants.slug), asc(tenants.id))
      .limit(Math.min(Math.max(limit, 1), SEARCH_MAX_LIMIT));
    const slugs = await this.tree.slugPaths(rows);
    return rows.map((node) => ({ node, slugPath: slugs.get(node.id)! }));
  }

  /**
   * The tree the caller may see (ADR 0013 7.4): platform admins everything, tenant admins their
   * node and everything below, everybody else their own node; plus, for non-platform callers,
   * the ancestors of their node as name-only path stubs. A `root` outside that reach is 404.
   */
  async visibleTree(p: Principal, opts: TreeOptions): Promise<TreeResult> {
    const reach = await this.access.reach(p);
    if (!reach) return { items: [], truncated: false };
    let root: TenantRow | undefined;
    if (opts.root !== undefined) {
      root = await this.access.resolveVisible(p, opts.root);
      if (!root) throw notFound('tenant');
    }
    const limit = Math.min(Math.max(opts.limit, 1), TREE_MAX_LIMIT);
    const base = root ?? (reach.kind === 'all' ? undefined : reach.home);
    const conds: (SQL | undefined)[] = [
      reach.kind === 'node' ? this.scope(reach) : undefined,
      root ? like(tenants.path, subtreePrefix(root.path)) : this.scope(reach),
      opts.depth === undefined ? undefined : lte(tenants.depth, (base?.depth ?? 0) + opts.depth),
    ];
    const rows = await this.ctx.db
      .select({
        node: tenants,
        // qualified by hand: drizzle prints a bare column name inside a single-table select
        hasChildren: sql<boolean>`exists (select 1 from tenants c where c.parent_id = tenants.id)`,
      })
      .from(tenants)
      .where(and(...conds))
      .orderBy(asc(tenants.depth), asc(tenants.slug), asc(tenants.id))
      .limit(limit + 1);
    const truncated = rows.length > limit;
    const visible = rows.slice(0, limit);

    // Path stubs: the names of the ancestors of the caller's own node, never their other children.
    const stubs: TenantRow[] =
      !root && reach.kind !== 'all' && reach.home.depth > 0
        ? await this.tree.ancestors(reach.home)
        : [];
    const all = [...stubs, ...visible.map((r) => r.node)];
    const slugs = await this.tree.slugPaths(all);
    const roles = nodeRoles(p);
    const homeId = homeTenantOf(p);
    const homePath = reach.kind === 'all' ? undefined : reach.home.path;
    const countsOf = opts.counts ? await this.counts(p, reach, root) : null;

    const entry = (node: TenantRow, isVisible: boolean, hasChildren: boolean): TreeNode => {
      const own = isVisible && node.id === homeId;
      const below = isVisible && !own && homePath !== undefined && node.path.startsWith(homePath);
      return {
        node,
        slugPath: slugs.get(node.id)!,
        visible: isVisible,
        hasChildren: isVisible ? hasChildren && reach.kind !== 'node' : true,
        myRoles: own ? roles : [],
        inheritedRoles: below ? roles : [],
        counts: isVisible ? (countsOf?.(node) ?? null) : null,
      };
    };
    const entries = [
      ...stubs.map((n) => entry(n, false, true)),
      ...visible.map((r) => entry(r.node, true, r.hasChildren)),
    ];
    return { items: depthFirst(entries), truncated };
  }

  /**
   * Counts for the returned nodes: own and subtree sums from one aggregate query per metric over
   * the whole scope (so a truncated or depth-limited response still shows complete subtree sums),
   * rolled up in memory along the materialised paths. A metric the caller may not read is null.
   */
  private async counts(
    p: Principal,
    reach: TenantReach,
    root: TenantRow | undefined,
  ): Promise<(node: TenantRow) => TreeCounts> {
    const where = root ? like(tenants.path, subtreePrefix(root.path)) : this.scope(reach);
    const nodeOnly = reach.kind === 'node' ? this.scope(reach) : undefined;
    const scope = and(where, nodeOnly);
    const month = monthOf(this.ctx.now());
    const since = new Date(this.ctx.now().getTime() - 30 * DAY_MS);
    const canAgents = holdsOnNode(p, 'agents:read');
    const canRuns = holdsOnNode(p, 'runs:read');
    const canCosts = holdsOnNode(p, 'costs:read');
    const grouped = async (
      allowed: boolean,
      run: () => Promise<{ id: string; path: string; n: unknown }[]>,
    ): Promise<{ own: Map<string, number>; sub: Map<string, number> } | null> => {
      if (!allowed) return null;
      const own = new Map<string, number>();
      const sub = new Map<string, number>();
      for (const r of (await run()) as Grouped[]) {
        const n = Number(r.n);
        own.set(r.id, n);
        for (const id of [...ancestorIds(r.path), r.id]) sub.set(id, (sub.get(id) ?? 0) + n);
      }
      return { own, sub };
    };
    const [agentCount, runCount, approvalCount, spend] = await Promise.all([
      grouped(canAgents, () =>
        this.ctx.db
          .select({ id: agents.tenantId, path: tenants.path, n: sql<number>`count(*)::int` })
          .from(agents)
          .innerJoin(tenants, eq(tenants.id, agents.tenantId))
          .where(scope)
          .groupBy(agents.tenantId, tenants.path),
      ),
      grouped(canRuns, () =>
        this.ctx.db
          .select({ id: runs.tenantId, path: tenants.path, n: sql<number>`count(*)::int` })
          .from(runs)
          .innerJoin(tenants, eq(tenants.id, runs.tenantId))
          .where(and(scope, gte(runs.createdAt, since)))
          .groupBy(runs.tenantId, tenants.path),
      ),
      grouped(canRuns, () =>
        this.ctx.db
          .select({ id: approvals.tenantId, path: tenants.path, n: sql<number>`count(*)::int` })
          .from(approvals)
          .innerJoin(tenants, eq(tenants.id, approvals.tenantId))
          .where(and(scope, eq(approvals.status, 'pending')))
          .groupBy(approvals.tenantId, tenants.path),
      ),
      grouped(canCosts, () =>
        this.ctx.db
          .select({
            id: costLedger.tenantId,
            path: tenants.path,
            n: sql<number>`coalesce(sum(${costLedger.costMicros}), 0)::bigint`,
          })
          .from(costLedger)
          .innerJoin(tenants, eq(tenants.id, costLedger.tenantId))
          .where(and(scope, eq(costLedger.month, month)))
          .groupBy(costLedger.tenantId, tenants.path),
      ),
    ]);
    const usd = (micros: number) => micros / MICROS_PER_USD;
    return (node) => ({
      agents: agentCount ? (agentCount.own.get(node.id) ?? 0) : null,
      agentsSubtree: agentCount ? (agentCount.sub.get(node.id) ?? 0) : null,
      runs30d: runCount ? (runCount.own.get(node.id) ?? 0) : null,
      pendingApprovals: approvalCount ? (approvalCount.own.get(node.id) ?? 0) : null,
      spendMonthUsd: spend ? usd(spend.own.get(node.id) ?? 0) : null,
      spendMonthSubtreeUsd: spend ? usd(spend.sub.get(node.id) ?? 0) : null,
      capUsd: canCosts && node.monthlyBudgetMicros !== null ? usd(node.monthlyBudgetMicros) : null,
      capSource: canCosts && node.monthlyBudgetMicros !== null ? 'tenant' : null,
    });
  }
}

/**
 * Depth-first, parents before children, siblings in the order they arrive (depth, slug, id).
 * Iterative: the depth is bounded, but the input is not trusted to be well formed.
 */
function depthFirst(entries: TreeNode[]): TreeNode[] {
  const byParent = new Map<string | null, TreeNode[]>();
  const ids = new Set(entries.map((e) => e.node.id));
  for (const e of entries) {
    const parent = e.node.parentId && ids.has(e.node.parentId) ? e.node.parentId : null;
    const list = byParent.get(parent);
    if (list) list.push(e);
    else byParent.set(parent, [e]);
  }
  const out: TreeNode[] = [];
  const stack = [...(byParent.get(null) ?? [])].reverse();
  while (stack.length > 0) {
    const e = stack.pop()!;
    out.push(e);
    const kids = byParent.get(e.node.id);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}
