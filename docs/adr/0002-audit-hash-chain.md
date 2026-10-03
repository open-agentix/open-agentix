# ADR 0002: Revision-safe audit trail (hash chain + signed checkpoints)

- Status: Accepted
- Date: 2026-10-03

## Context

Auditors must be able to prove what an agent did and that nobody altered the record afterwards,
including privileged operators with database access.

## Decision

- Every audit entry stores `seq`, `ts`, `actor`, `action`, `target`, `runId`, the **redacted**
  payload, `payloadDigest = SHA-256(canonical JSON(payload))`, `prevHash` and
  `hash = SHA-256(canonical JSON of all fields except payload)`. The first entry links to 64 zeros.
- Canonical JSON = sorted keys, no whitespace (`packages/core/src/canonical.ts`); it never changes.
- Appends are serialised with `pg_advisory_xact_lock` so the chain has no forks.
- Every `OAX_AUDIT_CHECKPOINT_EVERY` entries (and on demand via `POST /v1/audit/checkpoints`) the
  head `{seq, hash, ts, keyId}` is signed with **Ed25519** (`OAX_AUDIT_SIGNING_KEY`). Public keys
  (`OAX_AUDIT_PUBLIC_KEYS`) can be distributed to auditors independently.
- `audit_log`, `audit_checkpoints` and `agent_versions` are append-only: a trigger raises on
  UPDATE/DELETE/TRUNCATE, and production runs with a database role without those privileges
  (`deploy/sql/roles.sql`).
- `POST /v1/audit/verify` and `verifyAuditChain()` detect modified entries, modified payloads,
  deleted/inserted entries (gaps, broken links) and chains rewritten after a checkpoint.
- Secrets are redacted **before** hashing, so exports never contain secrets.

## Consequences

- A full rewrite of the table by a DB superuser is detectable as soon as one checkpoint signed
  with a key the attacker does not hold exists; keep the signing key in a KMS/Secret and rotate key ids.
- Appends are serialised (single writer); measured cost is a few milliseconds per entry. For very
  high volumes, per-tenant chains are a later option (ROADMAP v1.0).
- Exports (NDJSON) can be verified offline with the same library.

## Alternatives considered

- External immutable stores (QLDB, WORM S3): good complements (SIEM export, v0.3), not a
  self-hosted default.
- Merkle trees: cheaper partial proofs, more complexity; can be layered on checkpoints later.
