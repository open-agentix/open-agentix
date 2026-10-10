import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
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

/** Id used to make root slugs unique among "siblings without a parent" (migration 0013). */
export const NO_PARENT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Tenant = isolation boundary for agents, runs, connections, keys, audit partition and costs.
 * Tenants form a forest (ADR 0013): `path` holds the ids of the chain (`/<root>/.../<id>/`), a root
 * has `parent_id` null, `depth` 0 and `root_id = id`. The placement columns are written once, at
 * insert, through `placeNode` (packages/core); the database re-checks them (check constraint and
 * trigger of migration 0013) and refuses later changes until moves are implemented.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    rootId: uuid('root_id').notNull(),
    path: text('path').notNull(),
    depth: smallint('depth').notNull().default(0),
    monthlyBudgetMicros: micros('monthly_budget_micros'),
    /**
     * Secret reference globs the credential broker may hand out for this tenant's runs (ADR 0008).
     * Empty = no secret at all (fail closed); the default tenant is migrated to `["*"]`.
     */
    secretRefs: jsonb('secret_refs').$type<string[]>().notNull().default([]),
    /**
     * Authorisation epoch of an organisation, kept on its root (ADR 0014 section 6.1). Bumped by
     * every change that can alter an effective permission; read by slice S2 onwards.
     */
    authzEpoch: bigint('authz_epoch', { mode: 'number' }).notNull().default(0),
    createdAt: created(),
  },
  (t) => [
    // Slugs are unique among siblings. The global `tenants_slug_unique` stays until secret names
    // are node-aware (W13-7): the slug is the secret namespace and resolves X-OAX-Tenant.
    uniqueIndex('tenants_parent_slug_uq').on(
      sql`coalesce(${t.parentId}, '${sql.raw(NO_PARENT_ID)}'::uuid)`,
      t.slug,
    ),
    index('tenants_path_idx').using('btree', t.path.op('text_pattern_ops')),
    index('tenants_parent_idx').on(t.parentId),
    index('tenants_root_idx').on(t.rootId),
    // Names match migration 0013 so that `db:generate` sees no difference.
    foreignKey({
      name: 'tenants_parent_id_fk',
      columns: [t.parentId],
      foreignColumns: [t.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tenants_root_id_fk',
      columns: [t.rootId],
      foreignColumns: [t.id],
    }).onDelete('restrict'),
    check(
      'tenants_tree_check',
      sql`${t.depth} >= 0 AND ${t.depth} <= 32
	AND (${t.parentId} IS NULL) = (${t.depth} = 0)
	AND (${t.parentId} IS NULL) = (${t.rootId} = ${t.id})
	AND ${t.parentId} IS DISTINCT FROM ${t.id}
	AND ${t.path} ~ '^(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})+/$'
	AND char_length(${t.path}) = 37 * (${t.depth} + 1) + 1
	AND ${t.path} LIKE '%/' || ${t.id}::text || '/'
	AND ${t.path} LIKE '/' || ${t.rootId}::text || '/%'`,
    ),
  ],
);

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

/** The seven fixed roles as the database accepts them (check constraints below, migration 0018). */
const ROLE_SQL = sql.raw(
  "('admin','agent-engineer','integrator','operator','auditor','viewer','pentest')",
);

/**
 * Role bindings of users on nodes of the tenant tree (ADR 0014 section 4). `inherit = false`
 * (the default) applies the role at `tenant_id` only; `true` also at every descendant. The trigger
 * `trb_same_org` of migration 0018 keeps `tenant_id` inside the user's home organisation, so a
 * binding can never reach another organisation. The resolver in `@openagentix/core` is the only
 * reader that turns rows into permissions; nothing reads this table to authorise before slice S2.
 * `users.global_roles` is mirrored here for one release (write-through).
 */
