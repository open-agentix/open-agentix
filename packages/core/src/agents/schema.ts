import { z } from 'zod';
import { CLASSIFICATIONS } from '../classification.js';
import { ROLES } from '../rbac.js';

export const API_VERSION = 'openagentix.io/v1alpha1';

const slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, 'must be a lowercase slug (a-z, 0-9, -), max. 63 chars');

export const ClassificationSchema = z.enum(CLASSIFICATIONS);

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** Constraint for one tool argument; checked by the policy engine before every tool call. */
export const ArgConstraintSchema = z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object']).optional(),
  required: z.boolean().default(false),
  pattern: z.string().optional(),
  enum: z.array(scalar).min(1).optional(),
  const: scalar.optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  maxItems: z.number().int().positive().optional(),
  /** Regular expressions that must NOT match the (stringified) value. */
  deny: z.array(z.string()).optional(),
});
export type ArgConstraint = z.infer<typeof ArgConstraintSchema>;

export const ToolGrantSchema = z.strictObject({
  /** Name of the MCP server / API connection. */
  server: slug,
  /** Tool name; a trailing `*` grants all tools with that prefix (constraints still apply). */
  tool: z.string().regex(/^[A-Za-z0-9_.-]+\*?$|^\*$/, 'invalid tool name'),
  args: z.record(z.string(), ArgConstraintSchema).default({}),
  allowAdditionalArgs: z.boolean().default(false),
  approval: z.enum(['none', 'required']).default('none'),
  maxCallsPerRun: z.number().int().positive().optional(),
  /** Highest data classification this tool may receive. Defaults to the pipeline classification. */
  classification: ClassificationSchema.optional(),
});
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

export const BudgetSchema = z.strictObject({
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  maxSteps: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const TriggerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('webhook'), source: slug }),
  z.strictObject({ type: z.literal('mail'), source: slug }),
  z.strictObject({ type: z.literal('kafka'), topic: z.string().min(1) }),
  z.strictObject({
    type: z.literal('cron'),
    schedule: z.string().min(9),
    timezone: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('manual') }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const OUTPUT_FORMATS = [
  'markdown',
  'text',
  'json',
  'report',
  'message',
  'ticket-update',
  'pull-request',
] as const;

export const OutputSchema = z.strictObject({
  format: z.enum(OUTPUT_FORMATS),
  /** Optional connection/tool that receives the output (e.g. `chat/post_message`). */
  target: z.string().optional(),
});

export const SimulatedToolCallSchema = z.strictObject({
  server: slug,
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const SimulatedResponseSchema = z.strictObject({
  text: z.string().optional(),
  toolCalls: z.array(SimulatedToolCallSchema).optional(),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
});
export type SimulatedResponse = z.infer<typeof SimulatedResponseSchema>;

export const AgentSpecSchema = z.strictObject({
  id: slug,
  description: z.string().optional(),
  /** Name of a configured provider (see docs/configuration.md), e.g. `simulated`, `bedrock`. */
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokensPerCall: z.number().int().positive().optional(),
  /** Inline instructions; usually taken from the `## Agent: <id>` markdown section instead. */
  instructions: z.string().optional(),
  tools: z.array(ToolGrantSchema).default([]),
  /** Overrides the pipeline toolbox for this agent. */
  toolbox: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*(\+[a-z0-9][a-z0-9-]*)*$/)
    .optional(),
  outputs: z.array(OutputSchema).default([{ format: 'markdown' }]),
  budget: BudgetSchema.optional(),
  /** Scripted model responses used by the `simulated` provider (tests, demos). */
  simulation: z.strictObject({ responses: z.array(SimulatedResponseSchema).min(1) }).optional(),
});
export type AgentSpecInput = z.input<typeof AgentSpecSchema>;

export const RUNNER_KINDS = [
  'in-process',
  'local',
  'container',
  'kubernetes-job',
  'aws-lambda',
  'github-actions',
  'gitlab-ci',
] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

/**
 * Where and with which tools a run executes. A toolbox is a minimal, signed container image from
 * the catalog in `toolboxes/` (e.g. `trivy`, `git+node`); worker nodes are spawned from it (v0.2).
 */
export const RuntimeSchema = z.strictObject({
  runner: z.enum(RUNNER_KINDS).default('in-process'),
  toolbox: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*(\+[a-z0-9][a-z0-9-]*)*$/,
      'toolbox must look like "trivy" or "git+node"',
    )
    .optional(),
  /** Hostnames the worker node may reach (in addition to the control node). */
  egress: z.array(z.string().min(1)).default([]),
});
export type Runtime = z.infer<typeof RuntimeSchema>;

export const ApprovalSettingsSchema = z.strictObject({
  approverRoles: z.array(z.enum(ROLES)).min(1).default(['operator', 'admin']),
  timeoutSeconds: z.number().int().positive().default(3600),
});

export const PipelineFrontMatterSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.enum(['Agent', 'AgentPipeline']),
  name: slug,
  version: z.string(),
  description: z.string().optional(),
  owner: slug,
  classification: ClassificationSchema.default('internal'),
  labels: z.record(z.string(), z.string()).default({}),
  triggers: z.array(TriggerSchema).default([{ type: 'manual' }]),
  budget: BudgetSchema.default({}),
  approvals: ApprovalSettingsSchema.default({
    approverRoles: ['operator', 'admin'],
    timeoutSeconds: 3600,
  }),
  runtime: RuntimeSchema.default({ runner: 'in-process', egress: [] }),
  agents: z.array(AgentSpecSchema).min(1),
  /** Execution order of agent ids; defaults to the order in `agents`. */
  pipeline: z.array(slug).optional(),
});
export type PipelineFrontMatter = z.infer<typeof PipelineFrontMatterSchema>;
