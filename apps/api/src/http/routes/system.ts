import {
  getEgressPolicy,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  RUNNER_KINDS,
} from '@openagentix/core';
import { catalogModels } from '@openagentix/providers';
import { z } from 'zod';
import { HttpError } from '../../errors.js';
import { VERSION } from '../../version.js';
import type { Deps } from '../app.js';
import { bearerOf } from '../app.js';
import { HealthSchema, ReadySchema, SettingsSchema, VersionInfoSchema } from '../schemas.js';
import type { ZApp } from '../zapp.js';

export function airgapState(): { enabled: boolean; allowlist: number; blockedAttempts: number } {
  const s = getEgressPolicy().status();
  return { enabled: s.airgapped, allowlist: s.allowlist, blockedAttempts: s.blocked };
}

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
        airgapped: airgapState(),
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
    '/v1/models',
    {
      config: { access: 'agents:read' },
      schema: {
        tags: ['system'],
        summary: 'Model catalog (pinned snapshot + local overrides from OAX_PRICE_TABLE)',
        security: [{ bearer: [] }],
        querystring: z.object({
          provider: z
            .string()
            .max(100)
            .optional()
            .describe('models.dev provider id, e.g. anthropic'),
          q: z.string().max(100).optional().describe('substring of the model id or name'),
        }),
        response: {
          200: z.object({
            source: z.string(),
            snapshotDate: z.string(),
            sha256: z
              .string()
              .nullable()
              .describe('hash of the models.dev document of the snapshot'),
            items: z.array(
              z.object({
                provider: z.string(),
                providerName: z.string(),
                id: z.string(),
                name: z.string(),
                contextTokens: z.number().int().nullable(),
                outputTokens: z.number().int().nullable(),
                inputPerMTok: z.number().nullable(),
                outputPerMTok: z.number().nullable(),
                toolCall: z.boolean().nullable(),
                source: z.enum(['catalog', 'override']),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const catalog = ctx.modelCatalog;
      const q = req.query.q?.toLowerCase();
      return {
        source: catalog.source,
        snapshotDate: catalog.snapshotDate,
        sha256: catalog.sha256 ?? null,
        items: catalogModels(catalog, ctx.config.priceTable).filter(
          (m) =>
            (!req.query.provider || m.provider === req.query.provider) &&
            (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
        ),
      };
    },
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
      demo: ctx.config.demo.enabled,
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
