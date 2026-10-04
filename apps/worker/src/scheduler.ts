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
    const wanted: {
      key: string;
      agentId: string;
      schedule: string;
      timezone?: string | undefined;
      sourceId?: string;
    }[] = (await this.services.agents.cronAgents()).map((w) => ({
      key: `${w.agentId}|${w.versionId}|${w.schedule}`,
      agentId: w.agentId,
      schedule: w.schedule,
      timezone: w.timezone,
    }));
    // Cron event sources (kind "cron") bound to an agent.
    for (const s of await this.services.ingest.listSources()) {
      const cfg = s.config as { schedule?: unknown; timezone?: unknown };
      if (s.kind !== 'cron' || !s.enabled || !s.agentId || typeof cfg.schedule !== 'string')
        continue;
      wanted.push({
        key: `source|${s.id}|${cfg.schedule}`,
        agentId: s.agentId,
        schedule: cfg.schedule,
        timezone: typeof cfg.timezone === 'string' ? cfg.timezone : undefined,
        sourceId: s.id,
      });
    }
    const keys = new Set(wanted.map((w) => w.key));
    for (const [k, job] of this.jobs) {
      if (!keys.has(k)) {
        job.stop();
        this.jobs.delete(k);
      }
    }
    for (const w of wanted) {
      if (this.jobs.has(w.key)) continue;
      const job = new CronEventSource({
        name: w.sourceId ?? w.agentId,
        schedule: w.schedule,
        timezone: w.timezone,
        handler: async (event) => {
          await this.fire(w.agentId, w.schedule, event, w.sourceId);
        },
        onError: (err) => this.ctx.logger.error({ err, agentId: w.agentId }, 'cron trigger failed'),
      });
      job.start();
      this.jobs.set(w.key, job);
    }
    return [...this.jobs.keys()];
  }

  /** Creates the run for one tick unless another replica already did. */
  async fire(
    agentId: string,
    schedule: string,
    event: Parameters<Services['runs']['enqueue']>[0]['event'],
    sourceId?: string,
  ): Promise<string | null> {
    const tickAt = new Date(event.time ?? this.ctx.now().toISOString());
    tickAt.setMilliseconds(0);
    const inserted = await this.ctx.db
      .insert(schema.cronTicks)
      .values({ agentId, schedule, tickAt })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return null;
    if (sourceId) {
      const source = await this.services.ingest.getSource(sourceId);
      const gate = await this.services.ingest.changeGate(source);
      // Change gate: no event, no run, no tokens when the probe did not change.
      if (gate && !gate.changed) return null;
      const gated = gate ? { ...event, data: { ...(event.data as object), change: gate } } : event;
      return (await this.services.ingest.ingestEvent(source, gated, `cron:${source.name}`)).runId;
    }
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
