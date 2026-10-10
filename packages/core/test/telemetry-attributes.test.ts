import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_SPECS,
  ContextGuard,
  GENAI_SEMCONV_PIN,
  MAX_ATTRIBUTES_PER_CALL,
  OTHER_ERROR,
  OaxError,
  describeError,
  sanitizeAttributes,
  sanitizeName,
  spanKindFromName,
} from '../src/index.js';

// Example values only: none of these is a real credential.
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const TENANT = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const guard = () => new ContextGuard();

describe('semantic convention pin', () => {
  it('names the repository, commit and core version of ADR 0015', () => {
    expect(GENAI_SEMCONV_PIN).toEqual({
      repository: 'open-telemetry/semantic-conventions-genai',
      commit: '6fd0d76',
      coreVersion: '1.44.0',
    });
  });
});

describe('sanitizeAttributes: the closed allowlist', () => {
  it('keeps allowlisted keys of the span kind', () => {
    const r = sanitizeAttributes(
      'chat',
      {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'anthropic',
        'gen_ai.request.model': 'claude-sonnet-5-5',
        'gen_ai.usage.input_tokens': 1200,
        'oax.cost.priced': true,
        'gen_ai.response.finish_reasons': ['stop'],
      },
      guard(),
    );
    expect(r.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-5-5',
      'gen_ai.usage.input_tokens': 1200,
      'oax.cost.priced': true,
      'gen_ai.response.finish_reasons': ['stop'],
    });
    expect(r.dropped).toEqual({});
  });

  it('drops an unknown key and counts it by class, never by key', () => {
    const r = sanitizeAttributes('run', { 'my.new.field': 'x', 'oax.worker': 'w-1' }, guard());
    expect(r.attributes).toEqual({ 'oax.worker': 'w-1' });
    expect(r.dropped).toEqual({ unknown: 1 });
  });

  it('drops a known key that belongs to another span kind', () => {
    const r = sanitizeAttributes('run', { 'gen_ai.request.model': 'm' }, guard());
    expect(r.attributes).toEqual({});
    expect(r.dropped).toEqual({ wrong_span: 1 });
  });

  it.each([
    'gen_ai.input.messages',
    'gen_ai.output.messages',
    'gen_ai.system_instructions',
    'gen_ai.tool.definitions',
    'gen_ai.tool.description',
    'gen_ai.tool.call.arguments',
    'gen_ai.tool.call.result',
    'exception.stacktrace',
    'http.request.header.authorization',
    'url.full',
  ])('treats %s as content and drops it on every span kind', (key) => {
    for (const kind of ['chat', 'execute_tool', 'invoke_agent', 'unknown'] as const) {
      const r = sanitizeAttributes(kind, { [key]: 'prompt text' }, guard());
      expect(r.attributes).toEqual({});
      expect(r.dropped).toEqual({ content: 1 });
    }
  });

  it('accepts exception.message only in guarded mode, capped at 256 characters', () => {
    const raw = { 'exception.message': `${TOKEN} ${'x'.repeat(400)}` };
    expect(sanitizeAttributes('chat', raw, guard()).attributes).toEqual({});
    const r = sanitizeAttributes('chat', raw, guard(), { allowExceptionMessage: true });
    const msg = r.attributes['exception.message'] as string;
    expect(msg).not.toContain(TOKEN);
    expect(msg.length).toBeLessThanOrEqual(256);
    expect(r.redactions).toEqual({ 'github-token': 1 });
    expect(r.attributes['oax.redacted']).toBe(true);
  });

  it('caps the number of attributes per call', () => {
    const raw = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 'v']));
    const r = sanitizeAttributes('run', raw, guard());
    expect(r.dropped.unknown).toBe(MAX_ATTRIBUTES_PER_CALL);
    expect(r.dropped.overflow).toBe(200 - MAX_ATTRIBUTES_PER_CALL);
  });

  it('never throws on hostile values', () => {
    const hostile = {
      'oax.worker': { toString: () => 'x' },
      'oax.run.attempt': Number.NaN,
      'oax.cost.micro_usd': -1,
      'gen_ai.request.temperature': Infinity,
      'oax.policy.reason_codes': 'not-an-array',
    };
    const r = sanitizeAttributes('run', hostile, guard());
    expect(r.attributes).toEqual({});
  });
});

