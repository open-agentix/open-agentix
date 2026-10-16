import type { z } from 'zod';
import type { ThreadView } from '../../services/review-threads.js';
import type { Deps } from '../app.js';
import { principalOf } from '../app.js';
import {
  AddCommentBody,
  CommentParams,
  CreateThreadBody,
  InboxQuery,
  InboxSchema,
  PeopleSchema,
  ResolveBody,
  ReviewChangesSchema,
  ThreadListSchema,
  ThreadParams,
  ThreadSchema,
} from '../review-thread-schemas.js';
import { ErrorSchema, IdParams } from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ bearer: [] }];
const tags = ['lifecycle'];
const iso = (d: Date) => d.toISOString();

const threadDto = (v: ThreadView): z.infer<typeof ThreadSchema> => ({
  ...v,
  resolvedAt: v.resolvedAt ? iso(v.resolvedAt) : null,
  createdAt: iso(v.createdAt),
  comments: v.comments.map((c) => ({
    ...c,
    createdAt: iso(c.createdAt),
    editedAt: c.editedAt ? iso(c.editedAt) : null,
  })),
});

const READ_NOTE =
  'Needs `agents:review` on the agent (roles admin, agent-maintainer, agent-developer, integrator, operator and auditor; not viewer or pentest, who cannot read comment text). Use-case bindings never carry it. A review of another tenant, or of an agent the caller cannot read, is 404 like an unknown id.';
const WRITE_NOTE =
  ' Comment text is a Markdown subset shown without HTML, is limited to 10 000 characters (`400 comment_too_long`), a review holds at most 200 threads (`409 thread_limit_reached`) and a thread 200 comments (`409 comment_limit_reached`); creating comments is rate-limited per user (`429 rate_limited`). The review must be open (`409 review_closed`). The audit chain records ids and the length, never the text.';

