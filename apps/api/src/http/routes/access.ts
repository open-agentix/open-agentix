import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import {
  AccessQuery,
  AccessSchema,
  ErrorSchema,
  IdParams,
  NoticeQuery,
  NoticeSchema,
  UserAccessQuery,
} from '../schemas.js';
import type { AccessView } from '../../services/access-explain.js';
import { z } from 'zod';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];

const accessDto = (v: AccessView) => ({
  ...v,
  bindings: v.bindings.map((b) => ({
    ...b,
    expiresAt: b.expiresAt ? b.expiresAt.toISOString() : null,
  })),
});

/** Effective permissions with their sources (ADR 0014 section 14, slice S5). */
export function registerAccessRoutes(app: ZApp, { services }: Deps): void {
  const { accessExplain, pentest } = services;

  app.get(
    '/v1/me/notices',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['tenants'],
        summary: 'Own in-app notices (newest first)',
        description:
          'The only notification channel there is: tenant administrators and the grantor get a ' +
          'notice when a `pentest` role is granted, 24 hours before it ends and when it has ' +
          'expired (ADR 0014 section 8). Kept 30 days; there is no mail or webhook delivery.',
        security: sec,
        querystring: NoticeQuery,
        response: { 200: z.object({ items: z.array(NoticeSchema) }) },
      },
    },
    async (req) => ({
      items: (await pentest.listNotices(principalOf(req), req.query.limit)).map((n) => ({
        ...n,
        createdAt: n.createdAt.toISOString(),
      })),
    }),
  );

  app.get(
    '/v1/me/access',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['tenants'],
        summary: 'Own effective permissions at a tenant, with the bindings that give them',
        description:
          'Answers for the tenant in `tenant` (id or slug path) or, without it, the acting ' +
          'tenant. A tenant the caller cannot see is 404, the same as an unknown one. Computed ' +
          'with the resolver the request path uses; API token scopes are applied and reported ' +
          'as `limitedByToken`.',
        security: sec,
        querystring: AccessQuery,
        response: { 200: AccessSchema, 404: ErrorSchema },
      },
    },
    async (req) => accessDto(await accessExplain.forMe(principalOf(req), req.query.tenant)),
  );

  app.get(
    '/v1/tenants/:id/access',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['tenants'],
        summary: "A user's effective permissions at a tenant, with the bindings that give them",
        description:
          'Needs `users:read` on the tenant in the path (directly or through an inheriting ' +
          'binding above it), never on the acting tenant. A tenant or a user the caller cannot ' +
          'see is 404 (the grantee visibility of the role-binding API).',
        security: sec,
        params: IdParams,
        querystring: UserAccessQuery,
        response: { 200: AccessSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req) =>
      accessDto(await accessExplain.forUser(principalOf(req), req.params.id, req.query.userId)),
  );
}
