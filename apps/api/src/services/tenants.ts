import { randomUUID } from 'node:crypto';
import {
  OaxError,
  canonicalSecretRef,
  hasPermission,
  isValidUseCase,
  parseSecretRefPatterns,
  placeNode,
  slugsCollide,
  type Principal,
} from '@openagentix/core';
import { count, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { tenants } from '../db/schema.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import {
  isInheritingAdminAt,
  loadActor,
  notInheritingError,
  type Actor,
} from './grant-authority.js';
import { TenantAccess } from './tenant-access.js';
import { TenantTree } from './tenant-tree.js';
import { TenantViews } from './tenant-views.js';
import { assertNoCapAbove } from './budget-cap-guard.js';
import { lockBindings, lockTreeShared } from './tree-lock.js';
import type { AuditService } from './audit.js';
import type { IdentityService, TenantRow } from './identity.js';

export type { TenantRow };

/** Advisory lock key serialising tenant creation (slug overlap check, node limit). */
const TENANT_CREATE_LOCK = 734_203;

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.cause?.code ?? err.code;
}

/** Who authorised a tenant creation; recorded in the `tenant.created` audit entry. */
type CreateAuthority = 'platform' | 'inheriting_admin';

/** Runs inside the creation transaction, after the locks, with the parent re-read. */
type Authorize = (tx: Db, parent: TenantRow | null) => Promise<void>;

interface CreateInput {
  slug: string;
  name: string;
  monthlyBudgetUsd?: number | undefined;
  admin?: { email: string; displayName: string; password: string } | undefined;
  /** Fixed id (the deterministic demo seed); random when omitted. */
  id?: string | undefined;
}

const platformOnly = () => forbidden('platform operator access required');

