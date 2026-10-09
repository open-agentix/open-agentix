import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, DEFAULT_TENANT_ID } from '../src/db/schema.js';
import { deactivateAirgap } from '../src/airgap.js';
import { testNode, type TestNode } from './helpers.js';
import {
  BASE_ENV,
  FakeUpstream,
  publicLookup,
  ask,
  getModelToken,
  mkRun,
  modelToken,
  openaiJson,
  postModel,
  secrets,
  tenantScope,
} from './model-proxy-helpers.js';

const up = new FakeUpstream();
let n: TestNode;

beforeAll(async () => {
  n = await testNode(
    {
      ...BASE_ENV,
      // the static providers must satisfy the start-up check; the stored ones are checked per call
      OAX_PROVIDERS: JSON.stringify([{ kind: 'simulated', name: 'simulated' }]),
      OAX_AIRGAPPED: 'true',
      OAX_AIRGAPPED_ALLOW: 'vllm.internal',
    },
    { secrets, fetchImpl: up.fetch, hostLookup: publicLookup },
  );
  const local = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'local-llm',
      kind: 'model',
      config: {
        kind: 'vllm',
        baseUrl: 'http://vllm.internal/v1',
        models: [{ id: 'llama-3', inputPerMTok: 0, outputPerMTok: 0 }],
      },
    },
  });
  expect(local.statusCode).toBe(201);
  // A connection stored before air-gapped mode was switched on.
  await n.ctx.database.db.execute(
    `insert into connections (id, tenant_id, scope, name, kind, config)
     values (gen_random_uuid(), '${DEFAULT_TENANT_ID}', 'tenant', 'legacy-gpt', 'model',
       '{"kind":"openai","baseUrl":"https://api.openai.com/v1","apiKeySecret":"platform-openai"}'::jsonb)` as never,
  );
});
afterAll(async () => {
  await n.close();
  deactivateAirgap();
});
beforeEach(() => up.reset());

describe('air-gapped mode', () => {
  it('refuses a provider endpoint that is not allowlisted with egress_denied and zero connection attempts', async () => {
    const r = await mkRun(n, { provider: 'legacy-gpt', model: 'gpt-4.1' });
    const tok = await getModelToken(n, r.runId, r.runToken);
    // the token itself can be issued (the provider resolves); every call is refused
    expect(tok.statusCode).toBe(200);
    const mt = tok.json().token as string;
    const res = await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-4.1'));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('egress_denied');
    expect(up.calls).toHaveLength(0);
    expect(await n.services.modelAccounting.list(tenantScope, { runId: r.runId })).toEqual([]);
    const denied = (await n.ctx.db.select().from(auditLog)).filter(
      (e) => e.runId === r.runId && e.action === 'model.denied',
    );
    expect(denied[0]?.payload).toMatchObject({ reason: 'egress_denied', provider: 'legacy-gpt' });
    // the streaming variant is refused the same way
    const sse = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${r.runId}/model`,
      token: mt,
      payload: ask('hi', {}, 'gpt-4.1') as never,
      headers: { accept: 'text/event-stream' },
    });
    expect(sse.statusCode).toBe(403);
    expect(up.calls).toHaveLength(0);
  });

  it('serves an allowlisted internal endpoint and the keyless simulated provider', async () => {
    up.handler = () => openaiJson({ text: 'internal answer', prompt: 8, completion: 3 });
    const r = await mkRun(n, { provider: 'local-llm', model: 'llama-3' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, ask('hi', {}, 'llama-3'));
    expect(res.statusCode).toBe(200);
    expect(res.json().response.text).toBe('internal answer');
    expect(up.calls.map((c) => c.url)).toEqual(['http://vllm.internal/v1/chat/completions']);
    const sim = await mkRun(n, {});
    expect((await postModel(n, sim.runId, await modelToken(n, sim), ask())).statusCode).toBe(200);
  });
});
