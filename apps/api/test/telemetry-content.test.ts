import { randomUUID } from 'node:crypto';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { trace } from '@opentelemetry/api';
import {
  StaticSecretResolver,
  compileNetwork,
  issueModelToken,
  parseNetworkConfig,
} from '@openagentix/core';
import type { OutboundDispatcher } from '@openagentix/providers';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TENANT_ID, auditLog, connections, runs } from '../src/db/schema.js';
import { createTenantExporterSource } from '../src/services/telemetry-exporters.js';
import { GuardedSpanExporter } from '../src/telemetry-export.js';
import {
  capturedContentSize,
  captureModelContent,
  resetCapturedContent,
} from '../src/telemetry-content.js';
import { TenantExportRouter } from '../src/telemetry-tenant.js';
import { RunIdGenerator, resetTelemetryRuntime, withSpan } from '../src/telemetry.js';
import { RUN_TOKEN_SECRET, testNode, type TestNode } from './helpers.js';
import {
  BASE_ENV,
  FakeUpstream,
  HARNESS_ENV,
  IMAGE,
  PLATFORM_OPENAI_KEY,
  postModel,
  publicLookup,
} from './model-proxy-helpers.js';

/**
 * ADR 0015 S10, end to end: a model call through the real model proxy, the real database and the
 * real tenant source; only the network is a recording dispatcher. The canaries below must never
 * appear where the test says they must not.
 */
const TOOL_RESULT = 'CANARY-TOOL-RESULT-3a77';
const TOOL_ARG = 'CANARY-TOOL-ARG-9be1';
const PII_EMAIL = 'canary.person@example.org';
const PII_CARD = '4111 1111 1111 1111';
const PROMPT = 'CANARY-PROMPT-TEXT-d2f4';
const HEADERS_VALUE = 'Authorization=Bearer-COLLECTOR-SECRET-0123456789';

const secrets = new StaticSecretResolver({
  otlp: HEADERS_VALUE,
  'platform-openai': PLATFORM_OPENAI_KEY,
});
const ENV = {
  ...BASE_ENV,
  ...HARNESS_ENV,
  OAX_OTEL_TENANT_EXPORTERS: 'allow',
  OAX_OTEL_CONTENT: 'redacted',
};
const SOURCE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: content-agent
version: 1.0.0
owner: team-ops
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Research.
    runtime: { runner: container }
