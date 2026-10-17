import type { Principal } from '@openagentix/core';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import type { TenantRow } from '../../services/tenants.js';
import { roleBindingDto, roleRestrictionDto, tenantDto } from '../dto.js';
import { isUseCaseOnly } from '../use-case-policy.js';
import {
  EnableInheritanceBody,
  EnableInheritanceSchema,
  ErrorSchema,
  IdParams,
  RoleBindingCreateBody,
  RoleBindingListQuery,
  RoleBindingParams,
  RoleBindingPatchBody,
  RoleBindingSchema,
  RoleRestrictionDeleteQuery,
  RoleRestrictionListSchema,
  RoleRestrictionPutBody,
  RoleRestrictionSchema,
  TenantCreateBody,
  TenantMoveBody,
  TenantMoveSchema,
  TenantPatchBody,
  TenantSchema,
  TenantSearchQuery,
  TenantSearchSchema,
  TenantTreeQuery,
  TenantTreeSchema,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['tenants'];
/**
 * Every write of a role restriction bumps the authz epoch of the whole organisation (all cached
 * principals are rebuilt), so writes are throttled per caller (ADR 0014 S9).
 */

export function registerTenantRoutes(app: ZApp, { services, ctx }: Deps): void {
  const RESTRICTION_WRITE_LIMIT = {
    max: ctx.config.rateLimit.restrictionMax,
    timeWindow: '1 minute',
  };
  const { tenants, roleBindings, roleRestrictions, tenantMoves } = services;
  /**
   * The node limits (budget, secret references) stay hidden from a caller whose bindings are all
   * limited to use cases, like the node limit of `/v1/budgets` (ADR 0014 S8).
   */
  const redact = (p: Principal, d: ReturnType<typeof tenantDto>) =>
    isUseCaseOnly(p) ? { ...d, monthlyBudgetUsd: null, secretRefs: [] } : d;
  const view = async (row: TenantRow, p?: Principal) => {
    const d = tenantDto(row, (await tenants.slugPaths([row])).get(row.id)!);
    return p ? redact(p, d) : d;
  };

  app.get(
    '/v1/tenants',
    {
      config: { access: 'authenticated' },
      schema: {
        tags,
        summary: 'List tenants (platform operators see all, everybody else only their own)',
        security: sec,
        response: { 200: z.object({ items: z.array(TenantSchema) }) },
      },
    },
    async (req) => {
      const rows = await tenants.list(principalOf(req));
      const paths = await tenants.slugPaths(rows);
      return {
        items: rows.map((t) => redact(principalOf(req), tenantDto(t, paths.get(t.id)!))),
      };
    },
  );

  app.get(
    '/v1/tenants/tree',
    {
      config: { access: 'authenticated' },
      schema: {
        tags,
        summary:
          "The tenant tree the caller may see, with the caller's roles and optional counts per node",
        description:
          'Platform operators see every organisation; everybody else the nodes where their role ' +
          'bindings reach (their own node, plus descendants of inheriting bindings, ADR 0014). ' +
          "The ancestors of the caller's node appear as path stubs " +
          '(`visible: false`: name and slug only). Siblings, cousins and other organisations never ' +
          "appear. A `root` outside the caller's reach is 404. Counts are included only for nodes " +
          'and metrics the caller may read. Parents come before their children; siblings are ordered ' +
          'by slug. At most `limit` nodes are returned, shallowest first (`truncated`).',
        security: sec,
        querystring: TenantTreeQuery,
        response: { 200: TenantTreeSchema, 404: ErrorSchema },
      },
    },
    async (req) => {
      const r = await tenants.views.visibleTree(principalOf(req), {
        root: req.query.root,
        depth: req.query.depth,
        counts: req.query.include.includes('counts'),
        limit: req.query.limit,
      });
      return {
        truncated: r.truncated,
        items: r.items.map((e) => ({
          id: e.node.id,
          parentId: e.node.parentId,
          slug: e.node.slug,
          slugPath: e.slugPath,
          name: e.node.name,
          depth: e.node.depth,
          hasChildren: e.hasChildren,
          visible: e.visible,
          status: 'active' as const,
          myRoles: e.myRoles,
          inheritedRoles: e.inheritedRoles,
          counts: e.counts,
        })),
      };
    },
  );

  app.get(
    '/v1/tenants/search',
    {
      config: { access: 'authenticated' },
      schema: {
        tags,
        summary: 'Search the tenants the caller may act in by name or slug (at most 20)',
        security: sec,
        querystring: TenantSearchQuery,
        response: { 200: TenantSearchSchema },
      },
    },
    async (req) => ({
      items: (await tenants.views.search(principalOf(req), req.query.q, req.query.limit)).map(
        (r) => ({
          id: r.node.id,
          slug: r.node.slug,
          slugPath: r.slugPath,
          name: r.node.name,
          depth: r.node.depth,
          parentId: r.node.parentId,
        }),
      ),
    }),
  );

  app.post(
    '/v1/tenants',
    {
      config: { access: 'authenticated' },
      schema: {
        tags,
        summary: 'Create a tenant: an organisation (platform operators) or a sub-tenant',
        description:
          'Platform operators with `settings:write` create organisations (no `parentId`) and ' +
          'sub-tenants anywhere. With `OAX_ROLE_BINDINGS_READ=bindings` a tenant admin creates a ' +
          'sub-tenant by naming `parentId`: the caller needs an **inheriting** `admin` binding on ' +
          'the parent or an ancestor (403 `inheritance_required` if they are only a direct ' +
          'admin there), evaluated on the parent and never on the acting tenant. A parent the ' +
          'caller cannot see is 404. `admin` and `monthlyBudgetUsd` are for platform operators ' +
          'only (403). The depth, node and slug limits are the same for everybody; a slug that is ' +
          'taken is 409 without naming the other tenant. Audited as `tenant.created` in the ' +
          'partition of the new tenant.',
        security: sec,
        body: TenantCreateBody,
        response: {
          201: TenantSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(await view(await tenants.createFromRequest(principalOf(req), req.body))),
  );

  app.get(
    '/v1/tenants/:id',
    {
      config: { access: 'authenticated' },
      schema: {
        tags,
        summary: 'Get a tenant',
        security: sec,
        params: IdParams,
        response: { 200: TenantSchema },
      },
    },
    async (req) => view(await tenants.get(principalOf(req), req.params.id), principalOf(req)),
  );

  app.patch(
    '/v1/tenants/:id',
    {
      config: { access: 'authenticated' },
      schema: {
        tags,
        summary:
          'Rename a tenant or attach it to a use case; budget and secret references are platform operators only',
        description:
          'Platform operators with `settings:write` change any field. With ' +
          '`OAX_ROLE_BINDINGS_READ=bindings` a tenant admin renames (`name`) a tenant where ' +
          'they hold an inheriting `admin` binding on it or an ancestor (403 ' +
          '`inheritance_required` for a direct admin); this is evaluated on the tenant in the ' +
          'path, never on the acting tenant. `useCase` attaches the tenant to a use case of its ' +
          'parent (or detaches it with null) and needs an inheriting `admin` binding without use ' +
          'case on the parent or an ancestor: a use-case administrator cannot attach a tenant (403). ' +
          'Attaching is a grant to every inheriting use-case administrator of that use case on the ' +
          'parent; it is audited as `tenant.attached` / `tenant.detached` at the tenant and the ' +
          'parent. An organisation (root) cannot be attached (422 `use_case_on_root`). A tenant the ' +
          'caller cannot see is 404.',
        security: sec,
        params: IdParams,
        body: TenantPatchBody,
        response: { 200: TenantSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req) => view(await tenants.update(principalOf(req), req.params.id, req.body)),
  );

  app.post(
    '/v1/tenants/:id/move',
    {
      config: { access: 'authenticated', rateLimit: RESTRICTION_WRITE_LIMIT },
      schema: {
        tags,
        summary: 'Move a tenant and its subtree below another parent of the same organisation',
        description:
          'ADR 0014 section 7 (slice S10) and ADR 0013 section 9.1. Needs an **inheriting** ' +
          '`admin` binding (without use case) that covers the tenant, its old parent and the new ' +
          'parent, or platform operator access (403 `inheritance_required` for a direct admin); ' +
          'the mover therefore gains no coverage it did not have. Both tenants must be visible to ' +
          'the caller (404 otherwise, the same as for an id that does not exist). Refused: an ' +
          'organisation root (403 `move_not_allowed`, 422 `move_not_supported` for operators), ' +
          'another organisation (422 `move_not_supported`), the tenant itself or a descendant as ' +
          'parent (422 `move_cycle`), the current parent (409 `move_noop`), a depth above the ' +
          'limit (422 `tenant_depth_exceeded`), a parent below a node with a monthly budget (403 ' +
          '`budget_capped`, operators excepted), leaving a node whose role restrictions narrow ' +
          'bindings inside the subtree without the authority to lift them (403 ' +
          '`restriction_removal_forbidden`, whatever the role: also for a role nobody holds yet), or ' +
          'loosening the agent lifecycle policy (ADR 0017) that applies inside the subtree because ' +
          'the ancestors that set it are left behind (403 `policy_widening_forbidden`; the ' +
          'widened keys are listed as `policiesWidened`). A move that widens the policy is a ' +
          'loosening: it is also refused with 403 `policy_loosening_by_contributor` when the caller, or ' +
          "somebody the caller's authority comes from, contributed to an unfinished review in the moved " +
          'subtree (dry runs included). Only with `OAX_ROLE_BINDINGS_READ=bindings` (409 ' +
          '`role_bindings_read_required`). Bindings on the moved tenants move with them; bindings ' +
          'inherited from the old ancestors stop, those inheriting from the new ancestors start; ' +
          'restrictions of the old ancestors stop narrowing the bindings inside, those of the new ' +
          'ancestors start. The tenant is detached from its use case (re-attach with PATCH). ' +
          '`dryRun: true` runs every check and lists the users the caller may see who gain or lose ' +
          'permissions inside the subtree (at most 100, computed with the resolver of the request ' +
          "path); users outside the caller's visible set are not listed. The applied move runs " +
          'under the exclusive tree lock of the organisation, bumps its authz epoch (every cached ' +
          'principal is rebuilt on its next request) and is audited as `tenant.moved` in the ' +
          'partitions of the tenant, the old and the new parent (ids only). Open event streams ' +
          'keep the authorisation they were opened with until they end.',
        security: sec,
        params: IdParams,
        body: TenantMoveBody,
        response: {
          200: TenantMoveSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req) => tenantMoves.move(principalOf(req), req.params.id, req.body),
  );

  const asDate = (v: string | null | undefined) =>
    v === undefined ? undefined : v === null ? null : new Date(v);

  app.get(
    '/v1/tenants/:id/role-bindings',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['role-bindings'],
        summary: 'List the role bindings bound on a tenant',
        description:
          'Needs `users:read` on the tenant (directly or through an inheriting binding above it). A ' +
          'tenant the caller cannot see is 404. `source` tells mirror rows (the global roles of ' +
          'the user) from grants made through this API (ADR 0014 section 4).',
        security: sec,
        params: IdParams,
        querystring: RoleBindingListQuery,
        response: {
          200: z.object({
            items: z.array(RoleBindingSchema),
            nextCursor: z.string().nullable(),
          }),
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req) => {
      const r = await roleBindings.list(principalOf(req), req.params.id, req.query);
      return { items: r.items.map(roleBindingDto), nextCursor: r.nextCursor };
    },
  );

  app.post(
    '/v1/tenants/:id/role-bindings',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['role-bindings'],
        summary: 'Bind a role to a user on a tenant',
        description:
          'The grant rules of ADR 0014 section 7: `users:write` on the tenant, no grant above ' +
          "one's own permissions, an inheriting grant needs an inheriting binding of at least the " +
          'same role on the tenant or above, no grant to oneself (platform operators excepted), ' +
          'the grantee must be visible to the caller (otherwise 404 `user`, as for an unknown ' +
          'id). `inherit` is required. A use-case binding (`useCase`) applies to the resources of ' +
          'the use case on this tenant; with `inherit` also in the child tenants attached to it. A ' +
          'use-case administrator grants for its own use case only (rule 3). ' +
          '`pentest` (rule 7): only tenant admins of the tenant or above and platform operators ' +
          '(403 `pentest_grant_forbidden`); `expiresAt` is required (422 `expiry_required`) and at ' +
          'most `OAX_PENTEST_MAX_DAYS` ahead (422 `expiry_too_long`); the resolver read path only ' +
          '(409 `pentest_requires_bindings_read`). ' +
          'Audited as `tenant.role_bound` in the partition of the tenant.',
        security: sec,
        params: IdParams,
        body: RoleBindingCreateBody,
        response: {
          201: RoleBindingSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const created = await roleBindings.create(principalOf(req), req.params.id, {
        userId: b.userId,
        role: b.role,
        inherit: b.inherit,
        expiresAt: asDate(b.expiresAt) ?? null,
        useCase: b.useCase ?? null,
      });
      return reply.status(201).send(roleBindingDto(created));
    },
  );

  app.patch(
    '/v1/tenants/:id/role-bindings/:bindingId',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['role-bindings'],
        summary: 'Change the role, inheritance or expiry of a binding',
        description:
          'Every change re-checks all grant rules for the old and the new state (who may grant ' +
          'may revoke). Mirror rows (`source: mirror`) accept `inherit` only; their role follows ' +
          "the user's global roles. Narrowing or removing the last inheriting administrator of an " +
          'organisation is 409 `last_admin`. Audited as `tenant.role_binding_changed`.',
        security: sec,
        params: RoleBindingParams,
        body: RoleBindingPatchBody,
        response: {
          200: RoleBindingSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req) => {
      const b = req.body;
      return roleBindingDto(
        await roleBindings.update(principalOf(req), req.params.id, req.params.bindingId, {
          role: b.role,
          inherit: b.inherit,
          expiresAt: asDate(b.expiresAt),
        }),
      );
    },
  );

  app.delete(
    '/v1/tenants/:id/role-bindings/:bindingId',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['role-bindings'],
        summary: 'Remove a role binding',
        description:
          'Needs `users:write` and the same authority as granting it; a user may always remove ' +
          'their own binding (`reason: self`). The last inheriting administrator of an ' +
          'organisation cannot be removed (409 `last_admin`, platform operators excepted). Mirror ' +
          'rows are removed by changing the global roles of the user (409 `mirror_binding`). ' +
          'Audited as `tenant.role_unbound`.',
        security: sec,
        params: RoleBindingParams,
        response: {
          204: z.null(),
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      await roleBindings.remove(principalOf(req), req.params.id, req.params.bindingId);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/v1/tenants/:id/role-restrictions',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['role-restrictions'],
        summary: 'List the role restrictions set on a tenant',
        description:
          'Needs `users:read` on the tenant (directly or through an inheriting binding above it). ' +
          'Lists the restrictions set on this tenant only, grouped by role; restrictions set on ' +
          'ancestors show up as `denied` (reason `role_restricted`, with the restricting tenant) in ' +
          '`GET /v1/me/access` and `GET /v1/tenants/{id}/access`. A tenant the caller cannot see is ' +
          '404. `enforced` is false while `OAX_ROLE_BINDINGS_READ=legacy`.',
        security: sec,
        params: IdParams,
        response: { 200: RoleRestrictionListSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req) => {
      const r = await roleRestrictions.list(principalOf(req), req.params.id);
      return { items: r.items.map(roleRestrictionDto), enforced: r.enforced };
    },
  );

  app.put(
    '/v1/tenants/:id/role-restrictions',
    {
      config: { access: 'authenticated', rateLimit: RESTRICTION_WRITE_LIMIT },
      schema: {
        tags: ['role-restrictions'],
        summary: 'Remove permissions from a role for the bindings at a tenant and below',
        description:
          'Sets the complete list of permissions removed from `role` for bindings **bound on this ' +
          'tenant or below** (ADR 0014 section 5); idempotent, an empty list removes them. A ' +
          'binding granted on an ancestor of this tenant is never narrowed by it, a restriction ' +
          'never adds a permission, never applies to platform operators and never to `admin` (422 ' +
          '`restriction_on_admin`). Needs an inheriting `admin` binding on this tenant or an ' +
          'ancestor, or platform operator access (403 `inheritance_required` for an administrator ' +
          'whose binding does not inherit; never a use-case administrator). At most ' +
          '`OAX_MAX_ROLE_RESTRICTIONS_PER_NODE` entries per tenant (422 `restriction_limit_exceeded`). ' +
          'Only with `OAX_ROLE_BINDINGS_READ=bindings` (409 `role_restrictions_require_bindings_read`). ' +
          'Audited as `tenant.role_restricted` and `tenant.role_restriction_removed` in the ' +
          'partition of the tenant; takes effect on the next request of every user of the ' +
          'organisation (authz epoch).',
        security: sec,
        params: IdParams,
        body: RoleRestrictionPutBody,
        response: {
          200: RoleRestrictionSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req) =>
      roleRestrictionDto(await roleRestrictions.set(principalOf(req), req.params.id, req.body)),
  );

  app.delete(
    '/v1/tenants/:id/role-restrictions',
    {
      config: { access: 'authenticated', rateLimit: RESTRICTION_WRITE_LIMIT },
      schema: {
        tags: ['role-restrictions'],
        summary: 'Lift the restrictions of a role on a tenant',
        description:
          'Removes every restriction of `role` set on this tenant, or only `permission`. ' +
          'Idempotent (204 also when there was nothing to remove). Same authority and read-path ' +
          'rules as `PUT`. Audited as `tenant.role_restriction_removed`.',
        security: sec,
        params: IdParams,
        querystring: RoleRestrictionDeleteQuery,
        response: {
          204: z.null(),
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      await roleRestrictions.remove(principalOf(req), req.params.id, req.query);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/tenants/:id/role-bindings/enable-inheritance',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['role-bindings'],
        summary: 'Bulk opt-in: make the plain bindings of some roles inherit (platform operators)',
        description:
          'For an organisation root. Reports the bindings, users and nodes that gain access; ' +
          'with `dryRun` (the default) nothing changes. Bindings of disabled users and expired ' +
          'bindings are left alone. Audited as `tenant.inheritance_enabled` plus one ' +
          '`tenant.role_binding_changed` per binding.',
        security: sec,
        params: IdParams,
        body: EnableInheritanceBody,
        response: {
          200: EnableInheritanceSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req) => roleBindings.enableInheritance(principalOf(req), req.params.id, req.body),
  );
}
