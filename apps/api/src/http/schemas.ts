import { CLASSIFICATIONS, PERMISSIONS, ROLES, RUN_STATUSES, STEP_KINDS } from '@openagentix/core';
import { z } from 'zod';

/** zod schemas of the public API (source of the generated OpenAPI 3.1 document). */

export const Id = z.string().uuid();
export const IdParams = z.object({ id: Id });
export const Json = z.unknown();
export const Iso = z.string().describe('ISO 8601 timestamp');

export const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const IssueSchema = z.object({ path: z.string(), message: z.string() });
export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(IssueSchema),
  warnings: z.array(IssueSchema),
  name: z.string().nullable(),
  version: z.string().nullable(),
  digest: z.string().nullable(),
  definition: z.record(z.string(), z.unknown()).nullable().describe('parsed definition when valid'),
});

export const AgentSchema = z.object({
  id: Id,
  name: z.string(),
  teamId: Id.nullable(),
  description: z.string().nullable(),
  latestVersion: z.string().nullable(),
  latestVersionId: Id.nullable(),
  draftUpdatedAt: Iso,
  createdAt: Iso,
});
export const AgentDetailSchema = AgentSchema.extend({ draftSource: z.string() });
export const AgentSourceBody = z.object({ source: z.string().min(1).max(512_000) });

export const VersionSchema = z.object({
  id: Id,
  agentId: Id,
  version: z.string(),
  digest: z.string(),
  publishedBy: Id.nullable(),
  publishedAt: Iso,
});
export const VersionDetailSchema = VersionSchema.extend({
  source: z.string(),
  definition: z.record(z.string(), z.unknown()),
});
export const PublishResultSchema = z.object({ version: VersionSchema, created: z.boolean() });

export const RunStatusSchema = z.enum(RUN_STATUSES);
export const RunSchema = z.object({
  id: Id,
  agentId: Id,
  agentName: z.string().nullable(),
  agentVersionId: Id,
  teamId: Id.nullable(),
  eventId: Id.nullable(),
  status: RunStatusSchema,
  triggeredBy: z.string(),
  createdAt: Iso,
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
  attempts: z.number().int(),
  steps: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costMicros: z.number().int(),
  costUsd: z.number(),
  toolCalls: z.number().int(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  outputs: Json,
});
export const RunListQuery = PageQuery.extend({
  agentId: Id.optional(),
  status: RunStatusSchema.optional(),
  teamId: Id.optional(),
  from: z.string().datetime().optional().describe('created at or after (ISO 8601)'),
  to: z.string().datetime().optional().describe('created before (ISO 8601)'),
});
export const RunStatsQuery = RunListQuery.omit({ limit: true, cursor: true, status: true });
export const RunStatsSchema = z.object({
  total: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costMicros: z.number().int(),
  costUsd: z.number(),
  avgDurationMs: z.number().nullable(),
});
export const ManualRunBody = z.object({
  data: Json.describe('Event payload (wrapped into a manual CloudEvent) or a full CloudEvent'),
  version: z.string().optional(),
});

export const STEP_STATUSES = ['ok', 'error', 'denied', 'pending', 'approved', 'rejected'] as const;
export const StepSchema = z.object({
  seq: z.number().int(),
  kind: z.enum(STEP_KINDS),
  agentId: z.string().nullable(),
  name: z.string(),
  status: z.enum(STEP_STATUSES),
  input: Json,
  output: Json,
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costMicros: z.number().int(),
  durationMs: z.number().int().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: Iso,
});

export const ApprovalSchema = z.object({
  id: Id,
  runId: Id,
  pipelineName: z.string().nullable().describe('name of the agents.md pipeline of the run'),
  teamId: Id.nullable(),
  agentId: z.string(),
  tool: z.string(),
  args: Json,
  reasons: Json,
  approverRoles: z.array(z.string()),
  status: z.enum(['pending', 'approved', 'rejected', 'timeout']),
  requestedAt: Iso,
  expiresAt: Iso,
  decidedBy: Id.nullable(),
  decidedAt: Iso.nullable(),
  comment: z.string().nullable(),
});
export const ApprovalQuery = PageQuery.extend({
  status: z.enum(['pending', 'approved', 'rejected', 'timeout']).default('pending'),
  runId: Id.optional(),
});
export const DecisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().max(2000).optional(),
});

