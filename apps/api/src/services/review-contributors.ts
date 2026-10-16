import { collectContributors } from '@openagentix/core';
import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentDraftRevisions, agentVersions, auditLog, type agentReviews } from '../db/schema.js';
import { revisionById, type AgentRow, type RevisionRow } from './agent-revisions.js';

type ReviewRow = typeof agentReviews.$inferSelect;
type VersionRow = typeof agentVersions.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOr = (v: string): string | null => (UUID.test(v) ? v : null);

/**
 * The contributors of a review (ADR 0017 section 2): the opener, every author of a revision since
 * the base version up to the head, and, when a revision has no known author, everybody the audit
 * chain shows editing the draft plus the creator of the agent (best effort, section 4.1). Every
 * author kind other than a user is unknown until the Git slice (S12) maps signers to accounts.
 * Shared by the reviews service and the policy service (which refuses loosening by a contributor).
 */
export async function reviewContributors(
  db: Db,
  agent: AgentRow,
  review: Pick<ReviewRow, 'openedBy' | 'baseVersionId'>,
  head: RevisionRow,
): Promise<{ set: Set<string>; unknownAuthor: boolean; base: VersionRow | null }> {
  let base: VersionRow | null = null;
  if (review.baseVersionId) {
    const [v] = await db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.id, review.baseVersionId));
    base = v ?? null;
  }
  const baseRev = base?.revisionId ? await revisionById(db, base.revisionId) : undefined;
  const window = await db
    .select({
      authorId: agentDraftRevisions.authorId,
      authorKind: agentDraftRevisions.authorKind,
    })
    .from(agentDraftRevisions)
    .where(
      and(
        eq(agentDraftRevisions.agentId, agent.id),
        lte(agentDraftRevisions.seq, head.seq),
        baseRev
          ? gt(agentDraftRevisions.seq, baseRev.seq)
          : base
            ? gt(agentDraftRevisions.createdAt, base.publishedAt)
            : undefined,
      ),
    );
  const revisionAuthors = window.map((w) => ({
    authorId: w.authorId,
    authorKind: w.authorKind,
  }));
  const unknownAuthor = revisionAuthors.some((r) => r.authorKind !== 'user' || !r.authorId);
  let fallback: string[] = [];
  if (unknownAuthor) {
    // Best effort (ADR 0017 section 4.1): everybody the audit chain shows editing this draft since
    // the base version counts, as does the creator of the agent.
    const rows = await db
      .select({ actor: auditLog.actor })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, agent.id),
          inArray(auditLog.action, ['agent.created', 'agent.draft.updated']),
          base ? gt(auditLog.ts, base.publishedAt) : undefined,
        ),
      );
    fallback = [...new Set(rows.map((r) => uuidOr(r.actor)).filter((x): x is string => !!x))];
  }
  const set = collectContributors({
    revisionAuthors,
    opener: review.openedBy,
    unknownAuthorFallback: fallback,
    agentCreator: agent.createdBy,
  });
  return { set, unknownAuthor, base };
}
