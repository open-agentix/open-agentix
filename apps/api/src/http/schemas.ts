import {
  CLASSIFICATIONS,
  GRANTABLE_ROLES,
  PERMISSIONS,
  RUN_STATUSES,
  STEP_KINDS,
} from '@openagentix/core';
import { AGENT_STATUSES } from '../services/agent-filters.js';
import { PatchAttachmentSchema } from '@openagentix/runners';
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

/** The tenant a row of a `scope=subtree` list belongs to (ADR 0014 3.5). */
export const RowTenantSchema = z.object({
  id: Id,
  slug: z.string(),
  slugPath: z
    .string()
    .describe('slugs from the organisation root to the tenant, e.g. acme/security'),
  name: z.string(),
});

/**
 * `scope` and `tenantId` of the list routes that can span the tenant tree (ADR 0014 3.5). The node
 * list is built on the server from the caller's roles; `tenantId` can only narrow it.
 */
export const SubtreeQuery = z.object({
  scope: z
    .enum(['node', 'subtree'])
    .default('node')
    .describe(
      'node: the acting tenant only (default). subtree: the acting tenant and every descendant the caller may read, each with its own roles; rows then carry `tenant`',
    ),
  tenantId: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      "with scope=subtree: narrow to one node of the subtree (id or slug path). A node outside the caller's reach is 404",
    ),
});

/** Optional paging for lists that have none today; honoured with `scope=subtree` only. */
export const SubtreePageQuery = SubtreeQuery.extend({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('with scope=subtree: page size (default 200)'),
  cursor: z
    .string()
    .max(200)
    .optional()
    .describe('with scope=subtree: `nextCursor` of the previous page'),
});

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
  tenant: z
    .object({
      id: Id,
      slug: z.string(),
      slugPath: z
        .string()
        .describe('slugs from the organisation root to the tenant, e.g. acme/security'),
      name: z.string(),
    })
    .describe(
      'tenant the agent belongs to (the acting tenant, or any node of the subtree with scope=subtree)',
    ),
  useCase: z
    .string()
    .nullable()
    .describe('labels.useCase of the latest published version, of the draft while unpublished'),
  ownerTeam: z
    .object({ id: Id, slug: z.string(), name: z.string() })
    .nullable()
    .describe('owner team; readable with agents:read, like GET /v1/teams'),
  status: z
    .enum(AGENT_STATUSES)
    .describe(
      'draft: never published; published: draft equals latest version; changed: it differs; disabled: switched off, accepts no new runs (wins over the others)',
    ),
  disabledAt: Iso.nullable().describe('when the agent was disabled; null while it is enabled'),
  disabledBy: z
    .object({ id: Id, displayName: z.string() })
    .nullable()
    .describe('user who disabled the agent; null while enabled or if that user no longer exists'),
  disabledReason: z
    .string()
    .nullable()
    .describe('optional reason given when the agent was disabled (at most 500 characters)'),
  lastRun: z
    .object({ id: Id, status: z.enum(RUN_STATUSES), createdAt: Iso })
    .nullable()
    .describe('latest run of the agent the caller may read (runs:read); null if none or no access'),
  monthSpendUsd: z
    .number()
    .nullable()
    .describe('spend of this agent in the current UTC month; null without costs:read'),
  budget: z
    .object({
      limitUsd: z.number(),
      spentUsd: z.number().describe('spend of the whole budget scope this month, not of the agent'),
      percentUsed: z.number(),
      source: z.enum(['tenant', 'use_case', 'team']),
      sourceName: z.string(),
    })
    .nullable()
    .describe(
      'monthly budget closest to its limit among the scopes that apply; null without costs:read or limit',
    ),
});
export const AgentDetailSchema = AgentSchema.extend({ draftSource: z.string() });
export const DisableBody = z
  .object({
    reason: z
      .string()
      .max(500)
      .optional()
      .describe('free text for the audit log, at most 500 characters'),
  })
  .optional();
