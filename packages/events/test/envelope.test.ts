import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  createEvent,
  isCloudEvent,
  parseCloudEvent,
  sourceUri,
} from '../src/index.js';

describe('envelope', () => {
  it('creates CloudEvents 1.0 envelopes', () => {
    const e = createEvent({
      source: sourceUri('webhook', 'trivy'),
      type: EVENT_TYPES.webhook,
      data: { a: 1 },
      subject: 's',
      classification: 'internal',
      time: new Date(0),
    });
    expect(e).toMatchObject({
      specversion: '1.0',
      source: '/sources/webhook/trivy',
      subject: 's',
      oaxclassification: 'internal',
      time: '1970-01-01T00:00:00.000Z',
      datacontenttype: 'application/json',
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(createEvent({ source: 's', type: 't' }).data).toBeNull();
  });
  it('detects and validates CloudEvents', () => {
    expect(isCloudEvent({ specversion: '1.0', type: 'x' })).toBe(true);
    expect(isCloudEvent(null)).toBe(false);
    expect(isCloudEvent({ type: 'x' })).toBe(false);
    expect(() => parseCloudEvent({ specversion: '1.0', type: 'x' })).toThrow(/invalid CloudEvent/);
  });
});
