import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import {
  BudgetOverviewSchema,
  DevelopmentBudgetBody,
  ErrorSchema,
  SubtreePageQuery,
  UseCaseBudgetBody,
  UseCaseParams,
} from '../schemas.js';
import { SUBTREE_DEFAULT_PAGE, assertPagingNeedsSubtree } from '../subtree.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['budgets'];

/**
 * Monthly budgets. The tenant-wide limit is set by platform operators with `PATCH /v1/tenants/:id`,
 * team limits with `PATCH /v1/teams/:id`; use case limits are managed here by tenant admins.
 */
export function registerBudgetRoutes(app: ZApp, { services }: Deps): void {
  const { budgets } = services;

  app.get(
    '/v1/budgets',
    {
      config: { access: 'costs:read' },
      schema: {
        tags,
        summary: 'Monthly budgets of the tenant with spend and alerts raised this month',
        description:
          'With scope=subtree `nodes` lists the budgets of every node of the subtree the caller may read costs of (paged by slug path with limit and cursor).',
        security: sec,
        querystring: SubtreePageQuery,
        response: { 200: BudgetOverviewSchema },
      },
    },
    async (req) => {
      assertPagingNeedsSubtree(req.query);
      const principal = principalOf(req);
      const subtree = await services.subtree.resolve(principal, 'costs:read', req.query);
      const overview = await budgets.overview(principal);
      if (!subtree) return overview;
      const r = await budgets.overviewNodes(subtree, {
        limit: req.query.limit ?? SUBTREE_DEFAULT_PAGE,
        cursor: req.query.cursor,
      });
      return { ...overview, nodes: r.items, nextCursor: r.nextCursor };
    },
  );

  app.put(
    '/v1/budgets/use-cases/:useCase',
    {
      config: { access: 'settings:write' },
      schema: {
        tags,
        summary: 'Set the monthly budget of a use case (hard stop, alerts at 50, 80 and 100 %)',
        security: sec,
        params: UseCaseParams,
        body: UseCaseBudgetBody,
        response: { 204: z.null(), 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      await budgets.setUseCaseBudget(
        principalOf(req),
        req.params.useCase,
        req.body.monthlyBudgetUsd,
      );
      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/v1/budgets/use-cases/:useCase',
    {
      config: { access: 'settings:write' },
      schema: {
        tags,
        summary: 'Remove the monthly budget of a use case',
        security: sec,
        params: UseCaseParams,
        response: { 204: z.null(), 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      await budgets.removeUseCaseBudget(principalOf(req), req.params.useCase);
      return reply.status(204).send(null);
    },
  );
  app.put(
    '/v1/budgets/development',
    {
      config: { access: 'settings:write' },
      schema: {
        tags,
        summary:
          'Set the monthly development budget of the node (hard stop, alerts at 50, 80 and 100 %)',
        description:
          'Development runs (runs of draft revisions) are counted against this budget only, never against the production budgets. Until one is set, 10 % of the monthly cap of the node applies.',
        security: sec,
        body: DevelopmentBudgetBody,
        response: { 204: z.null(), 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      await budgets.setDevelopmentBudget(principalOf(req), req.body.monthlyBudgetUsd);
      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/v1/budgets/development',
    {
      config: { access: 'settings:write' },
      schema: {
        tags,
        summary: 'Remove the explicit development budget (10 % of the monthly cap applies again)',
        security: sec,
        response: { 204: z.null(), 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      await budgets.removeDevelopmentBudget(principalOf(req));
      return reply.status(204).send(null);
    },
  );
}
