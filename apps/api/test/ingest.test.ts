import { signGithubWebhook, signWebhook } from '@openagentix/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CVE_TRIAGE, TRIVY_EVENT } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';

let n: TestNode;
let agentId: string;
let sourceId: string;
const body = JSON.stringify(TRIVY_EVENT);
const now = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  n = await testNode();
  await n.req({
    method: 'POST',
    url: '/v1/teams',
    payload: { slug: 'team-security', name: 'Security' },
  });
  agentId = (
    await n.req({ method: 'POST', url: '/v1/agents', payload: { source: CVE_TRIAGE } })
  ).json().id;
  await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  const src = await n.req({
    method: 'POST',
    url: '/v1/event-sources',
    payload: { name: 'trivy', kind: 'webhook', secretRefs: ['trivy-hook'], agentId },
  });
  expect(src.statusCode).toBe(201);
  sourceId = src.json().id;
  expect(src.json().ingestUrl).toBe(`http://localhost:8080/v1/ingest/webhook/${sourceId}`);
});
afterAll(async () => n.close());

const post = (id: string, headers: Record<string, string>, payload = body, kind = 'webhook') =>
  n.req({
    method: 'POST',
    url: `/v1/ingest/${kind}/${id}`,
    token: null,
    payload,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('webhook ingest', () => {
  it('accepts signed webhooks and queues a run for the bound agent', async () => {
    const res = await post(sourceId, signWebhook('hook-secret-1', body, now(), 'delivery-1'));
    expect(res.statusCode).toBe(202);
    const { eventId, runId } = res.json();
    expect(runId).toBeTruthy();
    const run = (await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json();
    expect(run).toMatchObject({ status: 'queued', eventId, triggeredBy: 'webhook:trivy', agentId });
    const event = (await n.req({ method: 'GET', url: `/v1/events/${eventId}` })).json();
    expect(event).toMatchObject({
      cloudEventId: 'delivery-1',
      type: 'io.openagentix.webhook.received',
      payload: { data: TRIVY_EVENT },
    });
  });

  it('rejects replays, bad signatures and stale timestamps', async () => {
    const headers = signWebhook('hook-secret-1', body, now(), 'delivery-2');
    expect((await post(sourceId, headers)).statusCode).toBe(202);
    const replay = await post(sourceId, headers);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toBe('replayed');
    expect((await post(sourceId, signWebhook('wrong-secret', body, now()))).statusCode).toBe(401);
    expect(
      (await post(sourceId, signWebhook('hook-secret-1', body, now() - 3600))).statusCode,
    ).toBe(401);
    expect((await post(sourceId, {})).statusCode).toBe(401);
    expect((await post('00000000-0000-4000-8000-000000000000', {})).statusCode).toBe(404);
  });

  it('rejects invalid JSON with a valid signature', async () => {
    const bad = '{not json';
    const res = await post(sourceId, signWebhook('hook-secret-1', bad, now()), bad);
    expect(res.statusCode).toBe(400);
  });

  it('supports GitHub-style signatures and sources without agents', async () => {
    const gh = (
      await n.req({
        method: 'POST',
        url: '/v1/event-sources',
        payload: { name: 'github', kind: 'webhook', scheme: 'github', secretRefs: ['gh-hook'] },
      })
    ).json();
    const payload = JSON.stringify({ action: 'opened' });
    const res = await post(
      gh.id,
      {
        'x-hub-signature-256': signGithubWebhook('gh-secret', payload),
        'x-github-delivery': 'g-1',
      },
      payload,
    );
    expect(res.statusCode).toBe(202);
    expect(res.json().runId).toBeNull();
  });

  it('refuses disabled sources and sources without secrets', async () => {
    const nosecret = (
      await n.req({
        method: 'POST',
        url: '/v1/event-sources',
        payload: { name: 'nosecret', kind: 'webhook' },
      })
    ).json();
    expect((await post(nosecret.id, signWebhook('x', body, now()))).statusCode).toBe(401);
    const patched = await n.req({
      method: 'PATCH',
      url: `/v1/event-sources/${nosecret.id}`,
      payload: {
        enabled: false,
        secretRefs: ['trivy-hook'],
        scheme: 'oax-v1',
        agentId: null,
        config: { note: 'x' },
      },
    });
    expect(patched.json()).toMatchObject({ enabled: false, secretRefs: ['trivy-hook'] });
    expect((await post(nosecret.id, signWebhook('hook-secret-1', body, now()))).statusCode).toBe(
      404,
    );
    expect(
      (
        await n.req({
          method: 'POST',
          url: '/v1/event-sources',
          payload: { name: 'trivy', kind: 'webhook' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await n.req({
          method: 'PATCH',
          url: '/v1/event-sources/00000000-0000-4000-8000-000000000000',
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('mail-in', () => {
  it('normalises signed mail payloads', async () => {
    const mail = (
      await n.req({
        method: 'POST',
        url: '/v1/event-sources',
        payload: { name: 'support-mail', kind: 'mail', secretRefs: ['mail-hook'], agentId },
      })
    ).json();
    const payload = JSON.stringify({
      from: 'reporter@example.com',
      to: 'agent@example.com',
      subject: 'CVE report',
      text: 'Please check CVE-2024-3094',
    });
    const res = await post(mail.id, signWebhook('mail-secret-1', payload, now()), payload, 'mail');
    expect(res.statusCode).toBe(202);
    const ev = (await n.req({ method: 'GET', url: `/v1/events/${res.json().eventId}` })).json();
    expect(ev).toMatchObject({ type: 'io.openagentix.mail.received', subject: 'CVE report' });
    const bad = 'nope';
    expect(
      (await post(mail.id, signWebhook('mail-secret-1', bad, now()), bad, 'mail')).statusCode,
    ).toBe(400);
    expect(
      (await post(mail.id, signWebhook('mail-secret-1', body, now()), body, 'webhook')).statusCode,
    ).toBe(404);
  });
});

describe('events and sources listing', () => {
  it('lists sources and pages events by source', async () => {
    const sources = (await n.req({ method: 'GET', url: '/v1/event-sources' })).json().items;
    expect(sources.map((s: { name: string }) => s.name)).toContain('trivy');
    expect((await n.req({ method: 'GET', url: `/v1/event-sources/${sourceId}` })).json().name).toBe(
      'trivy',
    );
    const page1 = (
      await n.req({ method: 'GET', url: `/v1/events?sourceId=${sourceId}&limit=1` })
    ).json();
    expect(page1.items).toHaveLength(1);
    const page2 = (
      await n.req({
        method: 'GET',
        url: `/v1/events?sourceId=${sourceId}&limit=1&cursor=${page1.nextCursor}`,
      })
    ).json();
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(
      (await n.req({ method: 'GET', url: '/v1/events/00000000-0000-4000-8000-000000000000' }))
        .statusCode,
    ).toBe(404);
    expect(await n.services.ingest.pruneDeliveries()).toBe(0);
  });
});
