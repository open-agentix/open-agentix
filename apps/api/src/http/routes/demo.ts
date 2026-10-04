import { z } from 'zod';
import { DemoRateLimited, DemoScenarioService } from '../../demo/scenario-service.js';
import type { Deps } from '../app.js';
import { ErrorSchema } from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['demo'];

const OverviewSchema = z.object({
  llm: z.object({
    mode: z.enum(['simulated', 'claude-code']),
    model: z.string().nullable(),
    dailyBudgetUsd: z.number(),
    spentTodayUsd: z.number(),
    remainingUsd: z.number(),
  }),
  rateLimit: z.object({ runs: z.number().int(), windowSeconds: z.number().int() }),
  scenarios: z.array(
    z.object({ id: z.string(), title: z.string(), description: z.string(), agent: z.string() }),
  ),
});

/** Fixed demo scenarios (only available when `OAX_DEMO_MODE=true`, 404 otherwise). */
export function registerDemoRoutes(app: ZApp, { ctx, services }: Deps): void {
  const demo = new DemoScenarioService(ctx, services);

  app.get(
    '/v1/demo/scenarios',
    {
      config: { access: 'runs:read' },
      schema: {
        tags,
        summary: 'Demo mode: fixed scenarios, limits and the live-model budget',
        security: sec,
        response: { 200: OverviewSchema, 404: ErrorSchema },
      },
    },
    async () => demo.overview(),
  );

  app.post(
    '/v1/demo/scenarios/:scenario/run',
    {
      config: { access: 'runs:read' },
      schema: {
        tags,
        summary: 'Demo mode: run a fixed scenario (no free-text input; rate limited per visitor)',
        security: sec,
        params: z.object({ scenario: z.string().min(1).max(64) }),
        response: { 202: z.object({ runId: z.string() }), 404: ErrorSchema, 429: ErrorSchema },
      },
    },
    async (req, reply) => {
      try {
        return reply.status(202).send(await demo.start(req.params.scenario, req.ip));
      } catch (e) {
        if (e instanceof DemoRateLimited)
          void reply.header('retry-after', String(e.retryAfterSeconds));
        throw e;
      }
    },
  );
}
