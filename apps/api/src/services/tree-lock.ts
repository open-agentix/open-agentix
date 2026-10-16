import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

/**
 * Advisory locks of one organisation (ADR 0013 section 5.1 "L0", ADR 0014 section 6.2).
 *
 * Both use the two-key form `(namespace, hashtext(rootId))`, so they cannot collide with the
 * single-key locks of the audit chain and tenant creation, or with the accounting locks (#288 item
 * 4). They are transaction scoped: released at commit or rollback.
 *
 * Lock order, always: the tree lock (shared), then the installation-wide creation lock
 * (`TenantsService`, taken only after the caller is authorised), then the binding lock, then the
 * audit chain lock (taken by `AuditService.append`). No path takes them in another order.
 */
const TREE_LOCK_NS = 734_210;
const BINDINGS_LOCK_NS = 734_211;

/**
 * The tree lock of the organisation, shared: grants, revocations, renames and child creation hold
 * it, so none of them races a structural change (moves, {@link lockTreeExclusive}, take it exclusive).
 */
export async function lockTreeShared(tx: Db, rootId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(${TREE_LOCK_NS}::int, hashtext(${rootId}))`,
  );
}

/**
 * The tree lock of the organisation, exclusive: a move (ADR 0014 S10, W13-11) waits for every
 * shared holder (grant, revocation, rename, child creation) and blocks new ones until it commits,
 * so no write is decided against a tree that moves under it.
 */
export async function lockTreeExclusive(tx: Db, rootId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${TREE_LOCK_NS}::int, hashtext(${rootId}))`);
}

/**
 * The per-organisation binding lock, exclusive: binding writes of one organisation are serialised,
 * so the grantor's coverage and the last-admin check are read after every earlier write committed.
 */
export async function lockBindings(tx: Db, rootId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${BINDINGS_LOCK_NS}::int, hashtext(${rootId}))`,
  );
}
