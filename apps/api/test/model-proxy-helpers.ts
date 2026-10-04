import { Writable } from 'node:stream';
import { StaticSecretResolver } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { runs, DEFAULT_TENANT_ID } from '../src/db/schema.js';
import type { LightMyRequestResponse } from 'fastify';
import { testSecrets, type TestNode } from './helpers.js';

export const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;

/** Secret values that must never appear in a response, a log line or an audit payload. */
export const PLATFORM_OPENAI_KEY = 'sk-platform-OPENAI-KEY-1234567890';
export const PLATFORM_ANTHROPIC_KEY = 'sk-ant-PLATFORM-KEY-1234567890';
export const TENANT_B_KEY = 'sk-tenant-b-KEY-0987654321';
export const ALL_KEYS = [PLATFORM_OPENAI_KEY, PLATFORM_ANTHROPIC_KEY, TENANT_B_KEY];

export const secrets = new StaticSecretResolver({
  'platform-openai': PLATFORM_OPENAI_KEY,
  'platform-anthropic': PLATFORM_ANTHROPIC_KEY,
  'tenant-b.openai': TENANT_B_KEY,
  ...Object.fromEntries(['trivy-hook', 'mail-hook', 'gh-hook'].map((k) => [k, `${k}-value-1234`])),
});
void testSecrets;

export const PROVIDERS = JSON.stringify([
  { kind: 'simulated', name: 'simulated' },
  { kind: 'openai', name: 'oai', apiKeySecret: 'platform-openai', clearance: 'internal' },
  {
    kind: 'anthropic',
    name: 'claude',
    apiKeySecret: 'platform-anthropic',
    clearance: 'confidential',
  },
]);
export const PRICES = JSON.stringify([
  { provider: 'oai', model: 'gpt-x', inputPerMTok: 10, outputPerMTok: 20 },
  { provider: 'claude', model: 'claude-x', inputPerMTok: 3, outputPerMTok: 15 },
]);

export const BASE_ENV = {
  OAX_MODEL_PROXY_ENABLED: 'true',
  OAX_MODEL_PROXY_REVOCATION_POLL_MS: '30',
  OAX_MODEL_PROXY_MAX_BODY_BYTES: '65536',
  OAX_MODEL_PROXY_MIN_OUTPUT_TOKENS: '16',
  OAX_MODEL_PROXY_MAX_CONCURRENT_PER_SESSION: '8',
  OAX_MODEL_PROXY_MAX_CONCURRENT_PER_TENANT: '32',
  OAX_PROVIDERS: PROVIDERS,
  OAX_PRICE_TABLE: PRICES,
};

// ---------- captured logs ----------

export interface LogCapture {
  logger: pino.Logger;
  text: () => string;
}

/** A debug-level logger writing into memory, to assert that nothing sensitive is ever logged. */
export function captureLogger(): LogCapture {
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      buf += chunk.toString('utf8');
      cb();
    },
  });
  return { logger: pino({ level: 'trace' }, stream), text: () => buf };
}

// ---------- fake upstream provider (injected as ctx.fetchImpl) ----------

export interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  aborted: boolean;
}

export type UpstreamHandler = (
  call: UpstreamCall,
  init: RequestInit,
) => Response | Promise<Response>;

export class FakeUpstream {
  calls: UpstreamCall[] = [];
  handler: UpstreamHandler = () => openaiJson({ text: 'ok' });
  /** Number of connections currently open (response not finished or cancelled). */
  open = 0;

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const call: UpstreamCall = {
      url,
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
      aborted: false,
    };
    this.calls.push(call);
    init.signal?.addEventListener('abort', () => (call.aborted = true), { once: true });
    return this.handler(call, init);
  };

  reset(): void {
    this.calls = [];
    this.handler = () => openaiJson({ text: 'ok' });
  }
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const openaiJson = (o: {
  text?: string;
  prompt?: number;
  completion?: number;
  toolCalls?: { id: string; name: string; arguments: string }[];
  finish?: string;
}) =>
  json({
    model: 'gpt-x',
    choices: [
      {
        message: {
          content: o.text ?? '',
          ...(o.toolCalls
            ? {
                tool_calls: o.toolCalls.map((t) => ({
                  id: t.id,
                  type: 'function',
                  function: { name: t.name, arguments: t.arguments },
                })),
              }
            : {}),
        },
        finish_reason: o.finish ?? (o.toolCalls ? 'tool_calls' : 'stop'),
      },
    ],
    usage: { prompt_tokens: o.prompt ?? 100, completion_tokens: o.completion ?? 50 },
  });

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

export const sse = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

