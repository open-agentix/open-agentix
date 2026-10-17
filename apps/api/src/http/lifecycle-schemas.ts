import {
  APPROVER_ROLES,
  APPROVER_SCOPES,
  DRAFT_RUN_VALUES,
  IDENTITY_SOURCES,
  MAX_APPROVAL_EXPIRY_HOURS,
  MAX_MIN_APPROVALS,
  PERSONAL_SECRET_VALUES,
  PUBLISH_BY_VALUES,
  REQUIRE_APPROVAL_VALUES,
  UNSIGNED_CONTRIBUTOR_VALUES,
} from '@openagentix/core';
import { z } from 'zod';
import { Id, Iso } from './schemas.js';

/** Schemas of the agent lifecycle endpoints (ADR 0017 S1): revisions, reviews, policy. */

const Digest = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe('SHA-256, lower-case hex');

export const RevisionSchema = z.object({
  id: Id,
  agentId: Id,
  seq: z.number().int().describe('1 for the first revision of the draft; grows by one per change'),
  digest: Digest.describe('SHA-256 of the normalised source, as `agent_versions.digest`'),
  authorId: Id.nullable().describe(
    'null for the upgrade revision (author unknown) and Git commits',
  ),
  authorKind: z.enum(['user', 'repo', 'system']),
  parentId: Id.nullable(),
  sourceCommit: z.string().nullable(),
  createdAt: Iso,
});
export const RevisionDetailSchema = RevisionSchema.extend({ source: z.string() });
export const RevisionListSchema = z.object({
  items: z.array(RevisionSchema),
  nextCursor: z.string().nullable(),
  head: Id.nullable().describe('the newest revision, the one the draft is'),
});
export const RevisionParams = z.object({ id: Id, seq: z.coerce.number().int().min(1) });
export const RevisionListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(40).optional(),
});

export const BindingRefSchema = z.object({
  id: z.string(),
  role: z.string(),
  source: z.string().describe('`mirror`, `grant`, `directory`, `team`, `agent` or `platform`'),
  grantedBy: Id.nullable(),
});

export const DecisionKindSchema = z.enum(['approve', 'request_changes', 'reject']);

export const ApprovalSchema = z.object({
  id: Id,
  reviewerId: Id,
  decision: DecisionKindSchema,
  revisionId: Id,
  digest: Digest,
  expansionDigest: z.string(),
  resolutionDigest: Digest,
  baseVersionId: Id.nullable(),
  policyDigest: Digest,
  reviewerAuth: z.string().describe('`session` or `token:<id>`'),
  actingTenantId: Id,
  bindingRefs: z.array(BindingRefSchema),
  comment: z.string().nullable(),
  decidedAt: Iso,
  expiresAt: Iso.nullable(),
  current: z.boolean().describe("the reviewer's latest decision on the head revision"),
  counted: z.boolean().describe('counts towards the required approvals now'),
  reasons: z
    .array(z.string())
    .describe(
      'why it does not count: `revision_changed`, `superseded`, `expired`, `expansion_changed`, `secret_resolution_changed`, or a refusal code of the rules (the reviewer is no longer eligible)',
    ),
});

export const ReviewStateSchema = z.enum([
  'review_requested',
  'changes_requested',
  'approved',
  'withdrawn',
  'rejected',
  'published',
]);

export const ReviewSchema = z.object({
  id: Id,
  agentId: Id,
  status: z.enum(['open', 'withdrawn', 'rejected', 'published']),
  state: ReviewStateSchema,
  openedBy: Id,
  openedAt: Iso,
  openedRevisionId: Id,
  closedAt: Iso.nullable(),
  closedBy: Id.nullable(),
  baseVersion: z
    .object({ id: Id, version: z.string(), digest: Digest })
    .nullable()
    .describe('what the diff is computed against: the latest published version when it was opened'),
  revision: z.object({
    id: Id,
    seq: z.number().int(),
    digest: Digest,
    authorId: Id.nullable(),
    authorKind: z.string(),
    createdAt: Iso,
  }),
  requiredApprovals: z.number().int(),
  approvalRequired: z
    .boolean()
    .describe('whether the tenant policy requires an approval to publish this agent'),
  digests: z.object({
    digest: Digest,
    expansionDigest: z.string(),
    resolutionDigest: Digest,
    policyDigest: Digest,
  }),
  contributors: z.array(Id).describe('everybody who can never approve this review'),
  unknownAuthor: z
    .boolean()
    .describe('a revision of the window has no known author; the audit chain stands in for it'),
  approvals: z.array(ApprovalSchema),
  you: z.object({
    eligible: z.boolean(),
    code: z.string().nullable(),
    message: z.string().nullable(),
  }),
});
export const ReviewListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(100).optional(),
});
export const ReviewListSchema = z.object({
  items: z.array(ReviewSchema),
  nextCursor: z.string().nullable(),
});

export const ClearHoldBody = z.object({
  reason: z.string().min(1).max(500).describe('why the hold is released (kept in the hold record)'),
});

export const ClearHoldResultSchema = z.object({
  reviewId: Id,
  clearedBy: Id,
  clearedAt: z.string(),
});

export const DecisionBody = z.object({
  decision: DecisionKindSchema,
  expectedDigest: Digest.describe('the digest of the revision you looked at (`revision.digest`)'),
  expectedExpansionDigest: z
    .string()
    .max(64)
    .optional()
    .describe('required for an approval and while approval is required'),
  expectedResolutionDigest: Digest.optional().describe(
    'required for an approval and while approval is required',
  ),
  expectedPolicyDigest: Digest.optional().describe(
    'required for an approval and while approval is required',
  ),
  comment: z
    .string()
    .max(10_000)
    .optional()
    .describe('required for `request_changes` and `reject`; never copied to the audit chain'),
});
export const DecisionResultSchema = z.object({ review: ReviewSchema, decision: ApprovalSchema });

// ---------------------------------------------------------------- policy

const LifecycleValues = z.object({
  requireApprovalForPublish: z.enum(REQUIRE_APPROVAL_VALUES),
  productionUseCases: z.array(z.string()),
  selfApproval: z.literal('never'),
  minApprovals: z.number().int().min(1).max(MAX_MIN_APPROVALS),
  allowedApproverRoles: z.array(z.enum(APPROVER_ROLES)),
  approverScope: z.enum(APPROVER_SCOPES),
  approvalExpiryHours: z.number().int().min(1).max(MAX_APPROVAL_EXPIRY_HOURS),
  allowTokenApprovals: z.boolean(),
  approverIdentitySources: z.array(z.enum(IDENTITY_SOURCES)),
  publishBy: z.enum(PUBLISH_BY_VALUES),
  allowDraftRuns: z.enum(DRAFT_RUN_VALUES),
  allowPersonalSecretsInDevRuns: z.boolean(),
  allowPersonalSecretsInPublishedAgents: z.enum(PERSONAL_SECRET_VALUES),
  allowProductionSecretsInDraftRuns: z.boolean(),
  gitUnsignedContributors: z.enum(UNSIGNED_CONTRIBUTOR_VALUES),
});
export const LifecyclePolicySchema = z.object({
  tenantId: Id,
  own: LifecycleValues.partial().describe('the values this node stores itself'),
  effective: LifecycleValues.describe(
    'what applies at this node: the chain resolved, never looser than the parent',
  ),
  policyDigest: Digest,
});
/** `null` removes a value (the node then inherits). Unknown keys, `breakGlass*` included, are 400. */
export const LifecyclePatchBody = z.record(z.string(), z.unknown());
