import { PERMISSIONS } from '../../../packages/core/src/rbac';
import type {
  Agent,
  AgentVersion,
  AgentVersionDetail,
  ApiToken,
  BudgetOverview,
  Approval,
  AuditEntry,
  Connection,
  EventSource,
  IngestedEvent,
  Me,
  Policy,
  Run,
  RunStep,
  Settings,
  Team,
  User,
} from '../src/api/types';

export const ids = {
  admin: '11111111-1111-4111-8111-111111111111',
  viewer: '22222222-2222-4222-8222-222222222222',
  team: '33333333-3333-4333-8333-333333333333',
  agent: '44444444-4444-4444-8444-444444444444',
  agent2: '45454545-4545-4545-8545-454545454545',
  version: '55555555-5555-4555-8555-555555555555',
  version0: '56565656-5656-4656-8656-565656565656',
  run: '66666666-6666-4666-8666-666666666666',
  run2: '67676767-6767-4767-8767-676767676767',
  approval: '77777777-7777-4777-8777-777777777777',
  source: '88888888-8888-4888-8888-888888888888',
  kafka: '89898989-8989-4989-8989-898989898989',
  event: '99999999-9999-4999-8999-999999999999',
  connection: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  policy: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

const now = new Date();
const iso = (offsetMs = 0) => new Date(now.getTime() + offsetMs).toISOString();

const tenantId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const adminUser: User = {
  id: ids.admin,
  tenantId,
  email: 'ada@example.org',
  displayName: 'Ada Admin',
  source: 'local',
  globalRoles: ['admin'],
  disabled: false,
  teams: [{ teamId: ids.team, role: 'agent-engineer' }],
  createdAt: iso(-86_400_000 * 30),
  lastLoginAt: iso(-60_000),
};

const tenant = { id: tenantId, slug: 'acme', name: 'Acme' };

export const tenantRow = {
  ...tenant,
  monthlyBudgetUsd: null,
  secretRefs: [],
  createdAt: new Date(Date.now() - 86_400_000 * 90).toISOString(),
};

export const meAdmin: Me = {
  user: adminUser,
  tenant,
  platformAdmin: false,
  kind: 'user',
  permissions: [...PERMISSIONS],
  bindings: [{ role: 'admin', teamId: null }],
};

export const meViewer: Me = {
  user: {
    ...adminUser,
    id: ids.viewer,
    displayName: 'Vic Viewer',
    globalRoles: ['viewer'],
    teams: [],
  },
  tenant,
  platformAdmin: false,
  kind: 'user',
  permissions: ['agents:read', 'runs:read', 'events:read', 'costs:read'],
  bindings: [{ role: 'viewer', teamId: null }],
};

export const settings: Settings = {
  version: '0.1.0',
  demo: false,
  providers: [
    { name: 'simulated', kind: 'simulated', clearance: null },
    { name: 'bedrock', kind: 'bedrock', clearance: 'confidential' },
  ],
  runners: [
    { kind: 'in-process', available: true },
    { kind: 'kubernetes-job', available: false },
  ],
  auth: { local: true, ldap: true, oidc: false },
  roles: ['admin', 'agent-engineer', 'integrator', 'operator', 'auditor', 'viewer'],
  permissions: [...PERMISSIONS],
  rolePermissions: {
    admin: [...PERMISSIONS],
    viewer: ['agents:read', 'runs:read', 'events:read', 'costs:read'],
  },
};

export const draftSource = `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ticket-updater
version: 1.1.0
owner: team-security
runtime:
  runner: in-process
  toolbox: jira-cli
agents:
  - id: updater
    provider: simulated
    model: sim-1
---
# Ticket updater
`;

export const publishedSource = draftSource
  .replace('1.1.0', '1.0.0')
  .replace('jira-cli', 'git+node');

export const agent: Agent = {
  id: ids.agent,
  name: 'ticket-updater',
  teamId: ids.team,
  description: 'Moves triaged tickets',
  latestVersion: '1.0.0',
  latestVersionId: ids.version,
  draftUpdatedAt: iso(-3_600_000),
  createdAt: iso(-86_400_000),
  tenant: { ...tenant, slugPath: 'acme' },
  useCase: 'vulnerability-management',
  ownerTeam: { id: ids.team, slug: 'team-security', name: 'Security' },
  status: 'changed',
  lastRun: { id: ids.run, status: 'failed', createdAt: iso(-3_600_000) },
  monthSpendUsd: 41,
  budget: { limitUsd: 50, spentUsd: 41, percentUsed: 82, source: 'team', sourceName: 'Security' },
  draftSource,
};

export const draftOnlyAgent: Agent = {
  ...agent,
  id: ids.agent2,
  name: 'cve-triage',
  description: null,
  latestVersion: null,
  latestVersionId: null,
  teamId: null,
  useCase: null,
  ownerTeam: null,
  lastRun: null,
  monthSpendUsd: null,
  budget: null,
  status: 'draft',
};

export const versions: AgentVersion[] = [
  {
    id: ids.version0,
    agentId: ids.agent,
    version: '0.9.0',
    digest: 'sha256:000000000000000000000000000',
    publishedBy: null,
    publishedAt: iso(-86_400_000 * 2),
  },
  {
    id: ids.version,
    agentId: ids.agent,
    version: '1.0.0',
    digest: 'sha256:111111111111111111111111111',
    publishedBy: ids.admin,
    publishedAt: iso(-86_400_000),
  },
];

export const versionDetail: AgentVersionDetail = {
  ...versions[1]!,
  source: publishedSource,
  definition: {
    name: 'ticket-updater',
    version: '1.0.0',
    owner: 'team-security',
    classification: 'internal',
    triggers: [
      { type: 'webhook', source: 'jira' },
      { type: 'cron', schedule: '0 9 * * 1-5' },
    ],
    budget: { maxCostUsd: 0.2, maxSteps: 8 },
    approvals: { approverRoles: ['operator', 'admin'], timeoutSeconds: 3600 },
    runtime: { runner: 'in-process', toolbox: 'git+node', egress: ['jira.example.org'] },
    agents: [
      {
        id: 'updater',
        provider: 'simulated',
        model: 'sim-1',
        toolbox: 'jira-cli',
        outputs: [{ format: 'ticket-update' }],
        tools: [
          { server: 'tickets', tool: 'get_ticket', args: { key: {} }, approval: 'none' },
          {
            server: 'tickets',
            tool: 'update_ticket',
            args: { key: {}, status: {} },
            approval: 'required',
            maxCallsPerRun: 1,
          },
        ],
      },
    ],
  },
};

export const run: Run = {
  id: ids.run,
  agentId: ids.agent,
  agentName: 'ticket-updater',
  agentVersionId: ids.version,
  teamId: ids.team,
  eventId: ids.event,
  status: 'awaiting_approval',
  triggeredBy: 'webhook:jira',
  createdAt: iso(-120_000),
  startedAt: iso(-110_000),
  finishedAt: null,
  attempts: 1,
  steps: 3,
  tokensIn: 1200,
  tokensOut: 300,
  costMicros: 4200,
  costUsd: 0.0042,
  toolCalls: 1,
  errorCode: null,
  errorMessage: null,
  outputs: [],
};

export const finishedRun: Run = {
  ...run,
  id: ids.run2,
  status: 'failed',
  finishedAt: iso(-30_000),
  errorCode: 'tool_error',
  errorMessage: 'Upstream failed with Bearer abc.def.ghi',
  outputs: [{ agentId: 'updater', format: 'markdown', content: 'Ticket SEC-42 moved.' }],
};

export const steps: RunStep[] = [
  {
    seq: 1,
    kind: 'model_call',
    agentId: 'updater',
    name: 'sim-1',
    status: 'ok',
    input: { messages: 2 },
    output: { text: 'hi' },
    tokensIn: 1200,
    tokensOut: 300,
    costMicros: 4200,
    durationMs: 850,
    provider: 'simulated',
    model: 'sim-1',
    createdAt: iso(-100_000),
  },
  {
    seq: 2,
    kind: 'policy_decision',
    agentId: 'updater',
    name: 'tickets/delete_ticket',
    status: 'denied',
    input: { key: 'SEC-1' },
    output: {
      effect: 'deny',
      reasons: [{ code: 'tool_forbidden', message: 'tool not in allowlist' }],
    },
    tokensIn: 0,
    tokensOut: 0,
    costMicros: 0,
    durationMs: 2,
    provider: null,
    model: null,
    createdAt: iso(-90_000),
  },
  {
    seq: 3,
    kind: 'tool_call',
    agentId: 'updater',
    name: 'tickets/get_ticket',
    status: 'ok',
    input: { key: 'SEC-42', apiKey: 'secret-value' },
    output: null,
    tokensIn: 0,
    tokensOut: 0,
    costMicros: 0,
    durationMs: 1500,
    provider: null,
    model: null,
    createdAt: iso(-80_000),
  },
];

export const approval: Approval = {
  id: ids.approval,
  runId: ids.run,
  pipelineName: 'ticket-updater',
  teamId: ids.team,
  agentId: ids.agent,
  tool: 'tickets/update_ticket',
  args: { key: 'SEC-42', status: 'triaged', token: 'should-not-show' },
  reasons: [{ code: 'approval_required', message: 'update_ticket requires approval' }],
  approverRoles: ['operator', 'admin'],
  status: 'pending',
  requestedAt: iso(-60_000),
  expiresAt: iso(3_600_000),
  decidedBy: null,
  decidedAt: null,
  comment: null,
};

export const sources: EventSource[] = [
  {
    id: ids.source,
    name: 'jira',
    kind: 'webhook',
    scheme: 'oax-v1',
    secretRefs: ['JIRA_WEBHOOK_SECRET'],
    agentId: ids.agent,
    config: {},
    enabled: true,
    createdAt: iso(-86_400_000),
    ingestUrl: 'https://oax.example.org/v1/ingest/webhook/88888888',
  },
  {
    id: ids.kafka,
    name: 'scans',
    kind: 'kafka',
    scheme: 'oax-v1',
    secretRefs: [],
    agentId: null,
    config: { topic: 'security.scans' },
    enabled: false,
    createdAt: iso(-86_400_000),
    ingestUrl: null,
  },
];

export const events: IngestedEvent[] = [
  {
    id: ids.event,
    sourceId: ids.source,
    cloudEventId: 'jira-10001',
    type: 'com.atlassian.jira.issue.updated',
    subject: 'SEC-42',
    receivedAt: iso(-130_000),
    payload: { issue: { key: 'SEC-42' }, password: 'hunter2' },
  },
];

export const connections: Connection[] = [
  {
    id: ids.connection,
    tenantId,
    scope: 'tenant',
    scopeId: null,
    name: 'tickets',
    kind: 'mcp',
    config: {
      url: 'https://mcp.example.internal/mcp',
      headerSecrets: { authorization: 'TICKETS_TOKEN' },
      tools: ['get_ticket', 'update_ticket'],
    },
    createdAt: iso(-86_400_000),
    updatedAt: iso(-3_600_000),
  },
];

export const policies: Policy[] = [
  {
    id: ids.policy,
    scope: 'tenant',
    name: 'default',
    description: 'Baseline guardrails',
    bundle: {
      forbiddenTools: ['*/delete_*', 'shell/*'],
      forbiddenArgPatterns: [{ pattern: 'rm\\s+-rf', reason: 'destructive shell command' }],
      requireApprovalTools: ['*/deploy_*'],
      maxClassification: 'confidential',
    },
    enabled: true,
    version: 3,
    updatedAt: iso(-86_400_000),
  },
];

export const auditEntries: AuditEntry[] = Array.from({ length: 3 }, (_, i) => ({
  seq: 3 - i,
  ts: iso(-i * 60_000),
  actor: i === 0 ? ids.admin : 'agent:ticket-updater/updater',
  action: ['agent.published', 'step.tool_call', 'run.completed'][i]!,
  target: ids.agent,
  runId: i === 0 ? null : ids.run,
  payload: { version: '1.0.0', authorization: 'Bearer xyz' },
  payloadDigest: `sha256:digest${i}`,
  prevHash: `prev${i}`,
  hash: `hash${i}abcdefabcdef`,
}));

export const teams: Team[] = [
  {
    id: ids.team,
    slug: 'team-security',
    name: 'Security',
    monthlyBudgetUsd: 10,
    createdAt: iso(-86_400_000 * 10),
  },
];

export const users: User[] = [
  adminUser,
  { ...meViewer.user, disabled: true, source: 'ldap', lastLoginAt: null },
];

export const tokens: ApiToken[] = [
  {
    id: ids.token,
    name: 'ci-deploy',
    kind: 'api',
    scopes: ['runs:read', 'runs:execute'],
    expiresAt: iso(86_400_000 * 20),
    lastUsedAt: iso(-3_600_000),
    createdAt: iso(-86_400_000),
  },
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    name: 'old',
    kind: 'api',
    scopes: null,
    expiresAt: iso(-1000),
    lastUsedAt: null,
    createdAt: iso(-86_400_000 * 40),
  },
];

export const budgets: BudgetOverview = {
  month: '2026-10-01',
  tenant: {
    scope: 'tenant',
    key: 'default',
    limitUsd: 100,
    spentUsd: 12,
    percentUsed: 12,
    alerts: [],
  },
  useCases: [
    {
      scope: 'use_case',
      key: 'vulnerability-management',
      limitUsd: 10,
      spentUsd: 8.5,
      percentUsed: 85,
      alerts: [50, 80],
    },
    {
      scope: 'use_case',
      key: 'governance',
      limitUsd: 5,
      spentUsd: 5,
      percentUsed: 100,
      alerts: [50, 80, 100],
    },
    { scope: 'use_case', key: 'ops', limitUsd: 5, spentUsd: 1, percentUsed: 20, alerts: [] },
  ],
  teams: [],
};