/**
 * Tenants: the isolation boundary. Platform operators create organisations and change any tenant.
 * With `OAX_ROLE_BINDINGS_READ=bindings` (ADR 0014 S5) a tenant admin who inherits (an `admin`
 * binding with `inherit` on the parent or an ancestor) also creates sub-tenants and renames the
 * nodes it covers. Both are decided on the node the request
 * names (the parent, the renamed node), from grants re-read inside the transaction, never on the
 * acting node.
 */
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
   * every tenant, everybody else their own node, plus (read path `bindings`, ADR 0014 S2) every
   * node where the resolver gives them a permission.
   */
  async list(p: Principal): Promise<TenantRow[]> {
    const reach = await this.access.reach(p);
    if (!reach) return [];
    const scope =
      reach.kind === 'all'
        ? undefined
        : reach.kind === 'nodes'
          ? inArray(tenants.id, [...reach.ids])
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
   * Cached for 30 s (a move clears the entry; other replicas may show the old path
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

  /**
   * `POST /v1/tenants`. Platform operators (with `settings:write`) create organisations and
   * sub-tenants anywhere. Everybody else creates sub-tenants only: see {@link createAsAdmin}.
   */
  async createFromRequest(p: Principal, input: CreateInput & { parentId?: string | undefined }) {
    const { parentId, ...rest } = input;
    if (p.platformAdmin) {
      if (!hasPermission(p, 'settings:write')) throw forbidden();
      return parentId ? this.createChild(p, parentId, rest) : this.create(p, rest);
    }
    return this.createAsAdmin(p, parentId, rest);
  }

  /** Creates an organisation (root tenant) and, optionally, its first local administrator. */
  async create(p: Principal, input: CreateInput): Promise<TenantRow> {
    this.assertOperator(p);
    return this.insert(p, null, input, 'platform');
  }

  /**
   * Creates a sub-tenant below `parentId` (ADR 0013), as a platform operator. Refuses a missing
   * parent, a cycle, a depth above the configured maximum (`422 tenant_depth_exceeded`) and more
   * nodes than allowed per organisation (`tenant_node_limit_exceeded`).
   */
  async createChild(p: Principal, parentId: string, input: CreateInput): Promise<TenantRow> {
    this.assertOperator(p);
    const parent = await this.tree.node(parentId);
    if (!parent) throw notFound('tenant');
    return this.insert(p, parent, input, 'platform');
  }

  /**
   * A sub-tenant created by a tenant admin (ADR 0014 section 4.2, slice S5). Rules, in order:
   *
   * 1. Only with `OAX_ROLE_BINDINGS_READ=bindings` and only below a parent: organisations stay
   *    operator-only, and with the legacy read path nothing changes (`403`, as before).
   * 2. The first administrator and the budget are operator-only (`403`): creating users and
   *    setting ceilings are separate acts with their own rules.
   * 3. The parent must be visible to the caller, otherwise the same `404 tenant` as for an
   *    unknown id (the parent is named in the body, never taken from the acting node).
   * 4. Inside the transaction, with the tree lock held shared and the grants re-read: the caller
   *    needs an **inheriting** `admin` binding on the parent or an ancestor
   *    (`403 inheritance_required` when they are only a direct admin), so nobody creates a node
   *    they cannot administer. A token needs the `settings:write` scope.
   * 5. The same limits as for operators (depth, nodes per organisation, slug rules), with
   *    slug conflicts answered without naming the other node.
   */
  private async createAsAdmin(
    p: Principal,
    parentId: string | undefined,
    input: CreateInput,
  ): Promise<TenantRow> {
    if (this.ctx.config.auth.roleBindingsRead !== 'bindings' || !parentId) throw platformOnly();
    if (input.admin !== undefined || input.monthlyBudgetUsd !== undefined || input.id !== undefined)
      throw platformOnly();
    const parent = await this.get(p, parentId);
    const now = this.ctx.now();
    // Cheap pre-check from the cached grants, before any lock: a caller who is plainly not
    // allowed never queues on the installation-wide creation lock. The transaction decides again.
    if (p.grants) {
      const cached: Actor = {
        userId: p.userId,
        platformAdmin: false,
        raw: p.grants.raw,
        scopes: p.scopes,
      };
      if (!isInheritingAdminAt(cached, parent, now)) throw this.notInheriting(cached, parent, now);
    }
    return this.insert(p, parent, input, 'inheriting_admin', async (tx, current) => {
      const actor = await loadActor(tx, p);
      if (!isInheritingAdminAt(actor, current!, now))
        throw this.notInheriting(actor, current!, now);
    });
  }

  private notInheriting(actor: Actor, node: TenantRow, now: Date): HttpError {
    return notInheritingError(actor, node, now);
  }

  /**
   * Secrets are named `<slug>.*` and a tenant may use its own prefix (ADR 0013 section 3), so a
   * slug whose prefix already holds secrets, or that an operator reserved
   * (`OAX_TENANT_RESERVED_SLUGS`), cannot be claimed by a tenant admin.
   */
  private async slugReserved(slug: string): Promise<boolean> {
    const reserved = this.ctx.config.tenancy.reservedSlugs;
    if (reserved.some((r) => slugsCollide(r, slug))) return true;
    const prefix = `${canonicalSecretRef(slug)}_`;
    return (await this.ctx.secrets.hasEntriesUnder?.(prefix)) === true;
  }

  private async insert(
    p: Principal,
    parent: TenantRow | null,
    input: CreateInput,
    authority: CreateAuthority,
    authorize?: Authorize,
  ): Promise<TenantRow> {
    const { maxDepth, maxNodesPerRoot } = this.ctx.config.tenancy;
    const id = input.id ?? randomUUID();
    const row = await this.ctx.db
      .transaction(async (t) => {
        const tx = t as unknown as Db;
        // Lock order (tree-lock.ts): tree lock, authorisation, then the installation-wide creation
        // lock, so a caller who is not allowed never waits on the lock that serialises everybody.
        let current: TenantRow | null = null;
        if (parent) {
          await lockTreeShared(tx, parent.rootId);
          const [found] = await tx.select().from(tenants).where(eq(tenants.id, parent.id));
          if (!found) throw notFound('tenant');
          current = found;
        }
        if (authorize) await authorize(tx, current);
        // One writer at a time per creation: the node limit and the slug overlap check read what
        // the insert changes. Held until commit (PGlite serialises transactions anyway). The unique
        // index on `slug` stays as the database-level backstop.
        await tx.execute(sql`select pg_advisory_xact_lock(${TENANT_CREATE_LOCK})`);
        const placement = current
          ? placeNode(id, current, maxDepth)
          : placeNode(id, null, maxDepth);
        // Limits before the slug: a caller over a limit learns nothing about which slugs exist.
        if (current) {
          const [size] = await tx
            .select({ n: count() })
            .from(tenants)
            .where(eq(tenants.rootId, current.rootId));
          if (Number(size?.n ?? 0) >= maxNodesPerRoot)
            throw new OaxError(
              'tenant_node_limit_exceeded',
              `an organisation can have at most ${maxNodesPerRoot} tenants`,
            );
        }
        if (authority === 'inheriting_admin') await assertNoCapAbove(tx, current!);
        // Until secret names are node-aware (W13-7) slugs must not overlap anywhere in the
        // installation: `acme.corp.x` and `acme-corp.x` are the same secret for the resolver, so
        // tenants whose slugs overlap in canonical form could read each other's secrets and cannot
        // coexist. This also covers the same slug twice.
        const clash = (await tx.select({ slug: tenants.slug }).from(tenants)).find((x) =>
          slugsCollide(x.slug, input.slug),
        );
        if (clash) throw this.slugConflict(p, input.slug, clash.slug);
        if (authority === 'inheriting_admin' && (await this.slugReserved(input.slug)))
          throw this.slugConflict(p, input.slug);
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
        // The partition of the new node (names and ids only).
        await this.audit.append(
          {
            actor: p.userId,
            tenantId: inserted!.id,
            action: 'tenant.created',
            target: inserted!.id,
            payload: {
              slug: input.slug,
              name: input.name,
              authority,
              ...(current ? { parentId: current.id, depth: placement.depth } : {}),
            },
          },
          tx,
        );
        return inserted!;
      })
      .catch((e: unknown) => {
        // Backstop: the global slug index fired although the check passed (a writer that bypassed
        // the lock, e.g. another process version).
        if (pgCode(e) === '23505') throw this.slugConflict(p, input.slug);
        throw e;
      });
    if ('admin' in input && input.admin)
      await this.identity.createLocalUser(
        { userId: p.userId, tenantId: row.id },
        { ...input.admin, globalRoles: ['admin'] },
      );
    return row!;
  }

  /**
   * `409` for a slug that is taken or overlaps another one. Operators are told which slug clashes;
   * everybody else gets one message for both cases and never the name of a node they may not see
   * (the slug space is installation-wide until W13-7, so the fact that a slug is taken is the one
   * thing that cannot be hidden).
   */
  private slugConflict(p: Principal, slug: string, other?: string): HttpError {
    if (!p.platformAdmin) return conflict('this slug is not available');
    if (other === undefined || other === slug) return conflict(`tenant ${slug} already exists`);
    return conflict(
      `tenant slug ${slug} overlaps with ${other} in secret names (a. b-c and a-b.c are the same secret)`,
    );
  }

  /**
   * `PATCH /v1/tenants/{id}`. Platform operators (with `settings:write`) change any field. A tenant
   * admin renames a node (`name` only) where they hold an **inheriting** `admin` binding on the
   * node or an ancestor, with `OAX_ROLE_BINDINGS_READ=bindings` (so an installation that does not
   * use inheritance sees no change); the budget and the secret references stay operator-only. The
   * node is the one in the path, never the acting node.
   *
   * `useCase` attaches the node to a use case of its parent (or detaches it with `null`; ADR 0014
   * section 3.3, slice S8). That is a grant to every inheriting use-case administrator of that use
   * case, so it needs an **inheriting tenant admin on the parent** (a binding without use case, on
   * the parent or an ancestor) or a platform operator, evaluated on the parent from grants re-read
   * under the shared tree lock. A use-case administrator never attaches a node, not even to its own
   * use case; neither does a tenant admin who is only bound on the node itself. A root has no parent
   * and cannot be attached (`422 use_case_on_root`).
   */
  async update(
    p: Principal,
    id: string,
    patch: {
      name?: string | undefined;
      monthlyBudgetUsd?: number | null | undefined;
      secretRefs?: string[] | undefined;
      useCase?: string | null | undefined;
    },
  ): Promise<TenantRow> {
    if (patch.useCase !== undefined && patch.useCase !== null && !isValidUseCase(patch.useCase))
      throw new HttpError(
        422,
        'validation_failed',
        'useCase must be segments of letters, digits, ".", "_" or "-" separated by "/"',
      );
    if (p.platformAdmin) {
      if (!hasPermission(p, 'settings:write')) throw forbidden();
    } else if (
      this.ctx.config.auth.roleBindingsRead !== 'bindings' ||
      patch.monthlyBudgetUsd !== undefined ||
      patch.secretRefs !== undefined
    )
      throw platformOnly();
    const node = await this.get(p, id);
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
    if (patch.useCase !== undefined) set.useCase = patch.useCase;
    const now = this.ctx.now();
    return this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await lockTreeShared(tx, node.rootId);
      // Attaching is a grant: the same lock order as the grant path (tree, then bindings).
      if (patch.useCase !== undefined) await lockBindings(tx, node.rootId);
      // Re-read under the lock: authorisation looks at the node as it is now, not as it was.
      const [fresh] = await tx.select().from(tenants).where(eq(tenants.id, id));
      if (!fresh) throw notFound('tenant');
      let parent: TenantRow | undefined;
      if (patch.useCase !== undefined) {
        // A root has no parent to attach to (the database refuses it as well).
        if (fresh.parentId === null)
          throw new HttpError(
            422,
            'use_case_on_root',
            'an organisation has no parent; only a sub-tenant can be attached to a use case',
          );
        [parent] = await tx.select().from(tenants).where(eq(tenants.id, fresh.parentId));
        if (!parent) throw notFound('tenant');
      }
      if (!p.platformAdmin) {
        // Grants re-read under the lock, evaluated at the node of the path (never the acting node).
        const actor = await loadActor(tx, p);
        const attaching = patch.useCase !== undefined;
        if (patch.name !== undefined || !attaching) {
          if (!isInheritingAdminAt(actor, fresh, now)) throw this.notInheriting(actor, fresh, now);
        }
        // Attaching is a grant to the use case's administrators: the authority is that of the parent.
        if (parent && !isInheritingAdminAt(actor, parent, now))
          throw this.notInheriting(actor, parent, now);
      }
      // Unchanged attachment: not a change (no audit entry, no epoch bump).
      if (set.useCase !== undefined && set.useCase === fresh.useCase) delete set.useCase;
      if (Object.keys(set).length === 0) return fresh;
      const [row] = await tx.update(tenants).set(set).where(eq(tenants.id, id)).returning();
      if (!row) throw notFound('tenant');
      if (patch.useCase !== undefined && patch.useCase !== fresh.useCase && parent)
        await this.auditAttachment(tx, p, fresh, parent, patch.useCase);
      const { useCase: _attached, ...rest } = patch;
      // The attachment has its own entries; `tenant.updated` only when something else changed.
      if (Object.keys(rest).length === 0) return row;
      await this.audit.append(
        {
          actor: p.userId,
          tenantId: id,
          action: 'tenant.updated',
          target: id,
          payload: {
            ...rest,
            authority: p.platformAdmin ? ('platform' as const) : ('inheriting_admin' as const),
          },
        },
        tx,
      );
      return row;
    });
  }

  /**
   * `tenant.detached` (the use case the node leaves) and `tenant.attached` (the one it joins), each
   * written in the partition of the child and in that of the parent (ADR 0014 section 10): names and
   * ids only.
   */
  private async auditAttachment(
    tx: Db,
    p: Principal,
    child: TenantRow,
    parent: TenantRow,
    next: string | null,
  ): Promise<void> {
    const authority = p.platformAdmin ? ('platform' as const) : ('inheriting_admin' as const);
    const entries: { action: string; useCase: string }[] = [];
    if (child.useCase !== null) entries.push({ action: 'tenant.detached', useCase: child.useCase });
    if (next !== null) entries.push({ action: 'tenant.attached', useCase: next });
    for (const e of entries)
      for (const tenantId of [child.id, parent.id])
        await this.audit.append(
          {
            actor: p.userId,
            tenantId,
            action: e.action,
            target: child.id,
            payload: { nodeId: child.id, parentId: parent.id, useCase: e.useCase, authority },
          },
          tx,
        );
  }
}
