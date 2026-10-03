import { Readable } from 'node:stream';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { HttpError } from '../../errors.js';
import {
  AuditEntrySchema,
  AuditExportQuery,
  AuditQuery,
  CheckpointSchema,
  ErrorSchema,
  VerifyBody,
  VerifyResultSchema,
  pageOf,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['audit'];
const date = (s?: string) => (s ? new Date(s) : undefined);

export function registerAuditRoutes(app: ZApp, { services }: Deps): void {
  const { audit } = services;

  app.get(
    '/v1/audit',
    {
      config: { access: 'audit:read' },
      schema: {
        tags,
        summary: 'List audit entries (newest first)',
        security: sec,
        querystring: AuditQuery,
        response: { 200: pageOf(AuditEntrySchema) },
      },
    },
    async (req) =>
      audit.list(
        {
          runId: req.query.runId,
          action: req.query.action,
          from: date(req.query.from),
          to: date(req.query.to),
        },
        req.query.limit,
        req.query.cursor,
      ),
  );

  app.post(
    '/v1/audit/verify',
    {
      config: { access: 'audit:verify' },
      schema: {
        tags,
        summary: 'Verify the hash chain and signed checkpoints',
        security: sec,
        body: VerifyBody,
        response: { 200: VerifyResultSchema },
      },
    },
    async (req) => audit.verify(req.body.fromSeq ?? 1, req.body.toSeq),
  );

  app.get(
    '/v1/audit/export',
    {
      config: { access: 'audit:export' },
      schema: {
        tags,
        summary: 'Export audit entries as NDJSON (oldest first)',
        security: sec,
        querystring: AuditExportQuery,
        produces: ['application/x-ndjson'],
      },
    },
    async (req, reply) => {
      const gen = audit.export({
        runId: req.query.runId,
        action: req.query.action,
        from: date(req.query.from),
        to: date(req.query.to),
      });
      const lines = Readable.from(
        (async function* () {
          for await (const e of gen) yield `${JSON.stringify(e)}\n`;
        })(),
      );
      return reply
        .type('application/x-ndjson')
        .header('content-disposition', 'attachment; filename="openagentix-audit.ndjson"')
        .send(lines);
    },
  );

  app.get(
    '/v1/audit/checkpoints',
    {
      config: { access: 'audit:read' },
      schema: {
        tags,
        summary: 'List signed checkpoints',
        security: sec,
        response: { 200: z.object({ items: z.array(CheckpointSchema) }) },
      },
    },
    async () => ({
      items: await audit.listCheckpoints(),
    }),
  );

  app.post(
    '/v1/audit/checkpoints',
    {
      config: { access: 'settings:write' },
      schema: {
        tags,
        summary: 'Sign the current head of the chain now',
        security: sec,
        response: { 201: CheckpointSchema, 409: ErrorSchema },
      },
    },
    async (_req, reply) => {
      const cp = await audit.checkpoint();
      if (!cp)
        throw new HttpError(
          409,
          'invalid_state',
          'no signing key configured or audit log is empty',
        );
      return reply.status(201).send(cp);
    },
  );
}