export const SourceSchema = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(['webhook', 'mail', 'kafka', 'cron']),
  scheme: z.enum(['oax-v1', 'github']),
  secretRefs: z.array(z.string()),
  agentId: Id.nullable(),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  createdAt: Iso,
  ingestUrl: z.string().nullable(),
});
export const SourceCreateBody = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  kind: z.enum(['webhook', 'mail', 'kafka', 'cron']),
  scheme: z.enum(['oax-v1', 'github']).optional(),
  secretRefs: z.array(z.string().min(1)).max(4).optional(),
  agentId: Id.nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});
export const SourcePatchBody = SourceCreateBody.omit({ name: true, kind: true }).partial();
export const IngestResultSchema = z.object({
  eventId: Id,
  runId: Id.nullable(),
  status: z.literal('accepted'),
});
export const SourceIdParams = z.object({ sourceId: Id });

export const EventSchema = z.object({
  id: Id,
  sourceId: Id.nullable(),
  cloudEventId: z.string(),
  type: z.string(),
  subject: z.string().nullable(),
  receivedAt: Iso,
  payload: Json,
});
export const EventListQuery = PageQuery.extend({ sourceId: Id.optional() });

export const ConnectionScopeSchema = z.enum(['platform', 'tenant', 'team', 'agent']);
export const ConnectionSchema = z.object({
  id: Id,
  tenantId: Id,
  scope: ConnectionScopeSchema,
  scopeId: Id.nullable(),
  name: z.string(),
  kind: z.enum(['mcp', 'model']),
  config: z.record(z.string(), z.unknown()),
  createdAt: Iso,
  updatedAt: Iso,
});
export const ConnectionCreateBody = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  kind: z.enum(['mcp', 'model']).default('mcp'),
  scope: ConnectionScopeSchema.default('tenant').describe(
    'who may use it: platform (operators only), tenant, one team or one agent',
  ),
  scopeId: Id.nullable().optional().describe('team or agent id for team/agent scope'),
  config: z
    .record(z.string(), z.unknown())
    .describe(
      'kind mcp: MCP server config (secrets only as references: envSecrets/headerSecrets). ' +
        'kind model: provider settings (`kind`: anthropic, openai, azure-openai, openrouter, vllm, ' +
        'lmstudio, ollama, openai-compatible, bedrock, simulated; keys as `*Secret` references; ' +
        'optional `models` with price overrides - missing prices are proposed from the model catalog)',
    ),
});
export const ModelProposalQuery = z.object({
  provider: z
    .enum([
      'anthropic',
      'openai',
      'azure-openai',
      'openrouter',
      'vllm',
      'lmstudio',
      'ollama',
      'openai-compatible',
      'bedrock',
      'simulated',
    ])
    .describe('provider kind of the connection to create'),
  catalogProvider: z.string().max(100).optional().describe('models.dev provider id override'),
  models: z
    .array(
      z.object({ id: z.string().min(1).max(200), catalogModel: z.string().max(200).optional() }),
    )
    .max(500)
    .optional()
    .describe('models to price; all catalog models of the provider when omitted'),
});
export const ModelProposalSchema = z.object({
  id: z.string(),
  catalogModel: z.string().nullable(),
  name: z.string().nullable(),
  contextTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  inputPerMTok: z.number().nullable().describe('USD per million input tokens'),
  outputPerMTok: z.number().nullable(),
  toolCall: z.boolean().nullable(),
  priceSource: z.enum(['catalog', 'local', 'unknown']),
});
export const ConnectionTestBody = z.object({ model: z.string().min(1).max(200) });
export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int(),
  error: z.string().nullable(),
});
export const ConnectionUpdateBody = z.object({ config: z.record(z.string(), z.unknown()) });

export const PolicySchema = z.object({
  id: Id,
  scope: z.enum(['platform', 'tenant']),
  name: z.string(),
  description: z.string().nullable(),
  bundle: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  version: z.number().int(),
  updatedAt: Iso,
});
export const PolicyCreateBody = z.object({
  scope: z
    .enum(['platform', 'tenant'])
    .default('tenant')
    .describe('platform bundles apply to every tenant and need platform operator access'),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  description: z.string().max(2000).optional(),
  bundle: z.record(z.string(), z.unknown()),
  enabled: z.boolean().default(true),
});
export const PolicyUpdateBody = z.object({
  description: z.string().max(2000).optional(),
  bundle: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});
export const ToolCallSchema = z.object({
  server: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});
