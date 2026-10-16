import { randomUUID } from 'node:crypto';
import { normalizeSource, sha256Hex } from '@openagentix/core';
import { eq, isNull, max } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentDraftRevisions, agents } from '../db/schema.js';
import { notFound } from '../errors.js';

/**
 * Draft revisions (ADR 0017 section 4.1): every save of a draft that changes the normalised content
 * appends an immutable revision with its author; `agents.draft_source` stays as a denormalised copy
 * of the newest one and `agents.draft_revision_id` points to it. All writers take the agent row lock
 * (`lockAgent`) first, so the revision sequence of an agent never forks and a review or a decision
 * always sees one consistent head.
 */

export type AgentRow = typeof agents.$inferSelect;
export type RevisionRow = typeof agentDraftRevisions.$inferSelect;

export type RevisionAuthor =
  { kind: 'user'; id: string } | { kind: 'repo'; id: string | null } | { kind: 'system' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A user author for a principal; a non-account actor (the demo seed, a script) is a system author. */
export function authorOf(userId: string): RevisionAuthor {
  return UUID.test(userId) ? { kind: 'user', id: userId } : { kind: 'system' };
}

/** The digest of a source as `AgentDefinition.digest` and `agent_versions.digest` compute it. */
export const sourceDigest = (source: string): string => sha256Hex(normalizeSource(source));

/** Locks the agent row for the rest of the transaction and returns it. */
export async function lockAgent(tx: Db, id: string): Promise<AgentRow> {
  const [row] = await tx.select().from(agents).where(eq(agents.id, id)).for('update');
  if (!row) throw notFound('agent');
  return row;
}

export async function revisionById(db: Db, id: string): Promise<RevisionRow | undefined> {
  const [row] = await db.select().from(agentDraftRevisions).where(eq(agentDraftRevisions.id, id));
  return row;
}

async function insertRevision(
  tx: Db,
  agent: Pick<AgentRow, 'id' | 'tenantId'>,
  seq: number,
  source: string,
  author: RevisionAuthor,
  parentId: string | null,
  createdAt?: Date,
): Promise<RevisionRow> {
  const [row] = await tx
    .insert(agentDraftRevisions)
    .values({
      id: randomUUID(),
      agentId: agent.id,
      tenantId: agent.tenantId,
      seq,
      digest: sourceDigest(source),
      source,
      authorId: author.kind === 'system' ? null : author.id,
      authorKind: author.kind,
      parentId,
      ...(createdAt ? { createdAt } : {}),
    })
    .returning();
  return row!;
}

/**
 * The newest revision of a locked agent; an agent from before the revisions existed gets its one
 * system revision here (author unknown, ADR 0017 section 4.1). `onCreated` lets the caller audit it.
 */
export async function ensureHead(
  tx: Db,
  agent: AgentRow,
  onCreated?: (r: RevisionRow) => Promise<void>,
): Promise<RevisionRow> {
  if (agent.draftRevisionId) {
    const head = await revisionById(tx, agent.draftRevisionId);
    if (head) return head;
  }
  const [topRow] = await tx
    .select({ top: max(agentDraftRevisions.seq) })
    .from(agentDraftRevisions)
    .where(eq(agentDraftRevisions.agentId, agent.id));
  // Dated at the last save of the draft, so that "revisions since the base version" is right for
  // an agent whose draft has not changed since it was published.
  const rev = await insertRevision(
    tx,
    agent,
    (topRow?.top ?? 0) + 1,
    agent.draftSource,
    { kind: 'system' },
    null,
    agent.draftUpdatedAt,
  );
  await tx.update(agents).set({ draftRevisionId: rev.id }).where(eq(agents.id, agent.id));
  await onCreated?.(rev);
  return rev;
}

/** The first revision of a new agent (sequence 1), written in the transaction that creates it. */
export async function firstRevision(
  tx: Db,
  agent: AgentRow,
  source: string,
  author: RevisionAuthor,
): Promise<RevisionRow> {
  const rev = await insertRevision(tx, agent, 1, source, author, null);
  await tx.update(agents).set({ draftRevisionId: rev.id }).where(eq(agents.id, agent.id));
  return rev;
}

/**
 * Appends a revision for `source` unless the newest one has the same digest. The caller holds the
 * agent lock and updates the draft columns of the agent itself when `created` is true.
 */
export async function appendRevision(
  tx: Db,
  agent: AgentRow,
  source: string,
  author: RevisionAuthor,
  onSystemCreated?: (r: RevisionRow) => Promise<void>,
): Promise<{ revision: RevisionRow; previous: RevisionRow; created: boolean }> {
  const head = await ensureHead(tx, agent, onSystemCreated);
  if (head.digest === sourceDigest(source))
    return { revision: head, previous: head, created: false };
  const revision = await insertRevision(tx, agent, head.seq + 1, source, author, head.id);
  await tx.update(agents).set({ draftRevisionId: revision.id }).where(eq(agents.id, agent.id));
  return { revision, previous: head, created: true };
}

/** The agents that still lack a revision (installed before migration 0032), oldest first. */
export async function agentsWithoutRevision(db: Db, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(isNull(agents.draftRevisionId))
    .orderBy(agents.createdAt)
    .limit(limit);
  return rows.map((r) => r.id);
}