/** An event-stream response pulled from an async generator; stops when the request is aborted. */
export function sseResponse(
  up: FakeUpstream,
  gen: (signal: AbortSignal) => AsyncGenerator<string>,
  init: RequestInit,
): Response {
  const enc = new TextEncoder();
  const signal = init.signal ?? new AbortController().signal;
  const it = gen(signal);
  up.open++;
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      up.open--;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (signal.aborted) {
        close();
        c.error(new Error('aborted'));
        return;
      }
      const r = await it.next();
      if (r.done) {
        close();
        c.close();
      } else c.enqueue(enc.encode(r.value));
    },
    cancel() {
      close();
      void it.return?.(undefined);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export const openaiChunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  sse({
    id: 'c1',
    object: 'chat.completion.chunk',
    model: 'gpt-x',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
export const openaiUsage = (prompt: number, completion: number) =>
  sse({
    id: 'c1',
    object: 'chat.completion.chunk',
    model: 'gpt-x',
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion },
  });
export const DONE = 'data: [DONE]\n\n';

// ---------- agents, runs, sessions ----------

export interface AgentOpts {
  name?: string;
  provider?: string;
  model?: string;
  classification?: string;
  /** Pipeline budget lines, e.g. `  maxCostUsd: 0.01`. */
  budget?: string;
  maxTokensPerCall?: number;
  simulation?: string;
}

let counter = 0;

export function agentSource(o: AgentOpts = {}): string {
  const name = o.name ?? `proxy-agent-${++counter}`;
  return `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: 1.0.0
owner: team-security
${o.classification ? `classification: ${o.classification}\n` : ''}${o.budget ? `budget:\n${o.budget}\n` : ''}agents:
  - id: a
    provider: ${o.provider ?? 'simulated'}
    model: ${o.model ?? 'sim-1'}
${o.maxTokensPerCall ? `    maxTokensPerCall: ${o.maxTokensPerCall}\n` : ''}${o.simulation ? `    simulation:\n      responses:\n${o.simulation}\n` : ''}    instructions: Summarise the event.
---
`;
}

export type Request = TestNode['req'];

export interface MadeRun {
  runId: string;
  sessionId: string;
  nodeId: string;
  /** Step-scoped run token of the node. */
  runToken: string;
  expiresAt: Date;
}

export async function mkRun(
  n: TestNode,
  o: AgentOpts = {},
  request: Request = n.req,
  worker = 'w1',
): Promise<MadeRun> {
  const created = await request({
    method: 'POST',
    url: '/v1/agents',
    payload: { source: agentSource(o) },
  });
  if (created.statusCode !== 201) throw new Error(`agent create failed: ${created.body}`);
  const id = created.json().id as string;
  const pub = await request({ method: 'POST', url: `/v1/agents/${id}/publish` });
  if (pub.statusCode !== 201) throw new Error(`publish failed: ${pub.body}`);
  const run = await request({
    method: 'POST',
    url: `/v1/agents/${id}/runs`,
    payload: { data: { x: 1 } },
  });
  const runId = run.json().id as string;
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: worker,
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 600_000),
    })
    .where(eq(runs.id, runId));
  const s = await n.services.runNodes.createSession(runId, worker, {
    agentId: 'a',
    input: { go: true },
    timeoutSeconds: 120,
    runner: 'container',
    image: IMAGE,
  });
  return {
    runId,
    sessionId: s.sessionId,
    nodeId: s.nodeId,
    runToken: s.token,
    expiresAt: s.expiresAt,
  };
}

export const ask = (text = 'hello', extra: Record<string, unknown> = {}, model = 'sim-1') => ({
  agentId: 'a',
  request: { model, messages: [{ role: 'user' as const, content: text }], ...extra },
});

export const postModel = (
  n: TestNode,
  runId: string,
  token: string | null,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> =>
  n.req({
    method: 'POST',
    url: `/v1/worker/runs/${runId}/model`,
    token,
    payload: payload as never,
    headers,
  });

export const getModelToken = (
  n: TestNode,
  runId: string,
  runToken: string,
  agentId = 'a',
): Promise<LightMyRequestResponse> =>
  n.req({
    method: 'POST',
    url: `/v1/worker/runs/${runId}/model-token`,
    token: runToken,
    payload: { agentId },
  });

/** Issues the model token of a made run (asserting success). */
export async function modelToken(n: TestNode, r: MadeRun): Promise<string> {
  const res = await getModelToken(n, r.runId, r.runToken);
  if (res.statusCode !== 200) throw new Error(`model token failed: ${res.body}`);
  return res.json().token as string;
}

export const tenantScope = { tenantId: DEFAULT_TENANT_ID };

/** Parses the events of an SSE body. */
export function parseSse(body: string): { event: string; data: Record<string, unknown> }[] {
  return body
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith(':'))
    .map((b) => {
      const event = /^event: (.*)$/m.exec(b)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(b)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}
