import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { runs, secrets } from '../db/schema.js';
import type { AuditService } from './audit.js';
import { DEV_RUN_LOCK_NS } from './dev-run-lock.js';

/**
 * What stops with a person when their account is disabled (ADR 0017 section 13.5; accounts are
 * disabled, not deleted, in this release): their personal secrets are DELETED, with their sealed
 * values, and their development runs that are still going are asked to stop. Nothing can be issued
 * from a disabled account's secrets in the meantime either (the broker checks the account at every
 * issuance). Re-enabling the account does not bring the secrets back: the person enters them again.
 *
 * Runs in the transaction that disables the account, one `secret.deleted` audit entry per secret.
 */
export async function offboardPersonalCredentials(
  tx: Db,
  audit: AuditService,
  actor: { userId: string; tenantId: string },
  userId: string,
  now: Date,
): Promise<void> {
  const gone = await tx
    .delete(secrets)
    .where(and(eq(secrets.scope, 'personal'), eq(secrets.scopeId, userId)))
    .returning();
  for (const row of gone)
    await audit.append(
      {
        actor: actor.userId,
        tenantId: row.tenantId,
        action: 'secret.deleted',
        target: row.id,
        payload: {
          scope: row.scope,
          scopeId: row.scopeId,
          name: row.name,
          version: row.currentVersion,
          backend: row.backend,
          inherit: row.inherit,
          reason: 'owner_disabled',
        },
      },
      tx,
    );
  await stopDevelopmentRuns(tx, userId, now);
}

/**
 * Cancels the queued development runs of a person and asks the running ones to stop. Takes the
 * person's admission lock first, so a run that is being admitted at this moment either commits
 * before (and is stopped here) or waits and sees the account state.
 */
export async function stopDevelopmentRuns(tx: Db, userId: string, now: Date): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${DEV_RUN_LOCK_NS}::int, hashtext(${userId}))`);
  // A queued run is cancelled outright; a running one is asked to stop at its next check.
  await tx
    .update(runs)
    .set({
      status: 'cancelled',
      cancelRequested: true,
      finishedAt: now,
      errorCode: 'cancelled',
      errorMessage: 'the account that started the run was disabled',
    })
    .where(
      and(eq(runs.stage, 'development'), eq(runs.startedBy, userId), eq(runs.status, 'queued')),
    );
  await tx
    .update(runs)
    .set({ cancelRequested: true })
    .where(
      and(
        eq(runs.stage, 'development'),
        eq(runs.startedBy, userId),
        inArray(runs.status, ['running', 'awaiting_approval']),
      ),
    );
}