export const DecisionSchema = z.object({
  effect: z.enum(['allow', 'deny', 'require_approval']),
  reasons: z.array(z.object({ code: z.string(), message: z.string() })),
});
export const EvaluateBody = z.object({
  source: z.string().min(1).describe('agents.md source to evaluate against'),
  agentId: z
    .string()
    .describe(
      'id of the agent inside the agents.md pipeline (`agents[].id`), not the registry UUID',
    ),
  call: ToolCallSchema,
});

export const AuditEntrySchema = z.object({
  seq: z.number().int(),
  ts: Iso,
  actor: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  runId: z.string().nullable(),
  payload: Json,
  payloadDigest: z.string(),
  prevHash: z.string(),
  hash: z.string(),
});
export const AllTenantsQuery = z.object({
  allTenants: z.coerce
    .boolean()
    .default(false)
    .describe('platform operators only: span every tenant instead of the acting tenant'),
});
export const AuditQuery = PageQuery.extend({
  allTenants: AllTenantsQuery.shape.allTenants,
  runId: Id.optional(),
  action: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export const AuditExportQuery = AuditQuery.omit({ limit: true, cursor: true });
export const VerifyBody = z.object({
  fromSeq: z.number().int().min(1).optional(),
  toSeq: z.number().int().min(1).optional(),
});
export const VerifyResultSchema = z.object({
  valid: z.boolean(),
  checkedEntries: z.number().int(),
  checkedCheckpoints: z.number().int(),
  headSeq: z.number().int(),
  headHash: z.string(),
  issues: z.array(z.object({ seq: z.number().int(), code: z.string(), message: z.string() })),
});
export const CheckpointSchema = z.object({
  seq: z.number().int(),
  hash: z.string(),
  ts: Iso,
  keyId: z.string(),
  signature: z.string(),
});

export const CostQuery = z.object({
  groupBy: z
    .enum(['run', 'agent', 'team', 'tenant', 'use_case', 'month', 'provider', 'model'])
    .default('agent'),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/)
    .optional()
    .describe('first day of a month, inclusive'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  allTenants: AllTenantsQuery.shape.allTenants,
});
export const CostRowSchema = z.object({
  key: z.string().nullable(),
  label: z.string().nullable().describe('agent name / team slug for agent and team groupings'),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costMicros: z.number().int(),
  costUsd: z.number(),
});

export const RoleSchema = z.enum(ROLES);
export const PermissionSchema = z.enum(PERMISSIONS);
export const UserSchema = z.object({
  id: Id,
  tenantId: Id,
  email: z.string(),
  displayName: z.string(),
  source: z.string(),
  globalRoles: z.array(z.string()),
  disabled: z.boolean(),
  teams: z.array(z.object({ teamId: Id, role: z.string() })),
  createdAt: Iso,
  lastLoginAt: Iso.nullable(),
});
export const UserCreateBody = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(200),
  password: z.string().min(12).max(200),
  globalRoles: z.array(RoleSchema).default([]),
});
export const UserPatchBody = z.object({
  displayName: z.string().min(1).max(200).optional(),
  globalRoles: z.array(RoleSchema).optional(),
  disabled: z.boolean().optional(),
});
export const TeamSchema = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  monthlyBudgetUsd: z.number().nullable(),
  createdAt: Iso,
});
export const TeamMemberSchema = z.object({
  userId: Id,
  email: z.string(),
  displayName: z.string(),
  role: z.string(),
});
export const TeamCreateBody = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(200),
  monthlyBudgetUsd: z.number().positive().optional(),
});
export const MembersBody = z.object({
  members: z.array(z.object({ userId: Id, role: RoleSchema })).max(1000),
});

export const TokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  scopes: z.array(z.string()).nullable(),
  expiresAt: Iso,
  lastUsedAt: Iso.nullable(),
  createdAt: Iso,
});
export const IssuedTokenSchema = TokenSchema.extend({
  token: z.string().describe('shown once; store it securely'),
});
export const TokenCreateBody = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(PermissionSchema).optional(),
  expiresInDays: z.number().int().min(1).max(3650).default(90),
});
export const TokenListQuery = z.object({ all: z.coerce.boolean().default(false) });
export const TokenIdParams = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) });

