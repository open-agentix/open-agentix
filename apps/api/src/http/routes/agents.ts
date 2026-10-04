import { createEvent, isCloudEvent, parseCloudEvent } from '@openagentix/events';
import { z } from 'zod';
import { dryRunAgent } from '../../services/dry-run.js';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { agentDetailDto, agentDto, runDto, versionDetailDto, versionDto } from '../dto.js';
import {
  AgentDetailSchema,
  AgentSchema,
  AgentSourceBody,
  ErrorSchema,
  IdParams,
  ManualRunBody,
  MembersBody,
  PageQuery,
  PublishResultSchema,
  RunSchema,
  TeamMemberSchema,
  ValidationResultSchema,
  VersionDetailSchema,
  VersionSchema,
  pageOf,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['agents'];

export function registerAgentRoutes(app: ZApp, { services }: Deps): void {
  const { agents } = services;

  app.get(
    '/v1/agents',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'List agents',
        security: sec,
        querystring: PageQuery.extend({
          q: z.string().max(100).optional().describe('filter by name (substring)'),
        }),
        response: { 200: pageOf(AgentSchema) },
      },
    },
    async (req) => {
      const r = await agents.list(principalOf(req), req.query.limit, req.query.cursor, req.query.q);
      return { items: r.items.map(agentDto), nextCursor: r.nextCursor };
    },
  );

  app.post(
    '/v1/agents',
    {
      config: { access: 'agents:write' },
      schema: {
        tags,
        summary: 'Create an agent from an agents.md draft',
        security: sec,
        body: AgentSourceBody,
        response: { 201: AgentDetailSchema, 400: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(agentDetailDto(await agents.create(principalOf(req), req.body.source))),
  );

  app.post(
    '/v1/agents/validate',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'Validate an agents.md source without storing it',
        security: sec,
        body: AgentSourceBody,
        response: { 200: ValidationResultSchema },
      },
    },
    async (req) => {
      const r = agents.validate(req.body.source);
      return {
        valid: r.valid,
        errors: r.errors,
        warnings: r.warnings,
        name: r.definition?.name ?? null,
        version: r.definition?.version ?? null,
        digest: r.definition?.digest ?? null,
        definition: (r.definition as unknown as Record<string, unknown> | null) ?? null,
      };
    },
  );

  app.get(
    '/v1/agents/:id',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'Get an agent with its draft',
        security: sec,
        params: IdParams,
        response: { 200: AgentDetailSchema },
      },
    },
    async (req) => {
      const a = await agents.get(req.params.id);
      await agents.assertAccess(principalOf(req), a, 'agents:read');
      return agentDetailDto(a);
    },
  );

  app.put(
    '/v1/agents/:id/draft',
    {
      config: { access: 'agents:write' },
      schema: {
        tags,
        summary: 'Replace the draft agents.md',
        security: sec,
        params: IdParams,
        body: AgentSourceBody,
        response: { 200: AgentDetailSchema },
      },
    },
    async (req) =>
      agentDetailDto(await agents.updateDraft(principalOf(req), req.params.id, req.body.source)),
  );

  app.post(
    '/v1/agents/:id/publish',
    {
      config: { access: 'agents:publish' },
      schema: {
        tags,
        summary: 'Publish the draft as an immutable version',
        security: sec,
        params: IdParams,
        response: { 200: PublishResultSchema, 201: PublishResultSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) => {
      const r = await agents.publish(principalOf(req), req.params.id);
      return reply
        .status(r.created ? 201 : 200)
        .send({ version: versionDto(r.version), created: r.created });
    },
  );

  app.get(
    '/v1/agents/:id/versions',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'List published versions',
        security: sec,
        params: IdParams,
        response: { 200: z.object({ items: z.array(VersionSchema) }) },
      },
    },
    async (req) => {
      await agents.assertAccess(principalOf(req), await agents.get(req.params.id), 'agents:read');
      return { items: (await agents.versions(req.params.id)).map(versionDto) };
    },
  );

  app.get(
    '/v1/agents/:id/versions/:version',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'Get a published version (source + parsed definition)',
        security: sec,
        params: IdParams.extend({ version: z.string() }),
        response: { 200: VersionDetailSchema },
      },
    },
    async (req) => {
      await agents.assertAccess(principalOf(req), await agents.get(req.params.id), 'agents:read');
      return versionDetailDto(await agents.getVersion(req.params.id, req.params.version));
    },
  );

  app.get(
    '/v1/agents/:id/members',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'Users with a role on this agent only (agent-scoped bindings)',
        security: sec,
        params: IdParams,
        response: { 200: z.object({ items: z.array(TeamMemberSchema) }) },
      },
    },
    async (req) => {
      await agents.assertAccess(principalOf(req), await agents.get(req.params.id), 'agents:read');
      return { items: await services.identity.agentMembers(req.params.id) };
    },
  );

  app.put(
    '/v1/agents/:id/members',
    {
      config: { access: 'users:write' },
      schema: {
        tags,
        summary: 'Replace the agent-scoped role bindings (user + role) of an agent',
        security: sec,
        params: IdParams,
        body: MembersBody,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await agents.get(req.params.id);
      await services.identity.setAgentMembers(
        principalOf(req).userId,
        req.params.id,
        req.body.members,
      );
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/v1/agents/:id/dry-run',
    {
      config: { access: 'agents:write' },
      schema: {
        tags,
        summary:
          'Dry-run the draft (or a given source) with the simulated provider; tool calls are policy-checked but not executed, nothing is stored',
        security: sec,
        params: IdParams,
        body: z.object({
          data: z.unknown().optional().describe('event payload or CloudEvent'),
          source: z
            .string()
            .max(512_000)
            .optional()
            .describe('agents.md to test instead of the stored draft'),
          approve: z.enum(['all', 'none']).default('all'),
        }),
        response: {
          200: z.object({
            status: z.string(),
            outputs: z.array(
              z.object({ agentId: z.string(), format: z.string(), content: z.string() }),
            ),
            usage: z.record(z.string(), z.number()),
            error: z.object({ code: z.string(), message: z.string() }).nullable(),
            steps: z.array(
              z.object({
                kind: z.string(),
                agentId: z.string().nullable(),
                name: z.string(),
                status: z.string(),
                output: z.unknown(),
              }),
            ),
            auditValid: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      const agent = await agents.get(req.params.id);
      await agents.assertAccess(principalOf(req), agent, 'agents:write');
      const r = await dryRunAgent(
        req.body.source ?? agent.draftSource,
        req.body.data,
        await services.catalog.enabledBundles(),
        req.body.approve,
      );
      return {
        status: r.result.status,
        outputs: r.result.outputs.map((o) => ({
          agentId: o.agentId,
          format: o.format,
          content: o.content,
        })),
        usage: { ...r.result.usage },
        error: r.result.error ?? null,
        steps: r.steps.map((s) => ({
          kind: s.kind,
          agentId: s.agentId,
          name: s.name,
          status: s.status,
          output: s.output ?? null,
        })),
        auditValid: r.auditValid,
      };
    },
  );

  app.post(
    '/v1/agents/:id/runs',
    {
      config: { access: 'runs:execute' },
      schema: {
        tags: ['runs'],
        summary: 'Trigger a run manually',
        security: sec,
        params: IdParams,
        body: ManualRunBody,
        response: { 202: RunSchema },
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      const agent = await agents.get(req.params.id);
      await agents.assertAccess(p, agent, 'runs:execute');
      const event = isCloudEvent(req.body.data)
        ? parseCloudEvent(req.body.data)
        : createEvent({
            source: `/users/${p.userId}`,
            type: 'io.openagentix.manual',
            data: req.body.data ?? null,
          });
      const versionId = req.body.version
        ? (await agents.getVersion(agent.id, req.body.version)).id
        : undefined;
      const run = await services.runs.enqueue({
        agentId: agent.id,
        event,
        triggeredBy: `manual:${p.userId}`,
        ...(versionId ? { versionId } : {}),
      });
      return reply.status(202).send(runDto(run));
    },
  );
}