export const tenantRoleBindings = pgTable(
  'tenant_role_bindings',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    useCase: text('use_case'),
    inherit: boolean('inherit').notNull().default(false),
    expiresAt: ts('expires_at'),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * `mirror` = a row that mirrors `users.global_roles` (home node, legacy roles; owned by the
     * mirror, the reconcile and the home-move trigger), `grant` = created through the role-binding
     * API (ADR 0014 S4, #226). Part of the unique key, so the two never share a slot.
     */
    source: text('source').notNull().default('mirror'),
    createdAt: created(),
  },
  (t) => [
    check('trb_role_check', sql`${t.role} in ${ROLE_SQL}`),
    check('trb_source_check', sql`${t.source} in ('mirror','grant')`),
    check('trb_pentest_expiry', sql`${t.role} <> 'pentest' or ${t.expiresAt} is not null`),
    check(
      'trb_use_case_len',
      sql`${t.useCase} is null or char_length(${t.useCase}) between 1 and 200`,
    ),
    uniqueIndex('trb_uq').on(
      t.userId,
      t.tenantId,
      t.role,
      sql`coalesce(${t.useCase}, '')`,
      t.source,
    ),
    index('trb_tenant_idx').on(t.tenantId),
    index('trb_user_idx').on(t.userId),
  ],
);

/** Permissions removed from a role at a node and below (ADR 0014 section 5); unused until S9. */
export const tenantRoleRestrictions = pgTable(
  'tenant_role_restrictions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    permission: text('permission').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.role, t.permission] }),
    check('trr_role_check', sql`${t.role} in ${ROLE_SQL}`),
    // A node must not be able to lock out its own administrators.
    check('trr_not_admin', sql`${t.role} <> 'admin'`),
  ],
);

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
    /**
     * `labels.useCase` of the latest published version, or of the draft while the agent was never
     * published. Denormalised so that the agent list can filter and page by it (UX slice A1).
     */
    useCase: text('use_case'),
    /**
     * Set while the agent is disabled (UX slice A7): it accepts no new runs, its published versions
     * stay immutable and visible. `disabledBy` is the user who switched it off.
     */
    disabledAt: ts('disabled_at'),
    disabledBy: uuid('disabled_by'),
    disabledReason: text('disabled_reason'),
    createdBy: uuid('created_by'),
    createdAt: created(),
  },
  (t) => [
    index('agents_team_created_idx').on(t.teamId, t.createdAt.desc(), t.id.desc()),
    index('agents_tenant_created_idx').on(t.tenantId, t.createdAt.desc(), t.id.desc()),
    index('agents_tenant_use_case_idx').on(t.tenantId, t.useCase.op('text_pattern_ops')),
    uniqueIndex('agents_tenant_name_uq').on(t.tenantId, t.name),
    check('agents_disabled_reason_len', sql`char_length(${t.disabledReason}) <= 500`),
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
    /**
     * Trace identity (ADR 0015 section 2): 16 random bytes (hex) and the id of the root span
     * `oax.run.admit`, written once at run creation from a CSPRNG, never derived from the run id
     * and never taken from an input. NULL for runs created before migration 0020 (no trace).
     */
    traceId: text('trace_id'),
    traceRootSpanId: text('trace_root_span_id'),
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
    // Both ids or neither, in W3C shape and not all zero (ADR 0015 section 2).
    check(
      'runs_trace_ids_shape',
      sql`(${t.traceId} is null) = (${t.traceRootSpanId} is null) and (${t.traceId} is null or (${t.traceId} ~ '^[0-9a-f]{32}$' and ${t.traceId} <> repeat('0', 32) and ${t.traceRootSpanId} ~ '^[0-9a-f]{16}$' and ${t.traceRootSpanId} <> repeat('0', 16)))`,
    ),
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
    /** `node:<id>` for steps reported by an untrusted run node; null for the trusted worker. */
    reportedBy: text('reported_by'),
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
    /** Set when the MCP relay used the approval for one call (ADR 0016 S4): single use. */
    consumedAt: ts('consumed_at'),
    /** The scrubber changed the arguments (`[REDACTED]`): the approver sees less than the call has. */
    argsRedacted: boolean('args_redacted').notNull().default(false),
  },
  (t) => [
    index('approvals_status_idx').on(t.status, t.requestedAt.desc(), t.id.desc()),
    index('approvals_run_idx').on(t.runId),
    index('approvals_tenant_status_idx').on(t.tenantId, t.status),
  ],
);

/**
 * One row per isolated run node session (ADR 0008, section 3.3): the unit the credential broker
 * and every worker API call are scoped to. A revoked or expired session kills its run token at
 * once, long before the token's own expiry.
 */
