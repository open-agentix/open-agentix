import { randomUUID } from 'node:crypto';
import {
  OaxError,
  hasPermission,
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
import { isInheritingAdminAt, loadActor, permissionsAt, type Actor } from './grant-authority.js';
import { TenantAccess } from './tenant-access.js';
import { TenantTree } from './tenant-tree.js';
import { TenantViews } from './tenant-views.js';
import { lockTreeShared } from './tree-lock.js';
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
    return this.insert(p, parent, input, 'inheriting_admin', async (tx, current) => {
      const actor = await loadActor(tx, p);
      if (!isInheritingAdminAt(actor, current!, now))
        throw this.notInheriting(actor, current!, now);
    });
  }

  /**
   * The refusal for a caller that is not an inheriting admin at `node`. A direct admin there is told
   * what is missing (`inheritance_required`); anybody else gets a plain `403`. The node is visible
   * to the caller at this point, so the difference reveals nothing about other nodes.
   */
  private notInheriting(actor: Actor, node: TenantRow, now: Date): HttpError {
    if (permissionsAt(actor, node, now).has('settings:write'))
      return new HttpError(
        403,
        'inheritance_required',
        'this needs an inheriting admin binding on the tenant or an ancestor',
      );
    return forbidden();
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
        // One writer at a time per creation: the slug overlap check and the node limit read what
        // the insert changes. The lock is held until commit (also on PGlite, which serialises
        // transactions anyway). The unique index on `slug` stays as the database-level backstop.
        await tx.execute(sql`select pg_advisory_xact_lock(${TENANT_CREATE_LOCK})`);
        // The tree lock of the organisation, shared (ADR 0014 6.2): a creation never races a move
        // or a revocation that would change the creator's coverage; the grants are re-read below.
        let current: TenantRow | null = null;
        if (parent) {
          await lockTreeShared(tx, parent.rootId);
          const [found] = await tx.select().from(tenants).where(eq(tenants.id, parent.id));
          if (!found) throw notFound('tenant');
          current = found;
        }
        if (authorize) await authorize(tx, current);
        const placement = current
          ? placeNode(id, current, maxDepth)
          : placeNode(id, null, maxDepth);
        // Until secret names are node-aware (W13-7) slugs must not overlap anywhere in the
        // installation: `acme.corp.x` and `acme-corp.x` are the same secret for the resolver, so
        // tenants whose slugs overlap in canonical form could read each other's secrets and cannot
        // coexist. This also covers the same slug twice.
        const clash = (await tx.select({ slug: tenants.slug }).from(tenants)).find((x) =>
          slugsCollide(x.slug, input.slug),
        );
        if (clash) throw this.slugConflict(p, input.slug, clash.slug);
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
   */
  async update(
    p: Principal,
    id: string,
    patch: {
      name?: string | undefined;
      monthlyBudgetUsd?: number | null | undefined;
      secretRefs?: string[] | undefined;
    },
  ): Promise<TenantRow> {
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
    const now = this.ctx.now();
    return this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await lockTreeShared(tx, node.rootId);
      if (!p.platformAdmin) {
        // Grants re-read under the lock, evaluated at the node of the path (never the acting node).
        const actor = await loadActor(tx, p);
        if (!isInheritingAdminAt(actor, node, now)) throw this.notInheriting(actor, node, now);
      }
      if (Object.keys(set).length === 0) return node;
      const [row] = await tx.update(tenants).set(set).where(eq(tenants.id, id)).returning();
      if (!row) throw notFound('tenant');
      await this.audit.append(
        {
          actor: p.userId,
          tenantId: id,
          action: 'tenant.updated',
          target: id,
          payload: patch,
        },
        tx,
      );
      return row;
    });
  }
}
