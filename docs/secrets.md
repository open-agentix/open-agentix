# Scoped secrets and the encrypted secret store

Status: slices S4 (#247) and S5 (#248) of [ADR 0017](adr/0017-agent-lifecycle-governance.md) (section 13).
This page describes what is built; the design and the owner decisions are in the ADR. What these slices
leave out is listed at the end.

## What it gives you

- Credentials kept **per team or per tenant node** (and per person), **encrypted at rest** and **never
  readable**: a value goes in through `POST /v1/secrets` or `POST /v1/secrets/{id}/rotate` and comes out
  only inside the credential broker, into the memory of the run node of a step that references it.
- References with a scope in `agents.md`: `credentials: [{ secret: "team:jira-token" }]`. The prefix is the
  scope, there is **no fallback between scopes**, and unprefixed references mean exactly what they meant
  before (operator environment variables or files, the tenant `secret_refs` allowlist).
- Tenant secrets **inherit down the tree**; the approval of an agent binds to the **concrete** secret a
  reference resolves to, and a published version **pins** it.

## Scopes and references

| Reference | Resolves against | Managed by | Usable by |
| --- | --- | --- | --- |
| `team:<name>` | the team of the agent | `secrets:write` on that team | runs of agents of that team |
| `tenant:<name>` | the node of the agent, then its ancestors (nearest owner wins) | `secrets:write` held node-wide at the owning node | agents of that node and, unless `inherit: false`, of all descendants |
| `personal:<name>` | the user who starts a development run | the owner (needs `agents:write` to create and use one) | development runs started by the owner only; **never part of a published version**, see "Development runs and personal secrets" |
| `name` (no prefix) | operator environment and files (`OAX_SECRET_<NAME>`, `OAX_SECRETS_DIR`), unchanged | operator | unchanged |

Names are lower case (`[a-z0-9][a-z0-9_.-]{0,127}`). A reference with a colon that is not one of the three
scopes (`group:x`, `Team:x`) is invalid; it is never read as a legacy name. The environment variable of a
step credential is derived as before (`team:jira-token` becomes `TEAM_JIRA_TOKEN`; set `env` to choose).

Scoped references are supported in the `credentials` of a step (the credential broker path of run nodes).
**Limitation:** a scoped reference in an MCP connection (`envSecrets`, `headerSecrets`) is not supported:
connection save rules refuse it, and one that reached a stored connection some other way is never pinned, so
the broker refuses it with `secret_unavailable` (fail closed). See "Left out".

## Inheritance of tenant secrets

- **Nearest owner wins.** `tenant:x` of an agent at node M resolves to the secret `x` on the nearest node of
  M's chain (M, its parent, ..., the root) that has one. A node's secret with `inherit: false` is visible
  at that node only. Ancestors, siblings and other organisations never resolve a descendant's secret.
- **Shadowing.** A lower node may create a secret with the name of an inherited one, unless the owner set
  `allowOverride: false`; creating it then fails with `422 secret_name_reserved`. Secrets owned by a **root**
  node default to `allowOverride: false`, secrets on lower nodes to `true` (decision F4). A shadowing
  secret is audited (`secret.shadowed`, in the partition of the owning node). A secret that already
  shadows a name when an ancestor later creates a reserving secret stays; only new ones are refused.
- **Blocking.** A node may hide inherited names for itself and its subtree:
  `PUT /v1/secrets/policy { "blockInherited": ["jira-*"] }` (stored as `settings.secrets.blockInherited`).
  A blocked name does not resolve for agents at or below the node unless the node or a node below it owns
  one. The globs only ever hide names, so the setting can only narrow.
- **A secret that exists wins, even when it is revoked or expired.** Resolution never skips a dead nearer
  secret to a farther one; the reference fails instead.
- **Visibility.** `secrets:read` at a descendant lists the metadata of inherited secrets (owner as slug
  path, usage, destinations, expiry, `allowOverride`), without the creator and without the pointer.
  Rotating, revoking and deleting happen on the owning node only.

## Review, approval and publish

- The secret resolution of a revision is computed for the review: for every credential reference, the scope,
  the **owning node** and the **secret id** it resolves to. The `resolutionDigest` an approval binds to
  covers exactly that. A definition with no scoped reference keeps the old names-only digest byte for byte,
  so approvals given before this slice stay valid.
- A secret created later at a nearer node, a deleted secret and a changed chain (node move) change the
  digest: the approval becomes stale (`409 approval_stale`, `secret_resolution_changed`). **Rotation does not
  change it**: the binding is to the secret, not to a value or a version.
- Publish refuses, before the approval gate and whether or not approval is required, a reference that does
  not resolve to a secret that can be used in production: `422 secret_not_usable` with
  `details.references[] { ref, reason }` (`not_found`, `revoked`, `expired`, `usage`), and
  `422 personal_secret_in_version` for a `personal:` reference (the only supported value of
  `allowPersonalSecretsInPublishedAgents` in this slice is `never`).
- The version stores the pins (`agent_versions.secret_resolution`: `{ ref, state, scope, ownerNode,
  secretId }` per reference; versions from before this slice hold plain names). The pins are computed once
  under the publish locks and equal what the approval bound to.

## Secrets of a higher node need an approved review

A version whose `credentials` pin a tenant secret owned by **another node** than the agent's (inherited
from an ancestor) is published only under an approved review, even where `requireApprovalForPublish` is `off`
or the review would be advisory. Without a review the publish is refused with
`409 approval_required_for_foreign_secret` (`details.foreignSecrets[] { ref, scope, ownerNode }`); with
one, the normal gate applies (approvals, bindings, `publishBy`). It needs the resolver read path
(`OAX_ROLE_BINDINGS_READ=bindings`), like every enforced approval. The review (`GET /v1/reviews/{id}`)
lists `secrets[] { ref, state, scope, ownerNode, foreign }` so the approvers see whose secret it is.
Secrets of the agent's own node and own team do not trigger this.

