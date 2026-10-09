import { describe, expect, it } from 'vitest';
import {
  ContextGuard,
  SECRET_PATTERNS,
  auditShapeOfReport,
  contextGuardFromEnv,
  isGuardReportEmpty,
} from '../src/index.js';

// Example values only: none of these is a real credential.
const FAKE = {
  github: `ghp_${'a1B2c3D4e5'.repeat(4)}`,
  aws: 'AKIAIOSFODNN7EXAMPLE',
  anthropic: `sk-ant-${'x9Y8'.repeat(6)}`,
  slack: 'xoxb-1234567890-abcdefghij',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl',
  runToken: `oaxrt.${'AbCd1234'.repeat(3)}.${'Zz9Yy8Xx'}`,
  platform: `oax_abcdefgh_${'Q1w2E3r4'.repeat(3)}`,
  npm: `npm_${'aB3dE6gH9j'.repeat(3)}`,
  stripe: `sk_test_${'4eC39HqLyjWDarjt'}`,
};

const guard = (o = {}) => new ContextGuard(o);

describe('ContextGuard secret redaction', () => {
  it.each(Object.entries(FAKE))('replaces a %s-shaped token', (_name, token) => {
    const r = guard().text(`before ${token} after`);
    expect(r.text).not.toContain(token);
    expect(r.text).toMatch(/^before \[redacted:[a-z-]+\] after$/);
    expect(r.report.secrets.total).toBe(1);
  });

  it('names the kind in the replacement and in the report', () => {
    const r = guard().text(`token ${FAKE.github} and key ${FAKE.aws}`);
    expect(r.text).toBe('token [redacted:github-token] and key [redacted:aws-access-key]');
    expect(r.report.secrets).toEqual({
      total: 2,
      kinds: { 'github-token': 1, 'aws-access-key': 1 },
    });
  });

  it('replaces a whole private key block, also a truncated one', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(5);
    const key = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    const r = guard().text(`a\n${key}\nb`);
    expect(r.text).toBe('a\n[redacted:private-key]\nb');
    const cut = guard().text(`x -----BEGIN RSA PRIVATE KEY-----\n${body}`);
    expect(cut.text).toBe('x [redacted:private-key]');
  });

  it('replaces exact known secrets, also encoded', () => {
    const secret = 'correct-horse-battery-staple';
    const g = guard({ knownSecrets: [secret] });
    const b64 = Buffer.from(secret).toString('base64');
    const r = g.text(
      `plain ${secret} url ${encodeURIComponent(secret)} b64 ${b64} hex ${Buffer.from(secret).toString('hex')}`,
    );
    expect(r.text).not.toContain(secret);
    expect(r.text).not.toContain(b64);
    expect(r.report.secrets.kinds).toEqual({ 'known-secret': 4 });
  });

  it('registers secrets later and prefers the longer of two overlapping secrets', () => {
    const g = guard();
    g.addSecret('abcdefgh-short');
    g.addSecret('abcdefgh-short-and-longer');
    expect(g.text('x abcdefgh-short-and-longer y').text).toBe('x [redacted:known-secret] y');
  });

  it('does not match known secrets shorter than the minimum', () => {
    const g = guard({ knownSecrets: ['short'] });
    expect(g.text('a short text').text).toBe('a short text');
  });

  it('leaves ordinary text and code untouched', () => {
    const text = [
      'The function getToken() returns a token; see https://example.org/docs/tokens.',
      'password policy: at least 12 characters',
      'sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'const key = process.env.API_KEY;',
    ].join('\n');
    const r = guard().text(text);
    expect(r.text).toBe(text);
    expect(isGuardReportEmpty(r.report)).toBe(true);
  });

  it('keeps the variable name of an assignment out of the match only as far as the pattern allows', () => {
    const r = guard().text('export API_TOKEN=abcdefghijklmnop1234');
    expect(r.text).not.toContain('abcdefghijklmnop1234');
  });

  it('guards the strings of a nested value, not the keys', () => {
    const r = guard().value({ a: [`x\u200B ${FAKE.github}`], b: { c: 'ok' }, n: 1 });
    expect(r.value).toEqual({ a: ['x [redacted:github-token]'], b: { c: 'ok' }, n: 1 });
    expect(r.report.invisible.total).toBe(1);
    expect(r.report.secrets.total).toBe(1);
  });

  it('survives cycles', () => {
    const a: Record<string, unknown> = { s: FAKE.aws };
    a.self = a;
    expect(guard().value(a).value).toEqual({ s: '[redacted:aws-access-key]', self: '[Circular]' });
  });

  it('combines both stages in one report', () => {
    const r = guard().text(`a\u200Bb ${FAKE.github}\u{E0041}`);
    expect(r.text).toBe('ab [redacted:github-token]');
    expect(r.report.invisible).toEqual({ total: 2, classes: { zero_width: 1, tag: 1 } });
    expect(r.report.secrets.total).toBe(1);
  });
});

