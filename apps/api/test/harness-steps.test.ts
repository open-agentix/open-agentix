import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';
import { auditLog } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';
import {
  BASE_ENV,
  IMAGE,
  getModelToken,
  mkRun,
  publicLookup,
  secrets,
} from './model-proxy-helpers.js';

const ENV = {
  ...BASE_ENV,
  OAX_RUNNERS_ENABLED: 'in-process,container',
  OAX_CONTAINER_RUNNER_ENABLED: 'true',
  OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
  OAX_CONTAINER_IMAGE: IMAGE,
  OAX_CONTAINER_NETWORK: 'oax-nodes',
  OAX_NODE_CONTROL_URL: 'http://api:8080',
  OAX_CONTAINER_EGRESS_PROXY_URL: 'http://egress-proxy:3128',
  OAX_CONTAINER_EGRESS_GRANT_SECRET: 'g'.repeat(40),
  OAX_HARNESSES_ENABLED: 'claude-code,opencode',
};

let n: TestNode;
beforeAll(async () => {
  n = await testNode(ENV, { secrets, hostLookup: publicLookup });
});
afterAll(async () => n.close());

const token = (r: { runId: string; runToken: string }, payload: Record<string, unknown>) =>
  n.req({
    method: 'POST',
    url: `/v1/worker/runs/${r.runId}/model-token`,
    token: r.runToken,
    payload: { agentId: 'a', ...payload } as never,
  });

describe('harness model tokens (ADR 0009 section 10)', () => {
  it('hands a Claude Code step the Anthropic surface and records it in the audit chain', async () => {
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x', harness: 'claude-code' });
    const res = await token(r, { harness: 'claude-code' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, string>;
    expect(body).toMatchObject({ protocol: 'anthropic', model: 'claude-x' });
    expect(body.baseUrl).toBe('http://api:8080/v1/model-proxy/anthropic');
    expect(body.token).toMatch(/^oaxmt\./);
    expect(res.headers['cache-control']).toBe('no-store');
    const rows = (await n.ctx.db.select().from(auditLog).where(eq(auditLog.runId, r.runId))).filter(
      (a) => a.action === 'model_token.issued',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ harness: 'claude-code', protocol: 'anthropic' });
    expect(JSON.stringify(rows[0])).not.toContain(body.token);
  });

  it('lets OpenCode pick the surface of the provider: openai for an OpenAI connection', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x', harness: 'opencode' });
    const res = await token(r, { harness: 'opencode' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      protocol: 'openai',
      baseUrl: 'http://api:8080/v1/model-proxy/openai',
    });
  });

  it('accepts the simulated provider on the Anthropic surface', async () => {
    const r = await mkRun(n, { harness: 'claude-code' });
    expect((await token(r, { harness: 'claude-code' })).json()).toMatchObject({
      protocol: 'anthropic',
    });
  });

  it('refuses a provider the harness cannot speak (no translation)', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x', harness: 'claude-code' });
    const res = await token(r, { harness: 'claude-code' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('model_surface_mismatch');
  });

  it('refuses a harness the step did not publish', async () => {
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x', harness: 'claude-code' });
    const res = await token(r, { harness: 'opencode' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('model_not_allowed');
  });

  it('refuses a harness token for a step without a harness', async () => {
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x' });
    const res = await token(r, { harness: 'claude-code' });
    expect(res.statusCode).toBe(403);
  });

  it('gives a harness step no native token', async () => {
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x', harness: 'claude-code' });
    const res = await getModelToken(n, r.runId, r.runToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('model_not_allowed');
  });

  it('issues one token per step and session', async () => {
    const r = await mkRun(n, { harness: 'claude-code' });
    expect((await token(r, { harness: 'claude-code' })).statusCode).toBe(200);
    const again = await token(r, { harness: 'claude-code' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('model_token_already_issued');
  });

  it('still hands native tokens to ordinary steps', async () => {
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x' });
    expect((await getModelToken(n, r.runId, r.runToken)).json().protocol).toBe('native');
  });

  it('rejects unknown harness names at the wire', async () => {
    const r = await mkRun(n, {});
    expect((await token(r, { harness: 'hermes' })).statusCode).toBe(400);
  });
});

describe('publishing harness steps', () => {
  const source = (runtime: string, extra = '') => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: pub-${Math.random().toString(36).slice(2, 8)}
version: 1.0.0
owner: team-security
agents:
  - id: a
    provider: simulated
    model: sim-1
    runtime: ${runtime}
${extra}    instructions: Do it.
---
`;
  const publish = async (src: string) => {
    const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: src } });
    if (created.statusCode !== 201) return created;
    return n.req({ method: 'POST', url: `/v1/agents/${created.json().id as string}/publish` });
  };

  it('publishes a harness step on an isolating runner', async () => {
    expect((await publish(source('{ runner: container, harness: opencode }'))).statusCode).toBe(
      201,
    );
  });

  it('refuses a harness on the in-process runner and with a simulation', async () => {
    const inline = await publish(source('{ harness: claude-code }'));
    expect(inline.statusCode).toBe(400);
    expect(inline.body).toContain('isolating runner');
    const sim = await publish(
      source(
        '{ runner: container, harness: claude-code }',
        '    simulation:\n      responses:\n        - text: hi\n',
      ),
    );
    expect(sim.statusCode).toBe(400);
    expect(sim.body).toContain('simulation');
  });

  it('refuses a harness the operator did not enable', async () => {
    const off = await testNode(
      { ...ENV, OAX_HARNESSES_ENABLED: 'opencode' },
      { secrets, hostLookup: publicLookup },
    );
    try {
      const created = await off.req({
        method: 'POST',
        url: '/v1/agents',
        payload: { source: source('{ runner: container, harness: claude-code }') },
      });
      const res = await off.req({
        method: 'POST',
        url: `/v1/agents/${created.json().id as string}/publish`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('OAX_HARNESSES_ENABLED');
    } finally {
      await off.close();
    }
  });
});

describe('configuration', () => {
  const base = { OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' } as Record<string, string>;
  it('defaults to no harness and needs the model proxy for any', () => {
    expect(loadConfig(base).harnesses.enabled).toEqual([]);
    expect(() => loadConfig({ ...base, OAX_HARNESSES_ENABLED: 'opencode' })).toThrow(
      /requires OAX_MODEL_PROXY_ENABLED=true/,
    );
    expect(() =>
      loadConfig({ ...base, OAX_MODEL_PROXY_ENABLED: 'true', OAX_HARNESSES_ENABLED: 'hermes' }),
    ).toThrow(/unknown harness "hermes"/);
    expect(
      loadConfig({
        ...base,
        OAX_MODEL_PROXY_ENABLED: 'true',
        OAX_HARNESSES_ENABLED: 'opencode, claude-code,opencode',
      }).harnesses.enabled,
    ).toEqual(['opencode', 'claude-code']);
  });
});