## Development runs and personal secrets

A development run executes a draft revision as the person who starts it ([`agent-lifecycle.md`](agent-lifecycle.md),
slice S5). It resolves its references **live** (nothing is pinned for a draft) and the broker applies the
rules below at every issuance. The policy keys are read at that moment.

**Personal secrets.** `personal:<name>` resolves against the user who started the run, in the node of the
agent, and nowhere else.

- A scheduled or event-triggered run and any run of a published version never receive a personal secret:
  they have no starter, the broker refuses the scope for the stage, and a forged pin to a personal secret in
  a published version is refused as well (`secret_scope_not_usable`).
- A development run started by a reviewer or by another user resolves `personal:<name>` against **their own**
  personal secrets, so it never finds the author's (`secret_not_found` when they have none of that name).
- `allowPersonalSecretsInDevRuns: false` (or `allowDraftRuns: off`) refuses them (`secret_scope_not_usable`).
- The starter must still be entitled **at the moment of issuance**: the account active and `agents:write`
  held on the agent. The same check, with the policy, runs when a worker claims the run, at every model
  reservation, node session and relayed call (`403 dev_run_not_permitted`), so a disabled account, a lost
  role or `allowDraftRuns: off` stops a run that is already going. Otherwise nothing is issued to the run, of any scope (`secret_owner_unavailable`); the
  personal secrets are kept (a regained role brings them back) and their owner can still delete them while
  they hold `secrets:read` (deleting needs no `agents:write`; an owner left with no role at all cannot reach the
  route, and the secrets stay inert until the account is disabled).
- A **disabled account** loses its personal secrets: they are deleted with their sealed values in the
  transaction that disables the account (`secret.deleted`, `reason: owner_disabled`), queued development runs
  of the account are cancelled and running ones are asked to stop. Enabling the account again does not bring
  the secrets back. (Accounts are disabled, not deleted, in this release; the rule is the same for a delete.)