export function registerReviewThreadRoutes(app: ZApp, { services }: Deps): void {
  const { reviewThreads, reviewChanges, reviewInbox } = services;

  app.get(
    '/v1/reviews/:id/threads',
    {
      config: { access: 'agents:review' },
      schema: {
        tags,
        summary: 'List the comment threads of a review',
        description: `Threads with their comments, oldest first. A thread on a line is \`outdated\` when the line no longer holds the same text in the current source of its side; it is kept, anchored to the revision it was written on. ${READ_NOTE}`,
        security: sec,
        params: IdParams,
        response: { 200: ThreadListSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req) => ({
      items: (await reviewThreads.list(principalOf(req), req.params.id)).map(threadDto),
    }),
  );

  app.post(
    '/v1/reviews/:id/threads',
    {
      config: { access: 'agents:review' },
      schema: {
        tags,
        summary: 'Start a comment thread on a line or on the review',
        description: `With \`anchor\` the thread is about one line of the diff (side \`head\`: the revision shown; side \`base\`: the base version); the server stores the SHA-256 of that line (\`400 anchor_invalid\` when the source has no such line). Without it the thread is about the review as a whole.${WRITE_NOTE} ${READ_NOTE}`,
        security: sec,
        params: IdParams,
        body: CreateThreadBody,
        response: {
          201: ThreadSchema,
          400: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          threadDto(await reviewThreads.createThread(principalOf(req), req.params.id, req.body)),
        ),
  );

  app.post(
    '/v1/reviews/:id/threads/:tid/comments',
    {
      config: { access: 'agents:review' },
      schema: {
        tags,
        summary: 'Reply in a comment thread',
        description: `Returns the thread.${WRITE_NOTE} ${READ_NOTE}`,
        security: sec,
        params: ThreadParams,
        body: AddCommentBody,
        response: {
          201: ThreadSchema,
          400: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          threadDto(
            await reviewThreads.addComment(
              principalOf(req),
              req.params.id,
              req.params.tid,
              req.body,
            ),
          ),
        ),
  );

  app.patch(
    '/v1/reviews/:id/threads/:tid',
    {
      config: { access: 'agents:review' },
      schema: {
        tags,
        summary: 'Resolve or reopen a comment thread',
        description: `Only the person who started the thread or a contributor of the review (an author of a revision since the base version, or the opener) can change the state (\`403\` otherwise). Idempotent. The review must be open. ${READ_NOTE}`,
        security: sec,
        params: ThreadParams,
        body: ResolveBody,
        response: { 200: ThreadSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (req) =>
      threadDto(
        await reviewThreads.setResolved(
          principalOf(req),
          req.params.id,
          req.params.tid,
          req.body.resolved,
        ),
      ),
  );

  app.patch(
    '/v1/reviews/:id/threads/:tid/comments/:cid',
    {
      config: { access: 'agents:review' },
      schema: {
        tags,
        summary: 'Edit your own comment',
        description: `Only the author (\`403\` otherwise); a deleted comment is \`409 comment_deleted\`. Returns the thread.${WRITE_NOTE}`,
        security: sec,
        params: CommentParams,
        body: AddCommentBody,
        response: {
          200: ThreadSchema,
          400: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req) =>
      threadDto(
        await reviewThreads.editComment(
          principalOf(req),
          req.params.id,
          req.params.tid,
          req.params.cid,
          req.body,
        ),
      ),
  );

  app.delete(
    '/v1/reviews/:id/threads/:tid/comments/:cid',
    {
      config: { access: 'agents:review' },
      schema: {
        tags,
        summary: 'Delete your own comment',
        description: `Only the author (\`403\` otherwise). The comment stays as an empty tombstone so that the thread keeps its shape; the text is gone. Allowed on a closed review too. Returns the thread. ${READ_NOTE}`,
        security: sec,
        params: CommentParams,
        response: { 200: ThreadSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req) =>
      threadDto(
        await reviewThreads.deleteComment(
          principalOf(req),
          req.params.id,
          req.params.tid,
          req.params.cid,
        ),
      ),
  );

  app.get(
    '/v1/reviews/:id/changes',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'What a review changes: sources, semantic summary and expanded grants',
        description:
          'The base version and the reviewed revision (sources for the diff), the semantic summary of both (tools with their access class and the profile they came from, egress hosts, secret references by name, budget, classification, runtime, owner) and the changes between them. The head is expanded against the connection catalog of now. Secret references carry no scope or owning node until the secret store exists (`scope: legacy`). `rules` is empty until agent rules exist. Needs `agents:read` on the agent; another tenant or an unreadable agent is 404.',
        security: sec,
        params: IdParams,
        response: { 200: ReviewChangesSchema, 404: ErrorSchema },
      },
    },
    async (req) => reviewChanges.get(principalOf(req), req.params.id),
  );

  app.get(
    '/v1/reviews/:id/people',
    {
      config: { access: 'agents:read' },
      schema: {
        tags,
        summary: 'Display names of the people a review involves',
        description:
          'User id to display name for the opener, the authors of revisions, the reviewers and the authors and resolvers of comments, so that the console can show names. Only accounts of the acting tenant are named. Needs `agents:read` on the agent; another tenant or an unreadable agent is 404.',
        security: sec,
        params: IdParams,
        response: { 200: PeopleSchema, 404: ErrorSchema },
      },
    },
    async (req) => ({ people: await reviewThreads.people(principalOf(req), req.params.id) }),
  );

  app.get(
    '/v1/me/reviews',
    {
      config: { access: 'authenticated' },
      schema: {
        tags,
        summary: 'Your review inbox: open reviews you could decide now',
        description:
          'Open reviews of the acting tenant, newest first, for agents you can read and where the approval rules (A1 to A7) would let you decide. Reviews you are not eligible for are not listed. Looks at the newest 100 open reviews of the tenant.',
        security: sec,
        querystring: InboxQuery,
        response: { 200: InboxSchema },
      },
    },
    async (req) => ({
      items: (await reviewInbox.list(principalOf(req), req.query.limit)).map((i) => ({
        ...i,
        openedAt: iso(i.openedAt),
      })),
    }),
  );
}