export const runNodeSessions = pgTable(
  'run_node_sessions',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    tenantId: tenant(),
    /** Token worker id of the node. */
    nodeId: text('node_id').notNull(),
    /** The worker that holds the run's lease and created the session; must still hold it. */
    orchestratorId: text('orchestrator_id').notNull(),
    /** Opaque handles of dynamic credentials, recalled on revoke (any control node instance). */
    credentialHandles: jsonb('credential_handles').$type<string[]>().notNull().default([]),
    steps: jsonb('steps').$type<string[]>().notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    revokeReason: text('revoke_reason'),
    /** `jti` of the model token issued for this session (ADR 0009; written by the model proxy). */
    modelTokenJti: text('model_token_jti'),
    /** Agent ids whose credentials were already issued (once per step and session). */
    credentialsIssued: jsonb('credentials_issued').$type<string[]>().notNull().default([]),
    /** What the node may fetch: its step's spec, input, output schema (no other step's data). */
    handover: jsonb('handover'),
    /** The result the node posted; the orchestrator validates it again. */
    result: jsonb('result'),
    /**
     * Workspace seed of the step (DOG-4, ADR 0008 Amendment 5): the base64 of the archive the worker
     * built from the target repository. Fetchable once with the step token, dropped at revoke.
     */
    workspaceSeed: text('workspace_seed'),
    /** SHA-256 (hex) of the archive; kept after the bytes are dropped. */
    workspaceSeedSha256: text('workspace_seed_sha256'),
    workspaceSeedFetchedAt: ts('workspace_seed_fetched_at'),
    /**
     * W3C `traceparent` of the dispatching `invoke_agent` span (ADR 0015 section 6.1), written when
     * the session is created and only while tracing is on. Every span the control node creates for
     * the session is parented from it; the platform, never the node, sets it.
     */
    traceContext: text('trace_context'),
    /**
     * Bounded telemetry state of the session (ADR 0015 section 6.2): the runner and harness kind,
     * the node reports kept as events (`events`, at most `OAX_OTEL_NODE_EVENTS_MAX`) and how many
     * were not kept (`dropped`). Created with the session only while tracing is on (null otherwise),
     * appended to by the control node after it accepted a report, read once when the session ends.
     */
    otelSession: jsonb('otel_session'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('run_node_sessions_node_uq').on(t.nodeId),
    index('run_node_sessions_run_idx').on(t.runId),
    check(
      'run_node_sessions_trace_context_shape',
      sql`${t.traceContext} is null or ${t.traceContext} ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$'`,
    ),
    check(
      'run_node_sessions_otel_session_shape',
      sql`${t.otelSession} is null or coalesce(jsonb_typeof(${t.otelSession}) = 'object' and jsonb_typeof(${t.otelSession}->'events') = 'array' and jsonb_array_length(case when jsonb_typeof(${t.otelSession}->'events') = 'array' then ${t.otelSession}->'events' else '[]'::jsonb end) <= 1000 and jsonb_typeof(${t.otelSession}->'dropped') = 'number', false)`,
    ),
  ],
);

/**
 * Worst-case cost of a model call, held from before the call until it is settled (ADR 0009 4.3).
 * Active rows count against every budget scope, so concurrent calls cannot overshoot a limit.
 */