export const AgentSourceBody = z.object({ source: z.string().min(1).max(512_000) });

export const VersionSchema = z.object({
  id: Id,
  agentId: Id,
  version: z.string(),
  digest: z.string(),
  publishedBy: Id.nullable(),
  publishedAt: Iso,
});
export const ExpansionRecordSchema = z.object({
  agentId: z.string(),
  server: z.string(),
  profile: z.string(),
  tools: z.array(z.string()),
  connectionVersion: z.string(),
});
export const VersionDetailSchema = VersionSchema.extend({
  source: z.string(),
  definition: z.record(z.string(), z.unknown()),
  expansion: z
    .array(ExpansionRecordSchema)
    .optional()
    .describe('profile grants as expanded at publish (also inside `definition`)'),
  expansionDigest: z
    .string()
    .optional()
    .describe('SHA-256 over the expanded grants and the tool classification at publish'),
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
  tenant: RowTenantSchema.optional().describe('with scope=subtree: the tenant the run belongs to'),
});
/** `GET /v1/runs/{id}`: the run plus its trace identity (ADR 0015 section 11). */
export const RunDetailSchema = RunSchema.extend({
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .nullable()
    .describe(
      'W3C trace id of the run (random, server-generated); null for runs created before the trace identity existed',
    ),
  traceUrl: z
    .string()
    .nullable()
    .describe(
      "Link to the trace in the operator's trace backend (OAX_OTEL_TRACE_URL_TEMPLATE); null when no template is configured or the run has no trace",
    ),
});
export const RunListQuery = PageQuery.extend(SubtreeQuery.shape).extend({
  agentId: Id.optional(),
  status: RunStatusSchema.optional(),
  teamId: Id.optional(),
  from: z.string().datetime().optional().describe('created at or after (ISO 8601)'),
  to: z.string().datetime().optional().describe('created before (ISO 8601)'),
});
export const RunStatsQuery = RunListQuery.omit({
  limit: true,
  cursor: true,
  status: true,
  scope: true,
  tenantId: true,
});
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

export const STEP_STATUSES = [
  'ok',
  'error',
  'denied',
  'pending',
  'approved',
  'rejected',
  'skipped',
] as const;
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
  tenant: RowTenantSchema.optional().describe('with scope=subtree: the tenant the row belongs to'),
});
export const ApprovalQuery = PageQuery.extend(SubtreeQuery.shape).extend({
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
  tenant: RowTenantSchema.optional().describe('with scope=subtree: the tenant the row belongs to'),
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
  reason: z
    .enum(['agent_disabled'])
    .nullable()
    .describe('why no run was queued although an agent is bound; the event is stored all the same'),
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
  tenant: RowTenantSchema.optional().describe('with scope=subtree: the tenant the row belongs to'),
});
export const EventListQuery = PageQuery.extend(SubtreeQuery.shape).extend({
  sourceId: Id.optional(),
});

