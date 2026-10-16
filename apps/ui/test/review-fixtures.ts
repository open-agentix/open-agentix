import type {
  InboxItem,
  Review,
  ReviewChanges,
  ReviewComment,
  ReviewThread,
} from '../src/api/types';
import * as f from './fixtures';

/** Fixtures of the review tab (ADR 0017 S2), typed against the generated API types. */
export const rid = {
  review: 'a1111111-1111-4111-8111-111111111111',
  revision: 'a2222222-2222-4222-8222-222222222222',
  revision1: 'a2222222-2222-4222-8222-222222222221',
  thread: 'a3333333-3333-4333-8333-333333333333',
  thread2: 'a3333333-3333-4333-8333-333333333332',
  comment: 'a4444444-4444-4444-8444-444444444444',
  comment2: 'a4444444-4444-4444-8444-444444444442',
  other: 'a5555555-5555-4555-8555-555555555555',
};

const DIGEST = 'd'.repeat(64);
const at = (offset = 0) => new Date(Date.now() + offset).toISOString();

export function review(over: Partial<Review> = {}): Review {
  return {
    id: rid.review,
    agentId: f.ids.agent,
    status: 'open',
    state: 'review_requested',
    openedBy: rid.other,
    openedAt: at(-3_600_000),
    openedRevisionId: rid.revision,
    closedAt: null,
    closedBy: null,
    baseVersion: { id: f.ids.version, version: '1.0.0', digest: 'b'.repeat(64) },
    revision: {
      id: rid.revision,
      seq: 2,
      digest: DIGEST,
      authorId: rid.other,
      authorKind: 'user',
      createdAt: at(-1_800_000),
    },
    requiredApprovals: 1,
    approvalRequired: true,
    digests: {
      digest: DIGEST,
      expansionDigest: 'e'.repeat(64),
      resolutionDigest: 'f'.repeat(64),
      policyDigest: '9'.repeat(64),
    },
    contributors: [rid.other],
    unknownAuthor: false,
    approvals: [],
    you: { eligible: true, code: null, message: null },
    ...over,
  };
}

export function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: rid.comment,
    authorId: rid.other,
    body: 'Why is this host needed?',
    deleted: false,
    createdAt: at(-600_000),
    editedAt: null,
    ...over,
  };
}

export function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: rid.thread,
    reviewId: rid.review,
    createdBy: rid.other,
    anchor: null,
    outdated: false,
    resolved: false,
    resolvedAt: null,
    resolvedBy: null,
    canResolve: false,
    createdAt: at(-600_000),
    comments: [comment()],
    ...over,
  };
}

const facts = (
  over: Partial<ReviewChanges['facts']['head']> = {},
): ReviewChanges['facts']['head'] => ({
  name: 'ticket-updater',
  version: '1.0.1',
  owner: 'team-security',
  classification: 'internal',
  useCase: 'vulnerability-management',
  runtime: { runner: 'in-process', toolbox: null },
  egress: ['api.example.org'],
  budget: {
    maxTokens: null,
    maxCostUsd: 5,
    maxSteps: null,
    maxToolCalls: null,
    timeoutSeconds: null,
  },
  stepBudgets: {},
  tools: [
    {
      key: 'jira/get_issue',
      server: 'jira',
      tool: 'get_issue',
      access: 'read',
      approval: 'none',
      maxCallsPerRun: null,
      classification: null,
      profile: 'jira:read',
      steps: ['a'],
    },
    {
      key: 'jira/create_issue',
      server: 'jira',
      tool: 'create_issue',
      access: 'write',
      approval: 'required',
      maxCallsPerRun: null,
      classification: null,
      profile: null,
      steps: ['a'],
    },
  ],
  secretReferences: [
    { name: 'jira-token', scope: 'legacy', ownerNode: null, env: 'JIRA_TOKEN', steps: ['a'] },
  ],
  steps: [{ id: 'a', provider: 'simulated', model: 'sim-1', access: null }],
  ...over,
});

export const BASE_SOURCE = [
  '---',
  'name: ticket-updater',
  'version: 1.0.0',
  'owner: team-security',
  '---',
].join('\n');
export const HEAD_SOURCE = [
  '---',
  'name: ticket-updater',
  'version: 1.0.1',
  'owner: team-security',
  'runtime:',
  '  egress: [api.example.org]',
  '---',
].join('\n');

export function changes(over: Partial<ReviewChanges> = {}): ReviewChanges {
  const head = facts();
  return {
    reviewId: rid.review,
    revision: { id: rid.revision, seq: 2, digest: DIGEST },
    base: { id: f.ids.version, version: '1.0.0', digest: 'b'.repeat(64), source: BASE_SOURCE },
    headSource: HEAD_SOURCE,
    facts: { base: facts({ egress: [], tools: [head.tools[0]!], secretReferences: [] }), head },
    changes: {
      tools: { added: [head.tools[1]!], removed: [], changed: [] },
      egress: { added: ['api.example.org'], removed: [] },
      secretReferences: { added: head.secretReferences, removed: [] },
      scalars: [{ field: 'budget.maxCostUsd', from: null, to: 5 }],
    },
    policy: {
      requireApprovalForPublish: 'on',
      minApprovals: 1,
      allowedApproverRoles: ['admin', 'agent-maintainer'],
      approverScope: 'tenant',
      approvalExpiryHours: 168,
      allowTokenApprovals: false,
    },
    rules: { available: false, requirements: [] },
    ...over,
  };
}

export const inboxItem = (over: Partial<InboxItem> = {}): InboxItem => ({
  reviewId: rid.review,
  agentId: f.ids.agent,
  agentName: 'ticket-updater',
  state: 'review_requested',
  openedBy: rid.other,
  openedAt: at(-3_600_000),
  revisionSeq: 2,
  requiredApprovals: 1,
  countedApprovals: 0,
  yourDecision: null,
  ...over,
});
