import { describe, expect, it } from 'vitest';
import type { WebhookError } from '../src/index.js';
import {
  MemoryReplayGuard,
  signGithubWebhook,
  signWebhook,
  verifyWebhook,
  webhookToEvent,
} from '../src/index.js';

const NOW = 1_800_000_000_000;
const ts = NOW / 1000;
const body = JSON.stringify({ cve: 'CVE-2024-1' });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as WebhookError).code;
  }
}

describe('verifyWebhook (oax-v1)', () => {
  it('accepts valid signatures, supports rotation and blocks replays', async () => {
    const guard = new MemoryReplayGuard();
    const headers = signWebhook('new-secret', body, ts, 'd-1');
    const base = { scheme: 'oax-v1' as const, rawBody: body, replayGuard: guard, now: () => NOW };
    await expect(
      verifyWebhook({ ...base, secrets: ['old-secret', 'new-secret'], headers }),
    ).resolves.toEqual({ deliveryId: 'd-1' });
    expect(await code(verifyWebhook({ ...base, secrets: ['new-secret'], headers }))).toBe(
      'replayed',
    );
  });

  it('rejects missing, invalid, stale and tampered requests', async () => {
    const guard = new MemoryReplayGuard();
    const base = { scheme: 'oax-v1' as const, secrets: ['s'], replayGuard: guard, now: () => NOW };
    expect(await code(verifyWebhook({ ...base, rawBody: body, headers: {} }))).toBe(
      'signature_missing',
    );
    expect(
      await code(
        verifyWebhook({ ...base, rawBody: body, headers: signWebhook('s', body, ts - 3600) }),
      ),
    ).toBe('timestamp_invalid');
    expect(
      await code(
        verifyWebhook({
          ...base,
          rawBody: body,
          headers: { ...signWebhook('s', body, ts), 'x-oax-timestamp': 'abc' },
        }),
      ),
    ).toBe('timestamp_invalid');
    expect(
      await code(
        verifyWebhook({ ...base, rawBody: body + ' ', headers: signWebhook('s', body, ts) }),
      ),
    ).toBe('signature_invalid');
    expect(
      await code(
        verifyWebhook({ ...base, rawBody: body, headers: signWebhook('other', body, ts) }),
      ),
    ).toBe('signature_invalid');
    expect(
      await code(
        verifyWebhook({
          ...base,
          rawBody: body,
          headers: { ...signWebhook('s', body, ts), 'x-oax-signature': 'v1=zz' },
        }),
      ),
    ).toBe('signature_invalid');
  });

  it('derives a delivery id from the signature and accepts array headers', async () => {
    const h = signWebhook('s', body, ts);
    const r = await verifyWebhook({
      scheme: 'oax-v1',
      secrets: ['s'],
      rawBody: Buffer.from(body),
      headers: {
        'x-oax-timestamp': [h['x-oax-timestamp']!],
        'x-oax-signature': `v0=abc, ${h['x-oax-signature']!}`,
      },
      replayGuard: new MemoryReplayGuard(),
      now: () => NOW,
    });
    expect(r.deliveryId).toMatch(/^1800000000:[0-9a-f]{64}$/);
  });
});

describe('verifyWebhook (github)', () => {
  it('verifies x-hub-signature-256 and uses the delivery header', async () => {
    const guard = new MemoryReplayGuard();
    const headers = {
      'x-hub-signature-256': signGithubWebhook('gh', body),
      'x-github-delivery': 'g-1',
    };
    const base = { scheme: 'github' as const, secrets: ['gh'], rawBody: body, replayGuard: guard };
    expect(await verifyWebhook({ ...base, headers })).toEqual({ deliveryId: 'g-1' });
    expect(await code(verifyWebhook({ ...base, headers }))).toBe('replayed');
    expect(await code(verifyWebhook({ ...base, headers: {} }))).toBe('signature_missing');
    expect(
      await code(verifyWebhook({ ...base, headers: { 'x-hub-signature-256': 'sha256=00' } })),
    ).toBe('signature_invalid');
    const noDelivery = await verifyWebhook({
      ...base,
      rawBody: '{}',
      headers: { 'x-hub-signature-256': signGithubWebhook('gh', '{}') },
    });
    expect(noDelivery.deliveryId).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('MemoryReplayGuard', () => {
  it('expires entries and bounds memory', async () => {
    let t = 0;
    const g = new MemoryReplayGuard(2, () => t);
    expect(await g.checkAndRemember('a', 10)).toBe(true);
    expect(await g.checkAndRemember('a', 10)).toBe(false);
    t = 11;
    expect(await g.checkAndRemember('a', 10)).toBe(true);
    await g.checkAndRemember('b', 100);
    await g.checkAndRemember('c', 100);
    expect(g.size).toBeLessThanOrEqual(2);
  });
});

describe('webhookToEvent', () => {
  it('wraps JSON payloads', () => {
    const e = webhookToEvent({ sourceName: 'trivy', rawBody: body, deliveryId: 'd-9' });
    expect(e).toMatchObject({
      id: 'd-9',
      source: '/sources/webhook/trivy',
      type: 'io.openagentix.webhook.received',
      data: { cve: 'CVE-2024-1' },
    });
    expect(webhookToEvent({ sourceName: 'x', rawBody: '' }).data).toBeNull();
  });
  it('keeps structured CloudEvents', () => {
    const ce = {
      specversion: '1.0',
      id: 'x',
      source: '/jira',
      type: 'com.atlassian.jira.issue_created',
      data: { key: 'SEC-1' },
    };
    expect(
      webhookToEvent({
        sourceName: 'jira',
        rawBody: JSON.stringify(ce),
        contentType: 'application/cloudevents+json',
      }),
    ).toEqual(ce);
  });
  it('accepts text payloads and rejects bad JSON and oversize bodies', () => {
    expect(
      webhookToEvent({ sourceName: 'x', rawBody: 'hello', contentType: 'text/plain' }),
    ).toMatchObject({ data: 'hello', datacontenttype: 'text/plain' });
    expect(() =>
      webhookToEvent({ sourceName: 'x', rawBody: '{', contentType: 'application/json' }),
    ).toThrow(/not valid JSON/);
    expect(() =>
      webhookToEvent({ sourceName: 'x', rawBody: 'x'.repeat(20), maxBytes: 10 }),
    ).toThrow(/too large/);
  });
});
