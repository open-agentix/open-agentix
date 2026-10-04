import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();
const micros = (name: string) => bigint(name, { mode: 'number' });

/** Id of the tenant every row belongs to until multi-tenancy is configured. */
export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const tenant = () => uuid('tenant_id').notNull().default(DEFAULT_TENANT_ID);

/** Tenant = isolation boundary for agents, runs, connections, keys, audit partition and costs. */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  monthlyBudgetMicros: micros('monthly_budget_micros'),
  createdAt: created(),
});

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    monthlyBudgetMicros: micros('monthly_budget_micros'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('teams_tenant_slug_uq').on(t.tenantId, t.slug)],
);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash'),
  source: text('source').notNull(),
  externalId: text('external_id'),
  globalRoles: text('global_roles')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  disabled: boolean('disabled').notNull().default(false),
  /** Home tenant: every role of the user applies inside this tenant only. */
  tenantId: tenant(),
  /** Platform operators may manage tenants and switch the tenant they act in. */
  platformAdmin: boolean('platform_admin').notNull().default(false),
  createdAt: created(),
  lastLoginAt: ts('last_login_at'),
});

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId, t.role] }),
    index('team_members_user_idx').on(t.userId),
  ],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    secretHash: text('secret_hash').notNull(),
    scopes: text('scopes').array(),
    expiresAt: ts('expires_at').notNull(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: created(),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId, t.createdAt)],
);

export const oidcStates = pgTable('oidc_states', {
  state: text('state').primaryKey(),
  codeVerifier: text('code_verifier').notNull(),
  nonce: text('nonce').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    name: text('name').notNull(),
    teamId: uuid('team_id').references(() => teams.id),
    description: text('description'),
    draftSource: text('draft_source').notNull(),
    draftUpdatedAt: ts('draft_updated_at').notNull().defaultNow(),
    latestVersionId: uuid('latest_version_id'),
    latestVersion: text('latest_version'),
    createdBy: uuid('created_by'),
    createdAt: created(),
  },
  (t) => [
    index('agents_team_created_idx').on(t.teamId, t.createdAt.desc(), t.id.desc()),
    uniqueIndex('agents_tenant_name_uq').on(t.tenantId, t.name),
  ],
);

/** Immutable once inserted (trigger in migration 0001). */
export const agentVersions = pgTable(
  'agent_versions',
  {
    id: uuid('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    version: text('version').notNull(),
    digest: text('digest').notNull(),
    source: text('source').notNull(),
    definition: jsonb('definition').notNull(),
    publishedBy: uuid('published_by'),
    publishedAt: ts('published_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_versions_agent_version_uq').on(t.agentId, t.version),
    index('agent_versions_agent_idx').on(t.agentId, t.publishedAt.desc()),
  ],
);

export const eventSources = pgTable(
  'event_sources',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    scheme: text('scheme').notNull().default('oax-v1'),
    secretRefs: text('secret_refs')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    agentId: uuid('agent_id').references(() => agents.id),
    config: jsonb('config').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: created(),
  },
  (t) => [uniqueIndex('event_sources_tenant_name_uq').on(t.tenantId, t.name)],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    sourceId: uuid('source_id').references(() => eventSources.id),
    cloudEventId: text('cloud_event_id').notNull(),
    type: text('type').notNull(),
    subject: text('subject'),
    payload: jsonb('payload').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [
    index('events_source_received_idx').on(t.sourceId, t.receivedAt.desc(), t.id.desc()),
    index('events_received_idx').on(t.receivedAt.desc(), t.id.desc()),
  ],
);

/** Replay protection for webhooks across all API replicas. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    sourceId: uuid('source_id').notNull(),
    deliveryId: text('delivery_id').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.deliveryId] }),
    index('webhook_deliveries_expiry_idx').on(t.expiresAt),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    agentVersionId: uuid('agent_version_id')
      .notNull()
      .references(() => agentVersions.id),
    teamId: uuid('team_id'),
    eventId: uuid('event_id').references(() => events.id),
    status: text('status').notNull(),
    triggeredBy: text('triggered_by').notNull(),
    createdAt: created(),
    availableAt: ts('available_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    attempts: integer('attempts').notNull().default(0),
    lockedBy: text('locked_by'),
    leaseUntil: ts('lease_until'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    lastSeq: integer('last_seq').notNull().default(0),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costMicros: micros('cost_micros').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    outputs: jsonb('outputs'),
  },
  (t) => [
    index('runs_agent_created_idx').on(t.agentId, t.createdAt.desc(), t.id.desc()),
    index('runs_status_created_idx').on(t.status, t.createdAt.desc(), t.id.desc()),
    index('runs_team_created_idx').on(t.teamId, t.createdAt.desc(), t.id.desc()),
    index('runs_created_idx').on(t.createdAt.desc(), t.id.desc()),
    index('runs_tenant_created_idx').on(t.tenantId, t.createdAt.desc(), t.id.desc()),
    index('runs_queue_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`status = 'queued'`),
    index('runs_lease_idx')
      .on(t.leaseUntil)
      .where(sql`status in ('running', 'awaiting_approval')`),
  ],
);

export const runSteps = pgTable(
  'run_steps',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    agentId: text('agent_id'),
    name: text('name').notNull(),
    status: text('status').notNull(),
    input: jsonb('input'),
    output: jsonb('output'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costMicros: micros('cost_micros').notNull().default(0),
    durationMs: integer('duration_ms'),
    provider: text('provider'),
    model: text('model'),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    index('run_steps_tool_idx').on(t.runId, t.kind, t.name),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    teamId: uuid('team_id'),
    agentId: text('agent_id').notNull(),
    tool: text('tool').notNull(),
    args: jsonb('args').notNull(),
    reasons: jsonb('reasons').notNull(),
    approverRoles: text('approver_roles').array().notNull(),
    status: text('status').notNull(),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    comment: text('comment'),
  },
  (t) => [
    index('approvals_status_idx').on(t.status, t.requestedAt.desc(), t.id.desc()),
    index('approvals_run_idx').on(t.runId),
  ],
);

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    /** Scope of a key/connection: platform, tenant, team or agent (BYOK). */
    scope: text('scope').notNull().default('tenant'),
    scopeId: uuid('scope_id'),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    config: jsonb('config').notNull(),
    createdBy: uuid('created_by'),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Platform connections share one namespace, everything else is unique inside its tenant.
    uniqueIndex('connections_tenant_name_uq').on(t.tenantId, t.name),
  ],
);

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    /** `platform` bundles apply to every tenant (stricter only), `tenant` bundles to one. */
    scope: text('scope').notNull().default('tenant'),
    name: text('name').notNull(),
    description: text('description'),
    bundle: jsonb('bundle').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('policies_tenant_name_uq').on(t.tenantId, t.name)],
);