- Publishing a version that references a personal secret stays refused (`personal_secret_in_version`),
  whoever asks and whatever the review says. The `with-approval` path (`allowPersonalSecretsInPublishedAgents`,
  `usesPersonalCredentials`) is not part of this slice.

**Usage matrix.** `usage` is checked for the stage of the run:

| `usage` of the secret | Run of a published version | Development run |
| --- | --- | --- |
| `production` | issued | refused (`secret_not_usable`), unless `allowDraftRuns: on` **and** `allowProductionSecretsInDraftRuns: true` |
| `development` | refused (`secret_not_usable`) | issued |
| `any` (default) | issued | issued |

**Credentials that are not scoped secrets count as `production`.** Operator secrets (legacy references in
`credentials`), the environment secrets of a stdio MCP connection, the static header secrets and the OAuth
tokens of an HTTP MCP connection have no `usage`, so a development run is treated as asking for
production credentials. They are refused with `400 production_credentials_in_draft` at admission (the
draft names them), when a worker claims the run, at credential issuance
(`production_credentials_in_draft`, audited as `secret.access_denied`) and on the relay
(`mcp.relay.refused`, reason `development_credentials`), unless the policy lets drafts use production
credentials (`allowDraftRuns: on` together with `allowProductionSecretsInDraftRuns`). A connection
without secrets (`auth: none`) is not affected. Model provider keys are the platform's and are paid from
the development budget. Connections get no `usage` field in this slice (a per-connection `usage` is in
#376); a development run uses the same tool pins as a publish (the draft is expanded with the same
catalog, so unreviewed tool definitions are refused as at publish, and `OAX_MCP_REQUIRE_TOOL_PIN` applies).

**Personal secrets only for the author.** A personal secret is issued to a development run only if the
starter **wrote the revision it executes**. Somebody who runs another person's draft (a peer, a reviewer)
does not hand it their own personal credentials: the code is the author's, and an empty
`allowedDestinations` means anywhere. They edit the draft first, which makes them its author. (A run of a
revision whose author is not a user, such as an imported one, never gets a personal secret.)

**Secrets of a higher node in a draft.** A published version can pin a tenant secret of an ancestor only under an
approved review (`approval_required_for_foreign_secret`). A draft has no review, so a development run may use an
inherited tenant secret **only if its owner marked it `usage: development`**; an inherited secret of usage `any`
or `production` is refused (`secret_scope_not_usable`), even with the production flag. Secrets of the agent's
own node and team are not affected. This closes the way for an author to read a higher node's credential
through an unreviewed draft: the owner opts in per secret.

**Redaction.** Every value issued to a development run is stored sealed for that run like any issued value,
so step records, node results and audit payloads are scrubbed of it, also after the secret was rotated or
deleted.

**What a development run does not do.** It does not deliver pull requests (the step fails with
`pull_request_not_in_development`), it is not started by any trigger, and its spend is booked as
development spend ([`budgets.md`](budgets.md)). Tools are real and subject to the usual policy and
approval gates.

## Run time

The broker issues a scoped secret to a step of a run of a **published version** only if the pinned secret passes every check, in this order:
the version pinned it; the secret exists, is not revoked, not expired and still belongs to the pinned owner;
the owner is still on the run's chain (`secret_out_of_chain`) and, below the owner, no node blocks the name;
`usage` allows production; the step's effective egress and the hosts of its MCP connections lie inside
`allowedDestinations` (when set; `secret_destination_denied`); an imported pointer is still allowed by the
run's tenant and is not a platform secret. A refusal is audited twice, `secret.access_denied { ref, code }`
and `credential.denied`, answers `403 credential_scope` with the code, issues nothing and does not consume the
session. **There is no fallback to another node or scope.** Codes: `secret_unavailable`,
`secret_out_of_chain`, `secret_not_usable`, `secret_scope_not_usable`, `secret_destination_denied`.

