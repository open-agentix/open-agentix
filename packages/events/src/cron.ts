import { OaxError, type OaxEvent } from '@openagentix/core';
import { Cron } from 'croner';
import { EVENT_TYPES, createEvent, sourceUri } from './envelope.js';

export interface CronSourceOptions {
  name: string;
  schedule: string;
  timezone?: string | undefined;
  handler: (event: OaxEvent) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

/** Validates a cron expression (5 or 6 fields, croner syntax). */
export function validateCronExpression(schedule: string, timezone?: string): Date | null {
  try {
    return new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) }).nextRun();
  } catch (e) {
    throw new OaxError(
      'cron_invalid',
      `invalid cron expression "${schedule}": ${(e as Error).message}`,
    );
  }
}

/** Emits `io.openagentix.cron.tick` events; overlapping runs are skipped (`protect`). */
export class CronEventSource {
  private readonly job: Cron;

  constructor(private readonly opts: CronSourceOptions) {
    validateCronExpression(opts.schedule, opts.timezone);
    this.job = new Cron(
      opts.schedule,
      {
        paused: true,
        protect: true,
        ...(opts.timezone ? { timezone: opts.timezone } : {}),
        name: `oax-cron-${opts.name}`,
      },
      () => this.fire(),
    );
  }

  start(): void {
    this.job.resume();
  }

  stop(): void {
    this.job.stop();
  }

  nextRun(): Date | null {
    return this.job.nextRun();
  }

  isRunning(): boolean {
    return this.job.isRunning();
  }

  /** Emits one tick now (also used by the scheduler loop and tests). */
  async fire(at: Date = new Date()): Promise<void> {
    const event = createEvent({
      source: sourceUri('cron', this.opts.name),
      type: EVENT_TYPES.cron,
      subject: this.opts.schedule,
      time: at,
      data: { schedule: this.opts.schedule, scheduledAt: at.toISOString() },
    });
    try {
      await this.opts.handler(event);
    } catch (e) {
      this.opts.onError?.(e);
    }
  }
}
