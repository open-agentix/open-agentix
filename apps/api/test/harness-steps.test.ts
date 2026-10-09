import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';
import { auditLog } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';
import {
  BASE_ENV,
  HARNESS_ENV,
  HARNESS_IMAGE,
  IMAGE,
  ask,
  getModelToken,
  postModel,
  mkRun,
  publicLookup,
  secrets,
} from './model-proxy-helpers.js';

const ENV = { ...BASE_ENV, ...HARNESS_ENV };

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

describe('model token surface (native vs harness)', () => {
  it('refuses a harness token on the native /model route', async () => {
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x', harness: 'claude-code' });
    const mt = ((await token(r, { harness: 'claude-code' })).json() as { token: string }).token;
    const res = await postModel(n, r.runId, mt, ask('hi', {}, 'claude-x'));
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).toMatch(/model_not_allowed|not valid for this endpoint/);
  });

  it('refuses a native token on the harness pass-through surface', async () => {
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x' });
    const issued = await getModelToken(n, r.runId, r.runToken);
    expect(issued.statusCode).toBe(200);
    const mt = (issued.json() as { token: string }).token;
    const res = await n.req({
      method: 'GET',
      url: '/v1/model-proxy/anthropic/v1/models',
      token: null,
      headers: { 'x-api-key': mt },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('still lets the harness token open its pass-through surface', async () => {
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x', harness: 'claude-code' });
    const mt = ((await token(r, { harness: 'claude-code' })).json() as { token: string }).token;
    const res = await n.req({
      method: 'GET',
      url: '/v1/model-proxy/anthropic/v1/models',
      token: null,
      headers: { 'x-api-key': mt },
    });
    expect(res.statusCode).toBe(200);
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

describe('harness egress and images at publish (DOG-1)', () => {
  const source = (name: string, runtime: string, pipelineRuntime = '') => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: 1.0.0
owner: team-security
${pipelineRuntime}agents:
  - id: a
    provider: simulated
    model: sim-1
    runtime: ${runtime}
    instructions: Do it.
---
`;
  const publishOn = async (node: TestNode, src: string) => {
    const created = await node.req({ method: 'POST', url: '/v1/agents', payload: { source: src } });
    if (created.statusCode !== 201) return created;
    return node.req({
      method: 'POST',
      url: `/v1/agents/${created.json().id as string}/publish`,
    });
  };

  it('refuses a harness step with egress hosts unless the operator allows it', async () => {
    const withEgress = source(
      'egress-denied',
      '{ runner: container, harness: claude-code, egress: [jira.example.com] }',
      'runtime:\n  runner: container\n  egress: [jira.example.com]\n',
    );
    const res = await publishOn(n, withEgress);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('OAX_HARNESS_EGRESS_ALLOWED');
    // a step that narrows to nothing is fine even under a pipeline with egress
    const narrowed = source(
      'egress-narrowed',
      '{ runner: container, harness: claude-code, egress: [] }',
      'runtime:\n  runner: container\n  egress: [jira.example.com]\n',
    );
    // the pipeline egress is outside the (empty) operator ceiling here; only the harness rule is asserted
    expect((await publishOn(n, narrowed)).body).not.toContain('OAX_HARNESS_EGRESS_ALLOWED');
  });

  it('publishes a harness step with egress when the operator allowed it and the ceiling covers it', async () => {
    const node = await testNode(
      {
        ...ENV,
        OAX_HARNESS_EGRESS_ALLOWED: 'true',
        OAX_CONTAINER_EGRESS_ALLOW: 'jira.example.com',
      },
      { secrets, hostLookup: publicLookup },
    );
    try {
      const res = await publishOn(
        node,
        source(
          'egress-allowed',
          '{ runner: container, harness: claude-code, egress: [jira.example.com] }',
          'runtime:\n  runner: container\n  egress: [jira.example.com]\n',
        ),
      );
      expect(res.statusCode).toBe(201);
    } finally {
      await node.close();
    }
  });

  it('refuses a harness step that also sets a toolbox', async () => {
    const node = await testNode(
      { ...ENV, OAX_CONTAINER_TOOLBOX_IMAGES: JSON.stringify({ 'git+node': IMAGE }) },
      { secrets, hostLookup: publicLookup },
    );
    try {
      const res = await publishOn(
        node,
        source('harness-toolbox', '{ runner: container, harness: claude-code }').replace(
          '    runtime:',
          '    toolbox: git+node\n    runtime:',
        ),
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('must not set a toolbox');
    } finally {
      await node.close();
    }
  });

  it('refuses an ordinary step whose toolbox or default image is a harness image', async () => {
    const viaToolbox = await testNode(
      { ...ENV, OAX_CONTAINER_TOOLBOX_IMAGES: JSON.stringify({ 'git+node': HARNESS_IMAGE }) },
      { secrets, hostLookup: publicLookup },
    );
    const viaDefault = await testNode(
      { ...ENV, OAX_CONTAINER_IMAGE: HARNESS_IMAGE },
      { secrets, hostLookup: publicLookup },
    );
    try {
      const t = await publishOn(
        viaToolbox,
        source('plain-toolbox', '{ runner: container }').replace(
          '    runtime:',
          '    toolbox: git+node\n    runtime:',
        ),
      );
      expect(t.statusCode).toBe(400);
      expect(t.body).toContain('would run on a harness image');
      const d = await publishOn(viaDefault, source('plain-default', '{ runner: container }'));
      expect(d.statusCode).toBe(400);
      expect(d.body).toContain('would run on a harness image');
      // an ordinary step on the regular images still publishes
      expect((await publishOn(n, source('plain-ok', '{ runner: container }'))).statusCode).toBe(
        201,
      );
    } finally {
      await viaToolbox.close();
      await viaDefault.close();
    }
  });

  it('refuses a harness without a configured image on the container runner', async () => {
    const { OAX_CONTAINER_HARNESS_IMAGES: _drop, ...noImages } = ENV;
    const node = await testNode(noImages, { secrets, hostLookup: publicLookup });
    try {
      const res = await publishOn(
        node,
        source('no-image', '{ runner: container, harness: claude-code }'),
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('OAX_CONTAINER_HARNESS_IMAGES');
    } finally {
      await node.close();
    }
  });
});

describe('configuration', () => {
  const base = { OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' } as Record<string, string>;
  const IMG = `ghcr.io/o/r@sha256:${'d'.repeat(64)}`;
  const container = {
    ...base,
    OAX_CONTAINER_RUNNER_ENABLED: 'true',
    OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
    OAX_CONTAINER_IMAGE: IMG,
    OAX_CONTAINER_NETWORK: 'oax-nodes',
    OAX_NODE_CONTROL_URL: 'http://api:8080',
  };
  it('reads the harness image map, /tmp sizes and the egress switch', () => {
    const c = loadConfig({
      ...container,
      OAX_CONTAINER_HARNESS_IMAGES: JSON.stringify({ 'claude-code': IMG }),
      OAX_CONTAINER_MAX_MEMORY_MB: '4096',
      OAX_CONTAINER_TMP_MB: '128',
      OAX_CONTAINER_HARNESS_TMP_MB: '512',
      OAX_HARNESS_EGRESS_ALLOWED: 'true',
    });
    expect(c.runners.container.config).toMatchObject({
      harnessImages: { 'claude-code': IMG },
      tmpMb: 128,
      harnessTmpMb: 512,
      harnessMemoryMb: 2048,
      harnessEgressAllowed: true,
    });
    expect(c.harnesses.egressAllowed).toBe(true);
    expect(loadConfig(container).harnesses.egressAllowed).toBe(false);
  });
  it('refuses tag-only or unknown harness images and a /tmp that cannot fit in memory', () => {
    expect(() =>
      loadConfig({
        ...container,
        OAX_CONTAINER_HARNESS_IMAGES: JSON.stringify({ 'claude-code': 'x:latest' }),
      }),
    ).toThrow(/digest/);
    expect(() =>
      loadConfig({ ...container, OAX_CONTAINER_HARNESS_IMAGES: JSON.stringify({ evil: IMG }) }),
    ).toThrow(/container runner/);
    expect(() =>
      loadConfig({
        ...container,
        OAX_CONTAINER_HARNESS_IMAGES: JSON.stringify({ 'claude-code': IMG }),
        OAX_CONTAINER_HARNESS_TMP_MB: '2048',
        OAX_CONTAINER_MAX_MEMORY_MB: '4096',
      }),
    ).toThrow(/must be at most half of the node memory/);
  });
  it('keeps the memory of ordinary nodes apart from the ceiling and bounds /tmp to half of it', () => {
    // raising the ceiling for harness steps does not raise the default of ordinary nodes
    const high = loadConfig({ ...container, OAX_CONTAINER_MAX_MEMORY_MB: '2048' });
    expect(high.runners.container.config).toMatchObject({ memoryMb: 512, maxMemoryMb: 2048 });
    expect(
      loadConfig({
        ...container,
        OAX_CONTAINER_MEMORY_MB: '1024',
        OAX_CONTAINER_MAX_MEMORY_MB: '2048',
      }).runners.container.config,
    ).toMatchObject({ memoryMb: 1024 });
    // tmp 2047 of 2048 would be accepted by a plain "<" check; the margin rule refuses it
    expect(() =>
      loadConfig({
        ...container,
        OAX_CONTAINER_MEMORY_MB: '2048',
        OAX_CONTAINER_MAX_MEMORY_MB: '2048',
        OAX_CONTAINER_TMP_MB: '2047',
      }),
    ).toThrow(/OAX_CONTAINER_TMP_MB \(2047\) must be at most half/);
    expect(() =>
      loadConfig({
        ...container,
        OAX_CONTAINER_MEMORY_MB: '2048',
        OAX_CONTAINER_MAX_MEMORY_MB: '2048',
        OAX_CONTAINER_TMP_MB: '1024',
      }),
    ).not.toThrow();
    // a value beyond the upper bound is a typo, not a limit
    expect(() =>
      loadConfig({ ...container, OAX_CONTAINER_MAX_MEMORY_MB: '99999999999' }),
    ).toThrow();
  });
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