describe('sanitizeAttributes: values', () => {
  it('accepts tenant and run ids as UUIDs only, never names', () => {
    const ok = sanitizeAttributes(
      'run',
      { 'oax.tenant.id': TENANT, 'oax.run.id': TENANT },
      guard(),
    );
    expect(ok.attributes['oax.tenant.id']).toBe(TENANT);
    for (const bad of ['Acme Corp', 'acme', 'acme-corp-gmbh', TENANT.toUpperCase(), `${TENANT}x`]) {
      const r = sanitizeAttributes('run', { 'oax.tenant.id': bad }, guard());
      expect(r.attributes).toEqual({});
      expect(r.dropped).toEqual({ invalid: 1 });
    }
  });

  it('passes every free-text value through the ContextGuard', () => {
    const r = sanitizeAttributes(
      'execute_tool',
      { 'gen_ai.tool.name': `lookup ${TOKEN}`, 'oax.mcp.server': 'srv‮​x' },
      guard(),
    );
    expect(r.attributes['gen_ai.tool.name']).toBe('lookup [redacted:github-token]');
    expect(r.attributes['oax.mcp.server']).toBe('srvx');
    expect(r.redactions).toMatchObject({ 'github-token': 1, invisible: 2 });
    expect(r.attributes['oax.redacted']).toBe(true);
  });

  it('removes known secret values the guard was told about, in all encodings', () => {
    const g = guard();
    const secret = 'collector-api-key-0123456789';
    g.addSecret(secret);
    const r = sanitizeAttributes(
      'chat',
      {
        'gen_ai.request.model': `m-${secret}`,
        'oax.provider.instance': Buffer.from(secret).toString('hex'),
      },
      g,
    );
    expect(JSON.stringify(r.attributes)).not.toContain(secret);
    expect(JSON.stringify(r.attributes)).not.toContain(Buffer.from(secret).toString('hex'));
  });

  it('removes control characters and truncates free text instead of dropping it', () => {
    const r = sanitizeAttributes(
      'chat',
      { 'gen_ai.request.model': `a\nb\u0000c${'z'.repeat(500)}` },
      guard(),
    );
    const v = r.attributes['gen_ai.request.model'] as string;
    expect(v.startsWith('abc')).toBe(true);
    expect(v.length).toBe(ATTRIBUTE_SPECS['gen_ai.request.model'].max);
  });

  it('drops (does not truncate) a strictly typed value that is too long or malformed', () => {
    const r = sanitizeAttributes(
      'invoke_agent',
      { 'gen_ai.agent.name': 'a'.repeat(100), 'gen_ai.provider.name': 'Bad Name' },
      guard(),
    );
    expect(r.attributes).toEqual({});
    expect(r.dropped).toEqual({ invalid: 2 });
  });

  it('keeps a tool call id only in the provider-issued shape', () => {
    const ok = sanitizeAttributes(
      'execute_tool',
      { 'gen_ai.tool.call.id': 'toolu_01A-b_c' },
      guard(),
    );
    expect(ok.attributes['gen_ai.tool.call.id']).toBe('toolu_01A-b_c');
    for (const bad of ['has space', 'a/b', 'x'.repeat(65), 'ignore previous instructions']) {
      const r = sanitizeAttributes('execute_tool', { 'gen_ai.tool.call.id': bad }, guard());
      expect(r.attributes).toEqual({});
    }
  });

  it('checks enums, integer ranges and bounded arrays', () => {
    const r = sanitizeAttributes(
      'policy_check',
      {
        'oax.policy.effect': 'maybe',
        'oax.policy.reason_codes': Array.from({ length: 12 }, (_, i) => `code_${i}`),
        'oax.policy.bundle_digests': ['sha256:' + 'a'.repeat(64), 'not-a-digest'],
      },
      guard(),
    );
    expect(r.attributes['oax.policy.effect']).toBeUndefined();
    expect((r.attributes['oax.policy.reason_codes'] as string[]).length).toBe(8);
    expect(r.attributes['oax.policy.bundle_digests']).toEqual(['sha256:' + 'a'.repeat(64)]);
    expect(r.dropped).toMatchObject({ invalid: 1, overflow: 1 });
  });

  it('clamps a node-claimed duration instead of trusting it', () => {
    const r = sanitizeAttributes(
      'node_session',
      { 'oax.claimed.duration_ms': 10 * 24 * 3600 * 1000 },
      guard(),
    );
    expect(r.attributes['oax.claimed.duration_ms']).toBe(3_600_000);
  });
});

