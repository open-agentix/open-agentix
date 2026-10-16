import { randomUUID } from 'node:crypto';
import {
  hashOfLine,
  anchorMatches,
  sourceLines,
  stripInvisible,
  type AnchorSide,
  type Principal,
} from '@openagentix/core';
import { and, asc, count, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import {
  agentDraftRevisions,
  agentReviewComments,
  agentReviewDecisions,
  agentReviewThreads,
  agentReviews,
  agentVersions,
  agents,
  users,
} from '../db/schema.js';
import { HttpError, forbidden, notFound } from '../errors.js';
import { reviewHead, MAX_COMMENT_LENGTH, type AgentReviewsService } from './agent-reviews.js';
import { revisionById, type AgentRow, type RevisionRow } from './agent-revisions.js';
import type { AgentsService } from './agents.js';
import type { AuditService } from './audit.js';

/**
 * Review comment threads (ADR 0017 sections 9 and 11, slice S2).
 *
 * Trust boundaries, in the order a request crosses them:
 *
 * 1. the route: `agents:review` (no use-case binding carries it, viewer and pentest do not hold it);
 * 2. the review belongs to the acting tenant and the agent is readable by the caller, otherwise the
 *    same 404 as an unknown id (`AgentReviewsService.loadReview`); a thread or comment id of another
 *    review is the same 404;
 * 3. writes lock the agent row (key share) and then the review row, in the order a decision takes
 *    them, so they are serialised with a decision without deadlocking: a reject that wins makes a
 *    later comment `409 review_closed`, and the thread and rate limits are counted after every
 *    earlier write committed;
 * 4. the comment text is stored and returned, and goes nowhere else: the audit chain gets ids and
 *    lengths, never text, and no code path reads a comment into a model request or a span.
 */

export const MAX_THREADS_PER_REVIEW = 200;
export const MAX_COMMENTS_PER_THREAD = 200;
/** Bounds what one list call reads and returns: comments and characters of a whole review. */
export const MAX_COMMENTS_PER_REVIEW = 1000;
export const MAX_COMMENT_CHARS_PER_REVIEW = 1_000_000;
const RATE_WINDOW_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReviewRow = typeof agentReviews.$inferSelect;
type ThreadRow = typeof agentReviewThreads.$inferSelect;
type CommentRow = typeof agentReviewComments.$inferSelect;

export interface CommentView {
  id: string;
  authorId: string;
  /** Empty for a deleted comment. */
  body: string;
  deleted: boolean;
  createdAt: Date;
  editedAt: Date | null;
}

export interface ThreadView {
  id: string;
  reviewId: string;
  createdBy: string;
  anchor: {
    side: AnchorSide;
    line: number;
    lineHash: string;
    revisionId: string | null;
    revisionSeq: number | null;
  } | null;
  /** The anchored line no longer holds the same text in the current source of its side. */
  outdated: boolean;
  resolved: boolean;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  /** The caller may resolve or reopen the thread: its starter or a contributor of the review. */
  canResolve: boolean;
  createdAt: Date;
  comments: CommentView[];
}

export interface AnchorInput {
  side: AnchorSide;
  line: number;
  /** The revision the line was seen on (side `head`); defaults to the current head. */
  revisionId?: string | undefined;
}

type CommentOp = 'created' | 'edited' | 'deleted';

/** The text as it is stored: invisible and steering characters removed, line ends normalised. */
export function cleanCommentText(raw: string): string {
  const text = stripInvisible(raw).text.replace(/\r\n?/g, '\n').trim();
  if (text.length === 0)
    throw new HttpError(400, 'validation_failed', 'a comment must not be empty');
  if (text.length > MAX_COMMENT_LENGTH)
    throw new HttpError(
      400,
      'comment_too_long',
      `a comment must not exceed ${MAX_COMMENT_LENGTH} characters`,
    );
  return text;
}

export class ReviewThreadsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly agents: AgentsService,
    private readonly reviews: AgentReviewsService,
  ) {}

  // ------------------------------------------------------------------ access

  /** The review and agent the caller may comment on; 404 where they may not even read it. */
  private async open(p: Principal, reviewId: string) {
    const { review, agent } = await this.reviews.loadReview(p, reviewId);
    await this.agents.assertAccess(p, agent, 'agents:review').catch((e: unknown) => {
      throw e instanceof HttpError && e.statusCode === 404 ? notFound('review') : e;
    });
    if (!UUID.test(p.userId)) throw forbidden('comments need a user account'); // e.g. the demo visitor has none
    return { review, agent };
  }

  /**
   * Locks the review row for the rest of the transaction; writes need it open unless `closedOk`.
   * The agent row is locked first, `FOR KEY SHARE`, because inserting a thread or a comment takes
   * that lock anyway (foreign key) and a decision holds the agent row `FOR UPDATE` before it takes
   * the review row: taking them in the same order here is what keeps the two from deadlocking.
   */
  private async lockReview(tx: Db, p: Principal, review: ReviewRow, closedOk = false) {
    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, review.agentId))
      .for('key share');
    const [locked] = await tx
      .select()
      .from(agentReviews)
      .where(eq(agentReviews.id, review.id))
      .for('update');
    if (!locked || locked.tenantId !== p.tenantId) throw notFound('review');
    if (!closedOk && locked.status !== 'open')
      throw new HttpError(409, 'review_closed', `the review is ${locked.status}`);
    return locked;
  }

  private async loadThread(tx: Db, review: ReviewRow, threadId: string): Promise<ThreadRow> {
    if (!UUID.test(threadId)) throw notFound('thread');
    const [thread] = await tx
      .select()
      .from(agentReviewThreads)
      .where(and(eq(agentReviewThreads.id, threadId), eq(agentReviewThreads.reviewId, review.id)));
    if (!thread) throw notFound('thread');
    return thread;
  }

  /** Per user and minute, counted over every session and token, deleted comments and edits included. */
  private async assertRate(tx: Db, userId: string) {
    const since = new Date(this.ctx.now().getTime() - RATE_WINDOW_MS);
    const [row] = await tx
      .select({ n: count() })
      .from(agentReviewComments)
      .where(
        and(
          eq(agentReviewComments.authorId, userId),
          or(gt(agentReviewComments.createdAt, since), gt(agentReviewComments.editedAt, since)),
        ),
      );
    if ((row?.n ?? 0) >= this.ctx.config.rateLimit.commentMax)
      throw new HttpError(429, 'rate_limited', 'too many comments, try again in a minute', {
        retryAfterSeconds: RATE_WINDOW_MS / 1000,
      });
  }

  /**
   * The size of a review's discussion is bounded, so that listing it reads and returns a bounded
   * amount: at most {@link MAX_COMMENTS_PER_REVIEW} comments and {@link MAX_COMMENT_CHARS_PER_REVIEW}
   * characters. `adding` is the new text; `replacing` the length of the text an edit replaces.
   */
  private async assertBudget(tx: Db, reviewId: string, adding: number, replacing = 0) {
    const [row] = await tx
      .select({
        n: count(),
        chars: sql<number>`coalesce(sum(char_length(${agentReviewComments.body})), 0)::int`,
      })
      .from(agentReviewComments)
      .where(eq(agentReviewComments.reviewId, reviewId));
    const newComment = replacing === 0 ? 1 : 0;
    if (
      (row?.n ?? 0) + newComment > MAX_COMMENTS_PER_REVIEW ||
      (row?.chars ?? 0) - replacing + adding > MAX_COMMENT_CHARS_PER_REVIEW
    )
      throw new HttpError(
        409,
        'review_comment_budget_reached',
        `a review holds at most ${MAX_COMMENTS_PER_REVIEW} comments and ${MAX_COMMENT_CHARS_PER_REVIEW} characters of discussion`,
      );
  }

  private async auditComment(
    tx: Db,
    p: Principal,
    review: ReviewRow,
    thread: string,
    comment: string,
    op: CommentOp,
    length: number,
  ) {
    // Ids and the length only: the text is tenant content and never enters the audit chain.
    await this.audit.append(
      {
        actor: p.userId,
        tenantId: review.tenantId,
        action: 'agent.review.comment',
        target: review.agentId,
        payload: { review: review.id, thread, comment, op, length },
      },
      tx,
    );
  }

  // ------------------------------------------------------------------ anchors

  private async anchorOf(tx: Db, agent: AgentRow, review: ReviewRow, input: AnchorInput) {
    if (input.side === 'base') {
      if (!review.baseVersionId)
        throw new HttpError(400, 'anchor_invalid', 'the review has no base version to comment on');
      const [v] = await tx
        .select({ source: agentVersions.source })
        .from(agentVersions)
        .where(eq(agentVersions.id, review.baseVersionId));
      return this.lineAnchor(v?.source ?? '', input.line, { side: 'base', revisionId: null });
    }
    const rev = input.revisionId
      ? await revisionById(tx, input.revisionId)
      : await reviewHead(tx, agent, review);
    if (!rev || rev.agentId !== agent.id) throw notFound('revision');
    return this.lineAnchor(rev.source, input.line, { side: 'head', revisionId: rev.id });
  }

  private lineAnchor(
    source: string,
    line: number,
    at: { side: AnchorSide; revisionId: string | null },
  ) {
    // The server hashes the stored line: a client cannot name a line the source does not have.
    const lineHash = hashOfLine(sourceLines(source), line);
    if (lineHash === null)
      throw new HttpError(400, 'anchor_invalid', `the source has no line ${line}`);
    return { ...at, line, lineHash };
  }

  // ------------------------------------------------------------------ writes

  async createThread(
    p: Principal,
    reviewId: string,
    input: { body: string; anchor?: AnchorInput | undefined },
  ): Promise<ThreadView> {
    const { agent, review: found } = await this.open(p, reviewId);
    const body = cleanCommentText(input.body);
    const threadId = await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const review = await this.lockReview(tx, p, found);
      await this.assertRate(tx, p.userId);
      const [existing] = await tx
        .select({ n: count() })
        .from(agentReviewThreads)
        .where(eq(agentReviewThreads.reviewId, review.id));
      if ((existing?.n ?? 0) >= MAX_THREADS_PER_REVIEW)
        throw new HttpError(
          409,
          'thread_limit_reached',
          `a review has at most ${MAX_THREADS_PER_REVIEW} threads`,
        );
      await this.assertBudget(tx, review.id, body.length);
      const anchor = input.anchor ? await this.anchorOf(tx, agent, review, input.anchor) : null;
      const now = this.ctx.now();
      const id = randomUUID();
      await tx.insert(agentReviewThreads).values({
        id,
        reviewId: review.id,
        agentId: review.agentId,
        tenantId: review.tenantId,
        createdBy: p.userId,
        anchorKind: anchor ? 'line' : 'review',
        revisionId: anchor?.revisionId ?? null,
        side: anchor?.side ?? null,
        line: anchor?.line ?? null,
        lineHash: anchor?.lineHash ?? null,
        createdAt: now,
      });
      const commentId = randomUUID();
      await tx.insert(agentReviewComments).values({
        id: commentId,
        threadId: id,
        reviewId: review.id,
        tenantId: review.tenantId,
        authorId: p.userId,
        body,
        createdAt: now,
      });
      await this.auditComment(tx, p, review, id, commentId, 'created', body.length);
      return id;
    });
    return this.thread(p, reviewId, threadId);
  }

  async addComment(
    p: Principal,
    reviewId: string,
    threadId: string,
    input: { body: string },
  ): Promise<ThreadView> {
    const { review: found } = await this.open(p, reviewId);
    const body = cleanCommentText(input.body);
    await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const review = await this.lockReview(tx, p, found);
      const thread = await this.loadThread(tx, review, threadId);
      await this.assertRate(tx, p.userId);
      const [existing] = await tx
        .select({ n: count() })
        .from(agentReviewComments)
        .where(eq(agentReviewComments.threadId, thread.id));
      if ((existing?.n ?? 0) >= MAX_COMMENTS_PER_THREAD)
        throw new HttpError(
          409,
          'comment_limit_reached',
          `a thread has at most ${MAX_COMMENTS_PER_THREAD} comments`,
        );
      await this.assertBudget(tx, review.id, body.length);
      const id = randomUUID();
      await tx.insert(agentReviewComments).values({
        id,
        threadId: thread.id,
        reviewId: review.id,
        tenantId: review.tenantId,
        authorId: p.userId,
        body,
        createdAt: this.ctx.now(),
      });
      await this.auditComment(tx, p, review, thread.id, id, 'created', body.length);
    });
    return this.thread(p, reviewId, threadId);
  }

  /** The author's own comment, while the review is open. */
  async editComment(
    p: Principal,
    reviewId: string,
    threadId: string,
    commentId: string,
    input: { body: string },
  ): Promise<ThreadView> {
    const { review: found } = await this.open(p, reviewId);
    const body = cleanCommentText(input.body);
    await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const review = await this.lockReview(tx, p, found);
      const thread = await this.loadThread(tx, review, threadId);
      const comment = await this.ownComment(tx, p, thread, commentId, 'edit');
      if (comment.deletedAt) throw new HttpError(409, 'comment_deleted', 'the comment was deleted');
      await this.assertRate(tx, p.userId);
      await this.assertBudget(tx, review.id, body.length, comment.body.length);
      await tx
        .update(agentReviewComments)
        .set({ body, editedAt: this.ctx.now() })
        .where(eq(agentReviewComments.id, comment.id));
      await this.auditComment(tx, p, review, thread.id, comment.id, 'edited', body.length);
    });
    return this.thread(p, reviewId, threadId);
  }

  /**
   * The author's own comment. Allowed on a closed review too: somebody who pasted something they
   * should not have must be able to take it back. The row stays as a tombstone without text.
   */
  async deleteComment(
    p: Principal,
    reviewId: string,
    threadId: string,
    commentId: string,
  ): Promise<ThreadView> {
    const { review: found } = await this.open(p, reviewId);
    await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const review = await this.lockReview(tx, p, found, true);
      const thread = await this.loadThread(tx, review, threadId);
      const comment = await this.ownComment(tx, p, thread, commentId, 'delete');
      if (comment.deletedAt) return;
      await tx
        .update(agentReviewComments)
        .set({ body: '', deletedAt: this.ctx.now() })
        .where(eq(agentReviewComments.id, comment.id));
      await this.auditComment(tx, p, review, thread.id, comment.id, 'deleted', 0);
    });
    return this.thread(p, reviewId, threadId);
  }

  private async ownComment(
    tx: Db,
    p: Principal,
    thread: ThreadRow,
    commentId: string,
    verb: 'edit' | 'delete',
  ): Promise<CommentRow> {
    const [comment] = UUID.test(commentId)
      ? await tx
          .select()
          .from(agentReviewComments)
          .where(
            and(eq(agentReviewComments.id, commentId), eq(agentReviewComments.threadId, thread.id)),
          )
      : [];
    if (!comment) throw notFound('comment');
    if (comment.authorId !== p.userId) throw forbidden(`only the author can ${verb} a comment`);
    return comment;
  }

  /** Resolve or reopen: the person who started the thread or a contributor of the review. */
  async setResolved(
    p: Principal,
    reviewId: string,
    threadId: string,
    resolved: boolean,
  ): Promise<ThreadView> {
    const { agent, review: found } = await this.open(p, reviewId);
    await this.ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const review = await this.lockReview(tx, p, found);
      const thread = await this.loadThread(tx, review, threadId);
      const head = await reviewHead(tx, agent, review);
      const { set } = await this.reviews.contributorsOf(tx, agent, review, head);
      if (thread.createdBy !== p.userId && !set.has(p.userId))
        throw forbidden('only the person who started the thread or an author can resolve it');
      if ((thread.resolvedAt !== null) === resolved) return;
      await tx
        .update(agentReviewThreads)
        .set(
          resolved
            ? { resolvedAt: this.ctx.now(), resolvedBy: p.userId }
            : { resolvedAt: null, resolvedBy: null },
        )
        .where(eq(agentReviewThreads.id, thread.id));
      await this.audit.append(
        {
          actor: p.userId,
          tenantId: review.tenantId,
          action: 'agent.review.thread_resolved',
          target: review.agentId,
          payload: { review: review.id, thread: thread.id, resolved },
        },
        tx,
      );
    });
    return this.thread(p, reviewId, threadId);
  }

  // ------------------------------------------------------------------ reads

  /**
   * Display names of the people a review involves (opener, authors of revisions, reviewers, thread
   * and comment authors, resolvers), so that the console shows names instead of identifiers. Only
   * accounts of the acting tenant are named: a platform operator acting here stays an identifier.
   * Readable with `agents:read` on the agent, like the identifiers it resolves.
   */
  async people(p: Principal, reviewId: string): Promise<Record<string, string>> {
    const { review, agent } = await this.reviews.loadReview(p, reviewId);
    await this.agents.assertAccess(p, agent, 'agents:read').catch((e: unknown) => {
      throw e instanceof HttpError && e.statusCode === 404 ? notFound('review') : e;
    });
    const db = this.ctx.db;
    const ids = new Set<string>([review.openedBy]);
    const take = (...xs: (string | null)[]) => xs.forEach((x) => x && ids.add(x));
    for (const r of await db
      .select({ a: agentDraftRevisions.authorId })
      .from(agentDraftRevisions)
      .where(eq(agentDraftRevisions.agentId, agent.id)))
      take(r.a);
    for (const r of await db
      .select({ a: agentReviewDecisions.reviewerId })
      .from(agentReviewDecisions)
      .where(eq(agentReviewDecisions.reviewId, review.id)))
      take(r.a);
    for (const r of await db
      .select({ a: agentReviewThreads.createdBy, b: agentReviewThreads.resolvedBy })
      .from(agentReviewThreads)
      .where(eq(agentReviewThreads.reviewId, review.id)))
      take(r.a, r.b);
    for (const r of await db
      .select({ a: agentReviewComments.authorId })
      .from(agentReviewComments)
      .where(eq(agentReviewComments.reviewId, review.id)))
      take(r.a);
    const rows = await db
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(and(inArray(users.id, [...ids]), eq(users.tenantId, review.tenantId)));
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }

  async list(p: Principal, reviewId: string): Promise<ThreadView[]> {
    const { review, agent } = await this.open(p, reviewId);
    return this.views(p, agent, review);
  }

  private async thread(p: Principal, reviewId: string, threadId: string): Promise<ThreadView> {
    const { review, agent } = await this.open(p, reviewId);
    const found = (await this.views(p, agent, review, threadId))[0];
    if (!found) throw notFound('thread');
    return found;
  }

  private async views(
    p: Principal,
    agent: AgentRow,
    review: ReviewRow,
    onlyThread?: string,
  ): Promise<ThreadView[]> {
    const db = this.ctx.db;
    const threads = await db
      .select()
      .from(agentReviewThreads)
      .where(
        and(
          eq(agentReviewThreads.reviewId, review.id),
          onlyThread ? eq(agentReviewThreads.id, onlyThread) : undefined,
        ),
      )
      .orderBy(asc(agentReviewThreads.createdAt), asc(agentReviewThreads.id))
      .limit(MAX_THREADS_PER_REVIEW);
    if (threads.length === 0) return [];
    const comments = await db
      .select()
      .from(agentReviewComments)
      .where(
        and(
          eq(agentReviewComments.reviewId, review.id),
          onlyThread ? eq(agentReviewComments.threadId, onlyThread) : undefined,
        ),
      )
      .orderBy(asc(agentReviewComments.createdAt), asc(agentReviewComments.id))
      .limit(MAX_COMMENTS_PER_REVIEW);
    const byThread = new Map<string, CommentRow[]>();
    for (const c of comments) {
      const list = byThread.get(c.threadId);
      if (list) list.push(c);
      else byThread.set(c.threadId, [c]);
    }
    const head = await reviewHead(db, agent, review);
    const { set: contributors } = await this.reviews.contributorsOf(db, agent, review, head);
    const sources = await this.sourcesFor(db, review, head, threads);
    const seqs = await this.revisionSeqs(db, threads);
    return threads.map((th) => {
      const lines = th.side ? sources[th.side as AnchorSide] : null;
      return {
        id: th.id,
        reviewId: th.reviewId,
        createdBy: th.createdBy,
        anchor:
          th.anchorKind === 'line'
            ? {
                side: th.side as AnchorSide,
                line: th.line!,
                lineHash: th.lineHash!,
                revisionId: th.revisionId,
                revisionSeq: th.revisionId ? (seqs.get(th.revisionId) ?? null) : null,
              }
            : null,
        outdated:
          th.anchorKind === 'line' &&
          !(lines && anchorMatches({ line: th.line!, lineHash: th.lineHash! }, lines)),
        resolved: th.resolvedAt !== null,
        resolvedAt: th.resolvedAt,
        resolvedBy: th.resolvedBy,
        canResolve: th.createdBy === p.userId || contributors.has(p.userId),
        createdAt: th.createdAt,
        comments: (byThread.get(th.id) ?? []).map(commentView),
      };
    });
  }

  /** The lines each side of an anchor is checked against: the head of the review and its base. */
  private async sourcesFor(
    db: Db,
    review: ReviewRow,
    head: RevisionRow,
    threads: ThreadRow[],
  ): Promise<Record<AnchorSide, string[] | null>> {
    let base: string[] | null = null;
    if (review.baseVersionId && threads.some((t) => t.side === 'base')) {
      const [v] = await db
        .select({ source: agentVersions.source })
        .from(agentVersions)
        .where(eq(agentVersions.id, review.baseVersionId));
      base = v ? sourceLines(v.source) : null;
    }
    return { head: sourceLines(head.source), base };
  }

  private async revisionSeqs(db: Db, threads: ThreadRow[]): Promise<Map<string, number>> {
    const ids = [...new Set(threads.map((t) => t.revisionId).filter((x): x is string => !!x))];
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({ id: agentDraftRevisions.id, seq: agentDraftRevisions.seq })
      .from(agentDraftRevisions)
      .where(inArray(agentDraftRevisions.id, ids));
    return new Map(rows.map((r) => [r.id, r.seq]));
  }
}

const commentView = (c: CommentRow): CommentView => ({
  id: c.id,
  authorId: c.authorId,
  body: c.body,
  deleted: c.deletedAt !== null,
  createdAt: c.createdAt,
  editedAt: c.editedAt,
});
