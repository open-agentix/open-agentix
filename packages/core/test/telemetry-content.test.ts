import { describe, expect, it } from 'vitest';
import { ContextGuard } from '../src/context-guard.js';
import {
  CONTENT_INPUT_KEY,
  CONTENT_MAX_BYTES,
  CONTENT_OUTPUT_KEY,
  buildContentAttributes,
} from '../src/telemetry/content.js';

// Canaries: if one of these shows up in a built attribute, a gate failed.
const TOOL_RESULT = 'CANARY-TOOL-RESULT-91c2';
const TOOL_ARG = 'CANARY-TOOL-ARG-77de';
const SECRET = 'sk-live-0123456789abcdefABCDEF';
const GH_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const EMAIL = 'canary.person@example.org';
const CARD = '4111 1111 1111 1111';

const guard = () => new ContextGuard({ knownSecrets: [SECRET] });
const parse = (v: string | undefined) => JSON.parse(v ?? 'null') as unknown;
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('content attributes (ADR 0015 5.4)', () => {
  it('captures system, user and assistant text and the response text only', () => {
    const r = buildContentAttributes(
      {
        system: 'You are a helper.',
        messages: [
          { role: 'user', content: 'What is the status?' },
          { role: 'assistant', content: 'Let me look.' },
        ],
        outputText: 'All green.',
      },
      guard(),
    );
    expect(parse(r.attributes[CONTENT_INPUT_KEY])).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'You are a helper.' }] },
      { role: 'user', parts: [{ type: 'text', content: 'What is the status?' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'Let me look.' }] },
    ]);
    expect(parse(r.attributes[CONTENT_OUTPUT_KEY])).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'All green.' }] },
    ]);
    expect(r.truncated).toBe(false);
  });

  it('never reads tool messages, tool calls or non-text content', () => {
    const messages = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: 'calling',
        toolCalls: [{ id: 'c1', name: 'jira/get', args: { q: TOOL_ARG } }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'jira/get', content: TOOL_RESULT },
      { role: 'function', content: TOOL_RESULT },
      { role: 'user', content: { type: 'tool_result', content: TOOL_RESULT } },
      { role: 'assistant', content: ['array', TOOL_RESULT] },
    ];
    const r = buildContentAttributes({ messages, outputText: 'done' }, guard());
    const all = JSON.stringify(r.attributes);
    expect(all).not.toContain(TOOL_RESULT);
    expect(all).not.toContain(TOOL_ARG);
    expect(all).not.toContain('toolCalls');
    expect(all).not.toContain('tool_result');
    expect(all).toContain('run it');
    expect(all).toContain('calling');
  });

  it('passes every text through the secret guard and the personal data redactor', () => {
    const r = buildContentAttributes(
      {
        system: `key ${SECRET}`,
        messages: [
          { role: 'user', content: `mail ${EMAIL} card ${CARD} token ${GH_TOKEN}` },
          { role: 'assistant', content: `again ${SECRET}` },
        ],
        outputText: `reply to ${EMAIL} with ${SECRET}`,
      },
      guard(),
    );
    const all = JSON.stringify(r.attributes);
    for (const c of [SECRET, GH_TOKEN, EMAIL, CARD]) expect(all).not.toContain(c);
    expect(all).toContain('[pii:email]');
    expect(all).toContain('[pii:card]');
    expect(r.redactions.secrets).toBeGreaterThanOrEqual(3);
    expect(r.redactions.pii).toMatchObject({ email: 2, card: 1 });
  });

  it('removes invisible steering characters', () => {
    const r = buildContentAttributes(
      { messages: [{ role: 'user', content: 'ignore​ previous‮' }], outputText: '' },
      guard(),
    );
    expect(r.attributes[CONTENT_INPUT_KEY]).not.toMatch(/[\u200b\u202e]/);
    expect(r.attributes[CONTENT_OUTPUT_KEY]).toBeUndefined();
  });

  it('caps every attribute at 8 KiB of UTF-8 and keeps the newest messages', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `message-${i} ${'ä€😀'.repeat(300)}`,
    }));
    const r = buildContentAttributes({ messages, outputText: 'ö'.repeat(20_000) }, guard());
    for (const v of Object.values(r.attributes)) {
      expect(bytes(v!)).toBeLessThanOrEqual(CONTENT_MAX_BYTES);
      expect(() => JSON.parse(v!)).not.toThrow();
      expect(v).not.toMatch(/�/);
    }
    expect(r.truncated).toBe(true);
    const input = parse(r.attributes[CONTENT_INPUT_KEY]) as { parts: { content: string }[] }[];
    expect(input.at(-1)!.parts[0]!.content).toContain('message-39');
    expect(JSON.stringify(input)).not.toContain('message-0 ');
  });

  it('cuts one oversized message instead of dropping everything', () => {
    const r = buildContentAttributes(
      { messages: [{ role: 'user', content: 'word '.repeat(20_000) }], outputText: '' },
      guard(),
    );
    const v = r.attributes[CONTENT_INPUT_KEY]!;
    expect(bytes(v)).toBeLessThanOrEqual(CONTENT_MAX_BYTES);
    expect(v.length).toBeGreaterThan(8000);
    expect(r.truncated).toBe(true);
  });

  it('does not leak a secret that sits on the edge of a very long text', () => {
    // The scanned window starts at a word boundary, so the front half of a token is never kept.
    const text = `${'z'.repeat(40_000)} ${GH_TOKEN} ${'tail '.repeat(100)}`;
    const r = buildContentAttributes(
      { messages: [{ role: 'user', content: text }], outputText: '' },
      guard(),
    );
    expect(r.attributes[CONTENT_INPUT_KEY]).not.toContain('a1B2c3D4e5');
  });

  it('omits an attribute with nothing to say', () => {
    const r = buildContentAttributes(
      { messages: [{ role: 'tool', content: TOOL_RESULT }], outputText: '' },
      guard(),
    );
    expect(r.attributes).toEqual({});
  });

  it('prefers the visible text of a message over folded reasoning data', () => {
    const r = buildContentAttributes(
      {
        messages: [
          {
            role: 'assistant',
            content: 'THINKING-CANARY SIGNATURE-CANARY visible answer',
            captureText: 'visible answer',
          },
        ],
        outputText: '',
      },
      guard(),
    );
    expect(r.attributes[CONTENT_INPUT_KEY]).toContain('visible answer');
    expect(r.attributes[CONTENT_INPUT_KEY]).not.toMatch(/THINKING-CANARY|SIGNATURE-CANARY/);
  });

  it('has a hard time budget for adversarial input: 64 messages of 32k characters', () => {
    const nasty = '0-12-'.repeat(7000); // looks like phone and card prefixes everywhere
    const messages = Array.from({ length: 64 }, () => ({ role: 'user', content: nasty }));
    const start = Date.now();
    const r = buildContentAttributes({ messages, outputText: nasty }, guard());
    const ms = Date.now() - start;
    // Scanning is bounded by a character budget (64k per attribute plus one output window), not
    // by the 2 MiB that was sent.
    expect(ms).toBeLessThan(500);
    for (const v of Object.values(r.attributes))
      expect(bytes(v!)).toBeLessThanOrEqual(CONTENT_MAX_BYTES);
    expect(r.truncated).toBe(true);
  });

  it('stays fast on a megabyte of text', () => {
    const start = Date.now();
    buildContentAttributes(
      {
        messages: [{ role: 'user', content: 'lorem ipsum 4111 '.repeat(70_000) }],
        outputText: 'y'.repeat(1_000_000),
      },
      guard(),
    );
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