export const ConnectionScopeSchema = z.enum(['platform', 'tenant', 'team', 'agent']);
export const ConnectionSchema = z.object({
  id: Id,
  tenantId: Id,
  scope: ConnectionScopeSchema,
  scopeId: Id.nullable(),
  name: z.string(),
  kind: z.enum(['mcp', 'model']),
  config: z.record(z.string(), z.unknown()),
  warnings: z
    .array(z.string())
    .describe(
      'why the connection is refused at run time although it is stored (tenant stdio connections that break the ADR 0016 command rules); empty when fine',
    ),
  createdAt: Iso,
  updatedAt: Iso,
  tenant: RowTenantSchema.optional().describe('with scope=subtree: the tenant the row belongs to'),
});
export const StdioViolationsSchema = z.object({
  items: z.array(
    z.object({
      connection: ConnectionSchema,
      issues: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })),
    }),
  ),
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
  tenant: RowTenantSchema.optional().describe('with scope=subtree: the tenant the row belongs to'),
});
export const AllTenantsQuery = z.object({
  allTenants: z.coerce
    .boolean()
    .default(false)
    .describe('platform operators only: span every tenant instead of the acting tenant'),
});
export const AuditQuery = PageQuery.extend(SubtreeQuery.shape).extend({
  allTenants: AllTenantsQuery.shape.allTenants,
  runId: Id.optional(),
  action: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export const AuditExportQuery = AuditQuery.omit({
  limit: true,
  cursor: true,
  scope: true,
  tenantId: true,
});
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

/**
 * A cost period bound. Accepts a plain date (`2026-10-01`, `2026-10-15`) or a full ISO 8601
 * timestamp (`2026-10-01T00:00:00.000Z`) and is normalised to the first day of the month (UTC)
 * it falls in, because the cost ledger is kept per month.
 */
const MONTH_BOUND_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
export function toMonthStart(value: string): string | null {
  if (!MONTH_BOUND_RE.test(value)) return null;
  const hasTime = value.includes('T');
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value.slice(10));
  const d = new Date(hasTime && !hasZone ? `${value}Z` : value);
  if (Number.isNaN(d.getTime())) return null;
  if (!hasTime && d.toISOString().slice(0, 10) !== value) return null;
  return `${d.toISOString().slice(0, 7)}-01`;
}
export const MonthBound = z
  .string()
  .regex(MONTH_BOUND_RE, 'expected YYYY-MM-DD or an ISO 8601 timestamp')
  .refine((v) => toMonthStart(v) !== null, 'not a valid date')
  .transform((v) => toMonthStart(v) as string);

export const CostQuery = SubtreeQuery.extend({
  groupBy: z
    .enum(['run', 'agent', 'team', 'tenant', 'use_case', 'month', 'provider', 'model'])
    .default('agent'),
  from: MonthBound.optional().describe(
    'start of the period, inclusive: YYYY-MM-DD or ISO 8601 timestamp, rounded down to the first day of its month (UTC)',
  ),
  to: MonthBound.optional().describe('end of the period, inclusive: same formats as `from`'),
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

/** Roles accepted for grants; `pentest` is not grantable before ADR 0014 slice S6. */
export const RoleSchema = z.enum(GRANTABLE_ROLES);
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
  slugPath: z
    .string()
    .describe('slugs from the organisation root down to this tenant, e.g. `acme/security`'),
  parentId: Id.nullable().describe('parent tenant; null for an organisation (root)'),
  depth: z.number().int().describe('0 for an organisation, 1 for its children, ...'),
  name: z.string(),
  monthlyBudgetUsd: z.number().nullable(),
  secretRefs: z
    .array(z.string())
    .describe('secret reference globs the credential broker may hand out for this tenant'),
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
  secretRefs: z
    .array(z.string().max(128))
    .max(64)
    .optional()
    .describe('secret reference globs (`*` wildcard only); an empty list allows no secret'),
});
export const TenantRefSchema = z.object({ id: Id, slug: z.string(), name: z.string() });
export const ActingTenantSchema = z.object({
  id: Id,
  slug: z.string(),
  slugPath: z.string(),
  name: z.string(),
  path: z
    .array(TenantRefSchema)
    .describe(
      'breadcrumb, root first, ending with the acting tenant itself; ancestors by name only',
    ),
});
export const MeSchema = z.object({
  user: UserSchema,
  tenant: TenantSchema.pick({ id: true, slug: true, name: true }).describe(
    'the tenant the request acts in (same as `actingTenant`; kept for compatibility)',
  ),
  actingTenant: ActingTenantSchema,
  homeTenant: TenantRefSchema.extend({ slugPath: z.string() }).describe(
    'the tenant the user belongs to, regardless of `X-OAX-Tenant`',
  ),
  platformAdmin: z.boolean(),
  kind: z.enum(['user', 'token']),
  permissions: z.array(z.string()),
  bindings: z
    .array(
      z.object({
        role: z.string(),
        teamId: Id.nullable(),
        tenantId: Id.describe('the node the role is bound on'),
        tenantSlugPath: z.string(),
        useCase: z.string().nullable().describe('use case restriction; null = the whole node'),
        inherit: z
          .boolean()
          .describe('true: the binding also applies to every descendant of its node (opt-in)'),
        expiresAt: Iso.nullable().describe('end of the binding; null = does not expire'),
        source: z
          .enum(['direct', 'inherited', 'attached', 'team', 'agent', 'platform'])
          .describe(
            '`direct`: bound on the acting node; `inherited`: bound on an ancestor with ' +
              '`inherit = true` (read permissions only until ADR 0014 S5); `team` / `agent`: a ' +
              'team membership or agent binding of the acting node',
          ),
      }),
    )
    .describe('the grants that apply at the acting node, anchored at the node they are bound on'),
  visibleTenantCount: z
    .number()
    .int()
    .describe('number of tenants the caller can act in (`X-OAX-Tenant`), at least 1'),
  installationMode: z
    .enum(['single', 'multi'])
    .describe('`multi` when the caller can act in more than one tenant, else `single`'),
});

export const TenantTreeQuery = z.object({
  root: z.string().min(1).max(2048).optional().describe('start node: id or slug path'),
  depth: z.coerce.number().int().min(0).max(32).optional().describe('levels below the start node'),
  include: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()) : []))
    .pipe(z.array(z.enum(['counts'])))
    .describe('`counts` adds the per-node counts the caller may read'),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});
