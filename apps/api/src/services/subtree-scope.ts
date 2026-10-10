import {
  hasPermission,
  subtreePrefix,
  visibleAgents,
  visibleTeams,
  type Permission,
  type Principal,
} from '@openagentix/core';
import { createHash } from 'node:crypto';
import { and, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { AppContext } from '../context.js';
import { tenants } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { TenantRow } from './identity.js';
import { TenantAccess } from './tenant-access.js';
import { TenantTree } from './tenant-tree.js';

/**
 * `?scope=subtree` on the list routes (ADR 0014 section 3.5).
 *
 * The request names the acting node N (`X-OAX-Tenant`) and, for every node D of `subtree(N)` the
 * caller can see, the resolver gives the bindings the caller holds at D. One predicate is built
 * from that on the server; the client never supplies a node list. `?tenantId=` can only narrow it.
 * Ancestors, siblings and other organisations never take part: the candidates are the nodes of the
 * caller's reach that lie in the subtree of N.
 */
export type ListScope = 'node' | 'subtree';

export interface SubtreeParams {
  scope?: ListScope | undefined;
  /** Narrowing inside the subtree: a node id, a slug path or a bare slug. */
  tenantId?: string | undefined;
}

/** What a principal may read on one node for one permission. */
export interface NodeGrant {
  /** `'all'`: the whole node; otherwise the teams whose resources are readable. */
  teams: 'all' | readonly string[];
  /** Agents readable through agent-scoped bindings only. */
  agents: readonly string[];
}

/** The tenant a row belongs to, as returned on rows of subtree lists. */
export interface TenantRef {
  id: string;
  slug: string;
  slugPath: string;
  name: string;
}

/** Columns a predicate is applied to. Without `teamId` the resource is node-wide. */
export interface ScopeColumns {
  tenantId: PgColumn;
  teamId?: PgColumn;
  /** Restriction to the given agent ids (a column, or a builder for indirect references). */
  agent?: PgColumn | ((agentIds: string[]) => SQL);
}

/** The outcome of resolving one request: which nodes, with what read scope. */
export class ResolvedScope {
  constructor(private readonly grants: ReadonlyMap<string, NodeGrant>) {}

  get isEmpty(): boolean {
    return this.grants.size === 0;
  }

  get size(): number {
    return this.grants.size;
  }

  hasNode(id: string): boolean {
    return this.grants.has(id);
  }

  /** Ids of the nodes where the permission is held (in any scope). */
  nodeIds(): string[] {
    return [...this.grants.keys()];
  }

  /** In-memory twin of {@link predicate}, for rows that are already loaded. */
  allows(row: { tenantId: string; teamId?: string | null; agentId?: string | null }): boolean {
    const g = this.grants.get(row.tenantId);
    if (!g) return false;
    if (g.teams === 'all') return true;
    return (
      (typeof row.teamId === 'string' && g.teams.includes(row.teamId)) ||
      (typeof row.agentId === 'string' && g.agents.includes(row.agentId))
    );
  }

  /** `tenant_id in (nodes)`: for resources the permission covers node-wide. */
  nodePredicate(tenantId: PgColumn): SQL {
    return this.grants.size === 0 ? sql`false` : inArray(tenantId, this.nodeIds());
  }

  /**
   * The row filter of ADR 0014 3.5: nodes with an unscoped binding in one `= any(...)`, nodes with
   * team or agent scoped bindings one clause each, so a team id can never open rows of another node.
   */
  predicate(cols: ScopeColumns): SQL {
    const parts: SQL[] = [];
    const whole: string[] = [];
    for (const [id, g] of this.grants) {
      if (g.teams === 'all') {
        whole.push(id);
        continue;
      }
      const inner = or(
        cols.teamId && g.teams.length > 0 ? inArray(cols.teamId, [...g.teams]) : undefined,
        cols.agent && g.agents.length > 0
          ? typeof cols.agent === 'function'
            ? cols.agent([...g.agents])
            : inArray(cols.agent, [...g.agents])
          : undefined,
      );
      if (inner) parts.push(and(eq(cols.tenantId, id), inner)!);
    }
    if (whole.length > 0) parts.unshift(inArray(cols.tenantId, whole));
    return parts.length === 0 ? sql`false` : (or(...parts) as SQL);
  }

  /** Stable digest of what the scope allows (cache keys of aggregates). */
  digest(): string {
    const h = createHash('sha256');
    for (const id of [...this.grants.keys()].sort()) {
      const g = this.grants.get(id)!;
      h.update(
        `${id}|${g.teams === 'all' ? '*' : [...g.teams].sort().join(',')}|${[...g.agents].sort().join(',')};`,
      );
    }
    return h.digest('hex').slice(0, 32);
  }
}

const MAX_REF_LENGTH = 2048;

/** Builds {@link ResolvedScope}s from the reach of a principal; the only place that decides it. */
export class SubtreeScopes {
  private readonly access: TenantAccess;
  private readonly tree: TenantTree;

  constructor(private readonly ctx: AppContext) {
    this.access = new TenantAccess(ctx);
    this.tree = new TenantTree(ctx);
  }

  /**
   * `undefined` for the default (`scope=node`): callers keep their unchanged single-node path.
   * With `scope=subtree` the scope may be empty (nothing readable); a `tenantId` that is not a
   * visible node of the subtree is the same 404 as a node that does not exist.
   */
  async resolve(
    p: Principal,
    permission: Permission,
    params: SubtreeParams,
  ): Promise<ResolvedScope | undefined> {
    return (await this.resolveMany(p, [permission], params))?.[0];
  }

  /** {@link resolve} for several permissions at once (the nodes are evaluated a single time). */
  async resolveMany(
    p: Principal,
    permissions: readonly Permission[],
    params: SubtreeParams,
  ): Promise<ResolvedScope[] | undefined> {
    if (params.scope !== 'subtree') {
      if (params.tenantId !== undefined)
        throw new HttpError(400, 'validation_failed', 'tenantId needs scope=subtree');
      return undefined;
    }
    const reach = await this.access.reach(p);
    if (!reach) return permissions.map(() => new ResolvedScope(new Map()));
    const candidates = await this.candidates(p, reach);
    const only = await this.narrow(p, params.tenantId, candidates);
    const cap = this.ctx.config.tenancy.maxNodesPerRoot;
    return permissions.map((permission) => {
      const grants = new Map<string, NodeGrant>();
      for (const c of candidates) {
        if (only && c.id !== only) continue;
        const g = grantOf({ ...p, bindings: c.bindings }, permission);
        if (g) grants.set(c.id, g);
      }
      if (grants.size > cap)
        throw new HttpError(
          422,
          'subtree_too_large',
          `the subtree has more than ${cap} readable nodes; narrow it with tenantId`,
        );
      return new ResolvedScope(grants);
    });
  }

  /** The visible nodes of the subtree of the acting node, each with the bindings held there. */
  private async candidates(
    p: Principal,
    reach: NonNullable<Awaited<ReturnType<TenantAccess['reach']>>>,
  ): Promise<{ id: string; bindings: Principal['bindings'] }[]> {
    const cap = this.ctx.config.tenancy.maxNodesPerRoot;
    if (reach.kind === 'nodes') {
      const acting = reach.snapshot.byId.get(p.tenantId);
      if (!acting || !reach.ids.has(acting.id)) return [];
      // A node path ends with "/", so a prefix match is exactly "the node and everything below".
      return reach.snapshot.nodes
        .filter((n) => reach.ids.has(n.id) && n.path.startsWith(acting.path))
        .map((n) => ({ id: n.id, bindings: reach.appliedAt(n) }));
    }
    if (reach.kind === 'node') return p.tenantId === reach.home.id ? [this.own(p, reach.home)] : [];
    // Platform operators: the subtree of the acting node, with the roles they act with there.
    const acting = await this.tree.node(p.tenantId);
    if (!acting) return [];
    const rows = await this.ctx.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(like(tenants.path, subtreePrefix(acting.path)))
      .limit(cap + 1);
    if (rows.length > cap)
      throw new HttpError(
        422,
        'subtree_too_large',
        `the subtree has more than ${cap} nodes; narrow it with tenantId`,
      );
    return rows.map((r) => ({ id: r.id, bindings: p.bindings }));
  }

  private own(p: Principal, node: TenantRow) {
    return { id: node.id, bindings: p.bindings };
  }

  /** The node `tenantId` names, if it is a candidate; unknown and invisible are the same 404. */
  private async narrow(
    p: Principal,
    ref: string | undefined,
    candidates: { id: string }[],
  ): Promise<string | undefined> {
    if (ref === undefined) return undefined;
    if (ref.length === 0 || ref.length > MAX_REF_LENGTH) throw notFound('tenant');
    const row = await this.access.resolveVisible(p, ref);
    if (!row || !candidates.some((c) => c.id === row.id)) throw notFound('tenant');
    return row.id;
  }

  /**
   * Names and slug paths for the tenants of a page of rows. Only ids inside the scope are
   * described, so a row can never name a node the caller may not read.
   */
  async refsFor(
    scope: ResolvedScope,
    tenantIds: Iterable<string>,
  ): Promise<Map<string, TenantRef>> {
    const allowed = new Set(scope.nodeIds());
    const ids = [...new Set(tenantIds)].filter((id) => allowed.has(id));
    const out = new Map<string, TenantRef>();
    if (ids.length === 0) return out;
    const rows = await this.ctx.db.select().from(tenants).where(inArray(tenants.id, ids));
    const paths = await this.tree.slugPaths(rows);
    for (const r of rows)
      out.set(r.id, { id: r.id, slug: r.slug, slugPath: paths.get(r.id)!, name: r.name });
    return out;
  }
}

/** The read scope of a principal on one node; `undefined` when it may read nothing there. */
function grantOf(p: Principal, permission: Permission): NodeGrant | undefined {
  if (!hasPermission(p, permission)) return undefined;
  const teams = visibleTeams(p, permission);
  const agents = visibleAgents(p, permission);
  if (Array.isArray(teams) && teams.length === 0 && agents.length === 0) return undefined;
  return { teams, agents };
}