describe('cardinality and bounds', () => {
  it('only emits allowlisted keys within their caps, whatever goes in', () => {
    const rand = (n: number) =>
      Array.from({ length: n }, () =>
        String.fromCharCode(32 + Math.floor(Math.random() * 90)),
      ).join('');
    const keys = Object.keys(ATTRIBUTE_SPECS);
    for (let i = 0; i < 1000; i++) {
      const raw: Record<string, unknown> = {};
      for (let j = 0; j < 10; j++) {
        raw[Math.random() < 0.5 ? rand(8) : keys[Math.floor(Math.random() * keys.length)]!] =
          Math.random() < 0.5 ? rand(1 + Math.floor(Math.random() * 400)) : Math.random() * 1e12;
      }
      const kind = (['chat', 'invoke_workflow', 'execute_tool', 'unknown'] as const)[i % 4]!;
      const { attributes, dropped, redactions } = sanitizeAttributes(kind, raw, guard());
      for (const [k, v] of Object.entries(attributes)) {
        expect(keys).toContain(k);
        const spec = ATTRIBUTE_SPECS[k as keyof typeof ATTRIBUTE_SPECS] as { max?: number };
        if (typeof v === 'string' && spec.max !== undefined)
          expect(v.length).toBeLessThanOrEqual(spec.max);
      }
      // Drop classes and redaction kinds are closed sets, so they are safe as metric labels.
      for (const c of Object.keys(dropped))
        expect(['unknown', 'content', 'wrong_span', 'invalid', 'overflow']).toContain(c);
      for (const k of Object.keys(redactions)) expect(k).toMatch(/^[a-z-]+$/);
    }
  });
});

describe('sanitizeName and spanKindFromName', () => {
  it('guards and caps span names', () => {
    expect(sanitizeName(`chat ${TOKEN}`, guard(), 'x').name).toBe('chat [redacted:github-token]');
    expect(sanitizeName('a'.repeat(500), guard(), 'x').name.length).toBe(128);
    expect(sanitizeName('\n\u0000', guard(), 'fallback').name).toBe('fallback');
  });

  it('maps span names of the span table to kinds', () => {
    expect(spanKindFromName('oax.run')).toBe('run');
    expect(spanKindFromName('invoke_workflow my-agent')).toBe('invoke_workflow');
    expect(spanKindFromName('chat claude-sonnet-5-5')).toBe('chat');
    expect(spanKindFromName('oax.policy.check srv/tool')).toBe('policy_check');
    expect(spanKindFromName('GET /v1/runs/:id')).toBe('http_server');
    expect(spanKindFromName('anything else')).toBe('unknown');
  });
});

describe('describeError', () => {
  it('returns the stable code and the class name, never the message', () => {
    const e = new OaxError('provider_failed', `upstream said: ${TOKEN}`);
    expect(describeError(e)).toEqual({ code: 'provider_failed', type: 'OaxError' });
  });

  it('accepts system error codes and rejects anything that is not code-shaped', () => {
    const net = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    expect(describeError(net).code).toBe('ECONNREFUSED');
    const sneaky = Object.assign(new Error('x'), { code: `reason: ${TOKEN}` });
    expect(describeError(sneaky).code).toBe(OTHER_ERROR);
  });

  it('collapses non-errors and hostile objects to _OTHER without reading the message', () => {
    expect(describeError('plain string with a secret')).toEqual({ code: '_OTHER', type: '_OTHER' });
    expect(describeError(null)).toEqual({ code: '_OTHER', type: '_OTHER' });
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error('getter must not be able to break telemetry');
        },
        getPrototypeOf() {
          throw new Error('nor the prototype lookup');
        },
      },
    );
    expect(describeError(trap)).toEqual({ code: '_OTHER', type: '_OTHER' });
  });

  it('does not trust a mutable name property for the class name', () => {
    const e = Object.assign(new TypeError('x'), { name: `secret ${TOKEN}` });
    expect(describeError(e).type).toBe('TypeError');
  });
});
