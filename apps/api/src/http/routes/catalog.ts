import { CATALOG_PROVIDER_FOR, listProposals, proposeModels } from '@openagentix/providers';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { connectionDto, policyDto } from '../dto.js';
import {
  ConnectionCreateBody,
  ConnectionSchema,
  ConnectionTestBody,
  ConnectionTestResultSchema,
  McpConnectionTestResultSchema,
  ConnectionUpdateBody,
  StdioViolationsSchema,
  DecisionSchema,
  ErrorSchema,
  EvaluateBody,
  IdParams,
  ModelProposalQuery,
  ModelProposalSchema,
  PolicyCreateBody,
  PolicySchema,
  PolicyUpdateBody,
  SubtreePageQuery,
  ToolRefreshResultSchema,
  ToolSnapshotApproveBody,
  ToolSnapshotDetailSchema,
  ToolSnapshotListSchema,
  ToolSnapshotParams,
  ToolSnapshotSummarySchema,
} from '../schemas.js';
import { SUBTREE_DEFAULT_PAGE, assertPagingNeedsSubtree, rowTenants } from '../subtree.js';
import { HttpError } from '../../errors.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];

export function registerCatalogRoutes(app: ZApp, { ctx, services }: Deps): void {
  const { catalog } = services;

  app.get(
    '/v1/connections',
    {
      config: { access: 'connections:read' },
      schema: {
        tags: ['connections'],
        summary: 'List connections (MCP servers)',
        security: sec,
        description:
          'With scope=subtree: the connections owned by the acting tenant and its descendants the caller may read (paged with limit and cursor); platform connections owned by a tenant outside that set are not listed.',
        querystring: SubtreePageQuery,
        response: {
          200: z.object({
            items: z.array(ConnectionSchema),
            nextCursor: z.string().nullable().optional(),
          }),
        },
      },
    },
    async (req) => {
      assertPagingNeedsSubtree(req.query);
      const principal = principalOf(req);
      const subtree = await services.subtree.resolve(principal, 'connections:read', req.query);
      if (!subtree)
        return {
          items: (await catalog.listConnections(principal)).map((c) =>
            connectionDto(c, catalog.stdioIssues(c)),
          ),
        };
      const r = await catalog.listConnectionsIn(
        subtree,
        req.query.limit ?? SUBTREE_DEFAULT_PAGE,
        req.query.cursor,
      );
      const tenantOf = await rowTenants(services.subtree, subtree, r.items);
      return {
        items: r.items.map((c) => ({
          ...connectionDto(c, catalog.stdioIssues(c)),
          tenant: tenantOf(c),
        })),
        nextCursor: r.nextCursor,
      };
    },
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
    async (req, reply) => {
      const row = await catalog.createConnection(principalOf(req), req.body);
      return reply.status(201).send(connectionDto(row, catalog.stdioIssues(row)));
    },
  );

  app.get(
    '/v1/connections/stdio-violations',
    {
      config: { access: 'connections:read' },
      schema: {
        tags: ['connections'],
        summary:
          'Stored tenant stdio connections that break the stdio rules (ADR 0016); they fail closed at run time',
        security: sec,
        response: { 200: StdioViolationsSchema },
      },
    },
    async (req) => ({
      items: (await catalog.stdioViolations(principalOf(req))).map((v) => ({
        connection: connectionDto(
          v.connection,
          v.issues.map((i) => i.message),
        ),
        issues: v.issues,
      })),
    }),
  );

  app.post(
    '/v1/models/proposals',
    {
      config: { access: 'connections:read' },
      schema: {
        tags: ['connections'],
        summary:
          'Propose limits and USD prices per model from the pinned model catalog (before creating a model connection; every value can be overridden)',
        security: sec,
        body: ModelProposalQuery,
        response: {
          200: z.object({
            catalogProvider: z.string().nullable(),
            snapshotDate: z.string(),
            items: z.array(ModelProposalSchema),
          }),
        },
      },
    },
    async (req) => {
      const catalogProvider = req.body.catalogProvider ?? CATALOG_PROVIDER_FOR[req.body.provider];
      const items = req.body.models
        ? proposeModels(ctx.modelCatalog, catalogProvider, req.body.models)
        : catalogProvider
          ? listProposals(ctx.modelCatalog, catalogProvider)
          : [];
      return { catalogProvider, snapshotDate: ctx.modelCatalog.snapshotDate, items };
    },
  );

  app.post(
    '/v1/connections/:id/test',
    {
      config: { access: 'connections:write' },
      schema: {
        tags: ['connections'],
        summary:
          'Test a connection (audited). Model connection: one tiny completion (costs a few tokens, needs `model`). MCP connection (streamable-http): `initialize` and `tools/list` through the outbound dispatcher, answered with a category only; rate limited to 10 per minute per user',
        security: sec,
        params: IdParams,
        body: ConnectionTestBody,
        response: {
          200: z.union([ConnectionTestResultSchema, McpConnectionTestResultSchema]),
          400: ErrorSchema,
          404: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req) => {
      const actor = principalOf(req);
      const row = await catalog.getConnection(actor, req.params.id);
      if (row.kind === 'mcp') return services.mcpTest.test(actor, req.params.id);
      if (!req.body.model)
        throw new HttpError(400, 'validation_failed', 'a model connection test needs "model"');
      return services.models.test(actor, req.params.id, req.body.model);
    },
  );

  // ---------- pinned tool definitions (ADR 0016 section 5) ----------

  app.post(
    '/v1/connections/:id/tools/refresh',
    {
      config: { access: 'connections:write' },
      schema: {
        tags: ['connections'],
        summary:
          'Fetch the tool definitions of an HTTP MCP connection and store them as a pending snapshot (audited; shares the rate limit of the connection test)',
        description:
          'Connects like a run does (outbound dispatcher, destination checks) and lists the tools. The definitions are bounded, reduced to the model-visible fields and refused when they contain a credential. The answer carries the category and the snapshot summary, never a tool text; read the snapshot to review it.',
        security: sec,
        params: IdParams,
        response: {
          200: ToolRefreshResultSchema,
          400: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req) => services.mcpTools.refresh(principalOf(req), req.params.id),
  );

  app.get(
    '/v1/connections/:id/tool-snapshots',
    {
      config: { access: 'connections:read' },
      schema: {
        tags: ['connections'],
        summary: 'List the tool snapshots of an MCP connection (newest first, summaries only)',
        security: sec,
        params: IdParams,
        response: { 200: ToolSnapshotListSchema, 404: ErrorSchema },
      },
    },
    async (req) => services.mcpTools.list(principalOf(req), req.params.id),
  );

  app.get(
    '/v1/connections/:id/tool-snapshots/:digest',
    {
      config: { access: 'connections:read' },
      schema: {
        tags: ['connections'],
        summary:
          'One tool snapshot with its definitions, the current approved snapshot to diff against and the versions that pinned it',
        description:
          'Tool names, descriptions and schemas are untrusted text from the server; show them as data (escape invisible characters), never as instructions.',
        security: sec,
        params: ToolSnapshotParams,
        response: { 200: ToolSnapshotDetailSchema, 404: ErrorSchema },
      },
    },
    async (req) => services.mcpTools.get(principalOf(req), req.params.id, req.params.digest),
  );

  app.post(
    '/v1/connections/:id/tool-snapshots/:digest/approve',
    {
      config: { access: 'connections:write' },
      schema: {
        tags: ['connections'],
        summary:
          'Approve a pending tool snapshot (audited as mcp.tools.approved); `existing-versions` is refused when the granted tools or their access classes changed',
        security: sec,
        params: ToolSnapshotParams,
        body: ToolSnapshotApproveBody,
        response: {
          200: ToolSnapshotSummarySchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req) =>
      services.mcpTools.approve(principalOf(req), req.params.id, req.params.digest, req.body.scope),
  );

  app.post(
    '/v1/connections/:id/tool-snapshots/:digest/reject',
    {
      config: { access: 'connections:write' },
      schema: {
        tags: ['connections'],
        summary: 'Reject a pending tool snapshot (audited as mcp.tools.rejected)',
        security: sec,
        params: ToolSnapshotParams,
        response: {
          200: ToolSnapshotSummarySchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req) => services.mcpTools.reject(principalOf(req), req.params.id, req.params.digest),
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
    async (req) => {
      const row = await catalog.getConnection(principalOf(req), req.params.id);
      return connectionDto(row, catalog.stdioIssues(row));
    },
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
    async (req) => {
      const row = await catalog.updateConnection(principalOf(req), req.params.id, req.body.config);
      return connectionDto(row, catalog.stdioIssues(row));
    },
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
      await catalog.deleteConnection(principalOf(req), req.params.id);
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
    async (req) => ({
      items: (await catalog.listPolicies(principalOf(req))).map(policyDto),
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
      reply.status(201).send(policyDto(await catalog.createPolicy(principalOf(req), req.body))),
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
    async (req) => policyDto(await catalog.getPolicy(principalOf(req), req.params.id)),
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
    async (req) => policyDto(await catalog.updatePolicy(principalOf(req), req.params.id, req.body)),
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
    async (req) => ({
      items: (await services.guidelines.list(principalOf(req).tenantId)).map(guidelineDto),
    }),
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
        .send(guidelineDto(await services.guidelines.create(principalOf(req), req.body))),
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
      const agent = await services.agents.get(req.body.agentId, principalOf(req));
      await services.agents.assertAccess(principalOf(req), agent, 'agents:read');
      const def = agent.latestVersionId
        ? (await services.agents.definitionOf(agent.latestVersionId)).definition
        : services.agents.validate(agent.draftSource).definition;
      const r = await services.guidelines.review(
        principalOf(req),
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
      const d = await catalog.evaluate(
        principalOf(req).tenantId,
        req.body.source,
        req.body.agentId,
        req.body.call,
      );
      return { effect: d.effect, reasons: d.reasons };
    },
  );
}
