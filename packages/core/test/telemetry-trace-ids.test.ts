import { describe, expect, it } from 'vitest';
import {
  formatTraceparent,
  isSpanId,
  isTraceId,
  newRunTraceIdentity,
  newSpanId,
  newTraceId,
  parseTraceparent,
  runTraceIdentity,
  sanitizeAttributes,
  traceUrl,
  ContextGuard,
} from '../src/index.js';

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';

describe('trace and span id generation (ADR 0015 section 2)', () => {
  it('produces W3C-shaped, non-zero, distinct ids', () => {
    const traces = new Set(Array.from({ length: 2000 }, () => newTraceId()));
    const spans = new Set(Array.from({ length: 2000 }, () => newSpanId()));
    expect(traces.size).toBe(2000);
    expect(spans.size).toBe(2000);
    for (const t of traces) expect(isTraceId(t)).toBe(true);
    for (const s of spans) expect(isSpanId(s)).toBe(true);
  });

  it('draws from the CSPRNG: bytes come from node:crypto, nothing else', async () => {
    const crypto = await import('node:crypto');
    const real = crypto.randomBytes;
    expect(typeof real).toBe('function');
    // The module under test imports randomBytes from node:crypto only; its source has no other
    // entropy source and no input parameter, which is the property the security review checks.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/telemetry/trace-ids.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain("from 'node:crypto'");
    expect(src).not.toMatch(/Math\.random|Date\.now|randomUUID|createHash/);
  });

  it('a new run identity is independent of anything the caller knows', () => {
    const a = newRunTraceIdentity();
    const b = newRunTraceIdentity();
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.rootSpanId).not.toBe(b.rootSpanId);
    expect(a.traceId.startsWith(a.rootSpanId)).toBe(false);
  });

  it('rejects malformed and all-zero ids', () => {
    for (const bad of [
      '',
      '0'.repeat(32),
      TRACE.toUpperCase(),
      TRACE.slice(1),
      `${TRACE}0`,
      `${TRACE.slice(0, 31)}g`,
      null,
      undefined,
      42,
    ])
      expect(isTraceId(bad)).toBe(false);
    for (const bad of ['0'.repeat(16), SPAN.toUpperCase(), SPAN.slice(1), `${SPAN}0`, null])
      expect(isSpanId(bad)).toBe(false);
  });
});

describe('runTraceIdentity', () => {
  it('reads both ids of a row, or none', () => {
    expect(runTraceIdentity({ traceId: TRACE, traceRootSpanId: SPAN })).toEqual({
      traceId: TRACE,
      rootSpanId: SPAN,
    });
    expect(runTraceIdentity({ traceId: null, traceRootSpanId: null })).toBeNull();
    expect(runTraceIdentity({ traceId: TRACE, traceRootSpanId: null })).toBeNull();
    expect(runTraceIdentity({ traceId: 'x', traceRootSpanId: SPAN })).toBeNull();
    expect(runTraceIdentity({})).toBeNull();
  });
});

describe('parseTraceparent', () => {
  it('accepts exactly the version 00 form', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      sampled: true,
    });
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)?.sampled).toBe(false);
    expect(formatTraceparent(TRACE, SPAN)).toBe(`00-${TRACE}-${SPAN}-01`);
  });

  it.each([
    `01-${TRACE}-${SPAN}-01`,
    `00-${TRACE}-${SPAN}-01-extra`,
    `00-${TRACE.toUpperCase()}-${SPAN}-01`,
    `00-${'0'.repeat(32)}-${SPAN}-01`,
    `00-${TRACE}-${'0'.repeat(16)}-01`,
    `00-${TRACE}-${SPAN}-zz`,
    ` 00-${TRACE}-${SPAN}-01`,
    `00-${TRACE}-${SPAN}-01, 00-${TRACE}-${SPAN}-01`,
    '',
  ])('rejects %s', (header) => expect(parseTraceparent(header)).toBeNull());

  it('rejects non-strings', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent([`00-${TRACE}-${SPAN}-01`])).toBeNull();
  });
});

describe('traceUrl', () => {
  it('substitutes a valid id only', () => {
    expect(traceUrl('https://tempo.internal/trace/{traceId}', TRACE)).toBe(
      `https://tempo.internal/trace/${TRACE}`,
    );
    expect(traceUrl('https://t/{traceId}?x={traceId}', TRACE)).toBe(
      `https://t/${TRACE}?x=${TRACE}`,
    );
    expect(traceUrl(undefined, TRACE)).toBeNull();
    expect(traceUrl('https://t/{traceId}', null)).toBeNull();
    expect(traceUrl('https://t/{traceId}', '../../x')).toBeNull();
  });
});

describe('oax.audit.seq on the allowlist (ADR 0015 section 11)', () => {
  const guard = () => new ContextGuard();
  it('is accepted on the admission and the workflow span, as a positive integer', () => {
    for (const kind of ['run_admit', 'invoke_workflow'] as const) {
      const r = sanitizeAttributes(kind, { 'oax.audit.seq': 42 }, guard());
      expect(r.attributes).toEqual({ 'oax.audit.seq': 42 });
      expect(r.dropped).toEqual({});
    }
  });

  it('is dropped on span kinds that do not document an audit entry yet', () => {
    for (const kind of ['chat', 'http_server', 'unknown'] as const) {
      const r = sanitizeAttributes(kind, { 'oax.audit.seq': 42 }, guard());
      expect(r.attributes).toEqual({});
      expect(r.dropped).toEqual({ wrong_span: 1 });
    }
  });

  it.each([0, -1, 1.5, '7', NaN, true])('drops the invalid value %s', (value) => {
    const r = sanitizeAttributes('run_admit', { 'oax.audit.seq': value }, guard());
    expect(r.attributes).toEqual({});
    expect(r.dropped).toEqual({ invalid: 1 });
  });
});
