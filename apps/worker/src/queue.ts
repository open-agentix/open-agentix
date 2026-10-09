import { schema, type AppContext } from '@openagentix/api';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

const { runs } = schema;

export interface ClaimedRun {
  id: string;
  attempts: number;
}

/**
 * Postgres work queue on the `runs` table: `FOR UPDATE SKIP LOCKED` lets any number of worker
 * replicas claim runs concurrently without double execution; leases recover crashed workers.
 *
 * Runs of a disabled agent are never claimed (they stay queued until the agent is enabled again).
 * The agent row is locked `FOR SHARE` for the claim, so `disable` (an update of that row) either
 * committed before the claim looks, or waits until the claim committed: no run starts after
 * `disable` has returned. Runs that already run are not touched.
 */
export class RunQueue {
  constructor(
    private readonly ctx: AppContext,
    private readonly workerId: string,
    /** Called for every run whose lease was lost (its run node sessions must die with it). */
    private readonly onLeaseLost?: (runId: string) => Promise<void>,
  ) {}

  async claim(max: number): Promise<ClaimedRun[]> {
    if (max <= 0) return [];
    const lease = this.ctx.config.worker.leaseSeconds;
    const now = this.ctx.now();
    const res = (await this.ctx.db.execute(sql`
      update runs set
        status = 'running',
        locked_by = ${this.workerId},
        lease_until = ${new Date(now.getTime() + lease * 1000)},
        started_at = coalesce(started_at, ${now}),
        attempts = attempts + 1
      where id in (
        select r.id from runs r
        join agents a on a.id = r.agent_id
        where r.status = 'queued' and r.available_at <= ${now}
          and a.disabled_at is null
        order by r.available_at, r.created_at
        limit ${max}
        for update of r skip locked
        for share of a
      )
      returning id, attempts`)) as unknown as { rows: { id: string; attempts: number }[] };
    return res.rows.map((r) => ({ id: r.id, attempts: Number(r.attempts) }));
  }

  /** Extends the lease of runs this worker is executing. */
  async heartbeat(runIds: string[]): Promise<void> {
    if (runIds.length === 0) return;
    await this.ctx.db
      .update(runs)
      .set({
        leaseUntil: new Date(this.ctx.now().getTime() + this.ctx.config.worker.leaseSeconds * 1000),
      })
      .where(and(inArray(runs.id, runIds), eq(runs.lockedBy, this.workerId)));
  }

  /**
   * Requeues runs whose lease expired (worker crashed) with backoff, or fails them after
   * `maxAttempts`. Returns the number of recovered runs.
   */
  async reapExpired(): Promise<number> {
    const now = this.ctx.now();
    const expired = await this.ctx.db
      .select({ id: runs.id, attempts: runs.attempts })
      .from(runs)
      .where(and(inArray(runs.status, ['running', 'awaiting_approval']), lt(runs.leaseUntil, now)));
    for (const r of expired) {
      await this.onLeaseLost?.(r.id).catch(() => undefined);
      if (r.attempts >= this.ctx.config.worker.maxAttempts) {
        await this.ctx.db
          .update(runs)
          .set({
            status: 'failed',
            finishedAt: now,
            lockedBy: null,
            leaseUntil: null,
            errorCode: 'lease_expired',
            errorMessage: `worker lost the run ${r.attempts} times`,
          })
          .where(and(eq(runs.id, r.id), lt(runs.leaseUntil, now)));
      } else {
        await this.ctx.db
          .update(runs)
          .set({
            status: 'queued',
            lockedBy: null,
            leaseUntil: null,
            availableAt: new Date(now.getTime() + 2 ** r.attempts * 1000),
          })
          .where(and(eq(runs.id, r.id), lt(runs.leaseUntil, now)));
      }
    }
    return expired.length;
  }
}
