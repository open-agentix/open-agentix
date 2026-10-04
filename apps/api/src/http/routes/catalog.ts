import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { connectionDto, policyDto } from '../dto.js';
import {
  ConnectionCreateBody,
  ConnectionSchema,
  ConnectionUpdateBody,
  DecisionSchema,
  ErrorSchema,
  EvaluateBody,
  IdParams,
  PolicyCreateBody,
  PolicySchema,
  PolicyUpdateBody,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];

export function registerCatalogRoutes(app: ZApp, { services }: Deps): void {
  const { catalog } = services;

  app.get(
    '/v1/connections',
    {
      config: { access: 'connections:read' },
      schema: {
        tags: ['connections'],
        summary: 'List connections (MCP servers)',
        security: sec,
        response: { 200: z.object({ items: z.array(ConnectionSchema) }) },
      },
    },
    async () => ({
      items: (await catalog.listConnections()).map(connectionDto),
    }),
  );

  app.post(
    '/v1/connections',
    {
      config: { access: 'connections:write' },
      schema: {
        tags: ['connections'],
        summary: 'Create a connection',
        security: sec,
        body: ConnectionCreateBody,
        response: { 201: ConnectionSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(connectionDto(await catalog.createConnection(principalOf(req).userId, req.body))),
  );

  app.get(
    '/v1/connections/:id',
    {
      config: { access: 'connections:read' },
      schema: {
        tags: ['connections'],
        summary: 'Get a connection',
        security: sec,
        params: IdParams,
        response: { 200: ConnectionSchema },
      },
    },
    async (req) => connectionDto(await catalog.getConnection(req.params.id)),
  );

  app.put(
    '/v1/connections/:id',
    {
      config: { access: 'connections:write' },
      schema: {
        tags: ['connections'],
        summary: 'Replace the config of a connection',
        security: sec,
        params: IdParams,
        body: ConnectionUpdateBody,
        response: { 200: ConnectionSchema },
      },
    },
    async (req) =>
      connectionDto(
        await catalog.updateConnection(principalOf(req).userId, req.params.id, req.body.config),
      ),
  );

  app.delete(
    '/v1/connections/:id',
    {
      config: { access: 'connections:write' },
      schema: {
        tags: ['connections'],
        summary: 'Delete a connection',
        security: sec,
        params: IdParams,
      },
    },
    async (req, reply) => {
      await catalog.deleteConnection(principalOf(req).userId, req.params.id);
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/policies',
    {
      config: { access: 'policies:read' },
      schema: {
        tags: ['policies'],
        summary: 'List policy bundles',
        security: sec,
        response: { 200: z.object({ items: z.array(PolicySchema) }) },
      },
    },
    async () => ({
      items: (await catalog.listPolicies()).map(policyDto),
    }),
  );

  app.post(
    '/v1/policies',
    {
      config: { access: 'policies:write' },
      schema: {
        tags: ['policies'],
        summary: 'Create a policy bundle',
        security: sec,
        body: PolicyCreateBody,
        response: { 201: PolicySchema, 400: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(policyDto(await catalog.createPolicy(principalOf(req).userId, req.body))),
  );

  app.get(
    '/v1/policies/:id',
    {
      config: { access: 'policies:read' },
      schema: {
        tags: ['policies'],
        summary: 'Get a policy bundle',
        security: sec,
        params: IdParams,
        response: { 200: PolicySchema },
      },
    },
    async (req) => policyDto(await catalog.getPolicy(req.params.id)),
  );

  app.put(
    '/v1/policies/:id',
    {
      config: { access: 'policies:write' },
      schema: {
        tags: ['policies'],
        summary: 'Update a policy bundle (bumps its version)',
        security: sec,
        params: IdParams,
        body: PolicyUpdateBody,
        response: { 200: PolicySchema },
      },
    },
    async (req) =>
      policyDto(await catalog.updatePolicy(principalOf(req).userId, req.params.id, req.body)),
  );

  const GuidelineSchema = z.object({
    id: z.string().uuid(),
    scope: z.enum(['global', 'tenant', 'agent']),
    name: z.string(),
    version: z.string(),
    content: z.string(),
    rules: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  });
  const guidelineDto = (g: Awaited<ReturnType<typeof services.guidelines.list>>[number]) => ({
    id: g.id,
    scope: g.scope as 'global' | 'tenant' | 'agent',
    name: g.name,
    version: g.version,
    content: g.content,
    rules: g.rules as Record<string, unknown>,
    createdAt: g.createdAt.toISOString(),
  });

  app.get(
    '/v1/guidelines',
    {
      config: { access: 'policies:read' },
      schema: {
        tags: ['policies'],
        summary: 'List development guideline sets (global, tenant, agent)',
        security: sec,
        response: { 200: z.object({ items: z.array(GuidelineSchema) }) },
      },
    },
    async () => ({ items: (await services.guidelines.list()).map(guidelineDto) }),
  );

  app.post(
    '/v1/guidelines',
    {
      config: { access: 'policies:write' },
      schema: {
        tags: ['policies'],
        summary:
          'Create an immutable guideline version (stricter rules always win: global -> tenant -> agent)',
        security: sec,
        body: z.object({
          scope: z.enum(['global', 'tenant', 'agent']),
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
          version: z.string(),
          content: z.string().max(200_000).default(''),
          rules: z.record(z.string(), z.unknown()),
        }),
        response: { 201: GuidelineSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(guidelineDto(await services.guidelines.create(principalOf(req).userId, req.body))),
  );

  app.post(
    '/v1/guidelines/review',
    {
      config: { access: 'policies:read' },
      schema: {
        tags: ['policies'],
        summary:
          'Hardening agent: review a change (dependencies, coverage, commits, tests) of an agent against the resolved guidelines',
        security: sec,
        body: z.object({
          agentId: z.string().uuid(),
          change: z.object({
            addedDependencies: z.array(z.string()).optional(),
            coveragePercent: z.number().min(0).max(100).optional(),
            commitMessages: z.array(z.string()).optional(),
            changedFiles: z.array(z.string()).optional(),
          }),
        }),
        response: {
          200: z.object({
            passed: z.boolean(),
            findings: z.array(z.object({ rule: z.string(), message: z.string() })),
            applied: z.array(z.string()),
          }),
        },
      },
    },
    async (req) => {
      const agent = await services.agents.get(req.body.agentId);
      await services.agents.assertAccess(principalOf(req), agent, 'agents:read');
      const def = agent.latestVersionId
        ? (await services.agents.definitionOf(agent.latestVersionId)).definition
        : services.agents.validate(agent.draftSource).definition;
      const r = await services.guidelines.review(
        principalOf(req).userId,
        def ?? { name: agent.name, guidelines: [] },
        req.body.change,
      );
      return { passed: r.findings.length === 0, findings: r.findings, applied: r.applied };
    },
  );

  app.post(
    '/v1/policies/evaluate',
    {
      config: { access: 'policies:read' },
      schema: {
        tags: ['policies'],
        summary: 'Dry-run the policy gate for a tool call',
        security: sec,
        body: EvaluateBody,
        response: { 200: DecisionSchema },
      },
    },
    async (req) => {
      const d = await catalog.evaluate(req.body.source, req.body.agentId, req.body.call);
      return { effect: d.effect, reasons: d.reasons };
    },
  );
}
