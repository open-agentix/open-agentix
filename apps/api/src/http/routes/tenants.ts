import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import type { TenantRow } from '../../services/tenants.js';
import { roleBindingDto, tenantDto } from '../dto.js';
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
  TenantCreateBody,
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

export function registerTenantRoutes(app: ZApp, { services }: Deps): void {
  const { tenants, roleBindings } = services;
  const view = async (row: TenantRow) =>
    tenantDto(row, (await tenants.slugPaths([row])).get(row.id)!);

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
      return { items: rows.map((t) => tenantDto(t, paths.get(t.id)!)) };
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
          'Platform operators see every organisation; everybody else, tenant admins included, their ' +
          'own node until role bindings can inherit down the tree (ADR 0014). ' +
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
      config: { access: 'settings:write' },
      schema: {
        tags,
        summary: 'Create a tenant (platform operators only)',
        security: sec,
        body: TenantCreateBody,
        response: { 201: TenantSchema, 403: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) =>
      reply.status(201).send(await view(await tenants.create(principalOf(req), req.body))),
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
    async (req) => view(await tenants.get(principalOf(req), req.params.id)),
  );

  app.patch(
    '/v1/tenants/:id',
    {
      config: { access: 'settings:write' },
      schema: {
        tags,
        summary: 'Rename a tenant or change its monthly budget (platform operators only)',
        security: sec,
        params: IdParams,
        body: TenantPatchBody,
        response: { 200: TenantSchema, 403: ErrorSchema },
      },
    },
    async (req) => view(await tenants.update(principalOf(req), req.params.id, req.body)),
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
          'id). `inherit` is required. Use-case bindings are 422 `use_case_bindings_unsupported`. ' +
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
