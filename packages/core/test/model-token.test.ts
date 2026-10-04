import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MODEL_TOKEN_KEY_LABEL,
  issueModelToken,
  issueRunToken,
  verifyModelToken,
  verifyRunToken,
  type OaxError,
} from '../src/index.js';

const SECRET = 's'.repeat(32);
const NOW = 1_000_000_000;
const base = { runId: 'r1', sid: 'sid1', nodeId: 'node1', agentId: 'a1', ttlSeconds: 60 };
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return (e as OaxError).code;
  }
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** Signs a payload with an arbitrary key the way the module signs (prefix.payload). */
const sign = (key: string | Buffer, payload: string) =>
  createHmac('sha256', key).update(`oaxmt.${payload}`).digest('base64url');
const derivedKey = () => createHmac('sha256', SECRET).update(MODEL_TOKEN_KEY_LABEL).digest();
const goodClaims = {
  v: 1,
  aud: 'model',
  runId: 'r1',
  sid: 's',
  nodeId: 'n',
  agentId: 'a',
  jti: 'j',
  iat: 1000,
  exp: 1060,
};

describe('model token round trip', () => {
  it('issues and verifies all claims', () => {
    const { token, claims } = issueModelToken(SECRET, { ...base, jti: 'j1' }, NOW);
    expect(token.startsWith('oaxmt.')).toBe(true);
    expect(claims).toEqual({
      v: 1,
      aud: 'model',
      runId: 'r1',
      sid: 'sid1',
      nodeId: 'node1',
      agentId: 'a1',
      jti: 'j1',
      iat: 1_000_000,
      exp: 1_000_060,
    });
    expect(verifyModelToken(SECRET, token, NOW)).toEqual(claims);
  });

  it('generates a unique jti by default', () => {
    const a = issueModelToken(SECRET, base, NOW).claims.jti;
    const b = issueModelToken(SECRET, base, NOW).claims.jti;
    expect(a).not.toBe(b);
  });

  it('caps exp at the session expiry', () => {
    const { claims } = issueModelToken(
      SECRET,
      { ...base, notAfterMs: (1_000_000 + 10) * 1000 },
      NOW,
    );
    expect(claims.exp).toBe(1_000_010);
    const longSession = issueModelToken(
      SECRET,
      { ...base, notAfterMs: (1_000_000 + 9999) * 1000 },
      NOW,
    );
    expect(longSession.claims.exp).toBe(1_000_060);
  });

  it('refuses to issue an already expired or zero-lifetime token', () => {
    expect(code(() => issueModelToken(SECRET, { ...base, notAfterMs: NOW - 1000 }, NOW))).toBe(
      'model_token_ttl_invalid',
    );
    expect(code(() => issueModelToken(SECRET, { ...base, ttlSeconds: 0 }, NOW))).toBe(
      'model_token_ttl_invalid',
    );
    expect(code(() => issueModelToken(SECRET, { ...base, ttlSeconds: 1.5 }, NOW))).toBe(
      'model_token_ttl_invalid',
    );
  });

  it('refuses short secrets for issue and verify', () => {
    expect(code(() => issueModelToken('short', base, NOW))).toBe('config_invalid');
    const { token } = issueModelToken(SECRET, base, NOW);
    expect(code(() => verifyModelToken('short', token, NOW))).toBe('config_invalid');
  });

  it('rejects empty ids at issue time', () => {
    expect(() => issueModelToken(SECRET, { ...base, agentId: '' }, NOW)).toThrow();
  });
});

