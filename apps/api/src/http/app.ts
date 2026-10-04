import { randomUUID } from 'node:crypto';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import etag from '@fastify/etag';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import {
  MODEL_TOKEN_PREFIX,
  hasPermission,
  verifyModelToken,
  verifyRunToken,
  type OaxError,
  type Permission,
  type Principal,
} from '@openagentix/core';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppContext } from '../context.js';
import { LOG_REDACT_PATHS } from '../context.js';
import { HttpError, forbidden, registerErrorHandler } from '../errors.js';
import type { Services } from '../services/index.js';
import { VERSION } from '../version.js';
import { verifyStreamToken } from '../auth/stream-token.js';
import { decorateOpenApi } from './openapi-decorate.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerDemoRoutes } from './routes/demo.js';
import { registerEventRoutes } from './routes/events.js';
import { registerPlanRoutes } from './routes/plans.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerBudgetRoutes } from './routes/budgets.js';
import { registerTenantRoutes } from './routes/tenants.js';
import { registerUserRoutes } from './routes/users.js';
import { registerWorkerRoutes } from './routes/worker.js';

/** How a route authenticates: an RBAC permission, any signed-in principal, or a special scheme. */
export type RouteAccess =
  Permission | 'authenticated' | 'public' | 'run-token' | 'model-token' | 'webhook';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
    /** Accept a short-lived stream token in `?access_token=` (EventSource cannot set headers). */
    streamToken?: boolean;
  }
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface RouteInfo {
  method: string;
  url: string;
  access: RouteAccess | undefined;
}

export interface Deps {
  ctx: AppContext;
  services: Services;
}

export function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1] ?? null;
}

