import type { OaxEvent } from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import { CronEventSource, validateCronExpression } from '../src/index.js';

describe('cron', () => {
  it('validates expressions', () => {
    expect(validateCronExpression('0 3 * * *', 'Europe/Berlin')).toBeInstanceOf(Date);
    expect(() => validateCronExpression('nope')).toThrow(/invalid cron expression/);
  });

  it('emits tick events and reports handler errors', async () => {
    const events: OaxEvent[] = [];
    const errors: unknown[] = [];
    const src = new CronEventSource({
      name: 'nightly',
      schedule: '0 3 * * *',
      timezone: 'UTC',
      handler: (e) => {
        events.push(e);
        if (events.length === 2) throw new Error('boom');
      },
      onError: (e) => errors.push(e),
    });
    expect(src.isRunning()).toBe(false);
    src.start();
    expect(src.isRunning()).toBe(true);
    expect(src.nextRun()?.getUTCHours()).toBe(3);
    await src.fire(new Date('2026-01-01T03:00:00Z'));
    await src.fire();
    expect(events[0]).toMatchObject({
      type: 'io.openagentix.cron.tick',
      source: '/sources/cron/nightly',
      data: { schedule: '0 3 * * *', scheduledAt: '2026-01-01T03:00:00.000Z' },
    });
    expect(errors).toHaveLength(1);
    src.stop();
    expect(src.isRunning()).toBe(false);
  });

  it('fires from the croner schedule', async () => {
    const events: OaxEvent[] = [];
    const src = new CronEventSource({
      name: 'fast',
      schedule: '* * * * * *',
      handler: (e) => void events.push(e),
    });
    src.start();
    await new Promise((r) => setTimeout(r, 1100));
    src.stop();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const silent = new CronEventSource({
      name: 'x',
      schedule: '0 0 1 1 *',
      handler: () => {
        throw new Error('ignored');
      },
    });
    await expect(silent.fire()).resolves.toBeUndefined();
  });
});
