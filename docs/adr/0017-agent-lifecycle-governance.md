# ADR 0017: Agent lifecycle governance: development vs published, four-eyes publish approval with review comments, scoped and encrypted secrets, Vault and AWS Secrets Manager backends

- Status: Proposed
- Date: 2026-10-10
- Plan items: new wave W14 (this ADR, slices S1 to S9, issues #244 to #252); updates W6-3
  (#51, version approval bound to digest, model, eval set and policy), W7-2 (#54, multi-step
  approval workflows), W9-2 (#93, review and publish flow of Git-managed agents), W5-3 (#45, secret
  managers), W6-5 (#52, lifecycle console)
- Builds on: [ADR 0002](0002-audit-hash-chain.md) (audit chain),
  [ADR 0008](0008-agents-md-data-flow-and-isolation-contract.md) (per-step credentials, credential
  broker, run node), [ADR 0010](0010-agent-authoring-builder-and-git-sync.md) (builder, Git-synced
  agent repositories), [ADR 0012](0012-connections-instances-scopes-and-data-protection.md)
  (connection scopes, per-tenant data keys, customer-managed keys),
  [ADR 0013](0013-hierarchical-tenants-and-setup-modes.md) (tenant tree, narrowing-only settings),
  [ADR 0014](0014-tenant-tree-role-inheritance.md) (role bindings, grant rules, acting node),
  [ADR 0016](0016-mcp-egress-and-authorization.md) (per-connection egress, key service and token
  store, slice S5 #235)
- Amends: ADR 0010 section 7.4 (a Git candidate becomes a draft revision that goes through the
  review of this ADR; host review counts only under the rules of section 12)
- External references (read as reference data only): HashiCorp Vault documentation (KV secrets
  engine version 2, leases and revocation, AppRole, Kubernetes and JWT/OIDC auth methods, response
  wrapping); AWS Secrets Manager API reference (`GetSecretValue`, version stages) and AWS KMS
  envelope encryption; NIST SP 800-57 part 1 (key management).

## Context

### Owner requirements (2026-10-10, MUST)

A company with several departments applies the **four-eyes principle** to development, and it
must apply to agents as well:

1. As long as an agent is not published it is **in development**. Moving from "in development" to
   **published** must be approved by **another person**.
2. The approval can be **rejected with comments**, like a pull-request review (a Git-like
   principle).
3. When published, the agent's `agents.md` is **tagged with a version**. Edits happen only in the
   development state and affect production only after being published again.
4. While developing, the agent engineer may enter **personal tokens** for MCP servers. This is
   not recommended, but possible, also for review and production use; it is **controlled by
   policy**.
5. Tokens and secrets are better maintained at **group (team) or tenant level**, similar to Jenkins
   credentials, and stored **encrypted**.
6. A **HashiCorp Vault** connection is planned as an alternative backend, and **AWS Secrets
   Manager** as well.
7. The website must show the feature, **honestly marked as planned** until it is built.

### What exists on `main` (commit `5b66a5b`, verified)

**Drafts and published versions** (`apps/api/src/services/agents.ts`, `packages/core/src/agents/validate.ts`):

- An agent has exactly **one mutable draft** (`agents.draft_source`, `draft_updated_at`). There is
  **no draft history**: the table records `created_by` but not who edited the draft; editors are
  only visible in the audit chain (`agent.draft.updated` with the actor, version and digest).
- `POST /v1/agents/{id}/publish` turns the current draft into an **immutable version**
  (`agent_versions`: `version`, `digest`, `source`, expanded `definition`, `published_by`,
  `published_at`). `checkPublish` refuses a different source under an existing version number
  (`version_immutable`) and a version that is not greater than the newest published one
  (`version_not_increasing`); identical content is idempotent. The `digest` is the SHA-256 of the
  normalised source (`packages/core/src/agents/parser.ts`). Profile grants are expanded into
  concrete grants at publish and stored with the version (`agent.profiles.expanded` with an
  `expansionDigest`).
- **Publishing needs only `agents:publish`** on the agent. The role `agent-engineer` has both
  `agents:write` and `agents:publish` (`packages/core/src/rbac.ts`), so **the author publishes
  their own draft today**; there is no review, no second person and no approval record. Publish
  reads "the current draft" at the time of the call; nothing binds a publish to a reviewed content.
- The console has a diff between the draft and any published version (`DiffTab.tsx`) and a publish
  dialog with validation and the diff (`PublishDialog.tsx`). There are no comments.
- Runs execute **published versions only**: `RunsService.enqueue` uses the latest published version
  or a version pinned by the caller (`POST /v1/agents/{id}/runs` accepts `version`) and stores the
  version id on the run, so queued and running runs keep their version when a newer one is
  published. Drafts can only be **dry-run** (`POST /v1/agents/{id}/dry-run`, `agents:write`):
  simulated provider, tool calls policy-checked but never executed, nothing stored.
- **Disable/enable** of an agent exists (UX slice A7, `agents:publish`): a disabled agent accepts no
  new runs; published versions stay readable. There is **no per-version deprecation**.
- The agent's `team_id` is fixed when the agent is created (from `owner`); a later draft can change
  the `owner` field without moving the agent. Approval scoping in this ADR therefore uses the stored
  team, and a changed `owner` is shown as a review-relevant change.

**Approvals today are run-time only** (`apps/api/src/services/runs.ts`, `control-plane.ts`):

- A tool call with `require_approval` creates a row in `approvals` with the `approverRoles` of the
  **agent definition** (`approvals.approverRoles` in `agents.md`, default `[operator, admin]`) and
  a timeout. One decision (`approve` or `reject`, optional comment) by a user with `runs:approve`
  and one of those roles decides it.
- There is **no rule that the approver differs from the person who triggered the run or wrote the
  agent**, there is no n-of-m, and the approver roles are chosen by the agent's author. W7-2 (#54)
  plans n-of-m, distinct identities and "requester can never approve" for run-time approvals; it is
  not started. W6-3 (#51) plans a version approval bound to digest, model, eval set and policy; it
  is not started either.

**Git-synced agent repositories** (ADR 0010, W9-2, issues #90 to #96): designed, **not built**
(no `agent_repositories` table, no sync code on `main`). The design makes a passing file a
**candidate** (draft); `publishMode: manual` lets any user with `agents:publish` publish it (the
same self-publish gap as above); `publishMode: on-merge` publishes as `repo:<bindingId>` only with
signed commits by trusted signers, an ancestry check and branch protection with at least one
required review (read through the host extension or an operator attestation). That is a review in
the Git host, but the platform cannot tell **who** reviewed, whether the reviewer differs from the
author, or whether the reviewer may approve under a tenant policy.

**Roles and tenants** (ADR 0013, ADR 0014; `apps/api/src/db/schema.ts`):

- Fixed roles: `admin`, `agent-engineer`, `integrator`, `operator`, `auditor`, `viewer` (grantable)
  and `pentest` (not grantable before ADR 0014 S6). Bindings per tenant node
  (`tenant_role_bindings`, with `granted_by`, `expires_at`, `inherit`), per team (`team_members`)
  and per agent (`agent_role_bindings`). Grant rules forbid self-grant **except for platform
  admins** (ADR 0014 section 7 rule 6). Role restrictions per node can remove permissions (ADR
  0013 7.3; table exists, unused until ADR 0014 S9).
- API tokens are **user-level**: a token acts as its user with intersected scopes. There are no
  service-account users; non-human actors appear as strings in the audit chain (`repo:<id>`,
  `node:<id>`, `dry-run`). A platform admin can act in any tenant (`X-OAX-Tenant`), as themselves.
- **Tenant settings with narrowing-only inheritance** are designed (ADR 0013 section 3,
  `tenants.settings jsonb`, effective resolver W13-2) but **not built**: the `tenants` table on
  `main` has `monthly_budget_micros`, `secret_refs` and `authz_epoch`, no `settings` column.

**Secrets** (`packages/core/src/secrets.ts`, `credentials.ts`, `apps/api/src/services/run-nodes.ts`):

- Secrets are **references by name**; values come from the environment (`OAX_SECRET_<NAME>`) or a
  mounted directory (`OAX_SECRETS_DIR`), i.e. from the **operator**. The platform stores **no secret
  value** in its database; nothing is encrypted by the platform, and there is no key service (ADR
  0016 S5 #235 is open).
- Per tenant, `tenants.secret_refs` holds allowlist globs (fail closed when empty); references in
  canonical form must carry the tenant prefix (`<slug>.`); platform secrets never reach a run node
  (`platform_secret`).
- Steps declare `credentials: [{ secret, env }]` in `agents.md` (ADR 0008); connections reference
  secrets by name (`envSecrets`, `headerSecrets`, `*Secret`). The **credential broker** issues the
  values of exactly these references once per step and session to the run node, through the
  `CredentialSource` interface, which already supports dynamic credentials (`expiresAt`, `handle`,
  `revoke`); only the `static` source exists. `credential.issued` is audited with the references and
  the source name, never values.
- Values in use are registered with the `ContextGuard` and the log redactor (`addSecret`); values
  shorter than 8 characters (`MIN_KNOWN_SECRET_LENGTH`) are not redacted.
- There are **no personal, team or tenant secret scopes**, no secret API, no Vault or AWS Secrets
  Manager backend (W5-3 #45 open), no per-tenant data keys (ADR 0012 W12-2 open). ADR 0012 7.7 and
  the owner decision of 2026-10-04 require tenant-owned keys (KMS) for v1.0.

**Audit**: one global hash chain with Ed25519 checkpoints (ADR 0002); per-tenant chains are W7-1.

### Gaps against the requirements

| Requirement | Today | Gap |
| --- | --- | --- |
| In development vs published | draft + immutable versions | draft has no revisions and no authors; no status beyond "draft differs" |
| Another person approves | author self-publishes | no approval record, no distinct-person rule, no tenant policy |
| Reject with comments | none | no review, no threads |
| Version tag | `version` + `digest`, immutable | no link to who approved what; no tag in Git |
| Edits only in development | draft is separate from versions | already true; must stay true for reviews too |
| Personal tokens, policy | none | no personal scope, no policy |
| Team/tenant secrets, encrypted | operator env/files only | no store, no encryption |
| Vault / AWS SM | none | W5-3 #45 open |

## Decision

### 1. Principles

1. **Published means approved.** When the tenant policy requires it, a version can only come into
   existence from a draft revision whose exact content was approved by enough eligible people who
   are not its authors. There is no path around this except the audited break-glass of section 7.
2. **The approval binds to bytes, not to an agent.** It names the digest of one immutable draft
   revision, the digest of the expanded grants and the digest of the policy it was given under. Any
   change to any of them makes it stale.
3. **Nobody approves their own work**, in no role, through no token, impersonation or second
   account that the platform can recognise. This rule is not configurable.
4. **Making things safer never needs approval** (disable an agent, deprecate a version, revoke a
   secret, cancel runs); making things reachable does (publish, re-enable after a break-glass).
5. **Secrets are use-only.** After creation a value is never readable through any API, by anyone,
   including its creator. Agents reference secrets by name and scope, never by value.
6. **Policy is tenant-owned and only gets stricter down the tree** (ADR 0013 section 3). Nothing in
   `agents.md` can loosen it; the agent's own `approvals.approverRoles` keep governing run-time
   tool approvals only.
7. **Reuse, don't fork**: the key service is the one of ADR 0016 S5 (#235); the approval rule engine
   is shared with run-time approvals (W7-2) and version approvals (W6-3).

### 2. Terms

| Term | Meaning |
| --- | --- |
| Draft revision | Immutable snapshot of the draft: `source`, `digest`, `author`, `parent` revision, `created_at`. Every save creates one; the agent's draft is a pointer to the newest. |
| Base version | The published version the review compares against (the latest published version when the review was opened, or none). |
| Contributors | Every author of a revision after the base version up to the reviewed revision, plus the user who opened the review. For Git-managed agents also the mapped commit authors and committers (section 12). |
| Review | The equivalent of a pull request: one per agent at a time, follows the draft, has a status, comment threads and decisions. |
| Decision | `approve`, `request_changes` or `reject` by one reviewer on one revision. |
| Approval record | A valid `approve` decision with its bindings (section 4). |
| Policy snapshot | The effective lifecycle policy of the agent's node at the time the review was opened, canonical JSON, with its digest. |
| Development run | A run of a draft revision with real tools and models, manual only, development budget and credentials (section 8). |

### 3. State machine

Status of an agent's development line (shown as a badge) and of its review:

```text
                      save draft                 open review
   (published vN) ----------------> In development ----------------> Review requested
          ^                              ^   ^                           |   |   |
          |                              |   | new revision (approvals   |   |   | reject
          |                              |   |  dismissed, threads stay) |   |   v
          |                              |   +---------------------------+   | Rejected (closed;
          |                              |       request_changes              |  draft kept, a new
          |                              +---- Changes requested <------------+  review is needed)
          |                                          |  new revision -> Review requested
          |   publish (digest == approved digest,    |
          |   approvals valid, policy unchanged)     v (enough valid approvals)
          +------------------------------------- Approved
                                                    | any new revision / expiry / policy change
                                                    v
                                              Review requested (stale approvals listed)

   Published version vN:   active --(deprecate)--> deprecated      (no new runs pinned to it)
   Agent (A7, exists):     enabled <--(disable/enable)--> disabled (no new runs at all)
```

| From | Event | To | Who | Notes |
| --- | --- | --- | --- | --- |
| Published (no open review) | draft saved with a different digest | In development | `agents:write` | creates a revision; production keeps running vN |
| In development | open review | Review requested | `agents:write` on the agent | computes and stores digest, expansion digest, policy snapshot, required approvals; notifies eligible reviewers |
| Review requested | `request_changes` with at least one comment | Changes requested | eligible reviewer | blocks publish until that reviewer approves a later revision or the request is dismissed |
| Review requested, Changes requested, Approved | new revision saved | Review requested | `agents:write` | every approval and every `request_changes` on older revisions becomes **stale** (shown, not counted); threads stay, anchored to their revision and marked "outdated" where the line changed |
| Review requested | enough valid approvals | Approved | system | computed, never stored as a free flag |
| Approved | approval expiry, policy change that makes an approval ineligible, expansion digest change | Review requested | system | reason listed per approval |
| Approved | publish | Published | `agents:publish` (author or approver; policy `publishBy`) | section 4.3 checks inside one transaction |
| any open state | `reject` with a comment | Rejected | eligible reviewer | closes the review; the draft stays; a new review starts from scratch |
| any open state | withdraw | In development | the review opener or an admin | audited |
| Published version | deprecate | deprecated | `agents:publish` | refuses new runs pinned to that version (`409 version_deprecated`); latest version cannot be deprecated without disabling the agent or publishing a newer one |
| Agent | disable / enable (A7) | disabled / enabled | `agents:publish` | unchanged; enable after a break-glass publish needs ratification (section 7) |

When `requireApprovalForPublish` is `off` for an agent, the review is optional: publish behaves as
today, and an open review is shown as advisory.

### 4. Draft revisions and what an approval binds to

#### 4.1 Revisions

- Migration adds `agent_draft_revisions (id, agent_id, tenant_id, seq, digest, source, author_id,
  author_kind user|repo|system, parent_id, created_at)`, unique `(agent_id, seq)`. Every
  `create`/`updateDraft` (and a Git candidate, section 12) inserts a revision; `agents.draft_source`
  stays as a denormalised copy of the newest revision for compatibility; `agents.draft_revision_id`
  points to it. Saving identical content creates no revision.
- Revisions are immutable and kept while a review or a version references them; others may be
  pruned after `draftRevisionRetentionDays` (default 90), keeping authors in the audit chain.
- Upgrade: each existing agent gets one revision with `author_kind = system` and the author unknown.
  An unknown author is treated as **every** user who edited the draft according to the audit chain
  since the last publish (best effort), and the review page says so.

#### 4.2 Binding

An approval record stores:

| Field | Purpose |
| --- | --- |
| `review_id`, `revision_id`, `digest` | the exact source (SHA-256 of the normalised source, as `agent_versions.digest`) |
| `expansion_digest` | digest of the concrete grants after profile expansion against the catalog at review time, including `toolsDigest` of ADR 0016 S3 once it exists: the reviewer approves concrete tools, not profile names that may widen later |
| `base_version_id` | what the diff was computed against |
| `policy_digest` | digest of the policy snapshot |
| `reviewer_id`, `reviewer_auth` (`session`, `token:<id>`), acting node, the binding ids that made the reviewer eligible | for the re-check at publish and for audit |
| `decided_at`, `expires_at` | expiry from `approvalExpiryHours` |

#### 4.3 Publish under approval (TOCTOU)

`POST /v1/agents/{id}/publish` gains `{ reviewId, expectedDigest }` (both required when approval
is required). In **one transaction** with `SELECT ... FOR UPDATE` on the agent row:

1. the agent's current draft revision digest equals the review's revision digest equals
   `expectedDigest` (else `409 draft_changed`);
2. the profile expansion is recomputed against the current catalog; its digest equals the approved
   `expansion_digest` (else `409 approval_stale { reason: expansion_changed }`);
3. the current effective policy is evaluated; every counted approval is re-checked against it
   (eligibility, role bindings still present and not expired, not granted by a contributor, expiry,
   distinctness); at least `minApprovals` survive and no unresolved `request_changes` exists (else
   `409 approval_insufficient` with reasons per approval);
4. the published version row is inserted from the **revision's** source (never from a value read
   earlier), with `review_id`, `revision_id`, `approved_by[]`, `policy_digest`;
5. the review is closed as `published`; the audit entries of section 11 are appended in the same
   transaction or immediately after with the version id.

A change of the policy that is **looser** than the snapshot does not invalidate approvals; a
stricter one re-checks them (step 3). The version rule (`checkPublish`) still applies.

### 5. Who may approve

All rules are evaluated at decision time **and again at publish**:

| # | Rule | Configurable |
| --- | --- | --- |
| A1 | The reviewer is a user, not a contributor of the review (no author of any revision since the base version, not the opener, for Git-managed agents not a mapped commit author or committer). Applies to platform admins as well. | no |
| A2 | Approvals are counted per distinct user id; one user counts once, whatever roles they hold. | no |
| A3 | The reviewer holds `agents:approve` (new permission) on the agent through a binding whose role is in the effective `allowedApproverRoles`, with the binding covering the agent (tenant node binding with inheritance, team binding of the agent's team, or agent binding). | roles: yes (narrowing) |
| A4 | The qualifying binding was **not granted by a contributor** (`granted_by` not in contributors) and, when `approverBindingMinAgeHours` > 0, existed for at least that long when the review was opened. Prevents an author with grant rights from creating an approver. | min age: yes |
| A5 | Authentication: an interactive session (OIDC, LDAP or local). API tokens may approve only when `allowTokenApprovals` is true; non-human actors (`repo:*`, `node:*`, anonymous showcase guests, demo actors) never. | tokens: yes |
| A6 | Identity source: when `approverIdentitySources` is set (for example `[oidc, ldap]`), local accounts cannot approve. Reduces the "second local account" risk where an IdP exists. | yes |
| A7 | Scope: `approverScope: tenant` (any eligible binding covering the agent, default) or `team` (only members of the agent's team or bindings on the agent) or `other-team` (eligible and **not** a member of the agent's team; separation between departments). | yes |
| A8 | `minApprovals` distinct approvals (default 1, maximum 5). | yes |
| A9 | Path rules (S8): per tenant, rules like CODEOWNERS that map changed fields of the definition to required approver groups, e.g. a change to `runtime.egress`, `credentials`, any tool grant with `access: write`, `classification` or `budget` requires one approval from team `security`. Fields, not lines, so formatting cannot evade a rule. | yes |
| A10 | The reviewer can read the agent (`agents:read`), sees the full diff and the expansion; a decision without having loaded the current revision is refused (`409 stale_view` via `expectedDigest`). | no |

Run-time approvals (W7-2) adopt A1 (requester and agent contributors never approve their run's tool
calls when the tenant enables it), A2, A5 and A8 through the same rule module
(`packages/core/src/approvals/rules.ts`).

Acting node and impersonation: a platform admin acting in a tenant (`X-OAX-Tenant`) decides as
themselves; A1 and A2 apply unchanged. There is no "act as user" feature, and this ADR adds none.

### 6. Tenant policy

Stored as `settings.agentLifecycle` of a tenant node (ADR 0013 section 3). Until W13-2 builds the
general effective-settings resolver, slice S1 adds the column `tenants.settings jsonb` (if W13-2
has not landed) and a small resolver for exactly these keys in
`packages/core/src/tenancy/lifecycle-policy.ts`, shaped to fold into W13-2. Installation defaults
come from `OAX_LIFECYCLE_*` environment variables.

| Key | Values (strictest last) | Default | Inheritance (child may only) |
| --- | --- | --- | --- |
| `requireApprovalForPublish` | `off`, `production-only`, `on` | `on` in multi-tenant mode, `off` in single-tenant mode (one person cannot do four-eyes) | raise |
| `productionUseCases` | list of use-case globs that count as production (used by `production-only`) | `[]` | add entries (union) |
| `selfApproval` | `never` | `never` (fixed, shown for clarity) | n/a |
| `minApprovals` | 1 to 5 | 1 | raise |
| `allowedApproverRoles` | subset of `admin`, `agent-engineer`, `operator` | `[admin, agent-engineer]` | narrow (intersection, never empty) |
| `approverScope` | `tenant`, `team`, `other-team` | `tenant` | `tenant` -> `team` or `other-team` |
| `approverBindingMinAgeHours` | 0 to 720 | 0 | raise |
| `approvalExpiryHours` | 1 to 720 | 168 | lower |
| `allowTokenApprovals` | `true`, `false` | `false` | set to `false` |
| `approverIdentitySources` | list of `local`, `oidc`, `ldap` | all | narrow |
| `publishBy` | `any-publisher`, `approver-only` | `any-publisher` | `approver-only` |
| `allowDraftRuns` | `off`, `development-credentials`, `on` | `development-credentials` | lower |
| `allowPersonalSecretsInDevRuns` | `true`, `false` | `true` | set to `false` |
| `allowPersonalSecretsInPublishedAgents` | `never`, `with-approval` | `never` | set to `never` |
| `allowProductionSecretsInDraftRuns` | `true`, `false` | `false` | set to `false` |
| `breakGlass` | `on`, `off` | `off` | set to `off` |
| `breakGlassRatifyHours` | 1 to 72 | 24 | lower |
| `pathRules` (S8) | list of `{ fields: [json-pointer globs], requireFrom: { team? , role? }, min }` | `[]` | add rules |

`production-only` uses the **union** of the base version's and the draft's use case: moving an agent
out of a production use case by editing its label still needs approval. Writes that would widen an
ancestor's effective value are refused with `422 not_narrowing` (ADR 0013). The policy endpoint is
`GET/PATCH /v1/tenants/{id}/settings/agent-lifecycle` (`settings:read` / `settings:write` on the
node); every change is audited with field names, old and new values.

### 7. Break-glass publish

For incidents where a fix must go out before a second person is available:

- Only when `breakGlass: on` is effective; only a user with an `admin` binding covering the agent;
  a reason (20 to 500 characters) is required; the publish is audited as
  `agent.published { breakGlass: true, reason }` and notifies all tenant admins and the eligible
  reviewers.
- A **second, eligible approver** (rules of section 5, the break-glass publisher counts as a
  contributor) must ratify the version within `breakGlassRatifyHours`. Without ratification the
  agent is **disabled automatically** (A7, `disabledReason: break_glass_unratified`) and can only be
  enabled after a ratification.
- Break-glass never allows personal secrets in a published version and never skips validation,
  version rule or lint.
- Preferred incident action remains disabling the agent (no approval needed, principle 4).

### 8. Development vs production execution

| Aspect | Draft (in development) | Published version |
| --- | --- | --- |
| What runs | a specific **revision** (`agent_revision_id` on the run, `stage: development`) | a version (`agent_version_id`, `stage: production`), as today |
| Triggers | manual only (console "Test run", API); never webhooks, mail, Kafka, cron | all triggers |
| Who may start | `agents:write` on the agent (the author and co-authors); reviewers may start a run with **their own** development credentials | `runs:execute` |
| Tools | `allowDraftRuns: off` -> dry run only (today); `development-credentials` -> real tools only through connections/secrets marked `usage: development` or `any` and personal secrets of the run's starter; `on` -> also `production` secrets when `allowProductionSecretsInDraftRuns` | as published, the version's grants |
| Budget | development budget per tenant/team (`limits.devMonthlyBudgetMicros`, separate cost line `stage=development`, hard stop) | the normal budgets |
| Audit/costs | marked `development` everywhere (runs list filter, costs export column) | unchanged |
| Approvals at run time | as for published runs (the policy gate applies unchanged) | unchanged |

On a new publish: queued runs keep the version they were enqueued with (true today), running runs
finish on their version unless cancelled; new events and schedules use the new version. A
**deprecated** version refuses new runs pinned to it. A security fix that must stop old runs uses
the existing cancel and disable actions.

### 9. Review UI concept

- **Status badge** on the agent list and detail page: `In development`, `Review requested`,
  `Changes requested`, `Approved`, `Published vX.Y.Z` (plus `Disabled`, `Deprecated` on versions,
  `Break-glass – ratification pending`). All texts through i18n (en, de).
- **Review tab** (next to Overview, Editor, Diff, Versions, Test run): header with requested by,
  base version, required approvals (`1 of 2`), policy summary and why each rule applies; the
  **diff** of `agents.md` between the base version and the reviewed revision (the existing
  `DiffView`), plus a **semantic summary** (added/removed tools and their access class, egress hosts,
  secret references with scope, budget, classification, runtime, owner changes) and the expanded
  grants.
- **Comment threads** on a line of the diff (`revision_id`, side `base|head`, line, plus the SHA-256
  of the line text as anchor) or on the review as a whole. Threads can be resolved by the author or
  the commenter; on a new revision a thread whose anchor no longer matches is shown as **outdated**
  but kept. Markdown subset (no HTML, no images, links shown as text with the host), 10 000
  characters, 200 threads per review; comments are tenant content (retention and erasure of ADR
  0012 section 7 apply; never sent to models).
- **Decision bar**: Approve / Request changes / Reject, each with an optional (approve) or required
  (request changes, reject) comment; disabled with the reason when the user is not eligible ("You
  edited this draft", "Your role is not an approver role in this tenant").
- **Publish** button appears when the review is approved; the publish dialog shows the approval
  records and re-checks before submitting.
- **Notifications** (S8): review requested to eligible reviewers, decisions and comments to
  contributors, expiry and break-glass to admins; delivered through W2-5/W3-1 channels when they
  exist, in-console inbox before.

### 10. API (additions to `openapi.yaml`, generated by the implementing slices)

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /v1/agents/{id}/revisions`, `GET .../revisions/{rev}` | `agents:read` | metadata and source |
| `POST /v1/agents/{id}/reviews` | `agents:write` | opens a review on the current revision; `409 review_open` when one is open |
| `GET /v1/agents/{id}/reviews`, `GET /v1/reviews/{rid}` | `agents:read` | status, required approvals, approvals with eligibility per rule, stale reasons |
| `POST /v1/reviews/{rid}/decisions` | `agents:approve` | `{ decision, expectedDigest, comment? }`; refusal codes `self_approval`, `not_eligible`, `binding_granted_by_contributor`, `token_approval_disabled`, `stale_view` |
| `POST /v1/reviews/{rid}/threads`, `POST .../threads/{tid}/comments`, `PATCH .../threads/{tid}` | `agents:review` (new: comment) | resolve/unresolve |
| `POST /v1/reviews/{rid}/withdraw` | opener or `admin` | |
| `POST /v1/agents/{id}/publish` | `agents:publish` | `{ reviewId, expectedDigest }` when required; break-glass `{ breakGlass: { reason } }` |
| `POST /v1/agents/{id}/versions/{v}/ratify` | `agents:approve` | ratifies a break-glass version |
| `POST /v1/agents/{id}/versions/{v}/deprecate` | `agents:publish` | |
| `GET/PATCH /v1/tenants/{id}/settings/agent-lifecycle` | `settings:read` / `settings:write` | narrowing-only |
| `GET /v1/me/reviews` | any | inbox: reviews where the caller is eligible |

New permissions in `packages/core/src/rbac.ts`: `agents:review` (admin, agent-engineer, integrator,
operator, auditor), `agents:approve` (admin, agent-engineer, operator; narrowed by
`allowedApproverRoles`). The UI types are regenerated as usual.

### 11. Audit events (hash-chained, ADR 0002; names, ids and digests only)

`agent.revision.created { revision, digest, author }`, `agent.review.opened { review, revision,
digest, expansionDigest, policyDigest, requiredApprovals }`, `agent.review.decided { review,
revision, digest, decision, reviewer, auth, eligibleVia }`, `agent.review.refused { review, code }`
(rate-limited), `agent.review.stale { review, approvals, reason }`, `agent.review.comment { review,
thread }` (no comment text in the audit chain), `agent.review.closed { review, outcome }`,
`agent.published { version, digest, review, approvedBy[], policyDigest, breakGlass? }`,
`agent.version.ratified`, `agent.version.deprecated`, `tenant.lifecycle_policy_changed { fields,
from, to }`, `secret.created|rotated|revoked|deleted { scope, scopeId, name, version, backend }`,
`secret.access_denied { ref, code }`, and `credential.issued` gains `scope` and `secretVersion`.

### 12. Git-sync interplay (ADR 0010)

- A Git candidate (ADR 0010 7.4) becomes a **draft revision** with `author_kind = repo`; the review
  of this ADR applies to it like to a console revision. With `requireApprovalForPublish` effective,
  `publishMode: manual` means "publish after console review".
- **Host review as approval** (`acceptGitHostReview: true`, S9, off by default) counts only when
  **all** hold: `publishMode: on-merge` conditions of ADR 0010 A1.7 (signatures by trusted signers,
  ancestry, branch protection read through the **host extension**, an attestation alone is not
  enough because it cannot be checked); the host extension reads the merged change request's
  approving reviews and the commit authors/committers; every host account involved is mapped to a
  platform user through a **verified identity link** (user-initiated link proven by an OIDC claim of
  the host or a signed challenge); the mapped approvers satisfy section 5 against the mapped
  contributors; required reviews on the branch are at least `minApprovals`. Otherwise the candidate
  waits for a console review and the binding shows which condition failed.
- When published, the platform can push a lightweight tag `agents/<name>/v<version>` to the
  repository with the PR-back credential (optional, S9). The tag is informational; the platform's
  record is the version row with digest and approvals.

### 13. Secrets: scopes, store, encryption and backends

#### 13.1 Scopes

| Scope | Owner | Who may reference it in an agent | Who may use it at run time | Who manages it |
| --- | --- | --- | --- | --- |
| `personal` | one user in one tenant | only its owner, only in drafts | only runs **started by its owner**, only development runs (unless section 13.4) | the owner (needs `agents:write` somewhere in the tenant) |
| `team` | a team | agents of that team | runs of agents of that team | `secrets:write` on the team |
| `tenant` | a tenant node | agents of that node; descendants only if the secret has `inherit: true` | runs of those agents | `secrets:write` on the node |
| `platform` | operator | never brokered to nodes (unchanged `platform_secret`); used by platform connections, model proxy, event sources | trusted processes only | operator configuration |

Each secret has `usage: development | production | any` (default `any`), an optional
`allowedDestinations` list (host globs: the broker refuses to issue the secret to a step whose
effective egress or MCP connection URL lies outside it), a description, `created_by`,
`rotated_at`, `expires_at` (optional) and a backend pointer.

#### 13.2 References in `agents.md`

- Scoped references: `credentials: [{ secret: "team:jira-token", env: JIRA_TOKEN }]`, and in
  connections `headerSecrets: { Authorization: "tenant:jira-basic" }`. The prefix is the scope;
  team references resolve against the **agent's** team, tenant references against the agent's node,
  personal references against the **run's starter**. There is **no implicit fallback** between scopes
  (no shadowing, as ADR 0012 for connection names). Unprefixed references keep today's meaning
  (operator env/files, tenant prefix and `secret_refs` globs) and are labelled "legacy".
- Values never appear in `agents.md`; the existing inline-secret checks stay. Validation at save
  checks the syntax, publish checks that the referenced secret exists and that the agent may use it
  (`secret_not_usable`), and the review shows every added or removed reference with its scope.

#### 13.3 Visibility and use

- `secrets:read` (metadata), `secrets:write` (create, rotate, revoke, delete) are new permissions:
  `admin` and `integrator` on their scope; personal secrets only by their owner. `auditor` and
  `pentest` see metadata.
- **No API returns a value**, not even to the creator or a platform admin. Values are accepted
  only on create and rotate (request body, never in query strings or logs), are at least 8
  characters long (the redaction minimum) and at most 64 KiB.
- Using a secret means: the broker issues it to a step of an agent that may use it (13.1) in a run
  that may use it (13.4, section 8). The issuance is the audit event.

#### 13.4 Personal secrets

- Usable in development runs started by their owner when `allowPersonalSecretsInDevRuns` is
  effective. Reviewers never run with the author's personal secret (confused deputy); they use their
  own personal secret with the same name or a team/tenant secret.
- A revision that references personal secrets can be reviewed, but **publishing it is refused**
  (`personal_secret_in_version`) while `allowPersonalSecretsInPublishedAgents: never` (default).
- With `with-approval`: publish requires one additional approval from an `admin` covering the agent
  (counted separately), the version is flagged `usesPersonalCredentials` (badge, list filter, run
  view, audit), production runs act with the owner's credential whoever triggers them, and the
  flag is part of the approval binding. When the owner is disabled, leaves the tenant, or deletes or
  rotates the secret, runs fail closed (`secret_owner_unavailable`) and tenant admins are notified.
- Personal secrets are deleted when the user is deleted (crypto-shredded with their row, see 13.5).

#### 13.5 Encryption at rest (internal store)

- Envelope encryption with the **key service of ADR 0016 S5 (#235)**: AES-256-GCM, one data key
  (DEK) per tenant node (`tenants.data_key_id`, versioned), DEKs wrapped by a key-encryption key
  (KEK) from operator configuration first (`OAX_KEK_*`, file or env, two slots for rotation) and from
  a KMS later (AWS KMS, Vault Transit, then Azure Key Vault and Google Cloud KMS; customer-managed
  keys per tenant for v1.0, owner decision of 2026-10-04, ADR 0012 open question 4).
- Table `secrets (id, tenant_id, scope, scope_id, name, version, backend, ciphertext, nonce,
  dek_version, aad_digest, usage, allowed_destinations, inherit, created_by, created_at, rotated_at,
  expires_at, revoked_at)`; unique `(tenant_id, scope, scope_id, name, version)`. Additional
  authenticated data = `tenant_id | scope | scope_id | name | version`, so a ciphertext copied to
  another row or tenant does not decrypt.
- **Rotation**: KEK rotation rewraps DEKs only (no data re-encryption); DEK rotation creates a new
  DEK version, new writes use it, a background job re-encrypts old rows and audits progress; a DEK
  version is destroyed only after no row uses it. Crypto-shredding of a tenant or a user's personal
  secrets destroys the DEK or deletes the rows.
- Plaintext exists only in the api/worker process for one issuance; it is not cached across
  requests (wrapped DEKs may be cached in memory for at most 5 minutes, never in Valkey), never
  logged, never written to telemetry, and registered with the `ContextGuard` and redactor of the
  run.

#### 13.6 Backends (pluggable)

A secret row can hold a value (internal store) or a **pointer** to an external backend. The
backends implement the existing `CredentialSource` interface (`issue(ref, scope)`, optional
`revoke(handle)`) plus `describe()` and `health()`:

| Backend | Pointer | Auth of the platform | Leases |
| --- | --- | --- | --- |
| `internal` | value (13.5) | n/a | static |
| `env` (legacy) | today's `OAX_SECRET_*` / files | n/a | static |
| `vault-kv2` | `{ connection, mount, path, key, version? }` | AppRole (role id from config, secret id delivered response-wrapped), Kubernetes auth (projected service-account token), JWT/OIDC auth | static values; Vault token short TTL, renewed, revoked on shutdown |
| `vault-dynamic` | `{ connection, mount, role }` (database, AWS, other engines) | as above | lease per step: TTL <= step lifetime, revoked by the broker at step end through `credentialHandles` (already persisted per session) |
| `aws-sm` | `{ connection, secretId (ARN), versionStage?, jsonKey? }` | IRSA or instance role, then `AssumeRole` per tenant with `ExternalId = tenant id` | static; rotation by AWS, the platform reads `AWSCURRENT` |

- **Backend connections** are typed connection instances (ADR 0012): `vault` and `aws-sm`, scope
  platform (operator-wide) or tenant (**tenant-owned store**, which gives the separation from
  operators that ADR 0012 7.7 asks for). The operator-wide backend has a fixed per-tenant path
  template (`<mount>/tenants/<tenantId>/...`) or ARN prefix; a tenant pointer outside its prefix is
  refused at save and at issue (`secret_pointer_out_of_scope`). Outbound calls go through the ADR
  0011 dispatcher (purpose `secrets`, DNS pinning, proxies, trust store); air-gapped mode needs the
  backend host on the allowlist.
- **Caching**: no caching of static values by default; `cacheTtlSeconds` up to 60 per backend
  connection, in process memory only, keyed by tenant, scope, name and version, flushed on rotate
  and revoke. Dynamic credentials are never cached.
- Failures fail closed with a reason code in the audit entry (`backend_unavailable`,
  `backend_denied`, `pointer_not_found`), never with backend error text in API responses.
- Vault tokens and AWS session credentials live only in the control node and trusted worker
  memory, are never brokered to nodes and are registered with the redactor.

#### 13.7 Delivery to run nodes

Unchanged path: the credential broker (ADR 0008 section 2) issues the values of exactly the
references a step declares, once per step and session, into node memory, and revokes the session at
step end (and dynamic leases through their handles). New checks before issuance: scope and usage
(13.1, 13.4, section 8), `allowedDestinations` against the step's egress and MCP URLs, secret not
revoked or expired. For HTTP MCP connections the relay of ADR 0016 S4 keeps header secrets in the
control node.

#### 13.8 Exfiltration

- An agent definition cannot read a value: it can only name references, and every new reference is
  visible in the review diff with its scope and destinations.
- A crafted definition could hand a secret to a tool that sends it elsewhere. Mitigations: the
  review (new references, egress and write tools are highlighted), `allowedDestinations` per secret,
  per-connection egress (ADR 0016), the policy gate, and the `ContextGuard` redacting registered
  values from tool results and model context.
- An MCP server that receives a secret is the trust boundary: it can do anything the credential
  allows. Least privilege on the credential itself (scoped tokens) remains the owner's job; the
  console says so when a secret is created.

#### 13.9 Rotation, revocation, audit

- Rotate creates a new version; new issuances use it; sessions already issued keep their value
  until the step ends (at most the session lifetime). Revoke blocks new issuances immediately and,
  with `revokeSessions: true`, revokes active sessions that received the secret.
- `expires_at` warns 14 and 3 days before (notification) and refuses issuance after.
- Audit: section 11; a secret's page lists its issuances (from `credential.issued`) for
  `secrets:read`.

#### 13.10 Migration from today

- Existing `OAX_SECRET_*` and secret-directory references keep working as the `env` backend; the
  tenant `secret_refs` globs keep governing them. Nothing changes for existing agents.
- New agents should use scoped references; Agent Check gains a lint `legacy_secret_ref` (advisory).
- An import helper creates `tenant` or `team` secrets that **point** at existing env names (no value
  copy) so agents can move to scoped references without touching operator configuration.
- Legacy tenant use of env references may be deprecated in a later minor release with a changelog
  entry; not part of this ADR.

### 14. Relation to existing plan items

- **W6-3 (#51)**: this ADR delivers the approval record bound to the source digest, the expansion
  digest and the policy digest. W6-3 extends the binding with the model configuration and the
  evaluation run id and adds staleness on a model or toolbox change. #51 stays open, depends on S3.
- **W7-2 (#54)**: run-time multi-step approvals reuse the rule module of S1 (A1, A2, A5, A8). New
  acceptance item for #54: "the requester and the agent's contributors never approve when the tenant
  enables `runtimeSelfApproval: never`".
- **W9-2 (#93)**: the review and publish flow of Git-managed agents uses the reviews of this ADR; host
  review as approval is slice S9.
- **W5-3 (#45)**: implemented by S6 (#249, Vault) and S7 (#250, AWS SM); #45 becomes the umbrella and is closed
  when both are merged.
- **ADR 0016 S5 (#235)**: the key service is shared; whichever slice lands first builds it, the
  other reuses it.

### 15. Threat model

| # | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| G1 | **Self-approval** by the author, through a second role, a token or as platform admin | A1/A2 on user id, applied to every role including platform admins; contributors include every revision author since the base and the opener | a human with two accounts the platform cannot link (G3) |
| G2 | **Collusion** of two eligible people | `minApprovals` up to 5, `other-team` scope, path rules requiring a security team, full audit with reviewer identity, notifications to tenant admins | two colluding approvers can publish; this is the limit of four-eyes and is documented |
| G3 | **Sock-puppet account** (local account next to an IdP account) | `approverIdentitySources` (exclude `local`), A4 (binding not granted by a contributor, minimum age), creation of users and bindings audited | an IdP admin who creates a second IdP identity |
| G4 | **Role-grant bypass**: author grants approver role to an accomplice or to their own second account just before approving | A4 `granted_by` not a contributor, optional minimum binding age, ADR 0014 no-self-grant; re-check at publish | an admin who is not a contributor grants the role (collusion, G2) |
| G5 | **Replay of an approval** onto other content or another agent | approval binds review, revision, digest, expansion digest, policy digest, agent; publish compares inside a transaction; approvals expire | none known |
| G6 | **TOCTOU**: draft changed between approval and publish, or profiles widened in the catalog | publish uses the revision source, compares digests under row lock, recomputes the expansion digest; any new revision dismisses approvals | none known |
| G7 | **Policy downgrade** to slip a publish through | policy writes need `settings:write`, are narrowing-only below ancestors, audited and notified; approvals carry the policy digest; a stricter policy re-checks; a looser one requires `settings:write` on the node, which tenant admins hold by design (audited) | a tenant admin can loosen the own node's policy within the ancestors' bounds |
| G8 | **Break-glass abuse** | off by default, admin only, reason, notification, ratification by a second person or automatic disable | a short window of unreviewed production (at most `breakGlassRatifyHours`) |
| G9 | **Personal secret leakage into production** | publish refuses personal references by default; `with-approval` needs an extra admin approval, a flag and a badge; personal secrets usable only in runs started by their owner | with `with-approval`, runs act with a person's credential (documented, flagged) |
| G10 | **Confused deputy**: a reviewer's test run, a schedule or another user's run uses the author's personal secret | personal references resolve against the run's starter; draft runs are manual only | none known |
| G11 | **Secret exfiltration via a crafted agent definition** | references visible in the review; `allowedDestinations`; per-connection egress; policy gate; redaction | a tool that is allowed to reach a destination can misuse the credential there |
| G12 | **Malicious MCP server** receiving a secret | ADR 0016 egress per connection, tool pinning, relay keeps HTTP header secrets in the control node | the server can use the credential within its scope |
| G13 | **Reading secret values** through API, logs, telemetry, audit, errors | no read API, values only on create/rotate, redaction, audit with names only, telemetry allowlist (ADR 0015) | operators with database and KEK access (separation needs tenant KMS keys or tenant-owned backends) |
| G14 | **Vault token or AWS credential theft** | short TTLs, never brokered to nodes, kept in trusted memory only, response-wrapped AppRole secret id, Kubernetes auth preferred, revocation on shutdown, per-tenant role with `ExternalId` | compromise of the control node process |
| G15 | **Cross-tenant confused deputy** on a shared backend (tenant A points at tenant B's Vault path or ARN) | per-tenant path template or ARN prefix enforced at save and issue; AAD binds ciphertexts to tenant and name; tenant-owned backend connections | misconfigured operator template (validated at start) |
| G16 | **Comment content abuse** (stored XSS, prompt injection, personal data) | Markdown subset rendered without HTML, comments never sent to a model, length limits, retention and erasure apply | none known |
| G17 | **Denial of service** by review spam or forced re-reviews | one open review per agent, rate limits on decisions and comments, notification batching | none known |
| G18 | **Downgrade via `owner` or `labels.useCase` edits** to escape team scoping or `production-only` | team scoping uses the stored `team_id`; `production-only` uses the union of base and draft use case; owner and use-case changes highlighted | none known |

### 16. Test plan

- **Unit (core)**: rule module A1 to A10 with a table of principals (author, co-author, opener, admin
  author, platform admin author, token, repo actor, guest, local vs OIDC, binding granted by a
  contributor, too-young binding); policy resolver narrowing (each key, `not_narrowing`), union of
  production use cases; digest and expansion digest stability.
- **API**: full state machine; every refusal code; publish TOCTOU (concurrent draft save during
  publish, expansion change between approval and publish, policy tightened after approval, approval
  expired, binding revoked after approval); break-glass ratification and automatic disable;
  deprecation refusal; dev runs (manual only, dev budget hard stop, `stage` on costs and audit).
- **Secrets**: no endpoint returns a value (route-table test over the OpenAPI document); AAD swap
  refused; KEK and DEK rotation with mixed rows; crypto-shredding; personal secret refused at publish,
  in a reviewer's run and in a scheduled run; `allowedDestinations` refusal; scope resolution without
  fallback; leak canaries (a canary secret never appears in logs, audit, telemetry, step outputs,
  error bodies, model context).
- **Backends**: Vault and AWS SM against fakes (HTTP fakes with recorded API shapes, no real
  accounts in CI); lease revocation at step end; failure codes; path/ARN prefix enforcement; token
  renewal and expiry. An optional integration job against a local Vault dev container (pinned image)
  is allowed only as a manual workflow.
- **UI**: badges, decision bar eligibility texts, outdated threads, i18n en/de, accessibility of the
  diff comments (keyboard, screen reader labels).
- **Audit**: every event of section 11 present, chain verifies, no values or comment texts.
- Coverage of new modules >= 80 %, OpenAPI drift check green.

### 17. Slices

Each slice is one PR for a Sonnet agent; security-review points are checked by an Opus reviewer
before merge; every slice adds its tests, keeps `pnpm test` and the OpenAPI drift check green and
adds its `[Unreleased]` changelog line.

| # | Slice | Content | Depends on | Security review |
| --- | --- | --- | --- | --- |
| S1 (#244) | Lifecycle policy, revisions, reviews and approval records (API only, not enforced) | `agent_draft_revisions`, `agent_reviews`, `agent_review_decisions`; `tenants.settings` (or reuse W13-2) and the lifecycle policy resolver; rule module A1 to A8; permissions `agents:review`, `agents:approve`; endpoints to open, decide, withdraw; binding of digest, expansion digest and policy digest; publish reports "would be refused" in the response and audit (shadow mode) | – | yes: A1/A2 cannot be bypassed by role, token or platform admin; binding fields complete |
| S2 (#245) | Comment threads and review UI | threads and comments API, outdated anchors, Review tab, decision bar, status badges, inbox `GET /v1/me/reviews`, i18n en/de | S1 | yes: rendering without HTML; comment content out of audit and model context |
| S3 (#246) | Enforcement at publish, break-glass, deprecation, audit | publish with `reviewId` and `expectedDigest` under row lock, re-checks of section 4.3, break-glass with ratification and automatic disable, version deprecation, audit events of section 11 | S1 | yes: TOCTOU tests; no publish path without approval when required |
| S4 (#247) | Secret scopes and encrypted store | key service (shared with ADR 0016 S5 #235), `secrets` table, scoped references in `agents.md`, secrets API without read, broker checks (scope, usage, destinations, revoked), rotation and revocation, leak canaries, migration helper for env pointers | – (coordinates with #235) | yes: no plaintext at rest, AAD binding, no value in any response |
| S5 (#248) | Personal secrets and development runs | personal scope rules, draft runs of a revision (manual only, dev budget, `stage`), `allowDraftRuns`, `allowProductionSecretsInDraftRuns`, publish refusal and `with-approval` flag path | S3, S4 | yes: confused-deputy tests; personal secret never in a published version by default |
| S6 (#249) | HashiCorp Vault backend | `vault` backend connection, KV v2 and dynamic secrets with leases, AppRole/Kubernetes/JWT auth, per-tenant path template, dispatcher purpose `secrets`, fakes | S4 | yes: tokens never to nodes; lease revocation; path scope |
| S7 (#250) | AWS Secrets Manager backend | `aws-sm` backend connection, IRSA and per-tenant `AssumeRole` with `ExternalId`, ARN prefix enforcement, version stages, fakes | S4 | yes: cross-tenant ARN refusal; no credentials to nodes |
| S8 (#251) | Notifications and path rules | `pathRules` (field-based CODEOWNERS), `approverScope: other-team`, notifications for review events through existing or W2-5/W3-1 channels | S3 | yes: rules evaluated on the semantic diff, not text lines |
| S9 (#252) | Git-sync mapping | Git candidates as revisions, verified identity links to host accounts, host review as approval under section 12, optional version tag push | S3, W9-2-4 (#93) | yes: no approval from an unverified host account; attestation never counts |

### 18. Roadmap mapping

- Add to `ROADMAP.md` under v0.4 ("Agent lifecycle"): **W14 Agent lifecycle governance: four-eyes
  publish approval with review comments, development vs published, scoped and encrypted secrets
  with Vault and AWS Secrets Manager** (design: this ADR, issues #244 to #252).
- W7-2 (#54): add "uses the shared approval rule module of ADR 0017; requester and contributors never
  approve when enabled".
- W6-3 (#51): add "builds on ADR 0017 approval records (digest, expansion, policy)".
- W9-2 (#93): add "publish of Git-managed agents goes through ADR 0017 reviews; host review as
  approval is ADR 0017 S9".
- W5-3 (#45): "implemented by ADR 0017 S6 and S7".
- `docs/IMPLEMENTATION-PLAN.md` gets the W14 rows when the first slice starts.

### 19. Website wording (planned)

For openagentix.si (features/security/lifecycle pages) and `ROADMAP.md`. Status badge: **Planned**
until S3 (approval) and S4 (secrets) are released; then "Available in vX.Y" per part. The text must
not claim more than the code does.

**English**

> **Four-eyes publishing for agents** *(planned)*
> Agents are developed as drafts and only reach production when they are published. With the
> four-eyes policy enabled for a tenant, publishing needs the approval of another person: reviewers
> see the exact changes to `agents.md`, comment on single lines, and approve, request changes or
> reject, much like a pull-request review. The approval is bound to the exact content; any later
> edit needs a new approval. Every published version carries its version number, a content digest
> and who approved it in the audit trail. Edits never touch production until the next approved
> publish.
>
> **Credentials like in a CI server, encrypted** *(planned)*
> Store tokens and secrets per team or tenant, encrypted with a key per tenant, and reference them
> by name in agents. Values can be used by runs but never read back. Personal tokens are possible
> for development and stay out of published agents unless the tenant policy explicitly allows it.
> HashiCorp Vault and AWS Secrets Manager are planned as alternative secret backends.
>
> Today: agents have drafts and immutable published versions, and secrets come from the operator's
> environment or mounted files. Review, approval and the encrypted secret store are not built yet.

**Deutsch**

> **Vier-Augen-Prinzip beim Veröffentlichen von Agenten** *(geplant)*
> Agenten werden als Entwurf entwickelt und gehen erst mit der Veröffentlichung in Produktion. Ist
> das Vier-Augen-Prinzip für einen Mandanten aktiv, muss eine andere Person die Veröffentlichung
> freigeben: Prüfer sehen die genauen Änderungen an `agents.md`, kommentieren einzelne Zeilen und
> geben frei, fordern Änderungen an oder lehnen ab, ähnlich einem Pull-Request-Review. Die Freigabe
> gilt genau für diesen Inhalt; jede spätere Änderung braucht eine neue Freigabe. Jede
> veröffentlichte Version trägt ihre Versionsnummer, einen Inhalts-Hash und im Audit-Trail, wer sie
> freigegeben hat. Änderungen wirken erst nach der nächsten freigegebenen Veröffentlichung auf die
> Produktion.
>
> **Zugangsdaten wie in einem CI-Server, verschlüsselt** *(geplant)*
> Tokens und Secrets werden je Team oder Mandant verschlüsselt gespeichert (eigener Schlüssel je
> Mandant) und in Agenten nur über ihren Namen referenziert. Läufe können sie nutzen, auslesen kann
> sie niemand. Persönliche Tokens sind für die Entwicklung möglich und bleiben aus veröffentlichten
> Agenten heraus, solange die Mandanten-Richtlinie das nicht ausdrücklich erlaubt. HashiCorp Vault
> und AWS Secrets Manager sind als alternative Secret-Speicher geplant.
>
> Heute: Agenten haben Entwürfe und unveränderliche veröffentlichte Versionen; Secrets kommen aus
> der Umgebung oder eingebundenen Dateien des Betreibers. Review, Freigabe und der verschlüsselte
> Secret-Speicher sind noch nicht gebaut.

**ROADMAP.md line** (v0.4): "- [ ] **Agent lifecycle governance: four-eyes publish approval with
review comments, development vs published, scoped and encrypted secrets, Vault and AWS Secrets
Manager backends** (W14, design: [ADR 0017](docs/adr/0017-agent-lifecycle-governance.md), issues
#244 to #252) – *As a company with several departments, I want every agent version approved by another
person before it reaches production, and credentials kept per team or tenant, encrypted and never
readable, so that agents follow the same four-eyes rules as our software.*"

## Consequences

- Positive: publishing becomes a controlled, attributable act; approvals are cryptographically tied
  to the content and the policy; the same rule module hardens run-time approvals (W7-2) and version
  approvals (W6-3).
- Positive: secrets move from operator-only environment variables to a scoped, encrypted,
  auditable store with external backends, which is the prerequisite for tenant-owned keys (v1.0).
- Positive: development runs with real tools become possible without touching production budgets or
  credentials.
- Negative: single-person installations cannot use four-eyes (default `off` in single-tenant mode);
  small teams may find a required second person slow (break-glass and `production-only` help).
- Negative: the first stored secret values and keys bring key-management duties (KEK backup,
  rotation) to operators; documented in `docs/configuration.md`.
- Negative: more tables and states in the agent registry; the review page and its comments are
  tenant content subject to retention and erasure.

## Alternatives considered

- **Approval only in the Git host** (PR reviews): rejected as the only path because the platform
  cannot verify who approved, many users build agents in the console, and a tenant policy must be
  enforced by the platform. Kept as an opt-in mapping (S9).
- **Approval as a run-time approval of a "publish" tool call**: rejected; run-time approvals have no
  diff, no threads, and their approver roles come from the agent itself.
- **Approval bound to the agent and version number only**: rejected (replay and TOCTOU, G5, G6).
- **Mutable published versions with a "promote" flag**: rejected; immutability of versions is an
  existing guarantee.
- **Secrets readable by their creator** (convenience): rejected; use-only is the Jenkins-credentials
  model the owner asked for and removes a whole class of leaks.
- **External secret managers only, no internal store**: rejected; small installations need a
  built-in encrypted store; external backends are pointers on top.
- **Implicit scope fallback** (personal -> team -> tenant): rejected; shadowing makes it unclear
  which credential a production run uses and enables confused-deputy attacks.

## Open questions (owner decisions needed)

1. **Default of `requireApprovalForPublish` for new tenants.** Recommendation: `on` in multi-tenant
   mode, `off` in single-tenant mode (one person cannot do four-eyes), with a console hint.
2. **Default approver roles.** Recommendation: `admin` and `agent-engineer` (peer review among
   engineers); `operator` only when a tenant adds it.
3. **Default and maximum `minApprovals`.** Recommendation: default 1, maximum 5; recommend 2 for
   production use cases in the documentation.
4. **Approval expiry.** Recommendation: 7 days (168 hours), maximum 30 days.
5. **Who presses "publish" after approval.** Recommendation: anyone with `agents:publish`, including
   the author (`publishBy: any-publisher`); tenants can require `approver-only`.
6. **Approvals with API tokens.** Recommendation: not allowed by default (`allowTokenApprovals:
   false`); a decision should be a human, interactive act.
7. **Platform admins as approvers.** Recommendation: allowed as distinct persons with the same rules
   (never on their own work), audited; no exception from self-approval.
8. **Personal secrets in published agents.** Recommendation: `never` by default; `with-approval`
   available per tenant with an extra admin approval, a visible flag and fail-closed behaviour when
   the owner leaves.
9. **Development runs with real tools.** Recommendation: allowed with development-marked credentials
   and a separate development budget (`allowDraftRuns: development-credentials`), manual only;
   default development budget 10 % of the tenant's monthly cap until an admin sets one.
10. **Git host reviews counted as approval.** Recommendation: not in the first release; later (S9)
    only with the host extension, verified identity links and the same rules; an attestation never
    counts.
11. **Break-glass.** Recommendation: off by default; when on, admin only, ratification by a second
    eligible person within 24 hours, otherwise the agent is disabled automatically.
12. **"Rejected" and "Changes requested" as separate outcomes.** Recommendation: keep both (changes
    requested keeps the review open; rejected closes it), as in pull-request reviews.
13. **First Vault auth methods.** Recommendation: Kubernetes auth and AppRole (response-wrapped
    secret id) first, JWT/OIDC next; dynamic secrets in the same slice because the broker already
    revokes handles.
14. **Operator-wide vs tenant-owned secret backends.** Recommendation: both; operator-wide backends
    with an enforced per-tenant path or ARN prefix, and tenant-owned backend connections for
    separation from operators (ADR 0012 7.7).
15. **Inheritance of tenant secrets to sub-tenants.** Recommendation: node-only by default, opt-in
    `inherit: true` per secret.
16. **Caching of secret values.** Recommendation: none by default; at most 60 seconds per external
    backend connection when an operator opts in; never for dynamic secrets.
17. **Collusion.** Recommendation: accept as residual risk of four-eyes; offer `minApprovals: 2`,
    `other-team` scope and path rules for sensitive fields instead of heuristics.
18. **Minimum age of approver bindings.** Recommendation: default 0 (no friction), recommend 24 hours
    for production tenants in the documentation.
