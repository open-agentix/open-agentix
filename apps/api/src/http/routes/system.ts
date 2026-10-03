import { PERMISSIONS, ROLES, RUNNER_KINDS } from '@openagentix/core';
import { z } from 'zod';
import { HttpError } from '../../errors.js';
import { VERSION } from '../../version.js';
import type { Deps } from '../app.js';
import { bearerOf } from '../app.js';
import { HealthSchema, SettingsSchema, VersionInfoSchema } from '../schemas.js';
import type { ZApp } from '../zapp.js';

export function registerSystemRoutes(app: ZApp, { ctx }: Deps): void {
  app.get(
    '/healthz',
    { config: { access: 'public' }, schema: { hide: true, response: { 200: HealthSchema } } },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/readyz',
    {
      config: { access: 'public' },
      schema: { hide: true, response: { 200: HealthSchema, 503: HealthSchema } },
    },
    async (_req, reply) => {
      const db = await ctx.database.ping().catch(() => false);
      return reply
        .status(db ? 200 : 503)
        .send({ status: db ? 'ok' : 'unavailable', checks: { database: db } });
    },
  );

  app.get(
    '/metrics',
    { config: { access: 'public' }, schema: { hide: true } },
    async (req, reply) => {
      if (ctx.config.metricsToken && bearerOf(req) !== ctx.config.metricsToken)
        throw new HttpError(401, 'unauthenticated', 'metrics token required');
      return reply
        .type(ctx.metrics.registry.contentType)
        .send(await ctx.metrics.registry.metrics());
    },
  );

  app.get('/openapi.json', { config: { access: 'public' }, schema: { hide: true } }, async () =>
    app.swagger(),
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
        available: k === 'in-process' || k === 'local',
      })),
      auth: { local: true, ldap: !!ctx.config.auth.ldap, oidc: !!ctx.config.auth.oidc },
      roles: [...ROLES],
      permissions: [...PERMISSIONS],
    }),
  );
  void z;
}
