import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, RUNNER_KINDS } from '@openagentix/core';
import { z } from 'zod';
import { HttpError } from '../../errors.js';
import { VERSION } from '../../version.js';
import type { Deps } from '../app.js';
import { bearerOf } from '../app.js';
import { HealthSchema, ReadySchema, SettingsSchema, VersionInfoSchema } from '../schemas.js';
import type { ZApp } from '../zapp.js';

export function registerSystemRoutes(app: ZApp, { ctx }: Deps): void {
  const ops = ['ops'];
  app.get(
    '/healthz',
    {
      config: { access: 'public' },
      schema: { tags: ops, summary: 'Liveness probe', response: { 200: HealthSchema } },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/readyz',
    {
      config: { access: 'public' },
      schema: {
        tags: ops,
        summary: 'Readiness probe: database reachable and schema migrated for this build',
        response: { 200: ReadySchema, 503: ReadySchema },
      },
    },
    async (_req, reply) => {
      const db = await ctx.database.ping().catch(() => false);
      const schema = db ? await ctx.database.schemaStatus().catch(() => null) : null;
      const ok = db && !!schema?.ok;
      return reply.status(ok ? 200 : 503).send({
        status: ok ? 'ok' : 'unavailable',
        checks: { database: db, schema: !!schema?.ok },
        schema: schema ?? { expected: 0, applied: 0, ok: false },
      });
    },
  );

  app.get(
    '/metrics',
    {
      config: { access: 'public' },
      schema: {
        tags: ops,
        summary: 'Prometheus metrics (bearer token required if OAX_METRICS_TOKEN is set)',
        produces: ['text/plain'],
        response: { 200: z.string() },
      },
    },
    async (req, reply) => {
      if (ctx.config.metricsToken && bearerOf(req) !== ctx.config.metricsToken) {
        throw new HttpError(401, 'unauthenticated', 'metrics token required');
      }
      return reply
        .type(ctx.metrics.registry.contentType)
        .send(await ctx.metrics.registry.metrics());
    },
  );

  app.get(
    '/openapi.json',
    {
      config: { access: 'public' },
      schema: {
        tags: ops,
        summary: 'This OpenAPI 3.1 document',
        response: { 200: z.record(z.string(), z.unknown()) },
      },
    },
    async () => app.swagger() as unknown as Record<string, unknown>,
  );

  app.get(
    '/v1/version',
    {
      config: { access: 'public' },
      schema: {
        tags: ['system'],
        summary: 'Version of the control node',
        response: { 200: VersionInfoSchema },
      },
    },
    async () => ({ name: 'openagentix' as const, version: VERSION }),
  );

  app.get(
    '/v1/settings',
    {
      config: { access: 'authenticated' },
      schema: {
        tags: ['system'],
        summary: 'Capabilities for the UI (providers, runners, auth methods)',
        security: [{ bearer: [] }],
        response: { 200: SettingsSchema },
      },
    },
    async () => ({
      version: VERSION,
      providers: ctx.config.providers.map((p) => ({
        name: p.name,
        kind: p.kind,
        clearance: p.clearance ?? null,
      })),
      runners: RUNNER_KINDS.map((k) => ({
        kind: k,
        available: ctx.config.runners.enabled.includes(k),
      })),
      auth: { local: true, ldap: !!ctx.config.auth.ldap, oidc: !!ctx.config.auth.oidc },
      roles: [...ROLES],
      permissions: [...PERMISSIONS],
      rolePermissions: Object.fromEntries(ROLES.map((r) => [r, [...ROLE_PERMISSIONS[r]]])),
    }),
  );
}
