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

/**
 * Grant of a named tool profile of a connection (e.g. `{ server: jira, profile: read }`).
 * Expanded into concrete {@link ToolGrant}s when a version is published (ADR 0008); until then a
 * profile grant grants nothing. Argument constraints belong on concrete tool grants.
 */
export const ProfileGrantSchema = z.strictObject({
  server: slug,
  profile: slug,
  approval: z.enum(['none', 'required']).default('none'),
  maxCallsPerRun: z.number().int().positive().optional(),
  classification: ClassificationSchema.optional(),
});
export type ProfileGrant = z.infer<typeof ProfileGrantSchema>;

/** One entry of `agents[].tools`: a concrete tool grant or a profile grant (has `profile`). */
export const ToolEntrySchema = z.unknown().transform((value, ctx): ToolGrant | ProfileGrant => {
  const isProfile = typeof value === 'object' && value !== null && 'profile' in value;
  const result = (isProfile ? ProfileGrantSchema : ToolGrantSchema).safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) ctx.addIssue({ ...issue });
    return z.NEVER;
  }
  return result.data;
});

export function isProfileGrant(entry: ToolGrant | ProfileGrant): entry is ProfileGrant {
  return 'profile' in entry;
}

/**
 * A JSON Schema (2020-12 subset, see ADR 0008) used for typed handovers. Only the shape is checked
 * here; keywords, `$ref` targets and size/depth limits are checked by `checkJsonSchemaSubset`.
 */
export const JsonSchemaValueSchema = z.record(z.string(), z.unknown());

export const HANDOVER_EVENT_SOURCE = 'event';

export const HandoverInputSchema = z.strictObject({
  /** Validates the value the step receives as input (event data, previous output or `from` map). */
  schema: JsonSchemaValueSchema.optional(),
  /** Explicit sources (`event` or ids of earlier steps); the step then sees only these. */
  from: z.array(slug).min(1).max(16).optional(),
});
export type HandoverInput = z.infer<typeof HandoverInputSchema>;

export const HandoverOutputSchema = z.strictObject({
  schema: JsonSchemaValueSchema,
  /** `retry`: one more model turn with the validation errors, then fail. */
  onInvalid: z.enum(['fail', 'retry']).default('fail'),
});
export type HandoverOutput = z.infer<typeof HandoverOutputSchema>;

/** Same format as the secret resolver accepts (see `secrets.ts`). */
export const SECRET_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** A secret reference a step needs (never a value); issued by the credential broker per step. */
export const CredentialRefSchema = z.strictObject({
  secret: z.string().regex(SECRET_REF_PATTERN, 'invalid secret reference'),
  /** Environment variable that receives the value in the step's tool processes. */
  env: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'env must be an upper-case variable name')
    .optional(),
});
export type CredentialRef = z.infer<typeof CredentialRefSchema>;

export const STEP_ACCESS = ['read-only', 'write'] as const;
export type StepAccess = (typeof STEP_ACCESS)[number];

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
 * External agent harnesses that can execute a step through the model proxy (ADR 0009 section 10).
 * Hermes and OpenClaw are documented stubs and therefore not selectable.
 */
export const HARNESS_KINDS = ['claude-code', 'opencode'] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

/** Per-step runtime override: another runner, or a narrower egress list (ADR 0008). */
export const StepRuntimeSchema = z.strictObject({
  runner: z.enum(RUNNER_KINDS).optional(),
  /**
   * Run the step through an external harness that talks to the model proxy (ADR 0009 section 10).
   * Needs an isolating runner; the harness gets the policy gate as its only tool source.
   */
  harness: z.enum(HARNESS_KINDS).optional(),
  /** Must be a subset of the pipeline's `runtime.egress`; a step can only narrow it. */
  egress: z.array(z.string().min(1)).optional(),
});
export type StepRuntime = z.infer<typeof StepRuntimeSchema>;

export const WHEN_MAX_LENGTH = 512;

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
  /** Concrete tool grants and profile grants; the parser splits them (`tools`, `profileGrants`). */
  tools: z.array(ToolEntrySchema).default([]),
  /** Overrides the pipeline toolbox for this agent. */
  toolbox: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*(\+[a-z0-9][a-z0-9-]*)*$/)
    .optional(),
  outputs: z.array(OutputSchema).default([{ format: 'markdown' }]),
  budget: BudgetSchema.optional(),
  /** Scripted model responses used by the `simulated` provider (tests, demos). */
  simulation: z.strictObject({ responses: z.array(SimulatedResponseSchema).min(1) }).optional(),
  // ADR 0008 (additive, optional): typed handovers, conditions, access class, credentials, runtime.
  input: HandoverInputSchema.optional(),
  output: HandoverOutputSchema.optional(),
  /** Condition over `event` and `steps.<id>.output`; the step is skipped when false. */
  when: z.string().min(1).max(WHEN_MAX_LENGTH).optional(),
  access: z.enum(STEP_ACCESS).optional(),
  credentials: z.array(CredentialRefSchema).max(16).optional(),
  runtime: StepRuntimeSchema.optional(),
});
export type AgentSpecInput = z.input<typeof AgentSpecSchema>;

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
  /**
   * `dark-factory`: build software end to end with minimal human touch (opt-in, see
   * DARK_FACTORY_NOTICE). Approval gates of policies and guidelines still apply.
   */
  mode: z.enum(['standard', 'dark-factory']).default('standard'),
  /** Development guideline sets (`name@version`) attached to this agent. */
  guidelines: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]*@\d+\.\d+\.\d+$/, 'use name@x.y.z'))
    .default([]),
  runtime: RuntimeSchema.default({ runner: 'in-process', egress: [] }),
  /** Named JSON Schemas referenced as `{ $ref: '#/schemas/<name>' }` (ADR 0008). */
  schemas: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/, 'invalid schema name'),
      JsonSchemaValueSchema,
    )
    .optional(),
  agents: z.array(AgentSpecSchema).min(1),
  /** Execution order of agent ids; defaults to the order in `agents`. */
  pipeline: z.array(slug).optional(),
});
export type PipelineFrontMatter = z.infer<typeof PipelineFrontMatterSchema>;
