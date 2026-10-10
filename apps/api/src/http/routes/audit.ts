import { Readable } from 'node:stream';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { HttpError, forbidden } from '../../errors.js';
import type { Principal } from '@openagentix/core';
import { principalOf } from '../app.js';
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
import { assertNotBoth, rowTenants } from '../subtree.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['audit'];
const date = (s?: string) => (s ? new Date(s) : undefined);

/** The acting tenant, or every tenant for platform operators who ask for it. */
function auditScope(p: Principal, allTenants: boolean): string | 'all' {
  if (!allTenants) return p.tenantId;
  if (!p.platformAdmin) throw forbidden('allTenants needs platform operator access');
  return 'all';
}

export function registerAuditRoutes(app: ZApp, { services }: Deps): void {
  const { audit } = services;

  app.get(
    '/v1/audit',
    {
      config: { access: 'audit:read' },
      schema: {
        tags,
        summary: 'List audit entries (newest first)',
        description:
          'With scope=subtree: the entries of the acting tenant and of every descendant where the caller holds audit:read (entries without a tenant partition are never included).',
        security: sec,
        querystring: AuditQuery,
        response: { 200: pageOf(AuditEntrySchema) },
      },
    },
    async (req) => {
      assertNotBoth(req.query);
      const principal = principalOf(req);
      const subtree = await services.subtree.resolve(principal, 'audit:read', req.query);
      const r = await audit.list(
        {
          tenantId: subtree ? principal.tenantId : auditScope(principal, req.query.allTenants),
          runId: req.query.runId,
          action: req.query.action,
          from: date(req.query.from),
          to: date(req.query.to),
        },
        req.query.limit,
        req.query.cursor,
        subtree,
      );
      if (!subtree) return r;
      const tenantOf = await rowTenants(
        services.subtree,
        subtree,
        r.items.flatMap((e) => (e.tenantId ? [{ tenantId: e.tenantId }] : [])),
      );
      return {
        nextCursor: r.nextCursor,
        items: r.items.map(({ tenantId, ...entry }) => {
          const tenant = tenantId ? tenantOf({ tenantId }) : undefined;
          return tenant ? { ...entry, tenant } : entry;
        }),
      };
    },
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
    async (req) => {
      const p = principalOf(req);
      // The chain is global: operators verify it as a whole, tenants get a redacted result.
      if (p.platformAdmin) return audit.verify(req.body.fromSeq ?? 1, req.body.toSeq);
      return audit.verifyForTenant(p.tenantId);
    },
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
        tenantId: auditScope(principalOf(req), req.query.allTenants),
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
    async (req) => {
      const p = principalOf(req);
      if (!p.platformAdmin) return { items: [] };
      return { items: await audit.listCheckpoints() };
    },
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
    async (req, reply) => {
      if (!principalOf(req).platformAdmin) throw forbidden('platform operator access required');
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
