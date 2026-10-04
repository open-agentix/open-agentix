import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { tenantDto } from '../dto.js';
import {
  ErrorSchema,
  IdParams,
  TenantCreateBody,
  TenantPatchBody,
  TenantSchema,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['tenants'];

export function registerTenantRoutes(app: ZApp, { services }: Deps): void {
  const { tenants } = services;

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
    async (req) => ({ items: (await tenants.list(principalOf(req))).map(tenantDto) }),
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
      reply.status(201).send(tenantDto(await tenants.create(principalOf(req), req.body))),
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
    async (req) => tenantDto(await tenants.get(principalOf(req), req.params.id)),
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
    async (req) => tenantDto(await tenants.update(principalOf(req), req.params.id, req.body)),
  );
}
