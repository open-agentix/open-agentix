import {
  ancestorIds,
  hasPermission,
  homeTenantOf,
  subtreePrefix,
  type Permission,
  type Principal,
} from '@openagentix/core';
import { and, asc, count, eq, gte, inArray, like, lte, sql, type SQL } from 'drizzle-orm';
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
  /** Slug paths of the acting node, its ancestors, the home node and its ancestors. */
  slugPaths: ReadonlyMap<string, string>;
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
      case 'nodes':
        return inArray(tenants.id, [...reach.ids]);
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
    if (reach.kind === 'nodes') return reach.ids.size;
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
      slugPaths: slugs,
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
    const nodesReach = reach.kind === 'nodes' ? reach : undefined;
    // Depth limits count from the start node, or from the shallowest node the caller can see.
    const baseDepth = root
      ? root.depth
      : reach.kind === 'all'
        ? 0
        : nodesReach
          ? Math.min(
              ...[...nodesReach.ids].map((id) => nodesReach.snapshot.byId.get(id)?.depth ?? 0),
            )
          : reach.home.depth;
    const conds: (SQL | undefined)[] = [
      reach.kind === 'all' ? undefined : this.scope(reach),
      root ? like(tenants.path, subtreePrefix(root.path)) : undefined,
      opts.depth === undefined ? undefined : lte(tenants.depth, baseDepth + opts.depth),
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

    // Path stubs: the names of the ancestors of the caller's own node (or, with several visible
    // nodes, of every visible node that are not visible themselves), never their other children.
    let stubs: TenantRow[] = [];
    if (!root && nodesReach) {
      const want = new Set<string>();
      for (const id of nodesReach.ids)
        for (const a of ancestorIds(nodesReach.snapshot.byId.get(id)?.path ?? ''))
          if (!nodesReach.ids.has(a)) want.add(a);
      if (want.size > 0)
        stubs = (
          await this.ctx.db
            .select()
            .from(tenants)
            .where(inArray(tenants.id, [...want]))
        ).sort((a, b) => a.depth - b.depth);
    } else if (!root && reach.kind === 'node' && reach.home.depth > 0) {
      stubs = await this.tree.ancestors(reach.home);
    }
    const all = [...stubs, ...visible.map((r) => r.node)];
    const slugs = await this.tree.slugPaths(all);
    const roles = nodeRoles(p);
    const homeId = homeTenantOf(p);
    const homePath = reach.kind === 'all' ? undefined : reach.home.path;
    const countsOf = opts.counts ? await this.counts(p, reach, root) : null;
    // Nodes that have a visible child (a child the caller cannot see does not make `hasChildren`).
    const parentsOfVisible = new Set<string>();
    if (nodesReach)
      for (const id of nodesReach.ids) {
        const parent = nodesReach.snapshot.byId.get(id)?.parentId;
        if (parent && nodesReach.ids.has(parent)) parentsOfVisible.add(parent);
      }

    const entry = (node: TenantRow, isVisible: boolean, hasChildren: boolean): TreeNode => {
      let myRoles: string[] = [];
      let inheritedRoles: string[] = [];
      if (isVisible && nodesReach) {
        const snap = nodesReach.snapshot.byId.get(node.id);
        const applied = snap ? nodesReach.appliedAt(snap) : [];
        const whole = (source: string) => [
          ...new Set(
            applied
              .filter((b) => b.source === source && b.teamId === null && !b.agentId)
              .map((b) => b.role),
          ),
        ];
        myRoles = whole('direct').sort();
        inheritedRoles = whole('inherited').sort();
      } else if (isVisible) {
        const own = node.id === homeId;
        const below = !own && homePath !== undefined && node.path.startsWith(homePath);
        myRoles = own ? roles : [];
        inheritedRoles = below ? roles : [];
      }
      return {
        node,
        slugPath: slugs.get(node.id)!,
        visible: isVisible,
        hasChildren: !isVisible
          ? true
          : nodesReach
            ? parentsOfVisible.has(node.id)
            : hasChildren && reach.kind !== 'node',
        myRoles,
        inheritedRoles,
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
    const scope = and(
      root ? like(tenants.path, subtreePrefix(root.path)) : undefined,
      reach.kind === 'all' ? undefined : this.scope(reach),
    );
    const month = monthOf(this.ctx.now());
    const since = new Date(this.ctx.now().getTime() - 30 * DAY_MS);
    /**
     * The nodes whose metric the caller may read: with a `nodes` reach per node, from the roles it
     * holds there on the whole node (a team or agent scoped role never counts; token scopes
     * still apply); otherwise all-or-nothing as before. Nothing outside it is queried or summed.
     */
    const readable = (permission: Permission): Set<string> | 'all' | null => {
      if (reach.kind !== 'nodes') return holdsOnNode(p, permission) ? 'all' : null;
      const ok = new Set<string>();
      for (const id of reach.ids) {
        const snap = reach.snapshot.byId.get(id);
        if (!snap) continue;
        const whole = reach.appliedAt(snap).filter((b) => b.teamId === null && !b.agentId);
        if (hasPermission({ ...p, bindings: whole }, permission)) ok.add(id);
      }
      return ok.size > 0 ? ok : null;
    };
    const canAgents = readable('agents:read');
    const canRuns = readable('runs:read');
    const canCosts = readable('costs:read');
    const only = (allowed: Set<string> | 'all' | null): SQL | undefined =>
      allowed === 'all' || allowed === null ? undefined : inArray(tenants.id, [...allowed]);
    const may = (allowed: Set<string> | 'all' | null, id: string): boolean =>
      allowed === 'all' || (allowed !== null && allowed.has(id));
    const grouped = async (
      allowed: Set<string> | 'all' | null,
      run: () => Promise<{ id: string; path: string; n: unknown }[]>,
    ): Promise<{ own: Map<string, number>; sub: Map<string, number> } | null> => {
      if (allowed === null) return null;
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
          .where(and(scope, only(canAgents)))
          .groupBy(agents.tenantId, tenants.path),
      ),
      grouped(canRuns, () =>
        this.ctx.db
          .select({ id: runs.tenantId, path: tenants.path, n: sql<number>`count(*)::int` })
          .from(runs)
          .innerJoin(tenants, eq(tenants.id, runs.tenantId))
          .where(and(scope, only(canRuns), gte(runs.createdAt, since)))
          .groupBy(runs.tenantId, tenants.path),
      ),
      grouped(canRuns, () =>
        this.ctx.db
          .select({ id: approvals.tenantId, path: tenants.path, n: sql<number>`count(*)::int` })
          .from(approvals)
          .innerJoin(tenants, eq(tenants.id, approvals.tenantId))
          .where(and(scope, only(canRuns), eq(approvals.status, 'pending')))
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
          .where(and(scope, only(canCosts), eq(costLedger.month, month)))
          .groupBy(costLedger.tenantId, tenants.path),
      ),
    ]);
    const usd = (micros: number) => micros / MICROS_PER_USD;
    return (node) => ({
      agents: agentCount && may(canAgents, node.id) ? (agentCount.own.get(node.id) ?? 0) : null,
      agentsSubtree:
        agentCount && may(canAgents, node.id) ? (agentCount.sub.get(node.id) ?? 0) : null,
      runs30d: runCount && may(canRuns, node.id) ? (runCount.own.get(node.id) ?? 0) : null,
      pendingApprovals:
        approvalCount && may(canRuns, node.id) ? (approvalCount.own.get(node.id) ?? 0) : null,
      spendMonthUsd: spend && may(canCosts, node.id) ? usd(spend.own.get(node.id) ?? 0) : null,
      spendMonthSubtreeUsd:
        spend && may(canCosts, node.id) ? usd(spend.sub.get(node.id) ?? 0) : null,
      capUsd:
        may(canCosts, node.id) && node.monthlyBudgetMicros !== null
          ? usd(node.monthlyBudgetMicros)
          : null,
      capSource: may(canCosts, node.id) && node.monthlyBudgetMicros !== null ? 'tenant' : null,
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
