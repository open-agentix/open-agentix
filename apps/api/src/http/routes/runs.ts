import { isTerminal, type RunStatus } from '@openagentix/core';
import { encodeSeqCursor } from '../../pagination.js';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { approvalDto, runDto, stepDto } from '../dto.js';
import {
  ApprovalQuery,
  ApprovalSchema,
  CostQuery,
  CostRowSchema,
  DecisionBody,
  ErrorSchema,
  IdParams,
  PageQuery,
  RunListQuery,
  RunSchema,
  StepSchema,
  pageOf,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['runs'];

export function registerRunRoutes(app: ZApp, { ctx, services }: Deps): void {
  const { runs } = services;

  app.get(
    '/v1/runs',
    {
      config: { access: 'runs:read' },
      schema: {
        tags,
        summary: 'List runs (keyset pagination)',
        security: sec,
        querystring: RunListQuery,
        response: { 200: pageOf(RunSchema) },
      },
    },
    async (req) => {
      const r = await runs.list(principalOf(req), req.query, req.query.limit, req.query.cursor);
      return { items: r.items.map(runDto), nextCursor: r.nextCursor };
    },
  );

  app.get(
    '/v1/runs/:id',
    {
      config: { access: 'runs:read' },
      schema: {
        tags,
        summary: 'Get a run',
        security: sec,
        params: IdParams,
        response: { 200: RunSchema, 404: ErrorSchema },
      },
    },
    async (req) => runDto(await runs.getVisible(principalOf(req), req.params.id)),
  );

  app.get(
    '/v1/runs/:id/steps',
    {
      config: { access: 'runs:read' },
      schema: {
        tags,
        summary: 'List the steps of a run',
        security: sec,
        params: IdParams,
        querystring: PageQuery,
        response: { 200: pageOf(StepSchema) },
      },
    },
    async (req) => {
      await runs.getVisible(principalOf(req), req.params.id);
      const r = await runs.steps(req.params.id, req.query.limit, req.query.cursor);
      return { items: r.items.map(stepDto), nextCursor: r.nextCursor };
    },
  );

  app.get(
    '/v1/runs/:id/stream',
    {
      config: { access: 'runs:read' },
      schema: {
        tags,
        summary:
          'Stream run steps as Server-Sent Events (`step`, `status`, `end`); resumes from Last-Event-ID',
        security: sec,
        params: IdParams,
        produces: ['text/event-stream'],
      },
    },
    async (req, reply) => {
      await runs.getVisible(principalOf(req), req.params.id);
      const lastId = Number(req.headers['last-event-id'] ?? 0);
      let after = Number.isInteger(lastId) && lastId > 0 ? lastId : 0;
      let closed = false;
      req.raw.on('close', () => (closed = true));
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let lastStatus = '';
      let idle = 0;
      while (!closed) {
        const { items } = await runs.steps(
          req.params.id,
          200,
          after > 0 ? encodeSeqCursor(after) : undefined,
        );
        for (const s of items) {
          reply.raw.write(`id: ${s.seq}\nevent: step\ndata: ${JSON.stringify(stepDto(s))}\n\n`);
          after = s.seq;
        }
        const run = await runs.get(req.params.id);
        if (run.status !== lastStatus) {
          reply.raw.write(`event: status\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
          lastStatus = run.status;
        }
        if (isTerminal(run.status as RunStatus) && items.length === 0) {
          reply.raw.write(`event: end\ndata: ${JSON.stringify(runDto(run))}\n\n`);
          break;
        }
        if (items.length === 0 && ++idle % 30 === 0) reply.raw.write(': keep-alive\n\n');
        await new Promise((r) => setTimeout(r, ctx.config.ssePollMs));
      }
      reply.raw.end();
    },
  );

  app.post(
    '/v1/runs/:id/cancel',
    {
      config: { access: 'runs:cancel' },
      schema: {
        tags,
        summary: 'Cancel a queued or running run',
        security: sec,
        params: IdParams,
        response: { 200: RunSchema, 409: ErrorSchema },
      },
    },
    async (req) => runDto(await runs.cancel(principalOf(req), req.params.id)),
  );

  app.get(
    '/v1/approvals',
    {
      config: { access: 'runs:read' },
      schema: {
        tags: ['approvals'],
        summary: 'List approvals (default: pending)',
        security: sec,
        querystring: ApprovalQuery,
        response: { 200: pageOf(ApprovalSchema) },
      },
    },
    async (req) => {
      const r = await runs.listApprovals(
        principalOf(req),
        req.query.status,
        req.query.limit,
        req.query.cursor,
      );
      return { items: r.items.map(approvalDto), nextCursor: r.nextCursor };
    },
  );

  app.post(
    '/v1/approvals/:id/decision',
    {
      config: { access: 'runs:approve' },
      schema: {
        tags: ['approvals'],
        summary: 'Approve or reject a pending tool call',
        security: sec,
        params: IdParams,
        body: DecisionBody,
        response: { 200: ApprovalSchema, 403: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (req) =>
      approvalDto(
        await runs.decide(principalOf(req), req.params.id, req.body.decision, req.body.comment),
      ),
  );

  app.get(
    '/v1/costs/summary',
    {
      config: { access: 'costs:read' },
      schema: {
        tags: ['costs'],
        summary: 'Costs grouped by run, agent, team, month, provider or model',
        security: sec,
        querystring: CostQuery,
        response: { 200: z.object({ groupBy: z.string(), items: z.array(CostRowSchema) }) },
      },
    },
    async (req) => ({
      groupBy: req.query.groupBy,
      items: await services.costs.summary(
        principalOf(req),
        req.query.groupBy,
        req.query.from,
        req.query.to,
        req.query.limit,
      ),
    }),
  );
}
