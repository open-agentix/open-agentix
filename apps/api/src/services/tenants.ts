import { randomUUID } from 'node:crypto';
import { parseSecretRefPatterns, type Principal } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { tenants } from '../db/schema.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import type { IdentityService, TenantRow } from './identity.js';

export type { TenantRow };

/** Tenants: the isolation boundary. Only platform operators create or change them. */
export class TenantsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
  ) {}

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

  /** Creates a tenant and, optionally, its first local administrator. */
  async create(
    p: Principal,
    input: {
      slug: string;
      name: string;
      monthlyBudgetUsd?: number | undefined;
      admin?: { email: string; displayName: string; password: string } | undefined;
    },
  ): Promise<TenantRow> {
    this.assertOperator(p);
    const [exists] = await this.ctx.db.select().from(tenants).where(eq(tenants.slug, input.slug));
    if (exists) throw conflict(`tenant ${input.slug} already exists`);
    const [row] = await this.ctx.db
      .insert(tenants)
      .values({
        id: randomUUID(),
        slug: input.slug,
        name: input.name,
        monthlyBudgetMicros:
          input.monthlyBudgetUsd === undefined ? null : Math.round(input.monthlyBudgetUsd * 1e6),
      })
      .returning();
    await this.audit.append({
      actor: p.userId,
      tenantId: row!.id,
      action: 'tenant.created',
      target: row!.id,
      payload: { slug: input.slug, name: input.name },
    });
    if (input.admin)
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
