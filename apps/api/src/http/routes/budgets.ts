import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { BudgetOverviewSchema, ErrorSchema, UseCaseBudgetBody, UseCaseParams } from '../schemas.js';
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
        security: sec,
        response: { 200: BudgetOverviewSchema },
      },
    },
    async (req) => budgets.overview(principalOf(req)),
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
}