export const TenantTreeCountsSchema = z.object({
  agents: z.number().int().nullable(),
  agentsSubtree: z.number().int().nullable(),
  runs30d: z.number().int().nullable(),
  pendingApprovals: z.number().int().nullable(),
  spendMonthUsd: z.number().nullable(),
  spendMonthSubtreeUsd: z.number().nullable(),
  capUsd: z.number().nullable(),
  capSource: z.enum(['tenant']).nullable(),
});
export const TenantTreeNodeSchema = z.object({
  id: Id,
  parentId: Id.nullable(),
  slug: z.string(),
  slugPath: z.string(),
  name: z.string(),
  depth: z.number().int(),
  hasChildren: z.boolean(),
  visible: z
    .boolean()
    .describe('false for an ancestor shown as a path stub: name and slug only, no counts or roles'),
  status: z.enum(['active', 'blocked']),
  myRoles: z.array(z.string()),
  inheritedRoles: z.array(z.string()),
  counts: TenantTreeCountsSchema.nullable().describe(
    'null unless `include=counts`; single fields are null when the caller may not read them',
  ),
});
export const TenantTreeSchema = z.object({
  items: z.array(TenantTreeNodeSchema),
  truncated: z.boolean().describe('more nodes matched than `limit`; the shallowest come first'),
});
export const TenantSearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
export const TenantSearchSchema = z.object({
  items: z.array(
    TenantRefSchema.extend({
      slugPath: z.string(),
      depth: z.number().int(),
      parentId: Id.nullable(),
    }),
  ),
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
  airgapped: z
    .object({
      enabled: z.boolean(),
      allowlist: z
        .number()
        .int()
        .describe('Number of entries on OAX_AIRGAPPED_ALLOW (not their values)'),
      blockedAttempts: z.number().int().describe('Outbound attempts refused since start'),
    })
    .describe('Air-gapped (fail-closed egress) state of this process'),
});

// ---------- worker contract (run token) ----------
export const RunIdParams = z.object({ id: Id });
export const GateBody = z.object({ agentId: z.string(), call: ToolCallSchema });
export const StepBody = z.object({
  kind: z.enum(STEP_KINDS),
  agentId: z.string().nullable(),
  name: z.string().max(500),
  status: z.enum(STEP_STATUSES),
  input: Json.optional(),
  output: Json.optional(),
  tokensIn: z.number().int().nonnegative().max(1e9).optional(),
  tokensOut: z.number().int().nonnegative().max(1e9).optional(),
  costMicros: z.number().int().nonnegative().max(1e12).optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  provider: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  /** Trusted worker only: settles this model reservation (ignored for run nodes). */
  reservationId: z.uuid().optional(),
});

