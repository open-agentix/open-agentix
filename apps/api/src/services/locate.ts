import {
  hasPermission,
  hasPermissionIn,
  type Permission,
  type Principal,
  type RoleBinding,
} from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { agents, approvals, connections, eventSources, runs } from '../db/schema.js';
import { notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import { TenantAccess, type TenantReach } from './tenant-access.js';
import { TenantTree } from './tenant-tree.js';

/**
 * `GET /v1/locate/{kind}/{id}` (ADR 0014 section 12, slice S7; UX A9, #163): which tenant owns a
 * resource, so a console that acts in another tenant can switch to it for a deep link.
 *
 * The answer is `{ id, slugPath, name }` of the owning node, and only when the caller holds the
 * kind's **read permission at that node** (the resolver bindings there, token scopes applied, team
 * and agent scoped bindings honoured): seeing a node is not enough to learn that a run exists in it.
 * Everything else is one and the same `404 resource not found`:
 *
 *   an id that does not exist, a resource of a sibling or cousin node, of an ancestor, of another
 *   organisation, of a visible node where the caller lacks the permission, a token scope that
 *   removes the permission, a kind that needs a permission the principal does not have.
 *
 * Constant work: every request, whatever the outcome, runs the same statements in the same order
 * (the resource row by primary key, the home node, the node row of the answer or of the home node
 * as a stand-in, and the audit decision), so neither the status, the body, the headers nor the
 * number of queries separate those cases. The owner is compared in memory against the tree
 * snapshot of the caller's own organisation, never looked up by a caller-chosen reference.
 *
 * The response never contains resource data (no name, status or content), only the owning node.
 */
export const LOCATE_KINDS = ['agent', 'run', 'approval', 'event-source', 'connection'] as const;
export type LocateKind = (typeof LOCATE_KINDS)[number];

/** The read permission each kind needs at its owning node. */
const PERMISSION: Record<LocateKind, Permission> = {
  agent: 'agents:read',
  run: 'runs:read',
  // Approvals are read with `runs:read` (the list route), decided with `runs:approve`.
  approval: 'runs:read',
  'event-source': 'sources:read',
  connection: 'connections:read',
};

/** What the lookup of one resource returns: its node and the team and agent scoping, nothing else. */
interface Owner {
  tenantId: string;
  teamId: string | null | undefined;
  agentId: string | null | undefined;
  /** The use case of the resource's agent (use-case bindings of the caller apply to it). */
  useCase?: string | null | undefined;
  /** Node-wide resources (no team or agent scoping) are checked without a resource scope. */
  nodeWide: boolean;
}

export interface LocatedTenant {
  id: string;
  slugPath: string;
  name: string;
}

/** Audited denials per principal and kind within one window; further misses are not written. */
export const LOCATE_AUDIT_MAX = 3;
export const LOCATE_AUDIT_WINDOW_MS = 60_000;

export class LocateService {
  private readonly access: TenantAccess;
  private readonly tree: TenantTree;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {
    this.access = new TenantAccess(ctx);
    this.tree = new TenantTree(ctx);
  }

  async locate(p: Principal, kind: LocateKind, id: string): Promise<LocatedTenant> {
    const permission = PERMISSION[kind];
    const reach = await this.access.reach(p);
    const owner = await this.owner(kind, id);
    const bindings = owner && reach ? this.bindingsAt(p, reach, owner.tenantId) : undefined;
    const allowed =
      owner !== undefined &&
      bindings !== undefined &&
      (owner.nodeWide
        ? hasPermission({ ...p, bindings }, permission)
        : hasPermissionIn({ ...p, bindings }, permission, {
            teamId: owner.teamId,
            agentId: owner.agentId,
            useCase: owner.useCase,
          }));
    // The node row (the name) is read on every path: the owner when the caller may know it, the
    // caller's own home node as a stand-in otherwise, so the statements do not depend on the outcome.
    const standIn = reach && reach.kind !== 'all' ? reach.home.id : p.tenantId;
    const row = await this.tree.node(allowed ? owner.tenantId : standIn);
    const slugPath = row ? await this.slugPath(reach, row) : undefined;
    if (allowed && row && slugPath !== undefined) return { id: row.id, slugPath, name: row.name };
    await this.auditMiss(p, kind, id, permission);
    throw notFound('resource');
  }

  /** The bindings the principal holds at `tenantId`, or undefined when the node is out of reach. */
  private bindingsAt(
    p: Principal,
    reach: TenantReach,
    tenantId: string,
  ): RoleBinding[] | undefined {
    switch (reach.kind) {
      case 'all':
        // Platform operators act with the roles of their home node everywhere (ADR 0014 S2).
        return p.bindings;
      case 'node':
        // p.bindings are those of the acting node: they stand for the home node only while acting there.
        return tenantId === reach.home.id && p.tenantId === reach.home.id ? p.bindings : undefined;
      case 'nodes': {
        const node = reach.snapshot.byId.get(tenantId);
        return node && reach.ids.has(node.id) ? reach.appliedAt(node) : undefined;
      }
    }
  }

  private async slugPath(
    reach: TenantReach | undefined,
    row: Awaited<ReturnType<TenantTree['node']>> & object,
  ): Promise<string | undefined> {
    if (reach?.kind === 'nodes') return reach.snapshot.slugPath(row.id);
    return (await this.tree.slugPaths([row])).get(row.id);
  }

  /** One primary-key read per kind, selecting only the node and the scoping columns. */
  private async owner(kind: LocateKind, id: string): Promise<Owner | undefined> {
    const db = this.ctx.db;
    switch (kind) {
      case 'agent': {
        const [r] = await db
          .select({ tenantId: agents.tenantId, teamId: agents.teamId, useCase: agents.useCase })
          .from(agents)
          .where(eq(agents.id, id));
        return (
          r && {
            tenantId: r.tenantId,
            teamId: r.teamId,
            agentId: id,
            useCase: r.useCase,
            nodeWide: false,
          }
        );
      }
      case 'run': {
        const [r] = await db
          .select({
            tenantId: runs.tenantId,
            teamId: runs.teamId,
            agentId: runs.agentId,
            useCase: agents.useCase,
          })
          .from(runs)
          .leftJoin(agents, eq(agents.id, runs.agentId))
          .where(eq(runs.id, id));
        return r && { ...r, nodeWide: false };
      }
      case 'approval': {
        // The agent scope of an approval goes through its run, as in the approvals list.
        const [r] = await db
          .select({
            tenantId: approvals.tenantId,
            teamId: approvals.teamId,
            agentId: runs.agentId,
            useCase: agents.useCase,
          })
          .from(approvals)
          .leftJoin(runs, eq(runs.id, approvals.runId))
          .leftJoin(agents, eq(agents.id, runs.agentId))
          .where(eq(approvals.id, id));
        return r && { ...r, nodeWide: false };
      }
      case 'event-source': {
        const [r] = await db
          .select({ tenantId: eventSources.tenantId })
          .from(eventSources)
          .where(eq(eventSources.id, id));
        return r && { tenantId: r.tenantId, teamId: null, agentId: null, nodeWide: true };
      }
      case 'connection': {
        const [r] = await db
          .select({ tenantId: connections.tenantId })
          .from(connections)
          .where(eq(connections.id, id));
        return r && { tenantId: r.tenantId, teamId: null, agentId: null, nodeWide: true };
      }
    }
  }

  /**
   * `access.denied` for a miss, in the partition of the caller's acting node. Written for every
   * miss, existing or not (the decision never looks at the outcome of the lookup), at most
   * {@link LOCATE_AUDIT_MAX} per principal and kind per {@link LOCATE_AUDIT_WINDOW_MS}, so probing
   * cannot flood the chain. The entry names the requested id and the kind, never the owner. A
   * failing audit write must not turn the 404 into a 500 (which would be an oracle of its own).
   */
  private async auditMiss(
    p: Principal,
    kind: LocateKind,
    id: string,
    permission: Permission,
  ): Promise<void> {
    try {
      const key = `locate-denied:${p.userId}:${kind}`;
      const now = this.ctx.now().getTime();
      const state = await this.ctx.cache.get<{ n: number; until: number }>(key);
      const live =
        state && state.until > now ? state : { n: 0, until: now + LOCATE_AUDIT_WINDOW_MS };
      if (live.n >= LOCATE_AUDIT_MAX) return;
      await this.ctx.cache.set(key, { n: live.n + 1, until: live.until }, live.until - now);
      await this.audit.append({
        actor: p.userId,
        tenantId: p.tenantId,
        action: 'access.denied',
        target: id,
        payload: { permission, resource: kind, via: 'locate' },
      });
    } catch (err) {
      this.ctx.logger.warn({ err }, 'locate: access.denied audit failed');
    }
  }
}
