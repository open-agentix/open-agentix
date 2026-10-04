import type { paths } from './schema';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** JSON body of the response `S` of `M P`. */
export type ResponseOf<
  P extends keyof paths,
  M extends Method,
  S extends number = 200,
> = paths[P][M] extends { responses: { [K in S]: { content: { 'application/json': infer R } } } }
  ? R
  : never;

/** JSON request body of `M P`. */
export type BodyOf<P extends keyof paths, M extends Method> = paths[P][M] extends {
  requestBody?: { content: { 'application/json': infer B } };
}
  ? B
  : never;

export type Me = ResponseOf<'/v1/me', 'get'>;
export type Settings = ResponseOf<'/v1/settings', 'get'>;
export type LoginResponse = ResponseOf<'/v1/auth/login', 'post'>;
export type User = Me['user'];
export type AgentSummary = ResponseOf<'/v1/agents', 'get'>['items'][number];
export type Agent = ResponseOf<'/v1/agents/{id}', 'get'>;
export type AgentVersion = ResponseOf<'/v1/agents/{id}/versions', 'get'>['items'][number];
export type AgentVersionDetail = ResponseOf<'/v1/agents/{id}/versions/{version}', 'get'>;
export type ValidationResult = ResponseOf<'/v1/agents/validate', 'post'>;
export type PublishResult = ResponseOf<'/v1/agents/{id}/publish', 'post'>;
export type Run = ResponseOf<'/v1/runs/{id}', 'get'>;
export type RunStatus = Run['status'];
export type RunStep = ResponseOf<'/v1/runs/{id}/steps', 'get'>['items'][number];
export type Approval = ResponseOf<'/v1/approvals', 'get'>['items'][number];
export type EventSource = ResponseOf<'/v1/event-sources', 'get'>['items'][number];
export type EventSourceInput = BodyOf<'/v1/event-sources', 'post'>;
export type IngestedEvent = ResponseOf<'/v1/events', 'get'>['items'][number];
export type CostRow = ResponseOf<'/v1/costs/summary', 'get'>['items'][number];
export type CostGroupBy = NonNullable<
  NonNullable<paths['/v1/costs/summary']['get']['parameters']['query']>['groupBy']
>;
export type Connection = ResponseOf<'/v1/connections', 'get'>['items'][number];
export type ModelProposal = ResponseOf<'/v1/models/proposals', 'post'>['items'][number];
export type Policy = ResponseOf<'/v1/policies', 'get'>['items'][number];
export type PolicyEvaluation = ResponseOf<'/v1/policies/evaluate', 'post'>;
export type AuditEntry = ResponseOf<'/v1/audit', 'get'>['items'][number];
export type AuditVerification = ResponseOf<'/v1/audit/verify', 'post'>;
export type AuditCheckpoint = ResponseOf<'/v1/audit/checkpoints', 'get'>['items'][number];
export type Team = ResponseOf<'/v1/teams', 'get'>['items'][number];
export type ApiToken = ResponseOf<'/v1/tokens', 'get'>['items'][number];
export type CreatedApiToken = ResponseOf<'/v1/tokens', 'post', 201>;
export type TokenScope = NonNullable<BodyOf<'/v1/tokens', 'post'>['scopes']>[number];
export type RoleName = NonNullable<BodyOf<'/v1/users', 'post'>['globalRoles']>[number];

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'blocked_by_policy',
] as const satisfies readonly RunStatus[];

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'blocked_by_policy',
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
