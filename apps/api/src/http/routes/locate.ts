import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { ErrorSchema, LocateParams, LocateSchema } from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];

/** Locate the tenant of a resource for deep links (ADR 0014 section 12, slice S7; #163). */
export function registerLocateRoutes(app: ZApp, { services }: Deps): void {
  app.get(
    '/v1/locate/:kind/:id',
    {
      // The permission depends on the kind and is checked at the owning node, not the acting node.
      config: { access: 'authenticated' },
      schema: {
        tags: ['tenants'],
        summary: 'Which tenant owns this resource (for deep links)',
        description:
          'Returns the owning tenant (`id`, `slugPath`, `name`) of an agent, run, approval, ' +
          'event source or connection when the caller holds the read permission of that kind ' +
          '(`agents:read`, `runs:read`, `sources:read`, `connections:read`) at the owning ' +
          'tenant, directly or through an inheriting binding; API token scopes are applied. The ' +
          'answer does not depend on the acting tenant (`X-OAX-Tenant`). Everything else is one ' +
          'identical `404`: no such id, a resource of a sibling, an ancestor or another ' +
          'organisation, a tenant the caller can see but lacks the permission in. Misses are ' +
          'audited as `access.denied` (rate-limited per user and kind). The response never ' +
          'contains data of the resource.',
        security: sec,
        params: LocateParams,
        response: { 200: LocateSchema, 404: ErrorSchema },
      },
    },
    async (req) => ({
      tenant: await services.locate.locate(principalOf(req), req.params.kind, req.params.id),
    }),
  );
}
