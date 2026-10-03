import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  REDACTED,
  createAuditEntry,
  generateAuditKeyPair,
  loadPrivateKey,
  publicKeyFrom,
  signCheckpoint,
  verifyAuditChain,
  verifyCheckpointSignature,
  type AuditEntry,
} from '../src/index.js';

function chain(n: number): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      createAuditEntry(out.at(-1) ?? null, {
        actor: 'worker',
        action: 'tool.call',
        target: 'cve-db/lookup_cve',
        runId: 'run-1',
        payload: { i, apiKey: 'should-not-be-stored' },
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      }),
    );
  }
  return out;
}

const keys = generateAuditKeyPair();
const priv = loadPrivateKey(keys.privateKeyPem);
const pub = publicKeyFrom(keys.publicKeyPem);

describe('audit chain', () => {
  it('links entries and redacts payloads before hashing', () => {
    const c = chain(3);
    expect(c[0]?.prevHash).toBe(GENESIS_HASH);
    expect(c[1]?.prevHash).toBe(c[0]?.hash);
    expect(c[2]?.seq).toBe(3);
    expect(c[0]?.payload).toEqual({ i: 0, apiKey: REDACTED });
    expect(createAuditEntry(null, { actor: 'a', action: 'b' }).payload).toBeNull();
    expect(verifyAuditChain(c)).toMatchObject({
      valid: true,
      checkedEntries: 3,
      headSeq: 3,
      issues: [],
    });
  });

  it('detects modified content, payloads, gaps and broken links', () => {
    const modified = chain(3);
    modified[1] = { ...modified[1]!, actor: 'mallory' };
    expect(verifyAuditChain(modified).issues.map((i) => i.code)).toEqual(['hash_mismatch']);

    const payload = chain(2);
    payload[0] = { ...payload[0]!, payload: { i: 99 } };
    expect(verifyAuditChain(payload).issues.map((i) => i.code)).toEqual(['payload_mismatch']);

    const deleted = chain(3);
    deleted.splice(1, 1);
    expect(verifyAuditChain(deleted).issues.map((i) => i.code)).toEqual(['gap', 'broken_link']);
  });

  it('verifies slices against an anchor', () => {
    const c = chain(4);
    expect(verifyAuditChain(c.slice(2), { anchor: c[1]! }).valid).toBe(true);
    expect(verifyAuditChain(c.slice(2)).valid).toBe(false);
  });

  it('signs and verifies checkpoints', () => {
    const c = chain(5);
    const cp = signCheckpoint(c[4]!, priv, 'k1', new Date('2026-01-02T00:00:00Z'));
    expect(verifyCheckpointSignature(cp, pub)).toBe(true);
    expect(verifyAuditChain(c, { checkpoints: [cp], publicKeys: { k1: pub } })).toMatchObject({
      valid: true,
      checkedCheckpoints: 1,
    });
  });

  it('detects a fully rewritten chain via checkpoints', () => {
    const original = chain(3);
    const cp = signCheckpoint(original[2]!, priv, 'k1');
    const rewritten: AuditEntry[] = [];
    for (const e of original) {
      rewritten.push(
        createAuditEntry(rewritten.at(-1) ?? null, { ...e, ts: new Date(e.ts), actor: 'mallory' }),
      );
    }
    const r = verifyAuditChain(rewritten, { checkpoints: [cp], publicKeys: { k1: pub } });
    expect(r.issues.map((i) => i.code)).toEqual(['checkpoint_mismatch']);
  });

  it('detects forged signatures and unknown keys; skips checkpoints outside the slice', () => {
    const c = chain(2);
    const cp = signCheckpoint(c[1]!, priv, 'k1');
    const forged = { ...cp, signature: Buffer.from('x').toString('base64') };
    const r = verifyAuditChain(c, {
      checkpoints: [forged, { ...cp, keyId: 'k2' }, { ...cp, seq: 99 }],
      publicKeys: { k1: pub },
    });
    expect(r.issues.map((i) => i.code)).toEqual(['checkpoint_signature', 'unknown_key']);
    expect(verifyCheckpointSignature({ ...cp, signature: '!!!' }, publicKeyFrom(priv))).toBe(false);
  });

  it('loads DER keys and rejects non-Ed25519 keys', () => {
    const der = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' });
    expect(loadPrivateKey(der.toString('base64')).asymmetricKeyType).toBe('ed25519');
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    expect(() => loadPrivateKey(ec.toString())).toThrow(/Ed25519/);
  });

  it('verifyCheckpointSignature returns false when verify throws', () => {
    const c = chain(1);
    const cp = signCheckpoint(c[0]!, priv, 'k1');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
    expect(verifyCheckpointSignature(cp, rsa)).toBe(false);
  });
});
