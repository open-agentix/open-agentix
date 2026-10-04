import { describe, expect, it } from 'vitest';
import { SseParser, StreamError, formatSseComment, formatSseEvent } from '../../src/index.js';

const enc = (s: string) => new TextEncoder().encode(s);
const limits = { maxLineBytes: 1024, maxEventBytes: 4096 };

function parseAll(chunks: Uint8Array[], l = limits) {
  const p = new SseParser(l);
  const out = chunks.flatMap((c) => p.push(c));
  p.end();
  return { out, pending: p.hasPending };
}

const sample =
  'event: a\ndata: {"x":"wörld 🌍"}\n\n: keep-alive\n\ndata: l1\ndata: l2\n\nid: 7\nretry: 1\nfoo: bar\ndata: z\n\n';

describe('SseParser', () => {
  const whole = parseAll([enc(sample)]).out;

  it('parses events, multi-line data, comments and ignores unknown fields', () => {
    expect(whole).toEqual([
      { event: 'a', data: '{"x":"wörld 🌍"}' },
      { event: 'message', data: 'l1\nl2' },
      { event: 'message', data: 'z' },
    ]);
  });

  it('gives the same result for every possible split point (partial frames, split UTF-8)', () => {
    const bytes = enc(sample);
    for (let i = 1; i < bytes.length; i++) {
      const r = parseAll([bytes.slice(0, i), bytes.slice(i)]);
      expect(r.out).toEqual(whole);
    }
  });

  it('gives the same result when fed one byte at a time', () => {
    const bytes = enc(sample);
    const r = parseAll(Array.from(bytes, (b) => Uint8Array.of(b)));
    expect(r.out).toEqual(whole);
  });

  it('accepts CRLF, lone CR (also split across chunks) and a BOM', () => {
    const r = parseAll([enc('﻿data: 1\r\n\r\ndata: 2\r'), enc('\n\rdata: 3\r\r')]);
    expect(r.out.map((e) => e.data)).toEqual(['1', '2', '3']);
  });

  it('keeps a value without leading space and a field without colon', () => {
    const r = parseAll([enc('data:x\n\ndata\n\n')]);
    expect(r.out.map((e) => e.data)).toEqual(['x', '']);
  });

  it('does not dispatch an event without data and resets the event name', () => {
    const r = parseAll([enc('event: only\n\ndata: y\n\n')]);
    expect(r.out).toEqual([{ event: 'message', data: 'y' }]);
  });

  it('rejects an over-long line, also when it never terminates', () => {
    const p = new SseParser(limits);
    expect(() => p.push(enc(`data: ${'a'.repeat(2000)}\n\n`))).toThrow(StreamError);
    const q = new SseParser(limits);
    q.push(enc('data: '));
    expect(() => {
      for (let i = 0; i < 100; i++) q.push(enc('b'.repeat(100)));
    }).toThrow(/line size limit/);
  });

  it('counts multi-byte characters as bytes for the line limit', () => {
    const p = new SseParser({ maxLineBytes: 100, maxEventBytes: 4096 });
    expect(() => p.push(enc(`data: ${'€'.repeat(40)}\n\n`))).toThrow(/line size limit/);
  });

  it('rejects an event that grows over the event limit without a terminator', () => {
    const p = new SseParser({ maxLineBytes: 100, maxEventBytes: 500 });
    let err: unknown;
    try {
      for (let i = 0; i < 100; i++) p.push(enc(`data: ${'c'.repeat(50)}\n`));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StreamError);
    expect((err as StreamError).reason).toBe('event_too_large');
  });

  it('reports pending data at the end of the stream', () => {
    expect(parseAll([enc('data: 1\n\ndata: 2')]).pending).toBe(true);
    expect(parseAll([enc('data: 1\ndata: 2\n')]).pending).toBe(true);
    expect(parseAll([enc('data: 1\n\n')]).pending).toBe(false);
  });

  it('refuses invalid UTF-8 and a truncated multi-byte sequence', () => {
    const p = new SseParser(limits);
    expect(() => p.push(Uint8Array.of(0x64, 0x61, 0xff, 0x0a))).toThrow(/invalid UTF-8/);
    const q = new SseParser(limits);
    q.push(Uint8Array.of(0x64, 0xe2, 0x82));
    expect(() => q.end()).toThrow(/UTF-8/);
  });
});

describe('formatSseEvent (frame smuggling)', () => {
  it('splits data on every line terminator so a payload cannot end the frame', () => {
    const out = formatSseEvent({ event: 'x', data: 'a\n\nevent: evil\r\ndata: b\rc' });
    expect(out).toBe('event: x\ndata: a\ndata: \ndata: event: evil\ndata: data: b\ndata: c\n\n');
    const p = new SseParser(limits);
    const events = p.push(enc(out));
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('x');
  });

  it('refuses event names that contain line breaks, colons or spaces', () => {
    for (const bad of ['a\nb', 'a:b', 'a b', '', 'a\r', 'x'.repeat(65)]) {
      expect(() => formatSseEvent({ event: bad, data: '1' })).toThrow(TypeError);
    }
  });

  it('writes data-only events and single-line comments', () => {
    expect(formatSseEvent({ data: '{}' })).toBe('data: {}\n\n');
    expect(formatSseComment('a\r\nb')).toBe(': a b\n\n');
  });
});
