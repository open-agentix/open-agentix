import { describe, expect, it } from 'vitest';
import { OaxEventSchema, RUN_STATUSES, canTransition, isTerminal } from '../src/index.js';

describe('run state machine', () => {
  it('knows terminal states', () => {
    expect(RUN_STATUSES.filter(isTerminal)).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'blocked_by_policy',
    ]);
  });
  it('allows only documented transitions', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'awaiting_approval')).toBe(true);
    expect(canTransition('awaiting_approval', 'running')).toBe(true);
    expect(canTransition('succeeded', 'running')).toBe(false);
    expect(canTransition('queued', 'succeeded')).toBe(false);
  });
});

describe('OaxEventSchema', () => {
  it('accepts CloudEvents 1.0 envelopes with extensions', () => {
    const e = OaxEventSchema.parse({
      specversion: '1.0',
      id: '1',
      source: '/sources/trivy',
      type: 'io.openagentix.webhook',
      data: { a: 1 },
      oaxclassification: 'internal',
      custom: 'kept',
    });
    expect(e.oaxclassification).toBe('internal');
    expect((e as Record<string, unknown>).custom).toBe('kept');
    expect(
      OaxEventSchema.safeParse({ specversion: '0.3', id: '1', source: 's', type: 't' }).success,
    ).toBe(false);
  });
});