/** Request of an in-process model call reservation (ADR 0009 section 4.4). */
export const ModelReservationBody = z.strictObject({
  agentId: z.string().min(1).max(200),
  inputTokens: z.number().int().nonnegative().max(1e9),
  maxOutputTokens: z.number().int().positive().max(1e9),
  minOutputTokens: z.number().int().positive().max(1e9).optional(),
  cacheWrite: z.boolean().optional(),
});
export const ModelReservationSchema = z.strictObject({
  reservationId: z.string(),
  maxOutputTokens: z.number().int(),
  reservedMicros: z.number().int(),
  priced: z.boolean(),
  deadlineMs: z.number().int().positive().optional(),
  remaining: z.strictObject({
    costMicros: z.number().int().optional(),
    tokens: z.number().int().optional(),
    modelCalls: z.number().int().optional(),
  }),
});

/** Run node protocol (ADR 0008): the node's own step only; nothing about other steps. */
export const StepHandoverQuery = z.object({ agentId: z.string().min(1).max(64) });
export const StepHandoverSchema = z.object({
  agentId: z.string(),
  agent: z.record(z.string(), z.unknown()).describe("the step's own AgentSpec"),
  input: z.unknown().describe('the validated input of the step'),
  outputSchema: z.unknown().optional().describe('output schema with named schemas inlined'),
  attempt: z.number().int(),
  run: z.object({
    name: z.string(),
    version: z.string(),
    classification: z.enum(CLASSIFICATIONS),
    budget: z.record(z.string(), z.unknown()),
  }),
  mcp: z
    .array(z.record(z.string(), z.unknown()))
    .describe('MCP connections of the step with all secret references stripped'),
  stdio: z
    .object({ tenantServers: z.array(z.string()), allowlist: z.array(z.string()) })
    .optional()
    .describe('tenant-defined stdio servers of the step and the command allowlist (ADR 0016)'),
});
export const StepHandoverResultBody = z.object({
  agentId: z.string(),
  format: z.string().max(64),
  content: z.string().max(1_000_000),
  json: Json.optional(),
  patch: PatchAttachmentSchema.optional().describe(
    'the patch the node computed from its workspace (steps with a pull-request output)',
  ),
  failure: z
    .object({
      status: z.enum(['failed', 'blocked_by_policy', 'cancelled']),
      code: z.string().max(100),
      message: z.string().max(2000),
    })
    .optional()
    .describe('set instead of an output when the step did not succeed'),
  usage: z
    .object({
      tokensIn: z.number().int().nonnegative(),
      tokensOut: z.number().int().nonnegative(),
      costMicros: z.number().int().nonnegative(),
      steps: z.number().int().nonnegative(),
      toolCalls: z.number().int().nonnegative(),
    })
    .optional(),
});
export const StepCredentialsRequestBody = z.object({ agentId: z.string().min(1).max(64) });
export const StepCredentialsSchema = z.object({
  agentId: z.string(),
  expiresAt: Iso,
  credentials: z.array(z.object({ secret: z.string(), env: z.string(), value: z.string() })),
  connections: z.array(
    z.object({
      server: z.string(),
      env: z.record(z.string(), z.string()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  ),
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
  nodes: z
    .array(
      z.object({
        node: z.object({ id: Id, slugPath: z.string(), name: z.string() }),
        tenant: BudgetLineSchema,
        useCases: z.array(BudgetLineSchema),
        teams: z.array(BudgetLineSchema),
      }),
    )
    .optional()
    .describe(
      'with scope=subtree: the budgets of every readable node of the subtree (the acting node included), ordered by slug path',
    ),
  nextCursor: z
    .string()
    .nullable()
    .optional()
    .describe('with scope=subtree: cursor of the next page of `nodes`'),
});
export const BudgetQuery = SubtreePageQuery;
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
