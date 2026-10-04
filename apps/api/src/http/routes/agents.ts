import { createEvent, isCloudEvent, parseCloudEvent } from '@openagentix/events';
import { z } from 'zod';
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
  PageQuery,
  PublishResultSchema,
  RunSchema,
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
        querystring: PageQuery,
        response: { 200: pageOf(AgentSchema) },
      },
    },
    async (req) => {
      const r = await agents.list(principalOf(req), req.query.limit, req.query.cursor);
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
      agents.assertAccess(principalOf(req), a, 'agents:read');
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
      agents.assertAccess(principalOf(req), await agents.get(req.params.id), 'agents:read');
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
      agents.assertAccess(principalOf(req), await agents.get(req.params.id), 'agents:read');
      return versionDetailDto(await agents.getVersion(req.params.id, req.params.version));
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
      agents.assertAccess(p, agent, 'runs:execute');
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
