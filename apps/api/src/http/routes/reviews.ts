import { z } from 'zod';
import type { ApprovalView, ReviewView } from '../../services/agent-reviews.js';
import type { RevisionRow } from '../../services/agent-revisions.js';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import {
  ApprovalSchema,
  DecisionBody,
  DecisionResultSchema,
  LifecyclePatchBody,
  LifecyclePolicySchema,
  ReviewListQuery,
  ReviewListSchema,
  ReviewSchema,
  RevisionDetailSchema,
  RevisionListQuery,
  RevisionListSchema,
  RevisionParams,
} from '../lifecycle-schemas.js';
import { ErrorSchema, IdParams } from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['lifecycle'];
const iso = (d: Date) => d.toISOString();

const revisionDto = (r: RevisionRow) => ({
  id: r.id,
  agentId: r.agentId,
  seq: r.seq,
  digest: r.digest,
  authorId: r.authorId,
  authorKind: r.authorKind as 'user' | 'repo' | 'system',
  parentId: r.parentId,
  sourceCommit: r.sourceCommit,
  createdAt: iso(r.createdAt),
});

const approvalDto = (a: ApprovalView): z.infer<typeof ApprovalSchema> => ({
  ...a,
  decidedAt: iso(a.decidedAt),
  expiresAt: a.expiresAt ? iso(a.expiresAt) : null,
});

const reviewDto = (v: ReviewView): z.infer<typeof ReviewSchema> => ({
  ...v,
  state: v.state,
  openedAt: iso(v.openedAt),
  closedAt: v.closedAt ? iso(v.closedAt) : null,
  revision: { ...v.revision, createdAt: iso(v.revision.createdAt) },
  approvals: v.approvals.map(approvalDto),
});