---
`;

const up = new FakeUpstream();
let n: TestNode;
let agentId: string;
let provider: NodeTracerProvider;
let router: TenantExportRouter;
let platform: InMemorySpanExporter;
const sent: { url: string; text: string; headers: Record<string, string> }[] = [];

const dispatcher = {
  network: compileNetwork(parseNetworkConfig({}).config),
  plan: () => ({}) as never,
  fetch: vi.fn(async (url: string, init: RequestInit) => {
    sent.push({
      url,
      text: Buffer.from(init.body as Buffer).toString('utf8'),
      headers: init.headers as Record<string, string>,
    });
    return new Response(null, { status: 200 });
  }),
  nodeAgents: vi.fn(),
  dial: vi.fn(),
  close: vi.fn(async () => undefined),
} as unknown as OutboundDispatcher;

beforeAll(async () => {
  n = await testNode(ENV, { secrets, fetchImpl: up.fetch, hostLookup: publicLookup });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: SOURCE } });
  expect(created.statusCode, created.body).toBe(201);
  agentId = created.json().id;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  expect(pub.statusCode, pub.body).toBe(201);
});
afterAll(async () => n.close());

beforeEach(() => {
  up.reset();
  sent.length = 0;
  resetCapturedContent();
  platform = new InMemorySpanExporter();
  router = new TenantExportRouter({ dispatcher, config: n.ctx.config.otel });
  router.attach(createTenantExporterSource(n.ctx));
  provider = new NodeTracerProvider({
    idGenerator: new RunIdGenerator(),
    // The platform pipeline exactly as in production: the allowlist sanitiser in front of the exporter.
    spanProcessors: [new SimpleSpanProcessor(new GuardedSpanExporter(platform, 1000)), router],
  });
  provider.register({ propagator: null });
});
afterEach(async () => {
  await router.shutdown();
  await provider.shutdown();
  trace.disable();
  resetTelemetryRuntime();
  for (const c of (await n.req({ method: 'GET', url: '/v1/connections' })).json().items as {
    id: string;
    kind: string;
  }[])
    if (c.kind === 'telemetry') await n.req({ method: 'DELETE', url: `/v1/connections/${c.id}` });
});

const exporter = (config: Record<string, unknown> = {}) =>
  n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: `tel-${randomUUID().slice(0, 8)}`,
      kind: 'telemetry',
      config: { endpoint: 'https://otel.tenant.example', headersSecret: 'otlp', ...config },
    },
  });

async function dispatch() {
  const res = await n.req({
    method: 'POST',
    url: `/v1/agents/${agentId}/runs`,
    payload: { data: { go: true } },
  });
  const runId = res.json().id as string;
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 600_000),
    })
    .where(eq(runs.id, runId));
  const [run] = await n.ctx.db.select().from(runs).where(eq(runs.id, runId));
  let created!: Awaited<ReturnType<TestNode['services']['runNodes']['createSession']>>;
  await withSpan(
    {
      name: 'invoke_agent a',
      kind: 'invoke_agent',
      parent: { traceId: run!.traceId!, spanId: run!.traceRootSpanId! },
    },
    {},
    async () => {
      created = await n.services.runNodes.createSession(runId, 'w1', {
        agentId: 'a',
        input: { go: true },
        timeoutSeconds: 120,
        runner: 'container',
        image: IMAGE,
      });
    },
  );
  return { runId, created };
}

async function sentAfterFlush() {
  await vi.waitFor(() => expect((router as unknown as { pending: number }).pending).toBe(0));
  await router.forceFlush();
  return sent.map((s) => s.text).join('\n');
}

async function dispatchAndCall(request: Record<string, unknown>) {
  const { runId, created } = await dispatch();
  const call = await postModel(n, runId, created.token, {
    agentId: 'a',
    request: { model: 'sim-1', ...request },
  });
  expect(call.statusCode, call.body).toBe(200);
  return { runId, text: await sentAfterFlush() };
}

const request = (extra: Record<string, unknown> = {}) => ({
  system: 'You are careful.',
  messages: [
    {
      role: 'user',
      content: `${PROMPT} mail ${PII_EMAIL} card ${PII_CARD} key ${PLATFORM_OPENAI_KEY}`,
    },
    {
      role: 'assistant',
      content: 'calling a tool',
      toolCalls: [{ id: 'call_1', name: 'jira_get', args: { q: TOOL_ARG } }],
    },
    { role: 'tool', toolCallId: 'call_1', name: 'jira_get', content: TOOL_RESULT },
    { role: 'user', content: 'and now?' },
  ],
  ...extra,
});

const content = (text: string): string[] => {
  const keys = new Set<string>();
  for (const m of text.matchAll(/"key":"(gen_ai\.(?:input|output)\.messages)"/g)) keys.add(m[1]!);
  return [...keys];
};
const decoded = (text: string) => {
  const out: Record<string, string> = {};
  for (const b of text.split('\n').filter(Boolean)) {
    const j = JSON.parse(b) as {
      resourceSpans: {
        scopeSpans: {
          spans: { attributes: { key: string; value: { stringValue?: string } }[] }[];
        }[];
      }[];
    };
    for (const r of j.resourceSpans)
      for (const sc of r.scopeSpans)
        for (const sp of sc.spans)
          for (const a of sp.attributes)
            if (a.key.startsWith('gen_ai.') && a.key.endsWith('.messages'))
              out[a.key] = a.value.stringValue!;
  }
  return out;
};

describe('content reaches the tenant exporter that opted in, and only it', () => {
  it('sends input and output text, redacted, without tool arguments or results', async () => {
    const res = await exporter({ content: 'redacted', protocol: 'http/json' });
    expect(res.statusCode, res.body).toBe(201);
    const { text } = await dispatchAndCall(request());
    expect(content(text).sort()).toEqual(['gen_ai.input.messages', 'gen_ai.output.messages']);
    const attrs = decoded(text);
    const input = attrs['gen_ai.input.messages']!;
    expect(input).toContain(PROMPT);
    expect(input).toContain('You are careful.');
    expect(input).toContain('and now?');
    expect(input).toContain('calling a tool');
    // Canaries that must not be there: tool result, tool arguments, secret, personal data.
    for (const never of [
      TOOL_RESULT,
      TOOL_ARG,
      PII_EMAIL,
      PII_CARD,
      PLATFORM_OPENAI_KEY,
      'toolCalls',
      'jira_get',
    ])
      expect(text, never).not.toContain(never);
    expect(input).toContain('[pii:email]');
    expect(input).toContain('[pii:card]');
    for (const v of Object.values(attrs)) expect(Buffer.byteLength(v)).toBeLessThanOrEqual(8192);
    // The exporter credential went in a header, not in the payload.
    expect(text).not.toContain('COLLECTOR-SECRET');
    expect(sent[0]!.headers.Authorization).toBe('Bearer-COLLECTOR-SECRET-0123456789');
  });

  it('the platform pipeline never sees content, only the metadata span', async () => {
    await exporter({ content: 'redacted', protocol: 'http/json' });
    await dispatchAndCall(request());
    const spans = platform.getFinishedSpans();
    const chat = spans.find((s) => s.name.startsWith('chat'));
    expect(chat).toBeDefined();
    const everything = JSON.stringify(
      spans.map((s) => ({ a: s.attributes, e: s.events, n: s.name, l: s.links })),
    );
    for (const never of [
      PROMPT,
      TOOL_RESULT,
      TOOL_ARG,
      'gen_ai.input.messages',
      'gen_ai.output.messages',
    ])
      expect(everything, never).not.toContain(never);
    expect(chat!.attributes['gen_ai.request.model']).toBe('sim-1');
  });

  it('without the tenant opt-in only metadata is sent', async () => {
    await exporter({ content: 'off', protocol: 'http/json' });
    const { text } = await dispatchAndCall(request());
    expect(text).toContain('chat sim-1');
    expect(content(text)).toEqual([]);
    expect(text).not.toContain(PROMPT);
    expect(capturedContentSize()).toBe(0);
  });

  it('without any exporter nothing is sent and nothing is parked', async () => {
    const { text } = await dispatchAndCall(request());
    expect(text).toBe('');
    expect(capturedContentSize()).toBe(0);
  });

  it('a classification above the exporter clearance drops the content, not the span', async () => {
    await exporter({ content: 'redacted', clearance: 'public', protocol: 'http/json' });
    const { text } = await dispatchAndCall(request());
    expect(text).toContain('chat sim-1');
    expect(content(text)).toEqual([]);
    expect(text).not.toContain(PROMPT);
  });

  it('an opt-out stops the export of content on the next call; the change is audited', async () => {
    const created = await exporter({ content: 'redacted', protocol: 'http/json' });
    const id = created.json().id as string;
    expect(content((await dispatchAndCall(request())).text).length).toBe(2);
    sent.length = 0;
    const off = await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: {
        config: {
          endpoint: 'https://otel.tenant.example',
          headersSecret: 'otlp',
          protocol: 'http/json',
          content: 'off',
        },
      },
    });
    expect(off.statusCode, off.body).toBe(200);
    const { text } = await dispatchAndCall(request());
    expect(text).toContain('chat sim-1');
    expect(text).not.toContain(PROMPT);
    const audits = (await n.ctx.db.select().from(auditLog)).filter((a) =>
      a.action.startsWith('telemetry.content_'),
    );
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['telemetry.content_enabled', 'telemetry.content_disabled']),
    );
  });

  it('a disabled connection and a deleted one export nothing at all', async () => {
    const created = await exporter({ content: 'redacted', protocol: 'http/json' });
    const id = created.json().id as string;
    await n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      payload: {
        config: {
          endpoint: 'https://otel.tenant.example',
          headersSecret: 'otlp',
          protocol: 'http/json',
          content: 'redacted',
          enabled: false,
        },
      },
    });
    expect((await dispatchAndCall(request())).text).toBe('');
    await n.req({ method: 'DELETE', url: `/v1/connections/${id}` });
    expect((await dispatchAndCall(request())).text).toBe('');
  });

  it('long input is cut to 8 KiB and keeps the newest messages', async () => {
    await exporter({ content: 'redacted', protocol: 'http/json' });
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `turn-${i} ${'lorem ipsum '.repeat(120)}`,
    }));
    const { text } = await dispatchAndCall({ messages });
    const input = decoded(text)['gen_ai.input.messages']!;
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(8192);
    expect(input).toContain('turn-29');
    expect(input).not.toContain('turn-0 ');
    expect(text).toContain('oax.content.truncated');
  });
});

describe('pass-through surface', () => {
  it('covers a harness call and keeps tool_use and tool_result blocks out', async () => {
    await exporter({ content: 'redacted', protocol: 'http/json' });
    const { runId, created } = await dispatch();
    const { token, claims } = issueModelToken(
      RUN_TOKEN_SECRET,
      {
        runId,
        sid: created.sessionId,
        nodeId: created.nodeId,
        agentId: 'a',
        surface: 'harness',
        harness: 'claude-code',
        ttlSeconds: 60,
        notAfterMs: Date.now() + 60_000,
      },
      Date.now(),
    );
    expect(await n.services.runNodes.recordModelToken(created.sessionId, claims.jti)).toBe(true);
    const res = await n.req({
      method: 'POST',
      url: '/v1/model-proxy/anthropic/v1/messages',
      token,
      payload: {
        model: 'sim-1',
        max_tokens: 100,
        system: 'You are careful.',
        messages: [
          { role: 'user', content: `${PROMPT} mail ${PII_EMAIL}` },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'calling a tool' },
              { type: 'tool_use', id: 'toolu_1', name: 'jira_get', input: { q: TOOL_ARG } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: TOOL_RESULT }],
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const text = await sentAfterFlush();
    expect(text).toContain('chat sim-1');
    for (const never of [TOOL_RESULT, TOOL_ARG, PII_EMAIL, 'toolu_1', 'jira_get'])
      expect(text, never).not.toContain(never);
    const input = decoded(text)['gen_ai.input.messages']!;
    expect(input).toContain(PROMPT);
    expect(input).toContain('calling a tool');
    expect(input).toContain('[pii:email]');
  });
});

describe('operator gate', () => {
  it('with OAX_OTEL_CONTENT off nothing is captured even for a stored opt-in', async () => {
    const off = await testNode(
      { ...ENV, OAX_OTEL_CONTENT: 'off' },
      { secrets, fetchImpl: up.fetch, hostLookup: publicLookup },
    );
    try {
      // The API refuses to store the opt-in; write it straight into the table (a leftover from
      // an earlier configuration) and check that the proxy still captures nothing.
      await off.ctx.db.insert(connections).values({
        id: randomUUID(),
        tenantId: DEFAULT_TENANT_ID,
        scope: 'tenant',
        name: 'stored',
        kind: 'telemetry',
        config: { endpoint: 'https://otel.tenant.example', content: 'redacted' },
      });
      const r = await captureModelContent(
        { db: off.ctx.db, config: off.ctx.config.otel },
        {
          tenantId: DEFAULT_TENANT_ID,
          span: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
          classification: 'public',
          messages: [{ role: 'user', content: PROMPT }],
          outputText: 'x',
          secrets: [],
        },
      );
      expect(r).toBe('off');
      expect(capturedContentSize()).toBe(0);
    } finally {
      await off.close();
    }
  });
});
