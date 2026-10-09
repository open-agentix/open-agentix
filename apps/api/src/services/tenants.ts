import { randomUUID } from 'node:crypto';
import {
  OaxError,
  parseSecretRefPatterns,
  placeNode,
  slugsCollide,
  type Principal,
} from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { tenants } from '../db/schema.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { TenantTree } from './tenant-tree.js';
import type { AuditService } from './audit.js';
import type { IdentityService, TenantRow } from './identity.js';

export type { TenantRow };

/** Tenants: the isolation boundary. Only platform operators create or change them. */
export class TenantsService {
  /** Structural tree queries (ancestors, descendants, slug paths); no permission checks. */
  readonly tree: TenantTree;

  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
  ) {
    this.tree = new TenantTree(ctx);
  }

  private assertOperator(p: Principal): void {
    if (!p.platformAdmin) throw forbidden('platform operator access required');
  }

  /** Platform operators see every tenant, everybody else only their own. */
  async list(p: Principal): Promise<TenantRow[]> {
    const rows = await this.ctx.db.select().from(tenants).orderBy(tenants.slug);
    return p.platformAdmin ? rows : rows.filter((t) => t.id === p.tenantId);
  }

  async get(p: Principal, id: string): Promise<TenantRow> {
    const [row] = await this.ctx.db.select().from(tenants).where(eq(tenants.id, id));
    if (!row || (!p.platformAdmin && row.id !== p.tenantId)) throw notFound('tenant');
    return row;
  }

  /** Creates an organisation (root tenant) and, optionally, its first local administrator. */
  async create(
    p: Principal,
    input: {
      slug: string;
      name: string;
      monthlyBudgetUsd?: number | undefined;
      admin?: { email: string; displayName: string; password: string } | undefined;
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
    input: { slug: string; name: string; monthlyBudgetUsd?: number | undefined },
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
    },
  ): Promise<TenantRow> {
    this.assertOperator(p);
    const { maxDepth, maxNodesPerRoot } = this.ctx.config.tenancy;
    // Until secret names are node-aware (W13-7) slugs must not overlap anywhere in the installation:
    // `acme.corp.x` and `acme-corp.x` are the same secret for the resolver, so tenants whose slugs
    // overlap in canonical form could read each other's secrets and cannot coexist. This also
    // covers the same slug twice (stricter than "unique among siblings", which the database keeps).
    const clash = (await this.ctx.db.select({ slug: tenants.slug }).from(tenants)).find((t) =>
      slugsCollide(t.slug, input.slug),
    );
    if (clash)
      throw clash.slug === input.slug
        ? conflict(`tenant ${input.slug} already exists`)
        : conflict(
            `tenant slug ${input.slug} overlaps with ${clash.slug} in secret names (a. b-c and a-b.c are the same secret)`,
          );
    if (parent && (await this.tree.sizeOf(parent.rootId)) >= maxNodesPerRoot)
      throw new OaxError(
        'tenant_node_limit_exceeded',
        `an organisation can have at most ${maxNodesPerRoot} tenants`,
      );
    const id = randomUUID();
    const placement = parent ? placeNode(id, parent, maxDepth) : placeNode(id, null, maxDepth);
    const [row] = await this.ctx.db
      .insert(tenants)
      .values({
        id,
        slug: input.slug,
        name: input.name,
        ...placement,
        monthlyBudgetMicros:
          input.monthlyBudgetUsd === undefined ? null : Math.round(input.monthlyBudgetUsd * 1e6),
      })
      .returning();
    await this.audit.append({
      actor: p.userId,
      tenantId: row!.id,
      action: 'tenant.created',
      target: row!.id,
      payload: {
        slug: input.slug,
        name: input.name,
        ...(parent ? { parentId: parent.id, depth: placement.depth } : {}),
      },
    });
    if ('admin' in input && input.admin)
      await this.identity.createLocalUser(
        { userId: p.userId, tenantId: row!.id },
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
