import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import type { TenantRow } from '../../services/tenants.js';
import { tenantDto } from '../dto.js';
import {
  ErrorSchema,
  IdParams,
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
  const { tenants } = services;
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
}