export const LoginBody = z.object({
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1000),
  method: z.enum(['auto', 'local', 'ldap']).default('auto'),
});
export const AuthMethodsSchema = z.object({
  local: z.boolean(),
  ldap: z.boolean(),
  oidc: z.object({ enabled: z.boolean(), loginUrl: z.string().nullable() }),
});
export const LoginResponse = z.object({ token: z.string(), expiresAt: Iso, user: UserSchema });
export const TenantSchema = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  monthlyBudgetUsd: z.number().nullable(),
  createdAt: Iso,
});
export const TenantCreateBody = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(200),
  monthlyBudgetUsd: z.number().positive().optional(),
  admin: z
    .object({
      email: z.string().email(),
      displayName: z.string().min(1).max(200),
      password: z.string().min(12).max(200),
    })
    .optional()
    .describe('first local administrator of the new tenant'),
});
export const TenantPatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  monthlyBudgetUsd: z.number().positive().nullable().optional(),
});
export const MeSchema = z.object({
  user: UserSchema,
  tenant: TenantSchema.pick({ id: true, slug: true, name: true }),
  platformAdmin: z.boolean(),
  kind: z.enum(['user', 'token']),
  permissions: z.array(z.string()),
  bindings: z.array(z.object({ role: z.string(), teamId: Id.nullable() })),
});

export const SettingsSchema = z.object({
  version: z.string(),
  demo: z.boolean().describe('public demo mode: simulated provider, read-only, fake data'),
  providers: z.array(
    z.object({ name: z.string(), kind: z.string(), clearance: z.enum(CLASSIFICATIONS).nullable() }),
  ),
  runners: z.array(z.object({ kind: z.string(), available: z.boolean() })),
  auth: z.object({ local: z.boolean(), ldap: z.boolean(), oidc: z.boolean() }),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  rolePermissions: z.record(z.string(), z.array(z.string())).describe('role -> permissions'),
});
export const VersionInfoSchema = z.object({ name: z.literal('openagentix'), version: z.string() });
export const HealthSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.record(z.string(), z.boolean()).optional(),
});
export const ReadySchema = HealthSchema.extend({
  schema: z.object({ expected: z.number().int(), applied: z.number().int(), ok: z.boolean() }),
});

// ---------- worker contract (run token) ----------
export const RunIdParams = z.object({ id: Id });
export const GateBody = z.object({ agentId: z.string(), call: ToolCallSchema });
export const StepBody = z.object({
  kind: z.enum([
    'model_call',
    'tool_call',
    'policy_decision',
    'approval',
    'control',
    'output',
    'error',
  ]),
  agentId: z.string().nullable(),
  name: z.string().max(500),
  status: z.enum(['ok', 'error', 'denied', 'pending', 'approved', 'rejected']),
  input: Json.optional(),
  output: Json.optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  costMicros: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});
export const ApprovalRequestBody = z.object({
  agentId: z.string(),
  call: ToolCallSchema,
  reasons: Json.optional(),
});
export const ApprovalCreatedSchema = z.object({ approvalId: Id });
export const ApprovalStatusSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'timeout']),
});
export const ApprovalParams = z.object({ id: Id, approvalId: Id });
export const CancelStatusSchema = z.object({ cancelled: z.boolean() });
export const RunResultBody = z.object({
  status: z.enum(['succeeded', 'failed', 'cancelled', 'blocked_by_policy']),
  outputs: z.array(
    z.object({
      agentId: z.string(),
      format: z.string(),
      content: z.string(),
      json: Json.optional(),
    }),
  ),
  usage: z.object({
    tokensIn: z.number().int(),
    tokensOut: z.number().int(),
    costMicros: z.number().int(),
    steps: z.number().int(),
    toolCalls: z.number().int(),
  }),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const BudgetLineSchema = z.object({
  scope: z.enum(['tenant', 'use_case', 'team']),
  key: z.string().nullable().describe('tenant slug, use case label or team slug'),
  limitUsd: z.number().nullable().describe('monthly limit, null when no budget is set'),
  spentUsd: z.number().describe('spend of the current UTC month'),
  percentUsed: z.number().nullable(),
  alerts: z.array(z.number()).describe('alert thresholds (50, 80, 100) raised this month'),
});
export const BudgetOverviewSchema = z.object({
  month: z.string().describe('first day of the current month'),
  tenant: BudgetLineSchema,
  useCases: z.array(BudgetLineSchema),
  teams: z.array(BudgetLineSchema),
});
export const UseCaseParams = z.object({ useCase: z.string().min(1).max(200) });
export const UseCaseBudgetBody = z.object({ monthlyBudgetUsd: z.number().min(0).max(1e9) });
export const BudgetVerdictSchema = z.object({
  blocked: z.boolean(),
  breaches: z.array(
    z.object({
      scope: z.enum(['tenant', 'use_case', 'team']),
      key: z.string(),
      limitMicros: z.number(),
      spentMicros: z.number(),
      message: z.string(),
    }),
  ),
});