describe('ContextGuard configuration', () => {
  it('is on by default', () => {
    const g = contextGuardFromEnv({});
    expect(g.stripInvisible).toBe(true);
    expect(g.redactSecrets).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', ' FALSE '])('turns a stage off with %j', (v) => {
    const g = contextGuardFromEnv({
      OAX_STRIP_INVISIBLE_UNICODE: v,
      OAX_REDACT_MODEL_CONTEXT: v,
    });
    expect(g.stripInvisible).toBe(false);
    expect(g.redactSecrets).toBe(false);
    const r = g.text(`a\u200B ${FAKE.github}`);
    expect(r.text).toBe(`a\u200B ${FAKE.github}`);
    expect(isGuardReportEmpty(r.report)).toBe(true);
  });

  it('keeps a stage on for any other value (a typo must not disable a protection)', () => {
    const g = contextGuardFromEnv({
      OAX_STRIP_INVISIBLE_UNICODE: 'flase',
      OAX_REDACT_MODEL_CONTEXT: 'disabled',
    });
    expect(g.stripInvisible && g.redactSecrets).toBe(true);
  });

  it('switches the stages independently', () => {
    const g = contextGuardFromEnv({ OAX_REDACT_MODEL_CONTEXT: 'off' });
    expect(g.text(`a\u200B${FAKE.aws}`).text).toBe(`a${FAKE.aws}`);
  });
});

describe('auditShapeOfReport', () => {
  it('keeps counts and safe names only', () => {
    const shaped = auditShapeOfReport({
      invisible: { total: 3, classes: { tag: 2, 'Bad Name With Content!': 1 } },
      secrets: { total: -4, kinds: { 'github-token': 'ghp_secret', ok_kind: 2 } },
      extra: 'ignored',
    });
    expect(shaped).toEqual({
      invisible: { total: 3, classes: { tag: 2 } },
      secrets: { total: 0, kinds: { 'github-token': 0, ok_kind: 2 } },
    });
    expect(auditShapeOfReport('junk')).toEqual({
      invisible: { total: 0, classes: {} },
      secrets: { total: 0, kinds: {} },
    });
  });
});

describe('ContextGuard time and size bounds', () => {
  const SIZE = 256 * 1024;
  const hostile: [string, string][] = [
    ['dotted labels before ://', 'a.a.'.repeat(SIZE / 4)],
    ['bare scheme markers', 'a://'.repeat(SIZE / 4)],
    ['credential colons', 'a://u:p'.repeat(SIZE / 7)],
    ['Bearer + long run', `Bearer ${'A'.repeat(SIZE)}`],
    ['Bearer repeated', 'Bearer '.repeat(SIZE / 7)],
    ['spaces after Bearer', `Bearer${' '.repeat(SIZE)}`],
    ['sk- prefix repeated', 'sk-'.repeat(SIZE / 3)],
    ['sk- then dashes', `sk-${'-'.repeat(SIZE)}`],
    ['ghp_ repeated', 'ghp_'.repeat(SIZE / 4)],
    ['jwt-like dots', 'eyJ' + 'a'.repeat(100) + '.'.repeat(SIZE / 2)],
    ['assignment lookalikes', 'A_TOKEN = '.repeat(SIZE / 10)],
    ['quote lookalikes', `secret="${'a'.repeat(SIZE)}`],
    ['BEGIN lines without END', '-----BEGIN PRIVATE KEY-----\n'.repeat(SIZE / 28)],
    ['BEGIN with spaces', `-----BEGIN ${' '.repeat(SIZE)}`],
    ['private key header with body only', `-----BEGIN PRIVATE KEY-----${'A'.repeat(SIZE)}`],
    ['zero-width noise', 'a\u200B\u200D'.repeat(SIZE / 3)],
    ['tag noise', '\u{E0041}'.repeat(SIZE / 2)],
  ];

  it.each(hostile)('stays fast on %s (256 KiB)', (_name, input) => {
    const g = guard({ knownSecrets: ['correct-horse-battery-staple'] });
    const t0 = performance.now();
    g.text(input);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
  });

  it('every shared pattern is linear: doubling the input does not quadruple the time', () => {
    const probe = (n: number, make: (n: number) => string) => {
      const input = make(n);
      const t0 = performance.now();
      for (const [, re] of SECRET_PATTERNS) re.test(input);
      return performance.now() - t0;
    };
    const makers = [
      (n: number) => 'a.'.repeat(n),
      (n: number) => 'Bearer '.repeat(n),
      (n: number) => 'sk-'.repeat(n),
      (n: number) => 'A_TOKEN = '.repeat(n),
    ];
    for (const make of makers) {
      probe(2_000, make); // warm-up
      const small = Math.max(probe(40_000, make), 1);
      const large = probe(80_000, make);
      // a quadratic pattern would take ~4x; leave room for noise
      expect(large).toBeLessThan(small * 3.5 + 50);
    }
  });
});
