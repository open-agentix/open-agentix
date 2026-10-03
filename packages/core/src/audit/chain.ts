import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson, sha256Hex } from '../canonical.js';
import { redact, type RedactorOptions } from '../redact.js';

/**
 * Revision-safe audit trail: every entry contains the SHA-256 of its predecessor (hash chain).
 * Periodic checkpoints sign the head of the chain with Ed25519, so even a privileged attacker who
 * rewrites the whole table cannot produce a chain that matches previously issued checkpoints.
 */

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntryInput {
  actor: string;
  action: string;
  target?: string | null;
  runId?: string | null;
  payload?: unknown;
  ts?: Date;
}

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  runId: string | null;
  /** Redacted payload as stored. */
  payload: unknown;
  payloadDigest: string;
  prevHash: string;
  hash: string;
}

export interface AuditCheckpoint {
  seq: number;
  hash: string;
  ts: string;
  keyId: string;
  /** Base64 Ed25519 signature over the canonical `{seq, hash, ts, keyId}`. */
  signature: string;
}

export function computeEntryHash(e: Omit<AuditEntry, 'hash' | 'payload'>): string {
  return sha256Hex(
    canonicalJson({
      seq: e.seq,
      ts: e.ts,
      actor: e.actor,
      action: e.action,
      target: e.target,
      runId: e.runId,
      payloadDigest: e.payloadDigest,
      prevHash: e.prevHash,
    }),
  );
}

/** Builds the next entry of the chain. Payloads are redacted BEFORE they are hashed and stored. */
export function createAuditEntry(
  prev: Pick<AuditEntry, 'seq' | 'hash'> | null,
  input: AuditEntryInput,
  redaction: RedactorOptions = {},
): AuditEntry {
  const payload = redact(input.payload ?? null, redaction);
  const base = {
    seq: prev ? prev.seq + 1 : 1,
    ts: (input.ts ?? new Date()).toISOString(),
    actor: input.actor,
    action: input.action,
    target: input.target ?? null,
    runId: input.runId ?? null,
    payloadDigest: sha256Hex(canonicalJson(payload)),
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  return { ...base, payload, hash: computeEntryHash(base) };
}

function checkpointMessage(c: Omit<AuditCheckpoint, 'signature'>): Buffer {
  return Buffer.from(canonicalJson({ seq: c.seq, hash: c.hash, ts: c.ts, keyId: c.keyId }));
}

export function signCheckpoint(
  head: Pick<AuditEntry, 'seq' | 'hash'>,
  privateKey: KeyObject,
  keyId: string,
  ts: Date = new Date(),
): AuditCheckpoint {
  const body = { seq: head.seq, hash: head.hash, ts: ts.toISOString(), keyId };
  return { ...body, signature: sign(null, checkpointMessage(body), privateKey).toString('base64') };
}

export function verifyCheckpointSignature(c: AuditCheckpoint, publicKey: KeyObject): boolean {
  try {
    return verify(null, checkpointMessage(c), publicKey, Buffer.from(c.signature, 'base64'));
  } catch {
    return false;
  }
}

export interface AuditKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateAuditKeyPair(): AuditKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Loads an Ed25519 private key from PEM (PKCS#8) or a base64 PKCS#8 DER string. */
export function loadPrivateKey(material: string): KeyObject {
  const key = material.includes('-----BEGIN')
    ? createPrivateKey(material)
    : createPrivateKey({ key: Buffer.from(material, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('audit signing key must be Ed25519');
  return key;
}

export function publicKeyFrom(key: KeyObject | string): KeyObject {
  return typeof key === 'string' ? createPublicKey(key) : createPublicKey(key);
}

export interface VerifyIssue {
  seq: number;
  code:
    | 'hash_mismatch'
    | 'broken_link'
    | 'gap'
    | 'payload_mismatch'
    | 'checkpoint_signature'
    | 'checkpoint_mismatch'
    | 'unknown_key';
  message: string;
}

export interface VerifyResult {
  valid: boolean;
  checkedEntries: number;
  checkedCheckpoints: number;
  headSeq: number;
  headHash: string;
  issues: VerifyIssue[];
}

export interface VerifyOptions {
  checkpoints?: readonly AuditCheckpoint[];
  publicKeys?: Readonly<Record<string, KeyObject>>;
  /** Entry preceding the first given entry when verifying a slice (default: genesis). */
  anchor?: Pick<AuditEntry, 'seq' | 'hash'> | null;
}

/**
 * Verifies a contiguous slice of the chain (sorted by seq) and all checkpoints inside it.
 * Detects modified entries, modified payloads, deleted/inserted entries and forged checkpoints.
 */
export function verifyAuditChain(
  entries: readonly AuditEntry[],
  opts: VerifyOptions = {},
): VerifyResult {
  const issues: VerifyIssue[] = [];
  let prevSeq = opts.anchor?.seq ?? 0;
  let prevHash = opts.anchor?.hash ?? GENESIS_HASH;
  const bySeq = new Map<number, AuditEntry>();
  for (const e of entries) {
    if (e.seq !== prevSeq + 1) {
      issues.push({
        seq: e.seq,
        code: 'gap',
        message: `expected seq ${prevSeq + 1}, found ${e.seq}`,
      });
    }
    if (e.prevHash !== prevHash) {
      issues.push({
        seq: e.seq,
        code: 'broken_link',
        message: 'prevHash does not match the previous entry',
      });
    }
    if (sha256Hex(canonicalJson(e.payload)) !== e.payloadDigest) {
      issues.push({
        seq: e.seq,
        code: 'payload_mismatch',
        message: 'payload does not match its digest',
      });
    }
    if (computeEntryHash(e) !== e.hash) {
      issues.push({
        seq: e.seq,
        code: 'hash_mismatch',
        message: 'entry hash does not match its content',
      });
    }
    bySeq.set(e.seq, e);
    prevSeq = e.seq;
    prevHash = e.hash;
  }
  let checkedCheckpoints = 0;
  for (const c of opts.checkpoints ?? []) {
    const entry = bySeq.get(c.seq);
    if (!entry) continue;
    checkedCheckpoints++;
    const key = opts.publicKeys?.[c.keyId];
    if (!key) {
      issues.push({
        seq: c.seq,
        code: 'unknown_key',
        message: `no public key for checkpoint key "${c.keyId}"`,
      });
    } else if (!verifyCheckpointSignature(c, key)) {
      issues.push({
        seq: c.seq,
        code: 'checkpoint_signature',
        message: 'checkpoint signature is invalid',
      });
    }
    if (entry.hash !== c.hash) {
      issues.push({
        seq: c.seq,
        code: 'checkpoint_mismatch',
        message: 'entry hash differs from the signed checkpoint',
      });
    }
  }
  return {
    valid: issues.length === 0,
    checkedEntries: entries.length,
    checkedCheckpoints,
    headSeq: prevSeq,
    headHash: prevHash,
    issues,
  };
}