/** Append-only (trigger + role grants): never UPDATE or DELETE. */
export const auditLog = pgTable(
  'audit_log',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey(),
    /** Partition key for per-tenant views and exports (the chain itself is global in v0.x). */
    tenantId: uuid('tenant_id'),
    ts: ts('ts').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    runId: uuid('run_id'),
    payload: jsonb('payload'),
    payloadDigest: text('payload_digest').notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    index('audit_run_seq_idx').on(t.runId, t.seq),
    index('audit_ts_idx').on(t.ts.desc(), t.seq.desc()),
    index('audit_action_idx').on(t.action, t.seq.desc()),
  ],
);

export const auditCheckpoints = pgTable('audit_checkpoints', {
  seq: bigint('seq', { mode: 'number' }).primaryKey(),
  hash: text('hash').notNull(),
  ts: ts('ts').notNull(),
  keyId: text('key_id').notNull(),
  signature: text('signature').notNull(),
});

export const costLedger = pgTable(
  'cost_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: tenant(),
    runId: uuid('run_id').notNull(),
    stepSeq: integer('step_seq'),
    /** `labels.useCase` of the agent definition (cost attribution). */
    useCase: text('use_case'),
    agentId: uuid('agent_id').notNull(),
    teamId: uuid('team_id'),
    provider: text('provider'),
    model: text('model'),
    month: date('month', { mode: 'string' }).notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costMicros: micros('cost_micros').notNull().default(0),
    createdAt: created(),
  },
  (t) => [
    index('cost_team_month_idx').on(t.teamId, t.month),
    index('cost_agent_month_idx').on(t.agentId, t.month),
    index('cost_month_idx').on(t.month),
    index('cost_run_idx').on(t.runId),
    index('cost_tenant_month_idx').on(t.tenantId, t.month),
    index('cost_use_case_month_idx').on(t.useCase, t.month),
  ],
);

/**
 * Monthly budget of one use case (`labels.useCase`) inside a tenant. The tenant-wide limit lives
 * on `tenants.monthly_budget_micros`, team limits on `teams.monthly_budget_micros`.
 */
export const useCaseBudgets = pgTable(
  'use_case_budgets',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    useCase: text('use_case').notNull(),
    monthlyBudgetMicros: micros('monthly_budget_micros').notNull(),
    createdAt: created(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('use_case_budgets_tenant_uq').on(t.tenantId, t.useCase)],
);

/** Alert thresholds already raised in a month; the primary key keeps every alert to one event. */
export const budgetAlerts = pgTable(
  'budget_alerts',
  {
    tenantId: uuid('tenant_id').notNull(),
    scope: text('scope').notNull(),
    /** Use case or team id; empty for the tenant budget. */
    scopeKey: text('scope_key').notNull().default(''),
    month: date('month', { mode: 'string' }).notNull(),
    thresholdPercent: integer('threshold_percent').notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.scope, t.scopeKey, t.month, t.thresholdPercent] })],
);

/** Deduplicates cron ticks across worker replicas. */
export const cronTicks = pgTable(
  'cron_ticks',
  {
    agentId: uuid('agent_id').notNull(),
    schedule: text('schedule').notNull(),
    tickAt: ts('tick_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.schedule, t.tickAt] })],
);

/** Resource-scoped role bindings: a role for exactly one agent (no team-wide visibility). */
export const agentRoleBindings = pgTable(
  'agent_role_bindings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.agentId, t.role] }),
    index('agent_role_bindings_agent_idx').on(t.agentId),
  ],
);

/** Deterministic change gate of schedule sources: last digest of the probe. */
export const changeChecks = pgTable('change_checks', {
  sourceId: uuid('source_id').primaryKey(),
  digest: text('digest').notNull(),
  checkedAt: ts('checked_at').notNull(),
  changedAt: ts('changed_at').notNull(),
});

/** Versioned development guidelines (global, tenant or agent scope; stricter wins). */
export const guidelines = pgTable(
  'guidelines',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id'),
    scope: text('scope').notNull(),
    scopeId: uuid('scope_id'),
    name: text('name').notNull(),
    version: text('version').notNull(),
    content: text('content').notNull(),
    rules: jsonb('rules').notNull().default({}),
    createdBy: uuid('created_by'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('guidelines_scope_name_version_uq').on(t.scope, t.name, t.version),
    index('guidelines_scope_idx').on(t.scope, t.scopeId),
  ],
);