export function registerReviewRoutes(app: ZApp, { services }: Deps): void {
  const { agentReviews, lifecyclePolicy } = services;

  app.get(
    '/v1/agents/:id/revisions',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'List the draft revisions of an agent, newest first',
        description:
          'Every save of the draft that changes its normalised content is an immutable revision with its author (ADR 0017 section 4.1). Identical content creates none. Needs `agents:read` on the agent; an agent the caller cannot read is 404.',
        security: sec,
        params: IdParams,
        querystring: RevisionListQuery,
        response: { 200: RevisionListSchema, 404: ErrorSchema },
      },
    },
    async (req) => {
      const r = await agentReviews.revisions(principalOf(req), req.params.id, req.query);
      return { items: r.items.map(revisionDto), nextCursor: r.nextCursor, head: r.head };
    },
  );

  app.get(
    '/v1/agents/:id/revisions/:seq',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'Get one draft revision with its source',
        security: sec,
        params: RevisionParams,
        response: { 200: RevisionDetailSchema, 404: ErrorSchema },
      },
    },
    async (req) => {
      const r = await agentReviews.revision(principalOf(req), req.params.id, req.params.seq);
      return { ...revisionDto(r), source: r.source };
    },
  );

  app.post(
    '/v1/agents/:id/reviews',
    {
      config: { access: 'agents:write' },
      schema: {
        tags,
        summary: 'Open a review of the current draft',
        description:
          'Needs `agents:write` on the agent. One review per agent at a time (`409 review_open`); a draft equal to the latest published version has nothing to review (`409 nothing_to_review`). The review follows the draft: a new revision makes every earlier decision stale. Records the digests an approval binds to (revision, profile expansion, secret resolution, policy) and the required number of approvals. In this version publishing is not yet refused without an approval (shadow mode): the publish response reports what it would have been refused for.',
        security: sec,
        params: IdParams,
        response: { 201: ReviewSchema, 404: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) =>
      reply.status(201).send(reviewDto(await agentReviews.open(principalOf(req), req.params.id))),
  );

  app.get(
    '/v1/agents/:id/reviews',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'List the reviews of an agent, newest first',
        security: sec,
        params: IdParams,
        querystring: ReviewListQuery,
        response: { 200: ReviewListSchema, 404: ErrorSchema },
      },
    },
    async (req) => {
      const r = await agentReviews.list(principalOf(req), req.params.id, req.query);
      return { items: r.items.map(reviewDto), nextCursor: r.nextCursor };
    },
  );

  app.get(
    '/v1/reviews/:id',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'Get a review with its state, approvals and what you may do',
        description:
          'Every approval is re-checked against the bindings, policy and digests of now: `counted` says whether it counts and `reasons` why not. `you` tells whether the caller could decide the review (rules A1 to A7). A review of another tenant, or of an agent the caller cannot read, is 404 like an unknown id.',
        security: sec,
        params: IdParams,
        response: { 200: ReviewSchema, 404: ErrorSchema },
      },
    },
    async (req) => reviewDto(await agentReviews.get(principalOf(req), req.params.id)),
  );

  app.post(
    '/v1/reviews/:id/decisions',
    {
      config: { access: 'agents:approve' },
      schema: {
        tags,
        summary: 'Approve, request changes on, or reject a review',
        description:
          'Needs `agents:approve` on the agent through a role the tenant lists in `allowedApproverRoles` (default `admin`, `agent-maintainer`), with a binding that no contributor of the review granted. Refusals: `403 self_approval` (the caller is an author since the base version or the opener, in any role, with any token, platform administrators included), `403 actor_not_human`, `403 token_approval_disabled` (API tokens decide only when the tenant sets `allowTokenApprovals`), `403 identity_source_not_allowed`, `403 not_eligible`, `403 binding_granted_by_contributor`, `403 approver_scope`, `409 stale_view` (the digest you looked at is not the digest of the revision now; reload), `409 review_closed`. `expectedDigest` is required; the optional expected digests bind the decision to the expansion, secret resolution and policy you saw. Use-case bindings never carry `agents:approve` (fail closed). A comment is required to request changes or reject, is limited to 10 000 characters and never copied to the audit chain. A reject closes the review.',
        security: sec,
        params: IdParams,
        body: DecisionBody,
        response: {
          201: DecisionResultSchema,
          400: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const r = await agentReviews.decide(principalOf(req), req.params.id, req.body);
      return reply
        .status(201)
        .send({ review: reviewDto(r.review), decision: approvalDto(r.decision) });
    },
  );

  app.post(
    '/v1/reviews/:id/withdraw',
    {
      config: { access: 'agents:write' },
      schema: {
        tags,
        summary: 'Withdraw an open review',
        description:
          'The person who opened the review or an administrator; the agent returns to development. A closed review is `409 review_closed`.',
        security: sec,
        params: IdParams,
        response: { 200: ReviewSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (req) => reviewDto(await agentReviews.withdraw(principalOf(req), req.params.id)),
  );

  app.get(
    '/v1/tenants/:id/settings/agent-lifecycle',
    {
      config: { access: 'settings:read' },
      schema: {
        tags,
        summary: 'Read the agent lifecycle policy of a tenant',
        description:
          'The values the node stores itself (`own`) and the effective policy (`effective`) with its digest. Needs `settings:read` on the node; a node the caller cannot see is 404.',
        security: sec,
        params: IdParams,
        response: { 200: LifecyclePolicySchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req) => lifecyclePolicy.get(principalOf(req), req.params.id),
  );

  app.patch(
    '/v1/tenants/:id/settings/agent-lifecycle',
    {
      config: { access: 'settings:write' },
      schema: {
        tags,
        summary: 'Change the agent lifecycle policy of a tenant',
        description:
          "Send the keys to change; `null` removes a value (the node then inherits). Needs `settings:write` on the node. Narrowing only: below a parent a value that would make the effective policy looser than the parent's is refused with `422 not_narrowing` and the keys named (the root of an organisation chooses freely). Keys that do not exist, `breakGlass*` and `approverBindingMinAgeHours` included, are 400. Audited as `tenant.lifecycle_policy_changed`.",
        security: sec,
        params: IdParams,
        body: LifecyclePatchBody,
        response: {
          200: LifecyclePolicySchema,
          400: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req) => lifecyclePolicy.patch(principalOf(req), req.params.id, req.body),
  );
}
