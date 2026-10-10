import { isTerminal, type RunStatus } from '@openagentix/core';
import { issueStreamToken } from '../../auth/stream-token.js';
import { encodeSeqCursor } from '../../pagination.js';
import { costLinesToCsv } from '../../services/costs.js';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { approvalDto, runDetailDto, runDto, stepDto } from '../dto.js';
import {
  AllTenantsQuery,
  ApprovalQuery,
  ApprovalSchema,
  CostQuery,
  MonthBound,
  CostRowSchema,
  DecisionBody,
  ErrorSchema,
  IdParams,
  PageQuery,
  RunListQuery,
  RunDetailSchema,
  RunSchema,
  RunStatsQuery,
  RunStatsSchema,
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
      const q = req.query;
      const r = await runs.list(
        principalOf(req),
        {
          ...q,
          from: q.from ? new Date(q.from) : undefined,
          to: q.to ? new Date(q.to) : undefined,
        },
        q.limit,
        q.cursor,
      );
      const names = await runs.agentNames(r.items.map((x) => x.agentId));
      return {
        items: r.items.map((x) => runDto(x, names.get(x.agentId) ?? null)),
        nextCursor: r.nextCursor,
      };
    },
  );

  app.get(
    '/v1/stats/runs',
    {
      config: { access: 'runs:read' },
      schema: {
        tags,
        summary: 'Run counts by status, tokens, cost and average duration (dashboard)',
        security: sec,
        querystring: RunStatsQuery,
        response: { 200: RunStatsSchema },
      },
    },
    async (req) => {
      const q = req.query;
      return runs.stats(principalOf(req), {
        agentId: q.agentId,
        teamId: q.teamId,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
      });
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
        response: { 200: RunDetailSchema, 404: ErrorSchema },
      },
    },
    async (req) =>
      runDetailDto(
        await runs.getVisible(principalOf(req), req.params.id),
        ctx.config.otel.traceUrlTemplate,
      ),
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
      config: { access: 'runs:read', streamToken: true },
      schema: {
        tags,
        summary:
          'Stream run steps as Server-Sent Events (`step`, `status`, `end`); resumes from Last-Event-ID',
        security: sec,
        params: IdParams,
        querystring: z.object({
          access_token: z
            .string()
            .optional()
            .describe('stream token from POST /v1/runs/{id}/stream-token (for EventSource)'),
        }),
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
    '/v1/runs/:id/stream-token',
    {
      config: { access: 'runs:read' },
      schema: {
        tags,
        summary: 'Issue a 60 s token for EventSource access to the run stream (`?access_token=`)',
        security: sec,
        params: IdParams,
        response: { 201: z.object({ token: z.string(), expiresAt: z.string() }) },
      },
    },
    async (req, reply) => {
      const p = principalOf(req);
      await runs.getVisible(p, req.params.id);
      const t = issueStreamToken(
        ctx.config.runToken.secret,
        p.userId,
        req.params.id,
        60,
        ctx.now().getTime(),
      );
      return reply.status(201).send({ token: t.token, expiresAt: t.expiresAt.toISOString() });
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
        req.query.runId,
      );
      const names = await runs.pipelineNames(r.items.map((a) => a.runId));
      return {
        items: r.items.map((a) => approvalDto(a, names.get(a.runId) ?? null)),
        nextCursor: r.nextCursor,
      };
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
    '/v1/costs/export',
    {
      config: { access: 'costs:read' },
      schema: {
        tags: ['costs'],
        summary:
          'Export cost lines (tenant, team, agent, use case, run, step, provider, model) as CSV or JSON',
        security: sec,
        querystring: z.object({
          format: z.enum(['csv', 'json']).default('csv'),
          from: MonthBound.optional(),
          to: MonthBound.optional(),
          allTenants: AllTenantsQuery.shape.allTenants,
        }),
      },
    },
    async (req, reply) => {
      const lines = await services.costs.lines(
        principalOf(req),
        req.query.from,
        req.query.to,
        undefined,
        req.query.allTenants,
      );
      if (req.query.format === 'json')
        return reply.type('application/json').send(JSON.stringify({ items: lines }));
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="openagentix-costs.csv"')
        .send(costLinesToCsv(lines));
    },
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
        req.query.allTenants,
      ),
    }),
  );
}
