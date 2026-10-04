import type { FastifyRequest } from 'fastify';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { eventDto, sourceDto } from '../dto.js';
import {
  ErrorSchema,
  EventListQuery,
  EventSchema,
  IdParams,
  IngestResultSchema,
  SourceCreateBody,
  SourceIdParams,
  SourcePatchBody,
  SourceSchema,
  pageOf,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';
import { z } from 'zod';

const sec = [{ bearer: [] }];

export function registerEventRoutes(app: ZApp, { ctx, services }: Deps): void {
  const { ingest } = services;
  const url = ctx.config.publicUrl;

  app.get(
    '/v1/event-sources',
    {
      config: { access: 'sources:read' },
      schema: {
        tags: ['events'],
        summary: 'List event sources',
        security: sec,
        response: { 200: z.object({ items: z.array(SourceSchema) }) },
      },
    },
    async () => ({
      items: (await ingest.listSources()).map((s) => sourceDto(s, url)),
    }),
  );

  app.post(
    '/v1/event-sources',
    {
      config: { access: 'sources:write' },
      schema: {
        tags: ['events'],
        summary: 'Create an event source (secrets by reference)',
        security: sec,
        body: SourceCreateBody,
        response: { 201: SourceSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(sourceDto(await ingest.createSource(principalOf(req).userId, req.body), url)),
  );

  app.get(
    '/v1/event-sources/:id',
    {
      config: { access: 'sources:read' },
      schema: {
        tags: ['events'],
        summary: 'Get an event source',
        security: sec,
        params: IdParams,
        response: { 200: SourceSchema },
      },
    },
    async (req) => sourceDto(await ingest.getSource(req.params.id), url),
  );

  app.patch(
    '/v1/event-sources/:id',
    {
      config: { access: 'sources:write' },
      schema: {
        tags: ['events'],
        summary: 'Update an event source',
        security: sec,
        params: IdParams,
        body: SourcePatchBody,
        response: { 200: SourceSchema },
      },
    },
    async (req) =>
      sourceDto(await ingest.updateSource(principalOf(req).userId, req.params.id, req.body), url),
  );

  app.delete(
    '/v1/event-sources/:id',
    {
      config: { access: 'sources:write' },
      schema: {
        tags: ['events'],
        summary: 'Delete an event source (its events are kept)',
        security: sec,
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await ingest.deleteSource(principalOf(req).userId, req.params.id);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/v1/events',
    {
      config: { access: 'events:read' },
      schema: {
        tags: ['events'],
        summary: 'List received events (newest first)',
        security: sec,
        querystring: EventListQuery,
        response: { 200: pageOf(EventSchema) },
      },
    },
    async (req) => {
      const r = await ingest.listEvents(
        { sourceId: req.query.sourceId },
        req.query.limit,
        req.query.cursor,
      );
      return { items: r.items.map(eventDto), nextCursor: r.nextCursor };
    },
  );

  app.get(
    '/v1/events/:id',
    {
      config: { access: 'events:read' },
      schema: {
        tags: ['events'],
        summary: 'Get an event',
        security: sec,
        params: IdParams,
        response: { 200: EventSchema },
      },
    },
    async (req) => eventDto(await ingest.getEvent(req.params.id)),
  );

  // Ingest endpoints need the raw body for HMAC verification, so they get their own parser.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: ctx.config.webhook.maxBytes },
      (_req, body, done) => done(null, body),
    );
    const typed = scope as ZApp;
    for (const kind of ['webhook', 'mail'] as const) {
      typed.post(
        `/v1/ingest/${kind}/:sourceId`,
        {
          config: { access: 'webhook' },
          schema: {
            tags: ['events'],
            summary:
              kind === 'webhook'
                ? 'Receive a signed webhook (any JSON or CloudEvent)'
                : 'Receive a signed mail-in payload',
            security: [{ webhookSignature: [] }],
            params: SourceIdParams,
            response: { 202: IngestResultSchema, 401: ErrorSchema, 409: ErrorSchema },
          },
        },
        async (req: FastifyRequest<{ Params: { sourceId: string } }>, reply) => {
          const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
          const r = await ingest.ingestHttp(
            req.params.sourceId,
            kind,
            req.headers,
            body,
            req.headers['content-type'],
          );
          return reply.status(202).send(r);
        },
      );
    }
  });
}
