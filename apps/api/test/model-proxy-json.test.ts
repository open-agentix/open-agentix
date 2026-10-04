import { OaxError } from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors.js';
import { parseStrictJson, type StrictJsonError } from '../src/services/model-proxy-json.js';
import { ModelProxyError, toModelProxyError } from '../src/services/model-proxy.js';

const reason = (text: string, depth?: number) => {
  try {
    parseStrictJson(text, depth);
  } catch (e) {
    return (e as StrictJsonError).reason;
  }
  return null;
};

describe('parseStrictJson', () => {
  it('parses plain JSON like JSON.parse', () => {
    const text = '{"a":[1,-2.5e3,true,false,null,"x\\n\\u00e4"],"b":{"c":{}},"d":[]}';
    expect(parseStrictJson(`  ${text} `)).toEqual(JSON.parse(text));
    expect(parseStrictJson('"s"')).toBe('s');
    expect(parseStrictJson('12')).toBe(12);
    expect(parseStrictJson('[]')).toEqual([]);
  });

  it('refuses duplicate keys at any depth', () => {
    expect(reason('{"a":1,"a":2}')).toBe('duplicate_key');
    expect(reason('{"x":{"a":1,"b":2,"a":3}}')).toBe('duplicate_key');
    expect(reason('[{"a":1,"a":1}]')).toBe('duplicate_key');
  });

  it('refuses prototype keys', () => {
    for (const k of ['__proto__', 'constructor', 'prototype'])
      expect(reason(`{"ok":{"${k}":1}}`), k).toBe('forbidden_key');
  });

  it('refuses nesting beyond the limit', () => {
    expect(reason('['.repeat(70) + ']'.repeat(70), 64)).toBe('too_deep');
    expect(reason('['.repeat(60) + ']'.repeat(60), 64)).toBeNull();
  });

  it('refuses every kind of malformed input without echoing it', () => {
    for (const text of [
      '',
      '{',
      '{"a"}',
      '{"a":}',
      '{"a":1,}',
      '{a:1}',
      '[1,]',
      '[1 2]',
      '"abc',
      '"\\x"',
      'tru',
      '01',
      '1.',
      '{"a":1} x',
      '{"a":"\u0001"}',
      `{"k":"${'9'.repeat(100)}"`,
      '{"a":1e}',
    ]) {
      expect(reason(text), text).toBe('syntax');
    }
    try {
      parseStrictJson('{"password":SECRET}');
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET');
      expect((e as Error).message).toMatch(/offset \d+/);
    }
  });
});

describe('toModelProxyError', () => {
  it('keeps known codes and maps shared platform codes', () => {
    expect(toModelProxyError(new HttpError(403, 'control_budget_cost', 'm')).code).toBe(
      'control_budget_cost',
    );
    expect(toModelProxyError(new HttpError(409, 'invalid_state', 'm')).code).toBe(
      'run_node_session_revoked',
    );
    expect(toModelProxyError(new OaxError('run_node_session_revoked', 'm')).code).toBe(
      'run_node_session_revoked',
    );
    for (const c of ['not_found', 'forbidden', 'credential_scope', 'model_token_binding'])
      expect(toModelProxyError(new OaxError(c, 'm')).code, c).toBe('model_not_allowed');
    for (const c of [
      'run_token_invalid',
      'run_token_expired',
      'model_token_invalid',
      'model_token_expired',
    ])
      expect(toModelProxyError(new OaxError(c, 'm')).code, c).toBe('unauthenticated');
    const same = new ModelProxyError('provider_timeout', 'x');
    expect(toModelProxyError(same)).toBe(same);
    expect(same.status).toBe(504);
    expect(same.envelope()).toEqual({ error: { code: 'provider_timeout', message: 'x' } });
  });

  it('fails closed on anything else with a fixed message', () => {
    for (const e of [
      new Error('SELECT * FROM secrets'),
      'string',
      null,
      new OaxError('weird', 'internal detail'),
    ]) {
      const out = toModelProxyError(e);
      expect(out.code).toBe('model_proxy_unavailable');
      expect(out.message).toBe('the model proxy is unavailable');
    }
  });
});