`credential.issued` gains `secrets: [{ ref, scope, ownerNode, secretId, secretVersion, backend }]`. Values
are part of the redaction of the run: every scoped value that is issued is also stored **sealed** for that
run (`run_secret_issuances`, under the owner's data key, kept until a day after the session expired), and the
scrubber of node results and the pull request delivery check read it from there. So the redaction covers
what was **issued**, also after the secret was rotated, revoked or deleted, and for every credential source.

Consequences you should know:

- **Retention.** A sealed copy of an issued value stays until **one day after its session expired**, also
  after the secret was revoked or deleted; a periodic purge (every 15 minutes, in bounded batches, in the api
  process, safe on several replicas) removes the expired rows, and an issuance removes at most 20 on its way.
  Crypto-shredding the owning node makes the copies unreadable at once.
- **Operator environment values are copied into the database** (sealed, and so into backups) when a
  pointer secret is issued; they leave it with the purge. Rotating the environment value does not change the
  copy of an earlier issuance.
- **Availability.** A value that cannot be remembered is not issued: the step gets
  `credential_scope (unavailable)`, nothing leaves the control node, and the issuance is given back so that
  the node can retry (a failure after a dynamic credential source handed out a lease is not given back).

## Encryption at rest

- AES-256-GCM, one **data key (DEK) per tenant node** (`tenant_data_keys`, versioned), wrapped by a **key-
  encryption key (KEK)** from operator configuration, the same key service as the MCP OAuth tokens (ADR
  0016 S5): `OAX_MCP_OAUTH_KEK` or `OAX_MCP_OAUTH_KEK_FILE`. The variable names keep their MCP prefix for
  compatibility; ADR 0017 calls them `OAX_KEK_*` (aliases are a follow-up).
- Each value is sealed with additional authenticated data (AAD) = `secret | owning node | scope | scope id |
  name | secret id | version` (JSON array), so a ciphertext copied to another row, secret, node or version
  does not open. `secret_versions.aad_digest` (SHA-256 of the AAD, compared in constant time) is a second
  check that the identity columns were not edited; a trigger forbids changing them.
- Without a KEK nothing can be stored (`503 key_service_unconfigured`) and nothing is issued.
- Only the **current** version of a secret is stored. A rotation seals the new version and deletes the
  older one; a session that already received the old value keeps it until its step ends.
- Revoking deletes the stored values and keeps the row, so the name stays taken and a pinned reference
  fails closed. Sealed copies of values already **issued** to runs remain until the purge (see Run time).
- A secret is owned by the node whose data key seals it; an inherited secret is opened with the **owning**
  node's key. Shredding a node (`destroyTenantKeys`) makes its secrets unreadable for good and ends every
  descendant's use of them; it does not touch an ancestor's secrets.

## Key rotation

Operator tool `pnpm --filter @openagentix/api db:keys -- <command>` (compiled: `node dist/keys-cli.js`);
every step is idempotent, run it until `remaining` is `0`.

- **KEK rotation (two slots).** Set the new key as `OAX_MCP_OAUTH_KEK` (new `OAX_MCP_OAUTH_KEK_ID`) and the
  old one as `OAX_MCP_OAUTH_KEK_PREVIOUS` (or `_FILE`) with `OAX_MCP_OAUTH_KEK_PREVIOUS_ID` (the id the old
  key had), restart, then `db:keys -- rewrap` until `remaining` is 0 (`db:keys -- status` shows data keys per
  KEK id), then remove the previous slot. Only the small wrapped data keys are rewritten.
- **DEK rotation of a node.** `db:keys -- rotate-dek <node-id>` (new writes use the new version), then
  `db:keys -- reencrypt <node-id|--all>` until `remaining` is 0, then `db:keys -- retire <node-id|--all>`,
  which destroys a retired version only when no sealed value of any store (secrets and MCP OAuth tokens)
  still uses it. Mixed versions open side by side the whole time.
- Audit: `keys.kek.rewrapped`, `keys.dek.rotated`, `keys.dek.reencrypted`, `keys.dek.destroyed`.

## Backup, restore and moves

- A database backup holds ciphertext and wrapped DEKs only. **Restoring it needs the KEK** (and the previous
  slot if a rotation was in progress); without the KEK every secret is lost on purpose. Keep the KEK in the
  operator's own secret store, separate from the database backups.
- Crypto-shredding limit: while the KEK is unchanged, a backup taken before `destroyTenantKeys` still holds
  the wrapped DEK and the KEK unwraps it. Complete shredding needs a per-tenant KEK or a KMS (ADR 0012 W12-2).
- Restoring a backup older than a secret's deletion brings the secret back (with its old id, which pinned
  versions refer to); restoring older than a revocation restores the value.
