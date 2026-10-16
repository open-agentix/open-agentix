import {
  ANCHOR_SIDES,
  APPROVER_ROLES,
  APPROVER_SCOPES,
  MAX_ANCHOR_LINE,
  MAX_APPROVAL_EXPIRY_HOURS,
  MAX_MIN_APPROVALS,
  REQUIRE_APPROVAL_VALUES,
} from '@openagentix/core';
import { z } from 'zod';
import { MAX_COMMENT_LENGTH } from '../services/agent-reviews.js';
import { Id, Iso } from './schemas.js';

/** Schemas of the review thread, changes and inbox endpoints (ADR 0017 S2). */

const Side = z.enum(ANCHOR_SIDES);

/** Comment text: tenant content, shown as a Markdown subset without HTML; never audited. */
export const CommentText = z
  .string()
  .min(1)
  .max(MAX_COMMENT_LENGTH)
  .describe(
    `Markdown subset (no HTML, no images); at most ${MAX_COMMENT_LENGTH} characters after invisible characters are removed. Never copied to the audit chain, telemetry or a model context.`,
  );

export const CommentSchema = z.object({
  id: Id,
  authorId: Id,
  body: z.string().describe('empty when the comment was deleted'),
  deleted: z.boolean(),
  createdAt: Iso,
  editedAt: Iso.nullable(),
});

export const ThreadSchema = z.object({
  id: Id,
  reviewId: Id,
  createdBy: Id,
  anchor: z
    .object({
      side: Side,
      line: z.number().int(),
      lineHash: z.string().describe('SHA-256 of the line text, computed by the server'),
      revisionId: Id.nullable().describe('the revision a `head` anchor was written on'),
      revisionSeq: z.number().int().nullable(),
    })
    .nullable()
    .describe('`null` for a thread about the review as a whole'),
  outdated: z
    .boolean()
    .describe('the anchored line no longer holds the same text in the current source of its side'),
  resolved: z.boolean(),
  resolvedAt: Iso.nullable(),
  resolvedBy: Id.nullable(),
  canResolve: z.boolean().describe('the caller started the thread or is an author of the review'),
  createdAt: Iso,
  comments: z.array(CommentSchema),
});
export const ThreadListSchema = z.object({ items: z.array(ThreadSchema) });

export const ThreadParams = z.object({ id: Id, tid: Id });
export const CommentParams = z.object({ id: Id, tid: Id, cid: Id });

export const CreateThreadBody = z.object({
  body: CommentText,
  anchor: z
    .object({
      side: Side,
      line: z.number().int().min(1).max(MAX_ANCHOR_LINE),
      revisionId: Id.optional().describe('side `head`: the revision shown; defaults to the head'),
    })
    .optional()
    .describe('omit for a thread about the review as a whole'),
});
export const AddCommentBody = z.object({ body: CommentText });
export const ResolveBody = z.object({ resolved: z.boolean() });

export const PeopleSchema = z.object({
  people: z.record(z.string(), z.string()).describe('user id to display name'),
});

// ---------------------------------------------------------------- changes

const ToolFactSchema = z.object({
  key: z.string(),
  server: z.string(),
  tool: z.string(),
  access: z.enum(['read', 'write', 'unclassified']),
  approval: z.enum(['none', 'required']),
  maxCallsPerRun: z.number().int().nullable(),
  classification: z.string().nullable(),
  profile: z.string().nullable().describe('`server:profile` when the grant came from a profile'),
  steps: z.array(z.string()),
});
const SecretReferenceFactSchema = z.object({
  name: z.string(),
  scope: z
    .literal('legacy')
    .describe('scoped references arrive with the secret store (ADR 0017 S4)'),
  ownerNode: z.string().nullable(),
  env: z.string().nullable(),
  steps: z.array(z.string()),
});
const BudgetSchema = z.record(z.string(), z.number().nullable());
export const SemanticFactsSchema = z.object({
  name: z.string(),
  version: z.string(),
  owner: z.string(),
  classification: z.string(),
  useCase: z.string().nullable(),
  runtime: z.object({ runner: z.string(), toolbox: z.string().nullable() }),
  egress: z.array(z.string()),
  budget: BudgetSchema,
  stepBudgets: z.record(z.string(), BudgetSchema),
  tools: z.array(ToolFactSchema),
  secretReferences: z.array(SecretReferenceFactSchema),
  steps: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      model: z.string(),
      access: z.string().nullable(),
    }),
  ),
});
const SetChange = <T extends z.ZodType>(item: T) =>
  z.object({ added: z.array(item), removed: z.array(item) });
export const SemanticChangesSchema = z.object({
  tools: SetChange(ToolFactSchema).extend({
    changed: z.array(z.object({ from: ToolFactSchema, to: ToolFactSchema })),
  }),
  egress: SetChange(z.string()),
  secretReferences: SetChange(SecretReferenceFactSchema),
  scalars: z.array(
    z.object({
      field: z.string(),
      from: z.union([z.string(), z.number()]).nullable(),
      to: z.union([z.string(), z.number()]).nullable(),
    }),
  ),
});
export const ReviewChangesSchema = z.object({
  reviewId: Id,
  revision: z.object({ id: Id, seq: z.number().int(), digest: z.string() }),
  base: z
    .object({ id: Id, version: z.string(), digest: z.string(), source: z.string() })
    .nullable(),
  headSource: z.string(),
  facts: z.object({ base: SemanticFactsSchema.nullable(), head: SemanticFactsSchema }),
  changes: SemanticChangesSchema,
  policy: z
    .object({
      requireApprovalForPublish: z.enum(REQUIRE_APPROVAL_VALUES),
      minApprovals: z.number().int().min(1).max(MAX_MIN_APPROVALS),
      allowedApproverRoles: z.array(z.enum(APPROVER_ROLES)),
      approverScope: z.enum(APPROVER_SCOPES),
      approvalExpiryHours: z.number().int().min(1).max(MAX_APPROVAL_EXPIRY_HOURS),
      allowTokenApprovals: z.boolean(),
    })
    .describe('the part of the effective lifecycle policy that decides who may approve'),
  rules: z
    .object({
      available: z.literal(false),
      requirements: z.array(z.never()),
    })
    .describe('agent rules arrive with ADR 0017 S8; until then nothing is listed'),
});

// ---------------------------------------------------------------- inbox

export const InboxQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
export const InboxSchema = z.object({
  items: z.array(
    z.object({
      reviewId: Id,
      agentId: Id,
      agentName: z.string(),
      state: z.string(),
      openedBy: Id,
      openedAt: Iso,
      revisionSeq: z.number().int(),
      requiredApprovals: z.number().int(),
      countedApprovals: z.number().int(),
      yourDecision: z.enum(['approve', 'request_changes', 'reject']).nullable(),
    }),
  ),
});