describe('model token negative security tests', () => {
  const { token } = issueModelToken(SECRET, { ...base, jti: 'j1' }, NOW);
  const [prefix, payload, sig] = token.split('.') as [string, string, string];

  it('refuses a token past exp and exactly at exp', () => {
    expect(code(() => verifyModelToken(SECRET, token, (1_000_060 - 1) * 1000))).toBe('ok');
    expect(code(() => verifyModelToken(SECRET, token, 1_000_060 * 1000))).toBe(
      'model_token_expired',
    );
    expect(code(() => verifyModelToken(SECRET, token, 2_000_000 * 1000))).toBe(
      'model_token_expired',
    );
  });

  it('refuses a token that is not yet valid (iat in the future beyond skew)', () => {
    const early = issueModelToken(SECRET, base, NOW + 3_600_000).token;
    expect(code(() => verifyModelToken(SECRET, early, NOW))).toBe('model_token_invalid');
    const slight = issueModelToken(SECRET, base, NOW + 30_000).token;
    expect(code(() => verifyModelToken(SECRET, slight, NOW))).toBe('ok');
  });

  it('refuses tampered claims (run, session, agent, exp) with the old signature', () => {
    for (const patch of [
      { runId: 'r2' },
      { sid: 'other' },
      { agentId: 'a2' },
      { exp: 9_999_999_999 },
      { nodeId: 'n2' },
    ]) {
      const claims = { ...JSON.parse(Buffer.from(payload, 'base64url').toString()), ...patch };
      expect(code(() => verifyModelToken(SECRET, `${prefix}.${b64(claims)}.${sig}`, NOW))).toBe(
        'model_token_invalid',
      );
    }
  });

  it('refuses a flipped signature, a wrong secret, truncation and garbage', () => {
    const flipped = `${prefix}.${payload}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(code(() => verifyModelToken(SECRET, flipped, NOW))).toBe('model_token_invalid');
    expect(code(() => verifyModelToken('t'.repeat(32), token, NOW))).toBe('model_token_invalid');
    expect(code(() => verifyModelToken(SECRET, token.slice(0, -10), NOW))).toBe(
      'model_token_invalid',
    );
    expect(code(() => verifyModelToken(SECRET, `${prefix}.${payload}`, NOW))).toBe(
      'model_token_invalid',
    );
    expect(code(() => verifyModelToken(SECRET, `${token}.extra`, NOW))).toBe('model_token_invalid');
    expect(code(() => verifyModelToken(SECRET, '', NOW))).toBe('model_token_invalid');
    expect(code(() => verifyModelToken(SECRET, 'garbage', NOW))).toBe('model_token_invalid');
    expect(code(() => verifyModelToken(SECRET, `${prefix}..`, NOW))).toBe('model_token_invalid');
    expect(code(() => verifyModelToken(SECRET, 'x'.repeat(5000), NOW))).toBe('model_token_invalid');
    expect(code(() => verifyModelToken(SECRET, undefined as unknown as string, NOW))).toBe(
      'model_token_invalid',
    );
  });

  it('refuses non-canonical encodings (padding, whitespace, extra characters)', () => {
    expect(code(() => verifyModelToken(SECRET, `${prefix}.${payload}.${sig}=`, NOW))).toBe(
      'model_token_invalid',
    );
    expect(code(() => verifyModelToken(SECRET, `${prefix}.${payload}.${sig} `, NOW))).toBe(
      'model_token_invalid',
    );
    expect(code(() => verifyModelToken(SECRET, `${prefix}.${payload}*.${sig}`, NOW))).toBe(
      'model_token_invalid',
    );
  });

  it('refuses a wrong prefix even with a valid signature over it', () => {
    expect(code(() => verifyModelToken(SECRET, `oaxrt.${payload}.${sig}`, NOW))).toBe(
      'model_token_invalid',
    );
  });

  it('refuses a correctly signed token with a wrong audience, version or extra claims', () => {
    for (const patch of [
      { aud: 'run' },
      { aud: 'worker' },
      { v: 2 },
      { extra: 1 },
      { runId: '' },
      { jti: undefined },
    ]) {
      const p = b64({ ...goodClaims, ...patch });
      expect(
        code(() => verifyModelToken(SECRET, `oaxmt.${p}.${sign(derivedKey(), p)}`, 1_000_000)),
      ).toBe('model_token_invalid');
    }
    const ok = b64(goodClaims);
    expect(
      code(() => verifyModelToken(SECRET, `oaxmt.${ok}.${sign(derivedKey(), ok)}`, 1_000_000)),
    ).toBe('ok');
  });

  it('refuses a correctly signed payload that is not JSON or has an inverted lifetime', () => {
    const notJson = Buffer.from('not json').toString('base64url');
    expect(
      code(() => verifyModelToken(SECRET, `oaxmt.${notJson}.${sign(derivedKey(), notJson)}`, NOW)),
    ).toBe('model_token_invalid');
    const inverted = b64({ ...goodClaims, iat: 2000, exp: 1500 });
    expect(
      code(() =>
        verifyModelToken(SECRET, `oaxmt.${inverted}.${sign(derivedKey(), inverted)}`, 1_500_000),
      ),
    ).not.toBe('ok');
  });

  it('domain separation: a token signed with the raw run token key (no label) is refused', () => {
    const p = b64(goodClaims);
    expect(code(() => verifyModelToken(SECRET, `oaxmt.${p}.${sign(SECRET, p)}`, 1_000_000))).toBe(
      'model_token_invalid',
    );
  });

  it('token confusion: a run token is refused as model token and vice versa', () => {
    const run = issueRunToken(SECRET, { runId: 'r1', workerId: 'w1', ttlSeconds: 60 }, NOW);
    expect(code(() => verifyModelToken(SECRET, run, NOW))).toBe('model_token_invalid');
    expect(code(() => verifyRunToken(SECRET, token, NOW))).toBe('run_token_invalid');
  });

  it('replay as run token: a model token with run-token-shaped claims never verifies as a run token', () => {
    const claims = { runId: 'r1', workerId: 'node1', iat: 1000, exp: 9_999_999_999 };
    const p = b64(claims);
    // Model key + oaxmt prefix and the relabelled oaxrt prefix: both fail under the run token verifier.
    const asModel = `oaxmt.${p}.${sign(derivedKey(), p)}`;
    const relabelled = `oaxrt.${p}.${sign(derivedKey(), p)}`;
    expect(code(() => verifyRunToken(SECRET, asModel, NOW))).toBe('run_token_invalid');
    expect(code(() => verifyRunToken(SECRET, relabelled, NOW))).toBe('run_token_invalid');
    // And a genuine model token with its signature moved under the run prefix.
    expect(code(() => verifyRunToken(SECRET, `oaxrt.${payload}.${sig}`, NOW))).toBe(
      'run_token_invalid',
    );
  });

  it('rotating the secret invalidates model tokens', () => {
    expect(code(() => verifyModelToken('r'.repeat(32), token, NOW))).toBe('model_token_invalid');
  });
});

describe('model token bindings', () => {
  const { token } = issueModelToken(SECRET, { ...base, jti: 'j1' }, NOW);

  it('accepts matching bindings', () => {
    expect(
      code(() =>
        verifyModelToken(SECRET, token, NOW, {
          runId: 'r1',
          sid: 'sid1',
          nodeId: 'node1',
          agentId: 'a1',
          jti: 'j1',
        }),
      ),
    ).toBe('ok');
  });

  it.each([
    ['wrong run', { runId: 'r2' }],
    ['wrong session', { sid: 'sid2' }],
    ['wrong step', { agentId: 'a2' }],
    ['wrong node', { nodeId: 'node2' }],
    ['stale jti (a second token was issued)', { jti: 'j2' }],
  ])('refuses %s', (_name, expectation) => {
    expect(code(() => verifyModelToken(SECRET, token, NOW, expectation))).toBe(
      'model_token_binding',
    );
  });

  it('checks expiry before bindings', () => {
    expect(code(() => verifyModelToken(SECRET, token, 2_000_000_000, { runId: 'r2' }))).toBe(
      'model_token_expired',
    );
  });
});
