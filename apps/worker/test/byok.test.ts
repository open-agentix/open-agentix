import { randomUUID } from 'node:crypto';
import { StaticSecretResolver } from '@openagentix/core';
import { demoServerFactories, inMemoryServers } from '@openagentix/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSource } from '../../api/test/fixtures.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { Worker } from '../src/index.js';

const PW = 'long-password-123';
const secrets = new StaticSecretResolver({
  'platform-key': 'sk-platform',
  'tenant-b.openai': 'sk-tenant-b',
});
const calls: { url: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
const fakeFetch = async (url: string, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  calls.push({ url, auth: headers.authorization, body: JSON.parse(String(init?.body ?? '{}')) });
  return new Response(
    JSON.stringify({
      model: 'gpt-4.1',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

let n: TestNode;
let alice: string;
let bob: string;
let tenantB: string;

const as = (token: string) => (opts: Parameters<TestNode['req']>[0]) => n.req({ ...opts, token });

beforeAll(async () => {
  n = await testNode({}, { secrets, fetchImpl: fakeFetch });
  const mk = async (slug: string) =>
    (
      await n.req({
        method: 'POST',
        url: '/v1/tenants',
        payload: {
          slug,
          name: slug,
          admin: { email: `admin@${slug}.example.org`, displayName: slug, password: PW },
        },
      })
    ).json().id as string;
  await mk('tenant-a');
  tenantB = await mk('tenant-b');
  alice = await n.login('admin@tenant-a.example.org', PW);
  bob = await n.login('admin@tenant-b.example.org', PW);
});
afterAll(async () => n.close());

describe('model catalog proposals', () => {
  it('proposes prices from the pinned snapshot and lets models be listed per provider', async () => {
    const r = await n.req({
      method: 'POST',
      url: '/v1/models/proposals',
      payload: {
        provider: 'azure-openai',
        models: [{ id: 'prod-gpt', catalogModel: 'gpt-4.1' }, { id: 'mystery' }],
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.catalogProvider).toBe('azure');
    expect(body.items[0]).toMatchObject({ id: 'prod-gpt', priceSource: 'catalog' });
    expect(body.items[0].inputPerMTok).toBeGreaterThan(0);
    expect(body.items[1]).toMatchObject({ priceSource: 'unknown', inputPerMTok: null });
    const all = await n.req({
      method: 'POST',
      url: '/v1/models/proposals',
      payload: { provider: 'anthropic' },
    });
    expect(all.json().items.length).toBeGreaterThan(5);
    const none = await n.req({
      method: 'POST',
      url: '/v1/models/proposals',
      payload: { provider: 'openai-compatible' },
    });
    expect(none.json().items).toEqual([]);
    const local = await n.req({
      method: 'POST',
      url: '/v1/models/proposals',
      payload: { provider: 'vllm', models: [{ id: 'my-7b' }] },
    });
    expect(local.json().items[0]).toMatchObject({ priceSource: 'local', inputPerMTok: 0 });
  });

  it('filters the model list by provider and text', async () => {
    const r = await n.req({ method: 'GET', url: '/v1/models?provider=anthropic&q=opus' });
    const items = r.json().items as { provider: string; id: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((m) => m.provider === 'anthropic' && /opus/i.test(m.id))).toBe(true);
    expect(r.json().sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('bring your own key', () => {
  it('stores secret references and proposes prices when a model connection is created', async () => {
    const B = as(bob);
    const inline = await B({
      method: 'POST',
      url: '/v1/connections',
      payload: { name: 'gpt', kind: 'model', config: { kind: 'openai', apiKey: 'sk-inline' } },
    });
    expect(inline.statusCode).toBe(400);
    const foreign = await B({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'gpt',
        kind: 'model',
        config: { kind: 'openai', apiKeySecret: 'platform-key' },
      },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().message).toContain('tenant-b.');
    const ok = await B({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'gpt',
        kind: 'model',
        config: {
          kind: 'openai',
          apiKeySecret: 'tenant-b.openai',
          models: [
            { id: 'gpt-4.1' },
            { id: 'gpt-4.1-mini', inputPerMTok: 9, outputPerMTok: 9 },
            { id: 'unlisted-model' },
          ],
        },
      },
    });
    expect(ok.statusCode).toBe(201);
    const stored = ok.json();
    expect(stored).toMatchObject({ kind: 'model', scope: 'tenant', tenantId: tenantB });
    expect(JSON.stringify(stored)).not.toContain('sk-tenant-b');
    expect(stored.config.apiKeySecret).toBe('tenant-b.openai');
    const [a, b, c] = stored.config.models;
    expect(a).toMatchObject({ id: 'gpt-4.1', priceSource: 'catalog' });
    expect(a.inputPerMTok).toBeGreaterThan(0);
    expect(b).toMatchObject({ inputPerMTok: 9, priceSource: 'override' });
    expect(c).toMatchObject({ id: 'unlisted-model', priceSource: 'unknown' });
    expect(c.inputPerMTok).toBeUndefined();
  });

  it('tests a connection with one tiny audited completion and prices it from the overrides', async () => {
    const B = as(bob);
    const id = (await B({ method: 'GET', url: '/v1/connections' }))
      .json()
      .items.find((c: { name: string }) => c.name === 'gpt').id;
    calls.length = 0;
    const r = await B({
      method: 'POST',
      url: `/v1/connections/${id}/test`,
      payload: { model: 'gpt-4.1-mini' },
    });
    expect(r.json()).toMatchObject({
      ok: true,
      inputTokens: 1000,
      outputTokens: 500,
      costMicros: 13_500,
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.openai.com/v1/chat/completions',
      auth: 'Bearer sk-tenant-b',
    });
    expect(calls[0]?.body).toMatchObject({ max_completion_tokens: 16 });
    const audit = (await B({ method: 'GET', url: '/v1/audit?action=connection.tested' })).json()
      .items;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('sk-tenant-b');
    // Tenant A can neither see nor test it.
    expect(
      (
        await as(alice)({
          method: 'POST',
          url: `/v1/connections/${id}/test`,
          payload: { model: 'x' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('reports test failures without leaking secrets', async () => {
    const B = as(bob);
    const created = await B({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'broken',
        kind: 'model',
        config: { kind: 'openai', apiKeySecret: 'tenant-b.missing' },
      },
    });
    const r = await B({
      method: 'POST',
      url: `/v1/connections/${created.json().id}/test`,
      payload: { model: 'm' },
    });
    expect(r.json()).toMatchObject({ ok: false });
    expect(r.json().error).toMatch(/not configured/);
  });

  it('runs an agent through the tenant key, priced with the connection overrides', async () => {
    const B = as(bob);
    await B({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-security', name: 'S' } });
    const src = agentSource('byok-agent')
      .replace('provider: simulated', 'provider: gpt')
      .replace('model: sim-1', 'model: gpt-4.1-mini');
    const agent = (await B({ method: 'POST', url: '/v1/agents', payload: { source: src } })).json()
      .id;
    await B({ method: 'POST', url: `/v1/agents/${agent}/publish` });
    const run = (
      await B({ method: 'POST', url: `/v1/agents/${agent}/runs`, payload: { data: {} } })
    ).json().id;
    calls.length = 0;
    const w = new Worker(n.ctx, {
      workerId: 'w-byok',
      inMemoryMcp: inMemoryServers(demoServerFactories()),
    });
    await w.tick();
    await w.drain();
    const done = (await B({ method: 'GET', url: `/v1/runs/${run}` })).json();
    expect(done).toMatchObject({ status: 'succeeded', costMicros: 13_500 });
    expect(calls[0]?.auth).toBe('Bearer sk-tenant-b');
    // The same provider name does not exist for tenant A: its run fails with a clear error.
    await as(alice)({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-security', name: 'S' },
    });
    const agentA = (
      await as(alice)({ method: 'POST', url: '/v1/agents', payload: { source: src } })
    ).json().id;
    await as(alice)({ method: 'POST', url: `/v1/agents/${agentA}/publish` });
    const runA = (
      await as(alice)({ method: 'POST', url: `/v1/agents/${agentA}/runs`, payload: { data: {} } })
    ).json().id;
    await w.tick();
    await w.drain();
    expect((await as(alice)({ method: 'GET', url: `/v1/runs/${runA}` })).json()).toMatchObject({
      status: 'failed',
      errorCode: 'provider_unknown',
    });
  });

  it('shows a broken connection as the failure reason of the run', async () => {
    const B = as(bob);
    const src = agentSource('broken-agent').replace('provider: simulated', 'provider: broken');
    const agent = (await B({ method: 'POST', url: '/v1/agents', payload: { source: src } })).json()
      .id;
    await B({ method: 'POST', url: `/v1/agents/${agent}/publish` });
    const run = (
      await B({ method: 'POST', url: `/v1/agents/${agent}/runs`, payload: { data: {} } })
    ).json().id;
    const w = new Worker(n.ctx, { workerId: 'w-broken' });
    await w.tick();
    await w.drain();
    const done = (await B({ method: 'GET', url: `/v1/runs/${run}` })).json();
    expect(done.status).toBe('failed');
    expect(done.errorMessage).toMatch(/not configured|unavailable/);
  });
});

describe('connection scopes', () => {
  it('lets platform operators share a provider and teams or agents override it', async () => {
    const platform = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'shared-llm',
        kind: 'model',
        scope: 'platform',
        config: { kind: 'openai', apiKeySecret: 'platform-key' },
      },
    });
    expect(platform.statusCode).toBe(201);
    const registryA = await n.services.models.registryFor({
      tenantId: randomUUID(),
      teamId: null,
      agentId: 'x',
    });
    expect(registryA.has('shared-llm')).toBe(true);
    expect(registryA.has('gpt')).toBe(false);
    // Tenant admins may not create or change platform connections.
    expect(
      (
        await as(bob)({
          method: 'POST',
          url: '/v1/connections',
          payload: {
            name: 'sneaky',
            kind: 'model',
            scope: 'platform',
            config: { kind: 'simulated' },
          },
        })
      ).statusCode,
    ).toBe(403);
    const listed = (await as(bob)({ method: 'GET', url: '/v1/connections' }))
      .json()
      .items.map((c: { name: string }) => c.name);
    expect(listed).toContain('shared-llm');
    expect(
      (await as(bob)({ method: 'DELETE', url: `/v1/connections/${platform.json().id}` }))
        .statusCode,
    ).toBe(403);
    const reg = await n.services.models.registryFor({
      tenantId: tenantB,
      teamId: null,
      agentId: 'x',
    });
    expect(reg.has('gpt')).toBe(true);
    expect(n.services.models.catalogProviderOf({ config: { kind: 'bedrock', region: 'r' } })).toBe(
      'amazon-bedrock',
    );
  });
});
