import { describe, expect, it } from 'vitest';
import {
  MODEL_ERRORS,
  MODEL_PROXY_LIMITS,
  ModelErrorEnvelopeSchema,
  ModelTokenRequestSchema,
  ModelTokenResponseSchema,
  WorkerModelRequestSchema,
  WorkerModelResponseSchema,
  hasUnsafeJson,
  modelErrorEnvelope,
} from '../src/index.js';

const req = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  agentId: 'a1',
  request: { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }], ...over },
  ...top,
});
const ok = (v: unknown) => WorkerModelRequestSchema.safeParse(v).success;

describe('WorkerModelRequest', () => {
  it('accepts a full request', () => {
    expect(
      ok(
        req({
          system: 's',
          maxTokens: 100,
          temperature: 0.2,
          tools: [{ name: 'jira_search', description: 'd', inputSchema: { type: 'object' } }],
          messages: [
            { role: 'user', content: 'q' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'c1', name: 'jira_search', args: { q: 1 } }],
            },
            { role: 'tool', toolCallId: 'c1', name: 'jira_search', content: 'r', isError: false },
          ],
          hints: { context: { a: 1 } },
        }),
      ),
    ).toBe(true);
  });

  it('refuses unknown keys: provider, simulation, server tools, extra top-level fields', () => {
    expect(ok(req({ provider: 'openai' }))).toBe(false);
    expect(ok(req({ hints: { simulation: [] } }))).toBe(false);
    expect(ok(req({ mcp_servers: [] }))).toBe(false);
    expect(ok(req({}, { provider: 'x' }))).toBe(false);
    expect(ok(req({ messages: [{ role: 'user', content: 'x', extra: 1 }] }))).toBe(false);
    expect(ok(req({ messages: [{ role: 'system', content: 'x' }] }))).toBe(false);
  });

  it('refuses missing ids, empty messages, bad numbers and bad tool names', () => {
    expect(ok({ request: req().request })).toBe(false);
    expect(ok(req({ messages: [] }))).toBe(false);
    expect(ok(req({ maxTokens: 0 }))).toBe(false);
    expect(ok(req({ maxTokens: 1.5 }))).toBe(false);
    expect(ok(req({ temperature: 3 }))).toBe(false);
    expect(ok(req({ tools: [{ name: 'bad name!', inputSchema: {} }] }))).toBe(false);
    expect(ok(req({ tools: [{ name: 'x'.repeat(65), inputSchema: {} }] }))).toBe(false);
  });

  it('refuses prototype keys, also nested and from JSON.parse', () => {
    const polluted = JSON.parse(
      '{"agentId":"a","request":{"model":"m","messages":[{"role":"user","content":"x"}],"hints":{"context":{"__proto__":{"x":1}}}}}',
    );
    expect(ok(polluted)).toBe(false);
    const nested = JSON.parse('{"a":{"b":[{"constructor":1}]}}');
    expect(ok(req({ tools: [{ name: 't', inputSchema: nested }] }))).toBe(false);
    expect(
      ok(
        req({
          messages: [
            { role: 'assistant', content: '', toolCalls: [{ id: 'i', name: 'n', args: nested }] },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('enforces size and count limits', () => {
    const many = Array.from({ length: MODEL_PROXY_LIMITS.maxMessages + 1 }, () => ({
      role: 'user',
      content: 'x',
    }));
    expect(ok(req({ messages: many }))).toBe(false);
    const tools = Array.from({ length: MODEL_PROXY_LIMITS.maxTools + 1 }, (_, i) => ({
      name: `t${i}`,
      inputSchema: {},
    }));
    expect(ok(req({ tools }))).toBe(false);
    expect(ok(req({ system: 'x'.repeat(MODEL_PROXY_LIMITS.maxTextBytes + 1) }))).toBe(false);
    expect(ok(req({ system: '世'.repeat(MODEL_PROXY_LIMITS.maxTextBytes / 3 + 1) }))).toBe(false);
    expect(
      ok(
        req({
          tools: [
            { name: 't', inputSchema: { big: 'x'.repeat(MODEL_PROXY_LIMITS.maxToolSchemaBytes) } },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe('hasUnsafeJson', () => {
  it('flags depth and forbidden keys only', () => {
    expect(hasUnsafeJson({ a: [1, { b: 'x' }], c: null })).toBe(false);
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = { x: deep };
    expect(hasUnsafeJson(deep)).toBe(true);
    expect(hasUnsafeJson(deep, 100)).toBe(false);
    expect(hasUnsafeJson(JSON.parse('{"prototype":1}'))).toBe(true);
  });
});

describe('responses and envelopes', () => {
  const response = {
    callId: 'c1',
    response: {
      text: 't',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2 },
      stopReason: 'end_turn',
      model: 'm',
    },
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      source: 'provider',
    },
    costMicros: 5,
    priced: true,
    remaining: { costMicros: 10 },
  };

  it('validates WorkerModelResponse strictly', () => {
    expect(WorkerModelResponseSchema.safeParse(response).success).toBe(true);
    expect(WorkerModelResponseSchema.safeParse({ ...response, extra: 1 }).success).toBe(false);
    expect(
      WorkerModelResponseSchema.safeParse({
        ...response,
        usage: { ...response.usage, source: 'node' },
      }).success,
    ).toBe(false);
    expect(WorkerModelResponseSchema.safeParse({ ...response, costMicros: -1 }).success).toBe(
      false,
    );
    expect(WorkerModelResponseSchema.safeParse({ ...response, costMicros: 1.5 }).success).toBe(
      false,
    );
  });

  it('validates the model token response and request', () => {
    const t = {
      token: 'oaxmt.abc.def',
      expiresAt: '2026-10-04T10:00:00.000Z',
      protocol: 'anthropic',
      baseUrl: 'http://api:3000/v1/model-proxy/anthropic',
      model: 'm',
    };
    expect(ModelTokenResponseSchema.safeParse(t).success).toBe(true);
    expect(ModelTokenResponseSchema.safeParse({ ...t, token: 'oaxrt.abc.def' }).success).toBe(
      false,
    );
    expect(ModelTokenResponseSchema.safeParse({ ...t, protocol: 'grpc' }).success).toBe(false);
    expect(ModelTokenResponseSchema.safeParse({ ...t, expiresAt: 'tomorrow' }).success).toBe(false);
    expect(ModelTokenRequestSchema.safeParse({ agentId: 'a' }).success).toBe(true);
    expect(ModelTokenRequestSchema.safeParse({ agentId: 'a', run: 'x' }).success).toBe(false);
  });

  it('builds the error envelope and maps ADR 0009 codes to statuses', () => {
    const e = modelErrorEnvelope('control_budget_cost', 'no');
    expect(ModelErrorEnvelopeSchema.safeParse(e).success).toBe(true);
    expect(e).toEqual({ error: { code: 'control_budget_cost', message: 'no' } });
    expect(MODEL_ERRORS.control_budget_cost.status).toBe(403);
    expect(MODEL_ERRORS.model_rate_limited.status).toBe(429);
    expect(MODEL_ERRORS.model_token_already_issued.anthropicType).toBeNull();
    for (const v of Object.values(MODEL_ERRORS)) expect(v.status).toBeGreaterThanOrEqual(400);
    // Budget refusals must never be retryable statuses.
    expect([402, 429]).not.toContain(MODEL_ERRORS.control_budget_tenant.status);
  });
});
