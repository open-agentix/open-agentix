import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import type { Metrics } from '../metrics.js';
import {
  reconcileAllBindings,
  reconcileUserBindings,
  type ReconcileSummary,
} from './role-bindings.js';

export type ReconcileTrigger = 'startup' | 'periodic' | 'mismatch' | 'cli';

/**
 * Keeps `tenant_role_bindings` equal to its source of truth `users.global_roles` (ADR 0014 S1,
 * #216). Rows written by an application version that does not know the mirror (rolling deploy,
 * application-only rollback) are repaired here in both directions; the shadow check calls
 * {@link requestUser} for a mismatching user. Every repair is counted:
 * `oax_role_bindings_reconcile_fixes_total{kind,trigger}` and `..._runs_total{trigger,outcome}`.
 *
 * It never throws into a request and never holds more than one connection at a time.
 */
export class BindingReconciler {
  /** Minimum time between two targeted reconciles of the same user. */
  static readonly USER_MIN_INTERVAL_MS = 60_000;
  /** Targeted reconciles allowed at once; further requests are skipped (counted), not queued. */
  static readonly MAX_IN_FLIGHT = 1;

  private readonly lastUser = new Map<string, number>();
  private inFlight = 0;
  /** A full pass is running in this process (start-up or periodic); a second one is skipped. */
  private fullRunning = false;
  private readonly pending = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly deps: { db: Db; metrics: Metrics; logger: Logger; now: () => Date },
  ) {}

  private count(trigger: ReconcileTrigger, s: { added: number; removed: number }) {
    const c = this.deps.metrics.roleBindingsReconcileFixes;
    if (s.added) c.inc({ kind: 'added', trigger }, s.added);
    if (s.removed) c.inc({ kind: 'removed', trigger }, s.removed);
  }

  /**
   * One full pass over all users; errors are logged and counted, never thrown. At most one full
   * pass runs per process: a pass that overruns the interval makes the next tick a counted
   * `skipped` instead of a second concurrent scan.
   */
  async runAll(trigger: ReconcileTrigger, dryRun = false): Promise<ReconcileSummary | undefined> {
    const runs = this.deps.metrics.roleBindingsReconcileRuns;
    if (this.fullRunning) {
      runs.inc({ trigger, outcome: 'skipped' });
      return undefined;
    }
    this.fullRunning = true;
    try {
      const summary = await reconcileAllBindings(this.deps.db, { dryRun });
      if (!dryRun) this.count(trigger, summary);
      runs.inc({ trigger, outcome: 'ok' });
      if (summary.users > 0)
        this.deps.logger.warn(
          { trigger, dryRun, ...summary, fixed: summary.fixed.slice(0, 20) },
          dryRun
            ? 'role binding mirror drift found (dry run, nothing changed)'
            : 'role binding mirror drift repaired from users.global_roles',
        );
      return summary;
    } catch (e) {
      runs.inc({ trigger, outcome: 'error' });
      this.deps.logger.error({ err: e, trigger }, 'role binding reconcile failed');
      return undefined;
    } finally {
      this.fullRunning = false;
    }
  }

  /**
   * Reconciles one user now (awaited), counting the result. Used by the targeted trigger and by
   * tests; the caller decides about rate limiting.
   */
  async runUser(userId: string, trigger: ReconcileTrigger) {
    const runs = this.deps.metrics.roleBindingsReconcileRuns;
    try {
      const r = await reconcileUserBindings(this.deps.db, userId);
      if (r) this.count(trigger, r);
      runs.inc({ trigger, outcome: 'ok' });
      if (r && (r.added || r.removed))
        this.deps.logger.warn(
          { trigger, userId, added: r.added, removed: r.removed },
          'role binding mirror of a user repaired from users.global_roles',
        );
      return r;
    } catch (e) {
      runs.inc({ trigger, outcome: 'error' });
      this.deps.logger.error({ err: e, userId, trigger }, 'role binding reconcile failed');
      return undefined;
    }
  }

  /**
   * Fire-and-forget targeted reconcile for a user the shadow check found different (rate-limited
   * per user, one at a time). Never throws, never blocks the caller. Returns whether it started.
   */
  requestUser(userId: string): boolean {
    const runs = this.deps.metrics.roleBindingsReconcileRuns;
    const now = this.deps.now().getTime();
    if (
      this.stopped ||
      this.inFlight >= BindingReconciler.MAX_IN_FLIGHT ||
      now - (this.lastUser.get(userId) ?? 0) < BindingReconciler.USER_MIN_INTERVAL_MS
    ) {
      runs.inc({ trigger: 'mismatch', outcome: 'skipped' });
      return false;
    }
    this.lastUser.set(userId, now);
    if (this.lastUser.size > 1000) {
      this.lastUser.clear();
      this.lastUser.set(userId, now);
    }
    this.inFlight++;
    const p = this.runUser(userId, 'mismatch').finally(() => {
      this.inFlight--;
      this.pending.delete(p);
    });
    this.pending.add(p);
    return true;
  }

  /** Waits for targeted reconciles that are running (shutdown, tests). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Starts the periodic pass (`intervalMs` > 0). The timer never keeps the process alive. */
  start(intervalMs: number): void {
    if (intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      if (!this.stopped) {
        const p = this.runAll('periodic').finally(() => this.pending.delete(p));
        this.pending.add(p);
      }
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.drain();
  }
}
