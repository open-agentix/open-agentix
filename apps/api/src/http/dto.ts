import type { AuditCheckpoint } from '@openagentix/core';
import type { AgentRow, AgentVersionRow, VersionSummary } from '../services/agents.js';
import type { ConnectionRow, PolicyRow } from '../services/catalog.js';
import type { PublicUser, TeamRow, TenantRow, TokenInfo } from '../services/identity.js';
import type { EventRow, SourceRow } from '../services/ingest.js';
import type { ApprovalRow, RunRow, StepRow } from '../services/runs.js';

const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString());
const isoOrNull = (d: Date | string | null | undefined) => (d ? iso(d) : null);

export const agentDto = (a: AgentRow) => ({
  id: a.id,
  name: a.name,
  teamId: a.teamId,
  description: a.description,
  latestVersion: a.latestVersion,
  latestVersionId: a.latestVersionId,
  draftUpdatedAt: iso(a.draftUpdatedAt),
  createdAt: iso(a.createdAt),
});

export const agentDetailDto = (a: AgentRow) => ({ ...agentDto(a), draftSource: a.draftSource });

export const versionDto = (v: VersionSummary) => ({ ...v, publishedAt: iso(v.publishedAt) });

export const versionDetailDto = (v: AgentVersionRow) => ({
  id: v.id,
  agentId: v.agentId,
  version: v.version,
  digest: v.digest,
  publishedBy: v.publishedBy,
  publishedAt: iso(v.publishedAt),
  source: v.source,
  definition: v.definition as Record<string, unknown>,
});

export const runDto = (r: RunRow, agentName: string | null = null) => ({
  id: r.id,
  agentId: r.agentId,
  agentName,
  agentVersionId: r.agentVersionId,
  teamId: r.teamId,
  eventId: r.eventId,
  status: r.status as never,
  triggeredBy: r.triggeredBy,
  createdAt: iso(r.createdAt),
  startedAt: isoOrNull(r.startedAt),
  finishedAt: isoOrNull(r.finishedAt),
  attempts: r.attempts,
  steps: r.lastSeq,
  tokensIn: r.tokensIn,
  tokensOut: r.tokensOut,
  costMicros: Number(r.costMicros),
  costUsd: Number(r.costMicros) / 1e6,
  toolCalls: r.toolCalls,
  errorCode: r.errorCode,
  errorMessage: r.errorMessage,
  outputs: r.outputs ?? null,
});

export const stepDto = (s: StepRow) => ({
  seq: s.seq,
  kind: s.kind as never,
  agentId: s.agentId,
  name: s.name,
  status: s.status as never,
  input: s.input ?? null,
  output: s.output ?? null,
  tokensIn: s.tokensIn,
  tokensOut: s.tokensOut,
  costMicros: Number(s.costMicros),
  durationMs: s.durationMs,
  provider: s.provider,
  model: s.model,
  createdAt: iso(s.createdAt),
});

export const approvalDto = (a: ApprovalRow, pipelineName: string | null = null) => ({
  id: a.id,
  runId: a.runId,
  pipelineName,
  teamId: a.teamId,
  agentId: a.agentId,
  tool: a.tool,
  args: a.args,
  reasons: a.reasons,
  approverRoles: a.approverRoles,
  status: a.status as never,
  requestedAt: iso(a.requestedAt),
  expiresAt: iso(a.expiresAt),
  decidedBy: a.decidedBy,
  decidedAt: isoOrNull(a.decidedAt),
  comment: a.comment,
});

export const sourceDto = (s: SourceRow, publicUrl: string) => ({
  id: s.id,
  name: s.name,
  kind: s.kind as never,
  scheme: s.scheme as never,
  secretRefs: s.secretRefs,
  agentId: s.agentId,
  config: s.config as Record<string, unknown>,
  enabled: s.enabled,
  createdAt: iso(s.createdAt),
  ingestUrl:
    s.kind === 'kafka' || s.kind === 'cron' ? null : `${publicUrl}/v1/ingest/${s.kind}/${s.id}`,
});

export const eventDto = (e: EventRow) => ({
  id: e.id,
  sourceId: e.sourceId,
  cloudEventId: e.cloudEventId,
  type: e.type,
  subject: e.subject,
  receivedAt: iso(e.receivedAt),
  payload: e.payload,
});

export const connectionDto = (c: ConnectionRow) => ({
  id: c.id,
  tenantId: c.tenantId,
  scope: c.scope as 'platform' | 'tenant' | 'team' | 'agent',
  scopeId: c.scopeId,
  name: c.name,
  kind: c.kind as 'mcp' | 'model',
  config: c.config as Record<string, unknown>,
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
});

export const policyDto = (p: PolicyRow) => ({
  id: p.id,
  scope: p.scope as 'platform' | 'tenant',
  name: p.name,
  description: p.description,
  bundle: p.bundle as Record<string, unknown>,
  enabled: p.enabled,
  version: p.version,
  updatedAt: iso(p.updatedAt),
});

export const userDto = (u: PublicUser) => ({
  ...u,
  createdAt: iso(u.createdAt),
  lastLoginAt: isoOrNull(u.lastLoginAt),
});

export const teamDto = (t: TeamRow) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  monthlyBudgetUsd: t.monthlyBudgetMicros === null ? null : Number(t.monthlyBudgetMicros) / 1e6,
  createdAt: iso(t.createdAt),
});

export const tokenDto = (t: TokenInfo) => ({
  ...t,
  expiresAt: iso(t.expiresAt),
  lastUsedAt: isoOrNull(t.lastUsedAt),
  createdAt: iso(t.createdAt),
});

export const tenantDto = (t: TenantRow) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  monthlyBudgetUsd: t.monthlyBudgetMicros === null ? null : Number(t.monthlyBudgetMicros) / 1e6,
  createdAt: iso(t.createdAt),
});

export const checkpointDto = (c: AuditCheckpoint) => c;