- **Node moves.** The DEK, the AAD and the secrets of a moved node keep their node id, so they stay valid. What
  changes is the chain: an inherited secret of an ancestor the node no longer has fails closed at run time
  (`secret_out_of_chain`) for published versions that pinned it, and a new revision resolves against the new
  chain (and needs a new approval). Secrets of the moved subtree stay with their nodes. Moving into another
  organisation therefore leaves every pinned reference to the old ancestors unusable until agents are
  re-reviewed; references are not rewritten (`secretRefMap` is not implemented in this slice).
- Deleting a team deletes its secrets, in the same transaction, with one `secret.deleted` audit entry each.

## Import helper

`POST /v1/secrets { scope, name, pointer: "<legacy ref>" }` creates a secret that **points** at an operator
environment secret (`OAX_SECRET_<NAME>` or a file) instead of holding a value, so agents can move to scoped
references without touching the operator's configuration. The pointer must be opened by the tenant's
`secret_refs`, must not be a platform secret (provider keys, event sources, platform connections, exporter
and network secrets) and must exist now. The checks run again at every issuance, against the run's
tenant. Pointers have no values, cannot be rotated, and cannot be personal.

## API

All under `/v1/secrets`; the route-level permission is `secrets:read`, the service enforces the permission
of the scope. A secret the caller may not see is a `404`, the same as a missing one.

| Operation | Notes |
| --- | --- |
| `GET /v1/secrets?scope=tenant\|team\|personal&teamId=` | metadata, keyset paging; tenant scope includes inheritable secrets of ancestors |
| `POST /v1/secrets` | the value or a pointer is accepted here; 8 characters to 64 KiB |
| `GET /v1/secrets/{id}` | metadata |
| `POST /v1/secrets/{id}/rotate` | new value, optional new `expiresAt`; owning node only |
| `POST /v1/secrets/{id}/revoke` | values removed, cannot be undone |
| `DELETE /v1/secrets/{id}` | |
| `GET/PUT /v1/secrets/policy` | `blockInherited` of the acting node |

`secrets:read` (metadata): admin, integrator, agent-developer, agent-maintainer, auditor, pentest.
`secrets:write`: admin, integrator. Audit actions: `secret.created|rotated|revoked|deleted`
(`{ scope, scopeId, name, version, backend, inherit }`), `secret.shadowed`, `secret.access_denied`,
`secret.policy.changed`.

## Decisions taken in this slice

- One `secrets` row per secret and one `secret_versions` row for the current value (the ADR sketches one row
  per version). The secret id is stable, so pins and the approval digest bind to it; the AAD also contains the id.
- Older versions are deleted at rotation, revocation deletes the value, deletion removes the row.
- Resolution happens once per publish (under the tree, binding and agent locks) and at run time from the
  pins; no secret is resolved by name at run time.
- A scoped reference that does not resolve makes publish fail even where approval is not required.
- Every run of a published version is a production run; `usage: development` secrets are refused for
  them. Development runs (S5) use the rules in "Development runs and personal secrets".
- The globs of `blockInherited` and the destinations are validated narrowly (names with `*`; host names and
  `*.suffix`, no ports, no addresses). An egress entry that is an address never matches a destination.

- The policy columns of a secret (`usage`, `allowed_destinations`, `inherit`, `allow_override`, `pointer`)
  are immutable in the database, like the identity: the API has no edit of them, so a changed value can only
  come from outside the service. The broker also checks that the pinned row is the secret the reference names.
