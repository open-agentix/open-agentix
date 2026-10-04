import { PLAN_LIMITS } from '@openagentix/core';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import { ErrorSchema, IssueSchema } from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['plans'];
/** JSON escaping can inflate a plan source up to six times; the source itself is capped below. */
const BODY_LIMIT = PLAN_LIMITS.maxSourceBytes * 6 + 4096;

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

const Source = z
  .string()
  .min(1)
  .max(PLAN_LIMITS.maxSourceBytes)
  .describe('The AgentPlan as YAML or JSON text (at most 64 KiB)');
const Connections = z
  .array(slug)
  .max(100)
  .optional()
  .describe('Only offer these connections (names); default: all MCP connections of the tenant');

const FindingSchema = z.object({
  code: z.enum(['LP001', 'LP002', 'LP003', 'LP004', 'LP005', 'LP006', 'LP007', 'LP008', 'MODEL']),
  severity: z.enum(['error', 'warning', 'info']),
  path: z.string(),
  message: z.string(),
  source: z.enum(['lint', 'model']),
});

const LintSchema = z.object({
  kind: z.literal('AgentPlanLint'),
  lintVersion: z.number().int(),
  planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  findings: z.array(FindingSchema),
  summary: z.object({
    error: z.number().int(),
    warning: z.number().int(),
    info: z.number().int(),
  }),
});

const PlanSchema = z
  .record(z.string(), z.unknown())
  .describe('The parsed AgentPlan (defaults applied)');

const UsageSchema = z.object({
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int().describe('micro-USD (1e-6 USD), 0 when the model is unpriced'),
});

const CheckBody = z.object({
  source: Source,
  connections: Connections,
  assist: z
    .object({ provider: slug, model: z.string().min(1).max(200) })
    .optional()
    .describe(
      'Optional model-assisted suggestions: the model can only add info/warning findings. ' +
        'Costed, budget-checked and audited; needs agents:write.',
    ),
});

const CheckResult = z.object({
  valid: z.boolean().describe('false when the plan does not parse; then `errors` says why'),
  errors: z.array(IssueSchema),
  plan: PlanSchema.nullable(),
  lint: LintSchema.nullable(),
  usage: UsageSchema.nullable(),
});

const GenerateBody = z.object({
  source: Source,
  connections: Connections,
  provider: slug.optional().describe('Provider written to every agent (default `simulated`)'),
  model: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/)
    .optional()
    .describe('Model written to every agent (default `simulated`)'),
  owner: slug.optional().describe('Owner (team) of the draft (default `unassigned`)'),
});

const GenerateResult = z.object({
  valid: z.boolean(),
  errors: z.array(IssueSchema),
  plan: PlanSchema.nullable(),
  lint: LintSchema.nullable(),
  draft: z
    .string()
    .nullable()
    .describe('Draft agents.md; null when the plan is invalid or has error findings'),
});

/**
 * Agent Check and Agent Plan v1 (advisory, ADR 0008 section 4). Nothing is stored and nothing is
 * published: a draft only becomes an agent through the normal `POST /v1/agents` flow.
 */
export function registerPlanRoutes(app: ZApp, { ctx, services }: Deps): void {
  const limits = {
    rateLimit: { max: ctx.config.rateLimit.planMax, timeWindow: '1 minute' },
  };

  app.post(
    '/v1/plans/check',
    {
      bodyLimit: BODY_LIMIT,
      config: { access: 'agents:read', ...limits },
      schema: {
        tags,
        summary: 'Check an AgentPlan with the deterministic least-privilege lint (LP001-LP008)',
        security: sec,
        body: CheckBody,
        response: { 200: CheckResult, 402: ErrorSchema, 403: ErrorSchema, 429: ErrorSchema },
      },
    },
    async (req) => services.agentCheck.check(principalOf(req), req.body),
  );

  app.post(
    '/v1/plans/generate',
    {
      bodyLimit: BODY_LIMIT,
      config: { access: 'agents:write', ...limits },
      schema: {
        tags,
        summary: 'Generate a draft agents.md from an AgentPlan (deterministic, no model)',
        security: sec,
        body: GenerateBody,
        response: { 200: GenerateResult, 403: ErrorSchema, 429: ErrorSchema },
      },
    },
    async (req) => services.agentCheck.generate(principalOf(req), req.body),
  );
}
