import { randomUUID } from 'node:crypto';
import {
  OaxError,
  parseSecretRefPatterns,
  placeNode,
  slugsCollide,
  subtreePrefix,
  type Principal,
} from '@openagentix/core';
import { count, eq, like, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { tenants } from '../db/schema.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { TenantAccess } from './tenant-access.js';
import { TenantTree } from './tenant-tree.js';
import { TenantViews } from './tenant-views.js';
import type { AuditService } from './audit.js';
import type { IdentityService, TenantRow } from './identity.js';

export type { TenantRow };

/** Advisory lock key serialising tenant creation (slug overlap check, node limit). */
const TENANT_CREATE_LOCK = 734_203;

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.cause?.code ?? err.code;
}

/** Tenants: the isolation boundary. Only platform operators create or change them. */
export class TenantsService {
  /** Structural tree queries (ancestors, descendants, slug paths); no permission checks. */
  readonly tree: TenantTree;
  /** Read models for the console: acting context, visible tree, search. */
  readonly views: TenantViews;
  private readonly access: TenantAccess;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
  ) {
    this.tree = new TenantTree(ctx);
    this.views = new TenantViews(ctx);
    this.access = new TenantAccess(ctx);
  }

  private assertOperator(p: Principal): void {
    if (!p.platformAdmin) throw forbidden('platform operator access required');
  }

  /**
   * The tenants the principal may see and act in ({@link TenantAccess.reach}): platform operators
   * every tenant, everybody else only their own until bindings can inherit (ADR 0014).
   */
  async list(p: Principal): Promise<TenantRow[]> {
    const reach = await this.access.reach(p);
    if (!reach) return [];
    const scope =
      reach.kind === 'all'
        ? undefined
        : reach.kind === 'subtree'
          ? like(tenants.path, subtreePrefix(reach.home.path))
          : eq(tenants.id, reach.home.id);
    return this.ctx.db.select().from(tenants).where(scope).orderBy(tenants.slug);
  }

  /** A node inside the principal's reach; any other node is a plain 404. */
  async get(p: Principal, id: string): Promise<TenantRow> {
    const [row] = await this.ctx.db.select().from(tenants).where(eq(tenants.id, id));
    if (!row || !TenantAccess.allows(await this.access.reach(p), row)) throw notFound('tenant');
    return row;
  }

  /**
   * Slug path of a tenant for the `X-OAX-Acting-Tenant` header of every authenticated response.
   * Cached for 30 s (the placement of a node is fixed today; moves, W13-11, may show the old path
   * for that long in this informational header only).
   */
  async actingSlugPath(tenantId: string): Promise<string | undefined> {
    const key = `tenant-slug-path:${tenantId}`;
    const hit = await this.ctx.cache.get<string>(key);
    if (hit) return hit;
    const node = await this.tree.node(tenantId);
    if (!node) return undefined;
    const slugPath = (await this.tree.slugPaths([node])).get(node.id)!;
    await this.ctx.cache.set(key, slugPath, 30_000);
    return slugPath;
  }

  /** Id of the organisation (root tenant) a tenant belongs to; telemetry identifies it by id only. */
  async rootIdOf(tenantId: string): Promise<string | undefined> {
    return (await this.tree.node(tenantId))?.rootId;
  }

  /** `acme/security/blue` for every row, one lookup for all ancestors. */
  slugPaths(rows: TenantRow[]): Promise<Map<string, string>> {
    return this.tree.slugPaths(rows);
  }

  /** Creates an organisation (root tenant) and, optionally, its first local administrator. */
  async create(
    p: Principal,
    input: {
      slug: string;
      name: string;
      monthlyBudgetUsd?: number | undefined;
      admin?: { email: string; displayName: string; password: string } | undefined;
      /** Fixed id (the deterministic demo seed); random when omitted. */
      id?: string | undefined;
    },
  ): Promise<TenantRow> {
    return this.insert(p, null, input);
  }

  /**
   * Creates a sub-tenant below `parentId` (ADR 0013). Service layer only: there is deliberately no
   * HTTP route yet, because budget caps, inherited settings and roles of the tree arrive with
   * W13-2, W13-4 and W13-6. Refuses a missing parent, a cycle, a depth above the configured
   * maximum (`422 tenant_depth_exceeded`) and more nodes than allowed per organisation.
   */
  async createChild(
    p: Principal,
    parentId: string,
    input: {
      slug: string;
      name: string;
      monthlyBudgetUsd?: number | undefined;
      /** Fixed id (the deterministic demo seed); random when omitted. */
      id?: string | undefined;
    },
  ): Promise<TenantRow> {
    this.assertOperator(p);
    const parent = await this.tree.node(parentId);
    if (!parent) throw notFound('tenant');
    return this.insert(p, parent, input);
  }

  private async insert(
    p: Principal,
    parent: TenantRow | null,
    input: {
      slug: string;
      name: string;
      monthlyBudgetUsd?: number | undefined;
      admin?: { email: string; displayName: string; password: string } | undefined;
      id?: string | undefined;
    },
  ): Promise<TenantRow> {
    this.assertOperator(p);
    const { maxDepth, maxNodesPerRoot } = this.ctx.config.tenancy;
    const id = input.id ?? randomUUID();
    const placement = parent ? placeNode(id, parent, maxDepth) : placeNode(id, null, maxDepth);
    const row = await this.ctx.db
      .transaction(async (t) => {
        const tx = t as unknown as Db;
        // One writer at a time per creation: the slug overlap check and the node limit read what
        // the insert changes. The lock is held until commit (also on PGlite, which serialises
        // transactions anyway). The unique index on `slug` stays as the database-level backstop.
        await tx.execute(sql`select pg_advisory_xact_lock(${TENANT_CREATE_LOCK})`);
        if (parent) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${parent.rootId}))`);
        }
        // Until secret names are node-aware (W13-7) slugs must not overlap anywhere in the
        // installation: `acme.corp.x` and `acme-corp.x` are the same secret for the resolver, so
        // tenants whose slugs overlap in canonical form could read each other's secrets and cannot
        // coexist. This also covers the same slug twice.
        const clash = (await tx.select({ slug: tenants.slug }).from(tenants)).find((x) =>
          slugsCollide(x.slug, input.slug),
        );
        if (clash)
          throw clash.slug === input.slug
            ? conflict(`tenant ${input.slug} already exists`)
            : conflict(
                `tenant slug ${input.slug} overlaps with ${clash.slug} in secret names (a. b-c and a-b.c are the same secret)`,
              );
        if (parent) {
          const [size] = await tx
            .select({ n: count() })
            .from(tenants)
            .where(eq(tenants.rootId, parent.rootId));
          if (Number(size?.n ?? 0) >= maxNodesPerRoot)
            throw new OaxError(
              'tenant_node_limit_exceeded',
              `an organisation can have at most ${maxNodesPerRoot} tenants`,
            );
        }
        const [inserted] = await tx
          .insert(tenants)
          .values({
            id,
            slug: input.slug,
            name: input.name,
            ...placement,
            monthlyBudgetMicros:
              input.monthlyBudgetUsd === undefined
                ? null
                : Math.round(input.monthlyBudgetUsd * 1e6),
          })
          .returning();
        await this.audit.append(
          {
            actor: p.userId,
            tenantId: inserted!.id,
            action: 'tenant.created',
            target: inserted!.id,
            payload: {
              slug: input.slug,
              name: input.name,
              ...(parent ? { parentId: parent.id, depth: placement.depth } : {}),
            },
          },
          tx,
        );
        return inserted!;
      })
      .catch((e: unknown) => {
        // Backstop: the global slug index fired although the check passed (a writer that bypassed
        // the lock, e.g. another process version).
        if (pgCode(e) === '23505') throw conflict(`tenant ${input.slug} already exists`);
        throw e;
      });
    if ('admin' in input && input.admin)
      await this.identity.createLocalUser(
        { userId: p.userId, tenantId: row.id },
        { ...input.admin, globalRoles: ['admin'] },
      );
    return row!;
  }

  async update(
    p: Principal,
    id: string,
    patch: {
      name?: string | undefined;
      monthlyBudgetUsd?: number | null | undefined;
      secretRefs?: string[] | undefined;
    },
  ): Promise<TenantRow> {
    this.assertOperator(p);
    await this.get(p, id);
    const set: Partial<TenantRow> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.monthlyBudgetUsd !== undefined)
      set.monthlyBudgetMicros =
        patch.monthlyBudgetUsd === null ? null : Math.round(patch.monthlyBudgetUsd * 1e6);
    if (patch.secretRefs !== undefined) {
      try {
        set.secretRefs = parseSecretRefPatterns(patch.secretRefs);
      } catch (e) {
        throw new HttpError(400, 'validation_failed', (e as Error).message);
      }
    }
    const [row] = await this.ctx.db.update(tenants).set(set).where(eq(tenants.id, id)).returning();
    await this.audit.append({
      actor: p.userId,
      tenantId: id,
      action: 'tenant.updated',
      target: id,
      payload: patch,
    });
    return row!;
  }
}
