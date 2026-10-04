import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueRunToken, verifyRunToken, type OaxError } from '../src/index.js';

const SECRET = 'x'.repeat(32);
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return (e as OaxError).code;
  }
};

describe('run tokens', () => {
  it('round-trips claims', () => {
    const t = issueRunToken(SECRET, { runId: 'r1', workerId: 'w1', ttlSeconds: 60 }, 1_000_000);
    expect(t.startsWith('oaxrt.')).toBe(true);
    expect(verifyRunToken(SECRET, t, 1_000_000)).toEqual({
      runId: 'r1',
      workerId: 'w1',
      iat: 1000,
      exp: 1060,
    });
  });
  it('rejects tampering, wrong secrets, expiry and garbage', () => {
    const t = issueRunToken(SECRET, { runId: 'r1', workerId: 'w1', ttlSeconds: 60 }, 0);
    const [p, payload, sig] = t.split('.');
    const forged = `${p}.${Buffer.from(JSON.stringify({ runId: 'r2', workerId: 'w1', iat: 0, exp: 60 })).toString('base64url')}.${sig}`;
    expect(code(() => verifyRunToken(SECRET, forged, 0))).toBe('run_token_invalid');
    expect(code(() => verifyRunToken('y'.repeat(32), t, 0))).toBe('run_token_invalid');
    expect(code(() => verifyRunToken(SECRET, t, 61_000))).toBe('run_token_expired');
    expect(code(() => verifyRunToken(SECRET, 'abc', 0))).toBe('run_token_invalid');
    expect(code(() => verifyRunToken(SECRET, `oaxrt.${payload}`, 0))).toBe('run_token_invalid');
    const junk = 'not-json';
    const jp = Buffer.from(junk).toString('base64url');
    const js = createHmac('sha256', SECRET).update(`oaxrt.${jp}`).digest('base64url');
    expect(code(() => verifyRunToken(SECRET, `oaxrt.${jp}.${js}`, 0))).toBe('run_token_invalid');
    expect(code(() => issueRunToken('short', { runId: 'r', workerId: 'w', ttlSeconds: 1 }))).toBe(
      'config_invalid',
    );
  });
});

describe('step-scoped run tokens (run node sessions)', () => {
  const scoped = { runId: 'r1', workerId: 'n1', ttlSeconds: 60, sid: 's1', steps: ['a', 'b'] };
  it('round-trips sid and steps and keeps unscoped tokens unchanged', () => {
    const t = issueRunToken(SECRET, scoped, 0);
    expect(verifyRunToken(SECRET, t, 0)).toMatchObject({ sid: 's1', steps: ['a', 'b'] });
    const plain = verifyRunToken(
      SECRET,
      issueRunToken(SECRET, { runId: 'r1', workerId: 'w', ttlSeconds: 5 }, 0),
      0,
    );
    expect(plain).not.toHaveProperty('sid');
    expect(plain).not.toHaveProperty('steps');
  });
  it('refuses half-scoped or oversized scopes when issuing', () => {
    expect(code(() => issueRunToken(SECRET, { ...scoped, steps: undefined }, 0))).toBe(
      'config_invalid',
    );
    expect(code(() => issueRunToken(SECRET, { ...scoped, sid: undefined }, 0))).toBe(
      'config_invalid',
    );
    expect(code(() => issueRunToken(SECRET, { ...scoped, steps: [] }, 0))).toBe('config_invalid');
    expect(
      code(() =>
        issueRunToken(
          SECRET,
          { ...scoped, steps: Array.from({ length: 17 }, (_, i) => `s${i}`) },
          0,
        ),
      ),
    ).toBe('config_invalid');
  });
  it('fails closed on a correctly signed token with a malformed scope', () => {
    const sign = (claims: object) => {
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const mac = createHmac('sha256', SECRET).update(`oaxrt.${payload}`).digest('base64url');
      return `oaxrt.${payload}.${mac}`;
    };
    const base = { runId: 'r', workerId: 'n', iat: 0, exp: 60 };
    for (const bad of [
      { sid: 's' },
      { steps: ['a'] },
      { sid: '', steps: ['a'] },
      { sid: 's', steps: [] },
      { sid: 's', steps: [1] },
      { sid: 's', steps: 'a' },
      { sid: 's', steps: Array.from({ length: 17 }, () => 'a') },
    ])
      expect(code(() => verifyRunToken(SECRET, sign({ ...base, ...bad }), 0))).toBe(
        'run_token_invalid',
      );
  });
});
