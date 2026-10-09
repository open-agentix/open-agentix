import { describe, expect, it } from 'vitest';
import {
  ContextGuard,
  auditShapeOfReport,
  contextGuardFromEnv,
  isGuardReportEmpty,
} from '../src/index.js';

describe('ContextGuard', () => {
  it('strips invisible characters and reports counts by class', () => {
    const r = new ContextGuard().text('a\u200Bb\u{E0041}');
    expect(r.text).toBe('ab');
    expect(r.report.invisible).toEqual({ total: 2, classes: { zero_width: 1, tag: 1 } });
  });

  it('guards the strings of a nested value, not the keys', () => {
    const r = new ContextGuard().value({ a: ['x\u200B y'], b: { c: 'ok' }, n: 1 });
    expect(r.value).toEqual({ a: ['x y'], b: { c: 'ok' }, n: 1 });
    expect(r.report.invisible.total).toBe(1);
  });

  it('survives cycles', () => {
    const a: Record<string, unknown> = { s: 'a\u200Bb' };
    a.self = a;
    expect(new ContextGuard().value(a).value).toEqual({ s: 'ab', self: '[Circular]' });
  });
});

describe('ContextGuard configuration', () => {
  it('is on by default', () => {
    expect(contextGuardFromEnv({}).stripInvisible).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', ' FALSE '])('turns the stage off with %j', (v) => {
    const g = contextGuardFromEnv({ OAX_STRIP_INVISIBLE_UNICODE: v });
    expect(g.stripInvisible).toBe(false);
    const r = g.text('a\u200Bb');
    expect(r.text).toBe('a\u200Bb');
    expect(isGuardReportEmpty(r.report)).toBe(true);
  });

  it('keeps the stage on for any other value (a typo must not disable a protection)', () => {
    expect(contextGuardFromEnv({ OAX_STRIP_INVISIBLE_UNICODE: 'flase' }).stripInvisible).toBe(true);
    expect(contextGuardFromEnv({ OAX_STRIP_INVISIBLE_UNICODE: 'disabled' }).stripInvisible).toBe(
      true,
    );
  });
});

describe('auditShapeOfReport', () => {
  it('keeps counts and safe names only', () => {
    expect(
      auditShapeOfReport({
        invisible: { total: 3, classes: { tag: 2, 'Bad Name With Content!': 1 } },
        extra: 'ignored',
      }),
    ).toEqual({ invisible: { total: 3, classes: { tag: 2 } } });
    expect(auditShapeOfReport('junk')).toEqual({ invisible: { total: 0, classes: {} } });
    expect(auditShapeOfReport({ invisible: { total: -4, classes: { tag: 'x' } } })).toEqual({
      invisible: { total: 0, classes: { tag: 0 } },
    });
  });
});