/** Throws unless the request carries a principal (set by the auth hook). */
export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new HttpError(401, 'unauthenticated', 'authentication required');
  return req.principal;
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { ctx } = deps;
  const app = Fastify({
    logger: {
      level: ctx.config.logLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    },
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[\w.-]{1,128}$/.test(given) ? given : randomUUID();
    },
    trustProxy: ctx.config.trustProxy,
    bodyLimit: ctx.config.bodyLimit,
    disableRequestLogging: false,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  const routes: RouteInfo[] = [];
  app.decorate('routeIndex', routes);
  app.addHook('onRoute', (route) => {
    // HEAD mirrors GET; OPTIONS is the CORS preflight registered by @fastify/cors.
    if (route.method === 'HEAD' || route.method === 'OPTIONS') return;
    const access = route.config?.access;
    if (!access)
      throw new Error(
        `route ${String(route.method)} ${route.url} does not declare its access (config.access)`,
      );
    for (const m of [route.method].flat())
      routes.push({ method: String(m), url: route.url, access });
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: ctx.config.corsOrigins.length ? ctx.config.corsOrigins : false,
    credentials: false,
    exposedHeaders: ['etag', 'x-request-id'],
  });
  await app.register(compress, { threshold: 1024, encodings: ['br', 'gzip'] });
  await app.register(etag, { weak: true });
  await app.register(rateLimit, {
    global: true,
    max: ctx.config.rateLimit.max,
    timeWindow: '1 minute',
    keyGenerator: (req) => bearerOf(req)?.slice(0, 24) ?? req.ip,
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'openagentix API',
        version: VERSION,
        description:
          'Control node API of openagentix: agents, events, runs, approvals, audit, costs and RBAC.',
        license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
      },
      servers: [{ url: ctx.config.publicUrl }],
      components: {
        securitySchemes: {
          bearer: {
            type: 'http',
            scheme: 'bearer',
            description: 'Session or API token (`oax_...`)',
          },
          runToken: {
            type: 'http',
            scheme: 'bearer',
            description: 'Signed run token (`oaxrt....`) of a worker node',
          },
          modelToken: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Model token (`oaxmt....`) of one step of a run node session (ADR 0009); opens the model endpoint only',
          },
          webhookSignature: {
            type: 'apiKey',
            in: 'header',
            name: 'x-oax-signature',
            description: 'HMAC-SHA256 signature',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: (doc) => decorateOpenApi(jsonSchemaTransformObject(doc)),
  });

  /** Platform operators may act inside another tenant with `X-OAX-Tenant`; everybody else gets 404. */
  const actingIn = async (req: FastifyRequest, principal: Principal): Promise<Principal> => {
    const tenant = req.headers['x-oax-tenant'];
    if (typeof tenant !== 'string' || tenant === '') return principal;
    return deps.services.identity.actingIn(principal, tenant);
  };

  // Authentication + route-level RBAC. Resource-level (team) checks happen in the services.
  app.addHook('onRequest', async (req) => {
    const access = req.routeOptions.config?.access;
    if (!access || access === 'public' || access === 'webhook') return;
    const token = bearerOf(req);
    const query = req.query as { access_token?: string } | undefined;
    if (!token && req.routeOptions.config?.streamToken && query?.access_token) {
      const runId = (req.params as { id?: string }).id ?? '';
      const claims = verifyStreamToken(
        ctx.config.runToken.secret,
        query.access_token,
        runId,
        ctx.now().getTime(),
      );
      req.principal = await deps.services.identity.principalForUser(claims.userId, ['runs:read']);
      req.principal = await actingIn(req, req.principal);
      if (
        access !== 'authenticated' &&
        access !== 'run-token' &&
        access !== 'model-token' &&
        !hasPermission(req.principal, access)
      )
        throw forbidden(`missing permission ${access}`);
      return;
    }
    if (access === 'run-token') {
      // Signature and expiry are checked before the body is parsed; the run binding in the handler.
      try {
        verifyRunToken(ctx.config.runToken.secret, token ?? '', ctx.now().getTime());
      } catch (e) {
        throw new HttpError(401, (e as OaxError).code, 'valid run token required');
      }
      return;
    }
    if (access === 'model-token') {
      // The model endpoint takes the node's step-scoped run token or its model token (different
      // prefixes and keys, so neither verifies as the other). Session and binding checks follow in
      // the handler; here only the signature and expiry are checked before the body is parsed.
      try {
        if (token?.startsWith(`${MODEL_TOKEN_PREFIX}.`))
          verifyModelToken(ctx.config.runToken.secret, token, ctx.now().getTime());
        else verifyRunToken(ctx.config.runToken.secret, token ?? '', ctx.now().getTime());
      } catch {
        throw new HttpError(401, 'unauthenticated', 'valid model or run token required');
      }
      return;
    }
    if (!token) throw new HttpError(401, 'unauthenticated', 'authentication required');
    req.principal = await actingIn(req, await deps.services.identity.authenticate(token));
    if (access !== 'authenticated' && !hasPermission(req.principal, access))
      throw forbidden(`missing permission ${access}`);
  });
  // Public demo: read-mostly. Mutations are refused except sign-in and side-effect-free checks.
  const DEMO_ALLOWED = new Set([
    'POST /v1/auth/login',
    'POST /v1/auth/logout',
    'POST /v1/agents/validate',
    'POST /v1/agents/:id/dry-run',
    'POST /v1/policies/evaluate',
    'POST /v1/guidelines/review',
    'POST /v1/plans/check',
    'POST /v1/plans/generate',
    'POST /v1/runs/:id/stream-token',
    'POST /v1/audit/verify',
    'POST /v1/demo/scenarios/:scenario/run',
  ]);
  app.addHook('onRequest', async (req, reply) => {
    if (!ctx.config.demo.enabled) return;
    void reply.header('x-oax-demo', 'true');
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (DEMO_ALLOWED.has(`${req.method} ${req.routeOptions.url ?? ''}`)) return;
    throw new HttpError(
      403,
      'demo_read_only',
      'the public demo is read-only; run openagentix yourself to change data',
    );
  });
  app.addHook('preHandler', async (req) => {
    const id = (req.params as { id?: string } | undefined)?.id;
    if (id && req.routeOptions.url?.startsWith('/v1/runs/')) req.log = req.log.child({ runId: id });
  });
  app.addHook('onResponse', async (req, reply) => {
    ctx.metrics.httpDuration.observe(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unknown',
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  const typed = app.withTypeProvider<ZodTypeProvider>();
  registerSystemRoutes(typed, deps);
  registerAuthRoutes(typed, deps);
  registerAgentRoutes(typed, deps);
  registerEventRoutes(typed, deps);
  registerRunRoutes(typed, deps);
  registerCatalogRoutes(typed, deps);
  registerAuditRoutes(typed, deps);
  registerUserRoutes(typed, deps);
  registerTenantRoutes(typed, deps);
  registerDemoRoutes(typed, deps);
  registerBudgetRoutes(typed, deps);
  registerWorkerRoutes(typed, deps);
  registerPlanRoutes(typed, deps);
  await app.ready();
  return app;
}

export function routeIndex(app: FastifyInstance): RouteInfo[] {
  return (app as unknown as { routeIndex: RouteInfo[] }).routeIndex;
}
