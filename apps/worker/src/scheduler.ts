import { schema, type AppContext, type Services } from '@openagentix/api';
import { CronEventSource } from '@openagentix/events';

/**
 * Cron triggers of published agents. Every worker replica schedules them; a primary key on
 * (agent, schedule, tick) makes sure each tick creates exactly one run cluster-wide.
 */
export class CronScheduler {
  private readonly jobs = new Map<string, CronEventSource>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly services: Services,
  ) {}

  /** (Re)loads cron triggers from the registry; returns the active job keys. */
  async reload(): Promise<string[]> {
    const wanted = await this.services.agents.cronAgents();
    const keys = new Set(wanted.map((w) => `${w.agentId}|${w.versionId}|${w.schedule}`));
    for (const [k, job] of this.jobs) {
      if (!keys.has(k)) {
        job.stop();
        this.jobs.delete(k);
      }
    }
    for (const w of wanted) {
      const key = `${w.agentId}|${w.versionId}|${w.schedule}`;
      if (this.jobs.has(key)) continue;
      const job = new CronEventSource({
        name: w.agentId,
        schedule: w.schedule,
        timezone: w.timezone,
        handler: async (event) => {
          await this.fire(w.agentId, w.schedule, event);
        },
        onError: (err) => this.ctx.logger.error({ err, agentId: w.agentId }, 'cron trigger failed'),
      });
      job.start();
      this.jobs.set(key, job);
    }
    return [...this.jobs.keys()];
  }

  /** Creates the run for one tick unless another replica already did. */
  async fire(
    agentId: string,
    schedule: string,
    event: Parameters<Services['runs']['enqueue']>[0]['event'],
  ): Promise<string | null> {
    const tickAt = new Date(event.time ?? this.ctx.now().toISOString());
    tickAt.setMilliseconds(0);
    const inserted = await this.ctx.db
      .insert(schema.cronTicks)
      .values({ agentId, schedule, tickAt })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return null;
    const run = await this.services.runs.enqueue({
      agentId,
      event,
      triggeredBy: `cron:${schedule}`,
    });
    return run.id;
  }

  start(reloadMs = 60_000): void {
    void this.reload();
    this.timer = setInterval(
      () =>
        void this.reload().catch((err: unknown) =>
          this.ctx.logger.error({ err }, 'cron reload failed'),
        ),
      reloadMs,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
  }
}