- A reserving secret (`allowOverride: false`, inheritable) cannot be created while a node below already owns
  that name (`422 secret_name_conflict`), because that secret would keep winning for its subtree. Creating
  tenant secrets of one name within an organisation is serialised by an advisory lock, so a reserving secret
  and a same-named secret below it cannot both be created at the same time.
- The decision path of reviews uses the same predicate as publish: any decision on a review that pins a
  secret of a higher node needs the digests, whatever the policy says.

## Left out (follow-up issue)

Secret backends other than `internal` and the `env` pointer (Vault, AWS Secrets Manager); the `with-approval`
path for personal secrets in published agents (`usesPersonalCredentials`, the extra admin approval, fail
closed when the owner leaves) and notifications of `secret_owner_unavailable`; scoped references in MCP connections (`envSecrets`, `headerSecrets`) and the
relay; `revokeSessions` and expiry warnings (14 and 3 days); notifications of shadowing and of failing
pinned secrets; issuance listing per descendant node (the audit has the data); metadata editing (`PATCH`);
leak canaries as a runtime feature; `OAX_KEK_*` aliases; UI; the review view that shows "now resolved from
node X instead of node Y" (the digests carry it, the API does not render it yet).

## Residual risks

- A value lives in the memory of the api or worker for one issuance and in the run node; a JavaScript string
  cannot be zeroed. A compromised node holds the values it was given and can encode them past the scrubbers.
- Crypto-shredding the owning node also destroys the sealed copies of issued values: after that, a
  value issued earlier is no longer known to the control node's scrubber (the run node's redaction still has it).
- **A credential of a higher node reaches every agent below it.** A tenant secret is inheritable by
  default (`inherit: true`), and an author can make a step print it, put it in a prompt or send it through
  a channel the control node allows; `allowedDestinations` limits egress only, and an empty list is
  unrestricted. Mitigations built in: a version that pins a secret of another node always needs an
  **approved review**, whatever the lifecycle policy says (`409 approval_required_for_foreign_secret`;
  the review lists the owning node of each such secret), and the approval binds to that secret. Mitigations
  you must choose: `inherit: false` for narrow credentials, `allowedDestinations`, `usage`, and agent rules
  that name the owning-node approver. A secret of the own node or the own team is usable without review
  where the policy asks for none.
- Operations: do not run `db:keys -- retire` while writes to the node are in progress; `reencrypt` covers
  `secret_versions` only, and a retired data key stays (`remaining > 0`) while MCP OAuth rows or issued values
  of unexpired sessions still use it. Watch the audit actions `secret.created`, `secret.rotated`,
  `secret.revoked` and `secret.deleted` (a rotation by an attacker with `secrets:write` is a credential
  swap): alert on them in the audit export. `secret.rotated` carries the new version only, never a value.
- A development run (steps, outputs, stream) is visible to its starter and to node administrators
  (`settings:write`) only. Audit entries and approvals of the run are not filtered that way (#376).
- The foreign-secret rule for drafts is an opt-in by the owner (`usage: development`); a root secret marked
  `development` is usable by every author in the organisation who can write an agent, without a review. Use
  `inherit: false`, `allowedDestinations` and narrow tokens for such secrets.
- Existence oracles: a caller with `secrets:write` learns whether a `pointer` target is configured
  (`secret_not_found` vs `secret_pointer_not_allowed`) and a node that creates a name learns that an ancestor
  reserves it (`secret_name_reserved`) or that a node below owns it (`secret_name_conflict`); neither reveals
  a value or the node below. An author without `secrets:read` learns from `secret_not_usable` whether an
  inheritable name exists above.
- Rolling the application back to a version before slice S4 leaves object pins in
  `agent_versions.secret_resolution` (that table is insert-only); older code does not read the column.
- The first resolution of a name in a transaction is a read, not a lock: a secret created in the same
  instant as a publish can land just before or just after it; the pins and the digest are consistent with
  each other either way.