export const modelReservations = pgTable(
  'model_reservations',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    /** Run node session of a proxied call; null for in-process calls. */
    sessionId: uuid('session_id'),
    /** Id of the step agent inside the published definition (not the agent row). */
    agentId: text('agent_id').notNull(),
    teamId: uuid('team_id'),
    useCase: text('use_case'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    reservedMicros: micros('reserved_micros').notNull(),
    reservedInputTokens: integer('reserved_input_tokens').notNull(),
    reservedOutputTokens: integer('reserved_output_tokens').notNull(),
    /** `active`, `settled` or `expired`. */
    status: text('status').notNull().default('active'),
    actualMicros: micros('actual_micros'),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
    settledAt: ts('settled_at'),
  },
  (t) => [
    check('model_reservations_status', sql`${t.status} in ('active', 'settled', 'expired')`),
    check(
      'model_reservations_nonneg',
      sql`${t.reservedMicros} >= 0 and ${t.reservedInputTokens} >= 0 and ${t.reservedOutputTokens} >= 0 and (${t.actualMicros} is null or ${t.actualMicros} >= 0)`,
    ),
    index('model_reservations_tenant_status_idx').on(t.tenantId, t.status),
    index('model_reservations_run_status_idx').on(t.runId, t.status),
    index('model_reservations_active_expiry_idx')
      .on(t.expiresAt)
      .where(sql`status = 'active'`),
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

/**
 * Snapshots of the tool definitions an MCP connection offered (ADR 0016 section 5). One row per
 * (connection, digest). `digest` is SHA-256 over the RFC 8785 JSON of the tools, `tools` the
 * reduced definitions (untrusted server text, bounded by the check below and by the application,
 * never holding a secret). `tenant_id` is the owner of the connection; every query filters by it.
 * Written by the control node only: a tool list reported by a run node is stored as `pending`
 * with `source = 'run'` and needs an admin before anything uses it.
 */
export const mcpToolSnapshots = pgTable(
  'mcp_tool_snapshots',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    digest: text('digest').notNull(),
    tools: jsonb('tools').notNull(),
    toolCount: integer('tool_count').notNull(),
    /** `pending` until an admin decides; only `approved` snapshots are used for publishing. */
    status: text('status').notNull().default('pending'),
    /** `refresh` (an admin fetched it) or `run` (a run saw a changed list: rug-pull detection). */
    source: text('source').notNull().default('refresh'),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    fetchedBy: uuid('fetched_by'),
    runId: uuid('run_id'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    /** `new-versions` or `existing-versions` (set with the approval). */
    approvalScope: text('approval_scope'),
    rejectedBy: uuid('rejected_by'),
    rejectedAt: ts('rejected_at'),
  },
  (t) => [
    uniqueIndex('mcp_tool_snapshots_connection_digest_uq').on(t.connectionId, t.digest),
    index('mcp_tool_snapshots_tenant_connection_idx').on(t.tenantId, t.connectionId, t.status),
    check('mcp_tool_snapshots_status', sql`${t.status} in ('pending', 'approved', 'rejected')`),
    check('mcp_tool_snapshots_source', sql`${t.source} in ('refresh', 'run')`),
    check(
      'mcp_tool_snapshots_scope',
      sql`${t.approvalScope} is null or ${t.approvalScope} in ('new-versions', 'existing-versions')`,
    ),
    check('mcp_tool_snapshots_digest', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    check(
      'mcp_tool_snapshots_tools',
      sql`jsonb_typeof(${t.tools}) = 'array' and jsonb_array_length(${t.tools}) <= 500 and ${t.toolCount} = jsonb_array_length(${t.tools})`,
    ),
  ],
);

/**
 * `existing-versions` approvals (ADR 0016 section 5): every published version that pinned a
 * snapshot from which `to_digest` is reachable through these rows accepts `to_digest`. The versions
 * themselves stay immutable; this is the connection-level record of the decision.
 */
export const mcpToolSnapshotAcceptances = pgTable(
  'mcp_tool_snapshot_acceptances',
  {
    id: uuid('id').primaryKey(),
    tenantId: tenant(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    fromDigest: text('from_digest').notNull(),
    toDigest: text('to_digest').notNull(),
    acceptedBy: uuid('accepted_by'),
    acceptedAt: ts('accepted_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mcp_tool_snapshot_acceptances_uq').on(t.connectionId, t.fromDigest, t.toDigest),
    index('mcp_tool_snapshot_acceptances_tenant_idx').on(t.tenantId, t.connectionId),
    check(
      'mcp_tool_snapshot_acceptances_digests',
      sql`${t.fromDigest} ~ '^[0-9a-f]{64}$' and ${t.toDigest} ~ '^[0-9a-f]{64}$' and ${t.fromDigest} <> ${t.toDigest}`,
    ),
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
    /** `provider` (reported by the provider), `estimated`, `floor` or `reservation` (ADR 0009 4.1). */
    usageSource: text('usage_source').notNull().default('provider'),
    /** Cache tokens are part of `tokens_in`; these columns hold the breakdown. */
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    /** The reservation this line settled, if any. */
    reservationId: uuid('reservation_id'),
    /** `in-process`, `proxy` or `harness-report`. */
    via: text('via').notNull().default('in-process'),
    createdAt: created(),
  },
  (t) => [
    check('cost_ledger_cost_nonneg', sql`${t.costMicros} >= 0`),
    index('cost_team_month_idx').on(t.teamId, t.month),
    index('cost_agent_month_idx').on(t.agentId, t.month),
    index('cost_month_idx').on(t.month),
    index('cost_run_idx').on(t.runId),
    index('cost_tenant_month_idx').on(t.tenantId, t.month),
    index('cost_use_case_month_idx').on(t.useCase, t.month),
    // A reservation settles into at most one ledger line (settlement idempotency).
    uniqueIndex('cost_ledger_reservation_uq')
      .on(t.reservationId)
      .where(sql`reservation_id is not null`),
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
