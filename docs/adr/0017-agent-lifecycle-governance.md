# ADR 0017: Agent lifecycle governance: development vs published, four-eyes publish approval with review comments, agent rules, review via Git, scoped and inherited encrypted secrets, Vault and AWS Secrets Manager backends

- Status: Accepted (the owner answered all 18 open questions on 2026-10-10, see "Owner decisions
  (2026-10-10)"; four answers changed the design and are worked into the sections named there.
  The owner also answered the eight follow-up questions of the accepted version on 2026-10-10, see
  "Owner decisions on the follow-up questions (2026-10-10)"; one answer opened the separate design
  direction of [ADR 0018](0018-tenant-structure-as-code.md), which is Proposed).
  **Not implemented**: every slice is planned, nothing of this ADR is built (see "Implementation
  status" in section 17).
- Date: 2026-10-10
- Plan items: new wave W14 (this ADR, slices S1 to S13, issues #244 to #252 and #290 to #293);
  updates W6-3 (#51, version approval bound to digest, model, eval set and policy), W7-2 (#54,
  multi-step approval workflows), W9-2 (#93, review and publish flow of Git-managed agents), W5-3
  (#45, secret managers), W5-1 (#43, SCIM and tenant-scoped identity providers), W6-5 (#52,
  lifecycle console); follow-up decision F5 opened [ADR 0018](0018-tenant-structure-as-code.md)
  (Proposed, design issue #296)
- Builds on: [ADR 0002](0002-audit-hash-chain.md) (audit chain),
  [ADR 0008](0008-agents-md-data-flow-and-isolation-contract.md) (per-step credentials, credential
  broker, run node), [ADR 0010](0010-agent-authoring-builder-and-git-sync.md) (builder, Git-synced
  agent repositories; Amendment 1: any Git host over plain Git),
  [ADR 0011](0011-outbound-network-proxies-and-private-endpoints.md) (resolver, trust store,
  client certificates), [ADR 0012](0012-connections-instances-scopes-and-data-protection.md)
  (connection scopes, per-tenant data keys, customer-managed keys),
  [ADR 0013](0013-hierarchical-tenants-and-setup-modes.md) (tenant tree, narrowing-only settings),
  [ADR 0014](0014-tenant-tree-role-inheritance.md) (role bindings, grant rules, acting node; the
  role-binding API of slices S1 to S4 exists on `main`),
  [ADR 0016](0016-mcp-egress-and-authorization.md) (per-connection egress, key service and token
  store, slice S5 #235)
- Amends: ADR 0010 section 7.4 (a Git candidate becomes a draft revision that goes through the
  review of this ADR; host review counts only under section 12.3) and section 6 (a binding may
  reference a tenant **Git integration** and, for review via Git, carries a development and a
  publish branch, section 12.2); ADR 0011 section 3 (tenant-supplied CA bundles and client
  certificates, for Git integrations only, section 12.2); ADR 0014 sections 1 and 4 (two new fixed
  roles `agent-developer` and `agent-maintainer`, a third binding source `directory`, section 5)
- External references (read as reference data only): HashiCorp Vault documentation (KV secrets
  engine version 2, leases and revocation, AppRole, Kubernetes and JWT/OIDC auth methods, response
  wrapping); AWS Secrets Manager API reference (`GetSecretValue`, version stages) and AWS KMS
  envelope encryption; NIST SP 800-57 part 1 (key management); Jenkins folder-scoped credentials
  (inheritance model); protected branches and rulesets of common Git hosts (rule model);
  Microsoft Entra ID group claims and LDAP `memberOf` (directory group sources); SCIM 2.0 (RFC
  7643/7644).

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

### Owner decisions (2026-10-10)

The first version of this ADR ended with 18 open questions, each with a recommendation. The owner
answered all of them on 2026-10-10. Fourteen recommendations were adopted unchanged; questions 2,
15 and 17 were changed, and questions 11 and 18 were answered "no". The answers are binding for
this ADR and are worked into the sections named below.

| # | Question | Decision | Where |
| --- | --- | --- | --- |
| 1 | Default of `requireApprovalForPublish` | **Adopted**: `on` in multi-tenant mode, `off` in single-tenant mode, with a console hint | 6 |
| 2 | Default approver roles | **Changed**: approver roles are modelled on code hosting's developer and maintainer roles: two new fixed roles **Agent Developer** (`agent-developer`) and **Agent Maintainer** (`agent-maintainer`). Groups of LDAP, Active Directory, Entra ID and similar directories must be **mappable to these roles, also per tenant node** (group claims or SCIM-style provisioning mapped to role bindings) | 5.2, 5.3, 6 |
| 3 | Default and maximum `minApprovals` | **Adopted**: default 1, maximum 5; the documentation recommends 2 for production use cases | 6, 7 |
| 4 | Approval expiry | **Adopted**: 7 days (168 hours), maximum 30 days | 6 |
| 5 | Who presses "publish" after approval | **Adopted**: anyone with `agents:publish`, including the author (`publishBy: any-publisher`); tenants can require `approver-only` | 6 |
| 6 | Approvals with API tokens | **Adopted**: not allowed by default (`allowTokenApprovals: false`) | 5.1 A5, 6 |
| 7 | Platform admins as approvers | **Adopted**: allowed as distinct persons under the same rules, never on their own work, audited | 5.1 A1 |
| 8 | Personal secrets in published agents | **Adopted**: `never` by default; `with-approval` per tenant with an extra admin approval, a visible flag and fail-closed behaviour when the owner leaves | 13.5 |
| 9 | Development runs with real tools | **Adopted**: `allowDraftRuns: development-credentials`, manual only, separate development budget, default 10 % of the node's monthly cap until an admin sets one | 8 |
| 10 | Git host reviews counted as approval | **Adopted**: not in the first release; later (S9) only with the host extension, verified identity links and the same rules; an attestation never counts | 12.3 |
| 11 | Break-glass publish | **No**: there is **no break-glass at all**. No role, setting or endpoint publishes without the required approvals; incidents are handled by disabling, cancelling and rolling back to an approved version | 1, 3.1 |
| 12 | "Rejected" and "Changes requested" as separate outcomes | **Adopted**: both kept, as in pull-request reviews | 3 |
| 13 | First Vault auth methods | **Adopted**: Kubernetes auth and AppRole (response-wrapped secret id) first, JWT/OIDC next; dynamic secrets in the same slice | 13.7, S6 |
| 14 | Operator-wide vs tenant-owned secret backends | **Adopted**: both | 13.7 |
| 15 | Inheritance of tenant secrets to sub-tenants | **Changed**: tenant secrets **inherit top-down** to all descendant nodes by default, like Jenkins folder credentials; a lower node may override (shadow) a name unless the owner forbids it, and may block inherited names for its subtree; a secret can be kept node-only | 13.3 |
| 16 | Caching of secret values | **Adopted**: none by default; at most 60 seconds per external backend connection on operator opt-in; never for dynamic secrets | 13.7 |
| 17 | Collusion | **Changed**: instead of only accepting collusion as the limit, tenants define **agent rules** like protected branches (per agent or name pattern: minimum number of other approvers, required roles or teams, field path rules, required checks), plus a general **Git integration per tenant** that a use case or team selects for **review via Git** (development branch, publish branch, branch names free; the tenant admin supplies repository, token or deploy key and optional certificates), reusing "any Git host over plain Git" (ADR 0010 Amendment 1) | 7, 12.2 |
| 18 | Minimum age of approver bindings | **No**: there is no minimum age for approver bindings; approvers are assumed to be experienced people (for example an agent architect) | 5.1 A4 |

Note on question 17: the owner's request refers to the "Git as protocol" decision of 2026-10-04.
That decision is recorded in ADR 0010 Amendment 1 (HTTPS with a token, SSH with a deploy key, no
host-specific API in the core, optional host extensions; ADR 0012 section 7.4 supplies the
credential rules); section 12.2 builds on it and adds no host API.

### Owner decisions on the follow-up questions (2026-10-10)

The accepted version listed eight remaining questions. The owner answered them on 2026-10-10.
Questions 1, 3, 4, 6, 7 and 8 adopt the recommendation (question 7 with a narrow relaxation),
question 2 overrides it, and question 5 is replaced by a new design direction that is recorded
separately and is **not** decided in this ADR. Like everything in this ADR, these outcomes are
**planned**; none of them is built.

| # | Question | Decision | Where |
| --- | --- | --- | --- |
| F1 | Agent Developers as approvers by default | **Adopted**: Agent Developers are **not** approvers by default; the default approver roles are `agent-maintainer` and `admin`. A tenant can widen eligibility for its agents with agent rules (`requireFrom`) or by adding `agent-developer` to `allowedApproverRoles` | 5.2, 6, 7 |
| F2 | The `agent-engineer` alias | **Overrides the recommendation**: there is **no alias**. The project is before 1.0, so breaking changes are acceptable: `agent-engineer` is renamed to `agent-maintainer` outright in S10 (#290). The same migration rewrites every existing `agent-engineer` binding (`users.global_roles` and its mirror rows, explicit node bindings, team and agent bindings) to `agent-maintainer`. The role value `agent-engineer` in the installation-wide group mapping (`OAX_*_ROLE_MAPPING`) is configuration, not data: it is refused at start with an error that names `agent-maintainer`. The CHANGELOG entry of S10 is marked **Breaking** | 5.2, 10, 17 |
| F3 | Directory groups | **Adopted**: v1 has **no nested-group expansion** (direct membership only, as delivered by the groups claim or the LDAP group attribute) and **no Entra ID overage lookup** through the directory API; both are documented limits. Directory bindings are re-evaluated at **login and at token refresh**; a directory binding counts for an approval only when it was verified at most **15 minutes** earlier. SCIM comes later with #43 | 5.3, 17 |
| F4 | Override default for top-level secrets | **Adopted**: tenant secrets owned by a **root** node default to `allowOverride: false`; secrets on lower nodes keep `allowOverride: true` as default | 13.1, 13.3 |
| F5 | Git integrations across the tree | **Replaced by a new direction**: instead of deciding whether descendants may select an ancestor's integration, the owner proposes **tenant structure as code**: a repository may carry a tenant structure, and that tenant and its sub-tenants are then built from it (tenant tree, role bindings and groups, agents, Git integrations, secret references declared in the repository and reconciled into the platform). This is recorded as [ADR 0018](0018-tenant-structure-as-code.md) (**Proposed**, design issue #296, not accepted in detail, not built). Until ADR 0018 is decided, integrations of this ADR stay node-local as designed | 12.2 |
| F6 | Default of `OAX_GIT_TENANT_TRUST` | **Adopted**: tenant-supplied trust is available by default and **strict**: the bundle and client certificate are used only for the integration's host and port, verification failures fail closed, and there is no switch to disable verification. Together with F7 the trust in a review via Git is fail-closed end to end: contributors come only from commits signed by keys linked to platform users | 12.2 |
| F7 | Signed commits for review via Git | **Adopted**: signed commits by keys linked to platform users are **required** whenever an approval is required. A relaxation exists only for **non-production** use cases, through the tenant policy key `gitUnsignedContributors`, and every use writes an audit entry and shows a warning on the review | 6, 12.2 |
| F8 | Agent rules by maintainers | **Adopted**: `agent-maintainer` may add rules and tighten requirements; loosening or deleting a rule is **admin only** and writes an audit entry | 7 |

### What exists on `main` (verified 2026-10-10)

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
author, or whether the reviewer may approve under a tenant policy. A binding watches **one**
branch; there is no notion of a development branch and a publish branch.

**Roles, tenants and directory groups** (ADR 0013, ADR 0014; `apps/api/src/db/schema.ts`,
`apps/api/src/config.ts`, `apps/api/src/services/identity.ts`):

- Fixed roles: `admin`, `agent-engineer`, `integrator`, `operator`, `auditor`, `viewer` (grantable,
  `GRANTABLE_ROLES`) and `pentest` (not grantable before ADR 0014 S6). The role set is fixed; there
  are no custom roles and no roles named "developer" or "maintainer".
- Bindings per tenant node (`tenant_role_bindings` with `granted_by`, `expires_at`, `inherit` and
  `source = mirror | grant`), per team (`team_members`) and per agent (`agent_role_bindings`). The
  **role-binding API** of ADR 0014 S4 exists (`GET/POST /v1/tenants/{id}/role-bindings`,
  `PATCH/DELETE .../{bindingId}`, grant rules 1 to 9, audit). Grant rules forbid self-grant
  **except for platform admins** (ADR 0014 section 7 rule 6). Role restrictions per node can remove
  permissions (ADR 0013 7.3; table exists, unused until ADR 0014 S9).
- **Directory groups** are mapped **installation-wide** only: `OAX_OIDC_ROLE_MAPPING` and
  `OAX_LDAP_ROLE_MAPPING` (groups claim `OAX_OIDC_GROUPS_CLAIM`, LDAP attribute
  `OAX_LDAP_GROUP_ATTRIBUTE`, default `memberOf`) map a group to `role` or `role@team-slug`
  (`mapGroupsToBindings`). At every login `upsertExternalUser` replaces the user's `global_roles`
  (and therefore the mirror rows on the home node) and team memberships from that mapping;
  external users land in the default tenant. There is no per-node mapping, no SCIM (W5-1 #43 is
  open) and no tenant-scoped identity provider.
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
- There are **no personal, team or tenant secret scopes**, no inheritance of secrets down the
  tenant tree, no secret API, no Vault or AWS Secrets Manager backend (W5-3 #45 open), no
  per-tenant data keys (ADR 0012 W12-2 open). ADR 0012 7.7 and the owner decision of 2026-10-04
  require tenant-owned keys (KMS) for v1.0.
- Tenants cannot upload CA bundles or client keys (ADR 0011 section 3: client certificates are
  named from the platform configuration).

**Audit**: one global hash chain with Ed25519 checkpoints (ADR 0002); per-tenant chains are W7-1.

### Gaps against the requirements

| Requirement | Today | Gap |
| --- | --- | --- |
| In development vs published | draft + immutable versions | draft has no revisions and no authors; no status beyond "draft differs" |
| Another person approves | author self-publishes | no approval record, no distinct-person rule, no tenant policy, no agent rules |
| Developer and maintainer roles, directory groups per tenant | six fixed roles, installation-wide group mapping | no developer/maintainer roles, no per-node mapping |
| Reject with comments | none | no review, no threads |
| Version tag | `version` + `digest`, immutable | no link to who approved what; no tag in Git |
| Edits only in development | draft is separate from versions | already true; must stay true for reviews too |
| Review via Git (development and publish branch) | designed single-branch sync, not built | no branch roles, no link between a Git merge and a platform approval |
| Personal tokens, policy | none | no personal scope, no policy |
| Team/tenant secrets, encrypted, inherited like Jenkins | operator env/files only | no store, no encryption, no inheritance |
| Vault / AWS SM | none | W5-3 #45 open |

## Decision

### 1. Principles

1. **Published means approved.** When the tenant policy or an agent rule requires it, a version
   can only come into existence from a draft revision whose exact content was approved by enough
   eligible people who are not its authors. **There is no path around this**: no break-glass, no
   bypass list, no emergency role (owner decision 11). This holds for platform admins as well.
2. **The approval binds to bytes, not to an agent.** It names the digest of one immutable draft
   revision, the digest of the expanded grants, the digest of the secret resolution and the digest
   of the policy snapshot (tenant policy plus matching agent rules) it was given under. Any change
   to any of them makes it stale.
3. **Nobody approves their own work**, in no role, through no token, impersonation or second
   account that the platform can recognise. This rule is not configurable.
4. **Making things safer never needs approval** (disable an agent, deprecate a version and roll
   back to an earlier approved version, revoke a secret, cancel runs); making things reachable does
   (publish).
5. **Secrets are use-only.** After creation a value is never readable through any API, by anyone,
   including its creator. Agents reference secrets by name and scope, never by value.
6. **Policy is tenant-owned and only gets stricter down the tree** (ADR 0013 section 3). Tenant
   policy and agent rules of ancestors apply to the subtree; nothing in `agents.md` can loosen
   them; the agent's own `approvals.approverRoles` keep governing run-time tool approvals only.
7. **Roles come from the platform, membership may come from the directory.** Approver eligibility
   is expressed with fixed roles and teams; LDAP, Active Directory, Entra ID and similar directories
   feed role bindings through mappings, never decisions directly.
8. **Git is a transport, not an authority.** Review via Git uses plain Git (ADR 0010 Amendment 1);
   a merge in a Git host publishes only content whose digest the platform has approved (section
   12.2), unless the separate, stricter host-review path of section 12.3 is configured.
9. **Reuse, don't fork**: the key service is the one of ADR 0016 S5 (#235); the approval rule engine
   is shared with run-time approvals (W7-2) and version approvals (W6-3); role bindings are the ones
   of ADR 0014.

### 2. Terms

| Term | Meaning |
| --- | --- |
| Draft revision | Immutable snapshot of the draft: `source`, `digest`, `author`, `parent` revision, `created_at`. Every save (console, API or Git sync) creates one; the agent's draft is a pointer to the newest. |
| Base version | The published version the review compares against (the latest published version when the review was opened, or none). |
| Contributors | Every author of a revision after the base version up to the reviewed revision, plus the user who opened the review. For Git-managed agents also the platform users linked to the signing keys of the commits (section 12.2) and, with section 12.3, the mapped commit authors and committers. |
| Review | The equivalent of a pull request: one per agent at a time, follows the draft, has a status, comment threads and decisions. |
| Decision | `approve`, `request_changes` or `reject` by one reviewer on one revision. |
| Approval record | A valid `approve` decision with its bindings (section 4.2). |
| Agent rule | A tenant-owned rule, like a protected-branch rule, that matches agents by name pattern, team, use case or labels and adds requirements to their reviews (section 7). |
| Policy snapshot | The effective lifecycle policy of the agent's node and the agent rules matching the agent at the time the review was opened, canonical JSON, with its digest. |
| Secret resolution | For every secret reference of a revision: the scope, the owning node and the secret id it resolves to (section 13.3), with its digest. |
| Git integration | A tenant-owned connection to one Git repository (URL, credential, host keys, optional CA bundle and client certificate) that bindings of teams or use cases select (section 12.2). |
| Review via Git | A binding mode where a development branch feeds draft revisions and a publish branch publishes approved content (section 12.2). |
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
          |   approvals valid, policy unchanged)     v (enough valid approvals, all agent rules met)
          +------------------------------------- Approved
                                                    | any new revision / expiry / policy, rule or
                                                    v secret-resolution change
                                              Review requested (stale approvals listed)

   Published version vN:   active --(deprecate)--> deprecated      (no new runs; deprecating the
                                                                    latest rolls back, 3.1)
   Agent (A7, exists):     enabled <--(disable/enable)--> disabled (no new runs at all)
```

| From | Event | To | Who | Notes |
| --- | --- | --- | --- | --- |
| Published (no open review) | draft saved with a different digest | In development | `agents:write` | creates a revision; production keeps running vN |
| In development | open review | Review requested | `agents:write` on the agent | computes and stores digest, expansion digest, secret resolution digest, policy snapshot, required approvals; notifies eligible reviewers |
| Review requested | `request_changes` with at least one comment | Changes requested | eligible reviewer | blocks publish until that reviewer approves a later revision or the request is dismissed |
| Review requested, Changes requested, Approved | new revision saved | Review requested | `agents:write` | every approval and every `request_changes` on older revisions becomes **stale** (shown, not counted); threads stay, anchored to their revision and marked "outdated" where the line changed |
| Review requested | enough valid approvals and every matching agent rule satisfied | Approved | system | computed, never stored as a free flag |
| Approved | approval expiry, policy or rule change that makes an approval ineligible, expansion or secret-resolution change | Review requested | system | reason listed per approval |
| Approved | publish | Published | `agents:publish` (author or approver; policy `publishBy`, rule `restrictPublishers`) | section 4.3 checks inside one transaction |
| Approved (review via Git) | the publish branch carries the approved digest | Published | system as `repo:<bindingId>` | section 12.2; the same checks of section 4.3 |
| any open state | `reject` with a comment | Rejected | eligible reviewer | closes the review; the draft stays; a new review starts from scratch |
| any open state | withdraw | In development | the review opener or an admin | audited |
| Published version | deprecate | deprecated | `agents:publish` | refuses new runs pinned to that version (`409 version_deprecated`); deprecating the latest version is a rollback (section 3.1) |
| Agent | disable / enable (A7) | disabled / enabled | `agents:publish` | unchanged |

When `requireApprovalForPublish` is `off` for an agent and no agent rule matches it, the review is
optional: publish behaves as today, and an open review is shown as advisory.

#### 3.1 Incidents without break-glass

The owner decided against any break-glass publish (decision 11). Incidents are handled only with
actions that reduce reachability (principle 4) and with the normal review:

- **Disable** the agent (A7, exists): no new runs at all.
- **Cancel** queued and running runs (exists).
- **Roll back** by deprecating the latest version: new runs use the newest non-deprecated version.
  The target must have been published with approval records valid at its publish when approval is
  required for the agent today (`409 rollback_target_unapproved` otherwise; then the agent must be
  disabled). A rollback creates no version, needs no approval and is audited
  (`agent.version.deprecated { rollbackTo }`).
- **Fix forward** through a normal review. Reviews can be fast (an eligible reviewer approves the
  exact digest); agent rules cannot be skipped. The console says so on the publish dialog and in
  the documentation.

The decision concerns publishing agents. The operator support access of ADR 0012 section 7.7
(time-boxed, audited content access for support, also called break-glass there) is a different
mechanism; it grants no publish rights and is not changed by this ADR.

### 4. Draft revisions and what an approval binds to

#### 4.1 Revisions

- Migration adds `agent_draft_revisions (id, agent_id, tenant_id, seq, digest, source, author_id,
  author_kind user|repo|system, parent_id, source_commit null, created_at)`, unique
  `(agent_id, seq)`. Every `create`/`updateDraft` (and a Git candidate, section 12) inserts a
  revision; `agents.draft_source` stays as a denormalised copy of the newest revision for
  compatibility; `agents.draft_revision_id` points to it. Saving identical content creates no
  revision.
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
| `resolution_digest` | digest of the secret resolution (scope, owning node and secret id per reference, section 13.3): the reviewer approves concrete credentials, not names that a lower node may shadow later |
| `base_version_id` | what the diff was computed against |
| `policy_digest` | digest of the policy snapshot (effective tenant policy and the matching agent rules) |
| `reviewer_id`, `reviewer_auth` (`session`, `token:<id>`), acting node, the binding ids that made the reviewer eligible and their `source` (`mirror`, `grant`, `directory`, team, agent) | for the re-check at publish and for audit |
| `satisfies` | the agent-rule requirements this approval counts for (section 7), recomputed at publish |
| `decided_at`, `expires_at` | expiry from `approvalExpiryHours` |

#### 4.3 Publish under approval (TOCTOU)

`POST /v1/agents/{id}/publish` gains `{ reviewId, expectedDigest }` (both required when approval
is required). In **one transaction** with `SELECT ... FOR UPDATE` on the agent row:

1. the agent's current draft revision digest equals the review's revision digest equals
   `expectedDigest` (else `409 draft_changed`); for review via Git, the digest of the file on the
   publish branch equals the review's revision digest (section 12.2);
2. the profile expansion is recomputed against the current catalog; its digest equals the approved
   `expansion_digest` (else `409 approval_stale { reason: expansion_changed }`);
3. the secret resolution is recomputed; its digest equals the approved `resolution_digest` (else
   `409 approval_stale { reason: secret_resolution_changed }`);
4. the current effective policy and the currently matching agent rules are evaluated; every counted
   approval is re-checked against them (eligibility, role bindings still present and not expired,
   not granted by a contributor, expiry, distinctness, rule requirements); at least the required
   number survive, every rule requirement is met and no unresolved `request_changes` exists (else
   `409 approval_insufficient` with reasons per approval and per rule);
5. the published version row is inserted from the **revision's** source (never from a value read
   earlier), with `review_id`, `revision_id`, `approved_by[]`, `policy_digest` and the secret
   resolution (section 13.3, pinned for production runs);
6. the review is closed as `published`; the audit entries of section 11 are appended in the same
   transaction or immediately after with the version id.

A change of the policy or of the rules that is **looser** than the snapshot does not invalidate
approvals; a stricter one re-checks them (step 4). The version rule (`checkPublish`) still applies.

### 5. Who may approve

#### 5.1 Rules

All rules are evaluated at decision time **and again at publish**:

| # | Rule | Configurable |
| --- | --- | --- |
| A1 | The reviewer is a user, not a contributor of the review (no author of any revision since the base version, not the opener, for Git-managed agents not a linked signer of a contributing commit nor, with section 12.3, a mapped commit author or committer). Applies to platform admins as well. | no |
| A2 | Approvals are counted per distinct user id; one user counts once towards `minApprovals`, whatever roles they hold. | no |
| A3 | The reviewer holds `agents:approve` on the agent through a binding whose role is in the effective `allowedApproverRoles` (or in a rule's `requireFrom`), with the binding covering the agent (tenant node binding with inheritance, team binding of the agent's team, or agent binding). Bindings of every source count: explicit grants, the `global_roles` mirror and directory mappings (section 5.3). | roles: yes (narrowing) |
| A4 | The qualifying binding was **not granted by a contributor** (`granted_by` not in contributors; for a directory binding: the creator of the mapping is not a contributor). Prevents an author with grant rights from creating an approver. There is **no minimum age** of the binding (owner decision 18). | no |
| A5 | Authentication: an interactive session (OIDC, LDAP or local). API tokens may approve only when `allowTokenApprovals` is true; non-human actors (`repo:*`, `node:*`, anonymous showcase guests, demo actors) never. | tokens: yes |
| A6 | Identity source: when `approverIdentitySources` is set (for example `[oidc, ldap]`), local accounts cannot approve. Reduces the "second local account" risk where a directory exists. | yes |
| A7 | Scope: `approverScope: tenant` (any eligible binding covering the agent, default) or `team` (only members of the agent's team or bindings on the agent) or `other-team` (eligible and **not** a member of the agent's team; separation between departments). | yes (policy and rules) |
| A8 | `minApprovals` distinct approvals (default 1, maximum 5; the effective value is the maximum of the tenant policy and every matching agent rule). | yes |
| A9 | Agent rules (section 7): every matching rule's requirements (required roles or teams, field path rules, required checks, resolved threads) are met. Field rules work on the semantic diff, so formatting cannot evade a rule. | yes |
| A10 | The reviewer can read the agent (`agents:read`), sees the full diff, the expansion and the secret resolution; a decision without having loaded the current revision is refused (`409 stale_view` via `expectedDigest`). | no |

Run-time approvals (W7-2) adopt A1 (requester and agent contributors never approve their run's tool
calls when the tenant enables it), A2, A5 and A8 through the same rule module
(`packages/core/src/approvals/rules.ts`).

Acting node and impersonation: a platform admin acting in a tenant (`X-OAX-Tenant`) decides as
themselves; A1 and A2 apply unchanged (owner decision 7). There is no "act as user" feature, and
this ADR adds none.

#### 5.2 Agent roles: Agent Developer and Agent Maintainer (owner decision 2)

Approver roles follow the developer and maintainer roles of code hosting. Two **fixed** roles are
added to the role set of ADR 0014 (the set stays fixed; this is not a custom-role feature):

| Role | Display name | Permissions (in addition to the read basics `agents:read`, `runs:read`, `events:read`, `costs:read`) | Typical use |
| --- | --- | --- | --- |
| `agent-developer` | Agent Developer | `agents:write`, `agents:review` (comment), `agents:approve` (eligible only where the tenant or a rule lists the role), `runs:execute` (published versions and development runs), `runs:cancel`, `sources:read`, `connections:read`, `policies:read`, `repos:read`, `repos:sync`, `secrets:read` (metadata), `tokens:read`, `tokens:write`; personal secrets of their own | builds and changes agents, opens reviews, comments, reviews peers when the tenant allows it |
| `agent-maintainer` | Agent Maintainer | everything of `agent-developer` plus `agents:publish`, `agents:approve` (eligible by default), `agents:rules` (create agent rules and add requirements, section 7) | approves and publishes, owns the rules for the agents of their team or node, like a maintainer who merges into a protected branch |

- **Default approvers** (`allowedApproverRoles`): `admin` and `agent-maintainer`; Agent Developers
  are **not** approvers by default (follow-up decision F1). A tenant can widen eligibility with an
  agent rule (`requireFrom` naming `agent-developer` or a team, section 7) or by adding
  `agent-developer` or `operator` to `allowedApproverRoles`, and can narrow the list; a rule can
  require a specific role or team.
- **`agent-engineer` is renamed, without an alias** (follow-up decision F2, overriding the earlier
  alias proposal): S10 replaces the role `agent-engineer` by `agent-maintainer` in the role set,
  and its migration rewrites every existing binding (`users.global_roles` and its mirror rows,
  explicit node bindings, team and agent bindings) to `agent-maintainer`, so existing engineers
  keep their permissions under the new name and are eligible approvers. After the migration the
  role name `agent-engineer` is unknown: the API refuses it as an unknown role, and a value
  `agent-engineer` in `OAX_OIDC_ROLE_MAPPING` or `OAX_LDAP_ROLE_MAPPING` is refused at start with an
  error naming `agent-maintainer`. The project is before 1.0, so this breaking change is acceptable;
  the CHANGELOG entry of S10 lists it under **Breaking** with the migration note. The down migration
  maps `agent-maintainer` back to `agent-engineer` and refuses while `agent-developer` bindings exist.
- `admin` holds all permissions including `agents:approve` and `agents:rules`. `operator` keeps
  `runs:approve` and gains `agents:review` and `agents:approve` (not eligible by default).
  `integrator` and `auditor` gain `agents:review` (comment only).
- The roles are bindable like every fixed role: on a node (optionally inheriting, ADR 0014 section
  2), on a team (`team_members.role`) and on an agent (`agent_role_bindings`), and through directory
  mappings (section 5.3). `GRANTABLE_ROLES`, the check constraints of the binding tables, the
  role-binding API, the console and the existing group mapping accept them. ADR 0014 grant rules
  apply unchanged (no grant above one's own permissions, no self-grant).

#### 5.3 Directory groups mapped to role bindings (requirement, owner decision 2)

**Requirement.** Groups of LDAP, Active Directory, Microsoft Entra ID and similar directories
(OIDC providers such as Okta or Keycloak, later SCIM provisioning) must be mappable to the fixed
roles, the two agent roles included, **on any tenant node** and to teams, so that a company manages
who is an Agent Developer or Agent Maintainer of which department in its directory. This ADR does
not design an identity provider integration; it fixes the requirement, the mapping point in the
role-binding model and the open questions. The SCIM and per-tenant identity provider work stays in
W5-1 (#43).

**Mapping point.**

- A node-owned mapping table `directory_group_mappings (id, tenant_id, identity_source, group_key,
  role, team_id null, use_case null, inherit, created_by, created_at)`. `identity_source` names the
  installation's OIDC or LDAP configuration (later a tenant-scoped identity provider or a SCIM
  client of #43); `group_key` is a **stable identifier** (Entra ID group object id, LDAP DN or
  `objectGUID`, the value of the OIDC groups claim), never a display name.
- A mapping produces bindings in the existing tables: node bindings in `tenant_role_bindings` with a
  third `source` value **`directory`** (next to `mirror` and `grant`, part of the key, so directory
  rows never collide with explicit grants or the mirror) and `mapping_id`; team mappings produce
  `team_members` rows marked as directory-managed. `granted_by` is the mapping's creator.
- Refresh (follow-up decision F3): at every login (as today for the installation-wide mapping) and
  at every **token refresh** the directory bindings of the user are recomputed from the groups in
  the assertion, the refreshed token or the LDAP entry; later also by SCIM pushes or a periodic
  directory sync (#43). Rows get `verified_at`. Directory bindings are added to, never replace,
  explicit grants.
- **Maximum age for approvals**: a directory binding counts for an approval decision only when its
  `verified_at` is at most **15 minutes** old; otherwise the decision is refused with
  `409 directory_binding_stale` and the console asks the reviewer to refresh the session (OIDC token
  refresh or LDAP lookup). At publish (section 4.3) a counted approval whose directory binding was
  removed by a later refresh no longer counts.
- **Documented limits of v1** (F3): **no nested-group expansion** (only direct membership, as the
  groups claim or the LDAP group attribute delivers it; the LDAP matching rule for chains is not
  used) and **no Entra ID overage lookup** (a token that signals group overage instead of listing
  groups yields no directory bindings from groups, the login is audited with
  `directory.groups_overage`, and the documentation recommends "groups assigned to the application"
  or app roles). No host-specific directory API is called. SCIM provisioning comes later with #43.
- **Grant rules** (ADR 0014 section 7): creating, changing or deleting a mapping is a grant to every
  present and future member and needs rules 1, 2 and 3 on the node (`users:write`, no role above
  one's own, coverage of the subtree for `inherit: true`); rule 5 holds per derived binding (users of
  another organisation are skipped and audited); rule 6 (no self-grant) is enforced per derived
  binding: the mapping's creator never receives a binding from their own mapping (skipped,
  `directory.self_grant_skipped`), except platform admins. Mappings and every derived binding change
  are audited (`directory.mapping_created|changed|deleted`, `tenant.role_bound|unbound` with
  `source: directory`).
- The installation-wide variables keep working and are treated as mappings on the default
  tenant's node; whether they are migrated into table rows is an open question.
- For approvals, directory bindings count like any other binding (A3) and A4 applies to the
  mapping's creator. Removal from a group takes effect at the next refresh (login or token refresh);
  for approvals the 15-minute maximum age above bounds the delay until SCIM or a periodic sync
  exists.

### 6. Tenant policy

Stored as `settings.agentLifecycle` of a tenant node (ADR 0013 section 3). Until W13-2 builds the
general effective-settings resolver, slice S1 adds the column `tenants.settings jsonb` (if W13-2
has not landed) and a small resolver for exactly these keys in
`packages/core/src/tenancy/lifecycle-policy.ts`, shaped to fold into W13-2. Installation defaults
come from `OAX_LIFECYCLE_*` environment variables.

| Key | Values (strictest last) | Default | Inheritance (child may only) |
| --- | --- | --- | --- |
| `requireApprovalForPublish` | `off`, `production-only`, `on` | `on` in multi-tenant mode, `off` in single-tenant mode (one person cannot do four-eyes; the console shows a hint) | raise |
| `productionUseCases` | list of use-case globs that count as production (used by `production-only`) | `[]` | add entries (union) |
| `selfApproval` | `never` | `never` (fixed, shown for clarity) | n/a |
| `minApprovals` | 1 to 5 | 1 (the documentation recommends 2 for production use cases) | raise |
| `allowedApproverRoles` | subset of `admin`, `agent-maintainer`, `agent-developer`, `operator` | `[admin, agent-maintainer]` (Agent Developers not by default, F1) | narrow (intersection, never empty) |
| `approverScope` | `tenant`, `team`, `other-team` | `tenant` | `tenant` -> `team` or `other-team` |
| `approvalExpiryHours` | 1 to 720 | 168 | lower |
| `allowTokenApprovals` | `true`, `false` | `false` | set to `false` |
| `approverIdentitySources` | list of `local`, `oidc`, `ldap` (later `scim`) | all | narrow |
| `publishBy` | `any-publisher`, `approver-only` | `any-publisher` | `approver-only` |
| `allowDraftRuns` | `off`, `development-credentials`, `on` | `development-credentials` | lower |
| `allowPersonalSecretsInDevRuns` | `true`, `false` | `true` | set to `false` |
| `allowPersonalSecretsInPublishedAgents` | `never`, `with-approval` | `never` | set to `never` |
| `allowProductionSecretsInDraftRuns` | `true`, `false` | `false` | set to `false` |
| `gitUnsignedContributors` | `declared-non-production`, `refuse` | `refuse` (F7) | set to `refuse` |

The earlier keys `breakGlass`, `breakGlassRatifyHours` (owner decision 11) and
`approverBindingMinAgeHours` (owner decision 18) are removed; the earlier `pathRules` key moved into
agent rules (section 7).

`production-only` uses the **union** of the base version's and the draft's use case: moving an agent
out of a production use case by editing its label still needs approval. Writes that would widen an
ancestor's effective value are refused with `422 not_narrowing` (ADR 0013). The policy endpoint is
`GET/PATCH /v1/tenants/{id}/settings/agent-lifecycle` (`settings:read` / `settings:write` on the
node); every change is audited with field names, old and new values.

### 7. Agent rules (owner decision 17)

Agent rules work like protected-branch rules of Git hosts, applied to agents instead of branches.
They are the answer to "collusion": a tenant decides how many and which other people must approve
which agents and which kinds of change.

```json
{
  "name": "production support agents",
  "match": { "agents": ["support-*"], "teams": ["support"], "useCases": ["prod/**"], "labels": {} },
  "minApprovals": 2,
  "requireFrom": [
    { "role": "agent-maintainer", "min": 1 },
    { "team": "security", "min": 1, "when": { "fields": ["/runtime/egress/**", "/steps/*/credentials/**", "/grants/**"] } }
  ],
  "approverScope": "other-team",
  "requireResolvedThreads": true,
  "requireChecks": ["agent-check", "dry-run"],
  "restrictPublishers": { "roles": ["agent-maintainer"] },
  "reviewVia": "platform"
}
```

- **Match**: agent name globs, the stored team, use-case globs and labels. Matching uses the union
  of the base version and the draft (like `production-only`), so renaming an agent, changing its
  `owner` or its use case cannot escape a rule. An agent with no matching rule follows the tenant
  policy alone.
- **Aggregation**: every matching rule applies; requirements add up (maximum of `minApprovals`,
  union of `requireFrom`, strictest `approverScope`, any `true` flag wins). The tenant policy is the
  floor. As with rulesets in Git hosts, there is no precedence between rules and no rule can relax
  another.
- **"Other" approvers**: A1 and A2 always hold; a rule cannot allow self-approval.
- **`requireFrom`**: at least `min` distinct eligible approvers holding the role (on a binding
  covering the agent) or being members of the team. One approval may satisfy several requirements
  (as a code owner's approval does), but `minApprovals` counts distinct users. `when.fields` limits a
  requirement to changes of those fields of the **semantic diff** (JSON pointers with globs over the
  parsed definition and the expanded grants), which replaces the earlier `pathRules`.
- **`requireChecks`**: `agent-check` (Agent Check lint without errors on the reviewed revision),
  `dry-run` (a successful dry run of exactly that revision); later `eval` from W6-3 (#51).
- **`restrictPublishers`**: who may press publish after approval (roles or teams); combined with the
  policy's `publishBy`.
- **`reviewVia`**: `platform` (default) or `git` with a binding id (section 12.2): agents matching
  the rule are reviewed and published through review via Git only.
- **No bypass**: there is no bypass list, no admin exception and no break-glass (owner decision 11).
- **Tree**: rules are stored on a node and apply to the agents of that node and its descendants
  (ancestor rules apply to the subtree; a descendant adds rules, never removes or relaxes an
  ancestor's). Rules are part of the policy snapshot and its digest.
- **Who manages rules** (follow-up decision F8): `agents:rules` on the node. `admin` may create,
  change and delete any rule of the node. `agent-maintainer` may create rules and add or tighten
  requirements for agents of teams they maintain; **loosening a requirement or deleting a rule is
  admin only** (`settings:write`, `403 rule_loosening_admin_only` otherwise) and always writes an
  audit entry, so a maintainer cannot loosen the rule that governs their own next review. Whether a
  change loosens is computed field by field (lower `minApprovals`, removed `requireFrom` entry or
  lower `min`, wider `approverScope`, a flag turned off, a removed check, wider `restrictPublishers`,
  narrower `match`); a change that mixes tightening and loosening counts as loosening. Every change is audited
  (`agent.rule.created|changed|deleted` with field names, old and new values) and notified to the
  node's admins. A looser change does not invalidate approvals; a stricter one re-checks them at
  publish (section 4.3).
- API: `GET/POST /v1/tenants/{id}/agent-rules`, `PATCH/DELETE .../{ruleId}`,
  `GET /v1/agents/{id}/rules` (effective rules with the reason each one matches).

### 8. Development vs production execution

| Aspect | Draft (in development) | Published version |
| --- | --- | --- |
| What runs | a specific **revision** (`agent_revision_id` on the run, `stage: development`) | a version (`agent_version_id`, `stage: production`), as today |
| Triggers | manual only (console "Test run", API); never webhooks, mail, Kafka, cron | all triggers |
| Who may start | `agents:write` on the agent (the author and co-authors); reviewers may start a run with **their own** development credentials | `runs:execute` |
| Tools | `allowDraftRuns: off` -> dry run only (today); `development-credentials` -> real tools only through connections/secrets marked `usage: development` or `any` and personal secrets of the run's starter; `on` -> also `production` secrets when `allowProductionSecretsInDraftRuns` | as published, the version's grants |
| Secret resolution | live (nearest owner along the chain, section 13.3) | pinned at publish (section 13.3) |
| Budget | development budget per node/team (`limits.devMonthlyBudgetMicros`, separate cost line `stage=development`, hard stop); until an admin sets one, **10 % of the node's monthly cap** (owner decision 9) | the normal budgets |
| Audit/costs | marked `development` everywhere (runs list filter, costs export column) | unchanged |
| Approvals at run time | as for published runs (the policy gate applies unchanged) | unchanged |

On a new publish: queued runs keep the version they were enqueued with (true today), running runs
finish on their version unless cancelled; new events and schedules use the new version. A
**deprecated** version refuses new runs pinned to it. A security fix that must stop old runs uses
the existing cancel and disable actions (section 3.1).

### 9. Review UI concept

- **Status badge** on the agent list and detail page: `In development`, `Review requested`,
  `Changes requested`, `Approved`, `Published vX.Y.Z` (plus `Disabled`, `Deprecated` on versions).
  For review via Git the badge names the branches. All texts through i18n (en, de).
- **Review tab** (next to Overview, Editor, Diff, Versions, Test run): header with requested by,
  base version, required approvals (`1 of 2`), the matching agent rules and their open requirements
  ("1 approval from team security for changes to egress"), policy summary and why each rule
  applies; the **diff** of `agents.md` between the base version and the reviewed revision (the
  existing `DiffView`), plus a **semantic summary** (added/removed tools and their access class,
  egress hosts, secret references with scope and owning node, shadowed or inherited secrets,
  budget, classification, runtime, owner changes) and the expanded grants.
- **Comment threads** on a line of the diff (`revision_id`, side `base|head`, line, plus the SHA-256
  of the line text as anchor) or on the review as a whole. Threads can be resolved by the author or
  the commenter; on a new revision a thread whose anchor no longer matches is shown as **outdated**
  but kept. Markdown subset (no HTML, no images, links shown as text with the host), 10 000
  characters, 200 threads per review; comments are tenant content (retention and erasure of ADR
  0012 section 7 apply; never sent to models).
- **Decision bar**: Approve / Request changes / Reject, each with an optional (approve) or required
  (request changes, reject) comment; disabled with the reason when the user is not eligible ("You
  edited this draft", "Your role is not an approver role in this tenant", "This rule needs a member
  of team security").
- **Publish** button appears when the review is approved and the user may publish; the publish
  dialog shows the approval records and re-checks before submitting. For review via Git it shows
  which publish-branch commit will be or was published.
- **Roles and rules pages**: role bindings show their source (grant, mirror, directory mapping);
  the agent rules page lists rules per node with inherited rules from ancestors marked read-only.
- **Notifications** (S13): review requested to eligible reviewers, decisions and comments to
  contributors, expiry, rule changes and unapproved content on a publish branch to admins;
  delivered through W2-5/W3-1 channels when they exist, the in-console inbox before.

### 10. API (additions to `openapi.yaml`, generated by the implementing slices)

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /v1/agents/{id}/revisions`, `GET .../revisions/{rev}` | `agents:read` | metadata and source |
| `POST /v1/agents/{id}/reviews` | `agents:write` | opens a review on the current revision; `409 review_open` when one is open |
| `GET /v1/agents/{id}/reviews`, `GET /v1/reviews/{rid}` | `agents:read` | status, required approvals, rule requirements, approvals with eligibility per rule, stale reasons |
| `POST /v1/reviews/{rid}/decisions` | `agents:approve` | `{ decision, expectedDigest, comment? }`; refusal codes `self_approval`, `not_eligible`, `binding_granted_by_contributor`, `token_approval_disabled`, `stale_view` |
| `POST /v1/reviews/{rid}/threads`, `POST .../threads/{tid}/comments`, `PATCH .../threads/{tid}` | `agents:review` (new: comment) | resolve/unresolve |
| `POST /v1/reviews/{rid}/withdraw` | opener or `admin` | |
| `POST /v1/agents/{id}/publish` | `agents:publish` | `{ reviewId, expectedDigest }` when required; there is no break-glass parameter |
| `POST /v1/agents/{id}/versions/{v}/deprecate` | `agents:publish` | deprecating the latest version rolls back (section 3.1) |
| `GET/PATCH /v1/tenants/{id}/settings/agent-lifecycle` | `settings:read` / `settings:write` | narrowing-only |
| `GET/POST /v1/tenants/{id}/agent-rules`, `PATCH/DELETE .../{ruleId}`, `GET /v1/agents/{id}/rules` | `policies:read` / `agents:rules` | section 7 |
| `GET/POST /v1/tenants/{id}/directory-mappings`, `PATCH/DELETE .../{mappingId}` | `users:read` / `users:write` | section 5.3; grant rules of ADR 0014 |
| `GET/POST /v1/tenants/{id}/git-integrations`, `PATCH/DELETE .../{integrationId}`, `POST .../{integrationId}/test` | `repos:read` / `repos:write` | section 12.2 |
| `GET /v1/me/reviews` | any | inbox: reviews where the caller is eligible |

New permissions in `packages/core/src/rbac.ts`: `agents:review` (admin, agent-maintainer,
agent-developer, integrator, operator, auditor), `agents:approve` (admin, agent-maintainer,
agent-developer, operator; narrowed by `allowedApproverRoles` and rules), `agents:rules` (admin,
agent-maintainer), `secrets:read` and `secrets:write` (section 13.4). The role `agent-engineer` is
renamed to `agent-maintainer` without an alias (F2); the role enum in `openapi.yaml` loses
`agent-engineer`. The UI types are regenerated as usual.

### 11. Audit events (hash-chained, ADR 0002; names, ids and digests only)

`agent.revision.created { revision, digest, author }`, `agent.review.opened { review, revision,
digest, expansionDigest, resolutionDigest, policyDigest, requiredApprovals }`,
`agent.review.decided { review, revision, digest, decision, reviewer, auth, eligibleVia }`,
`agent.review.refused { review, code }` (rate-limited), `agent.review.stale { review, approvals,
reason }`, `agent.review.comment { review, thread }` (no comment text in the audit chain),
`agent.review.closed { review, outcome }`, `agent.published { version, digest, review,
approvedBy[], policyDigest, source? }`, `agent.version.deprecated { version, rollbackTo? }`,
`agent.rule.created|changed|deleted { rule, fields, from, to, loosening }`,
`tenant.lifecycle_policy_changed { fields, from, to }`, `directory.mapping_created|changed|deleted
{ mapping, identitySource, groupKey, role, team, inherit }`, `directory.self_grant_skipped {
mapping }`, `directory.groups_overage { identitySource }`, `repo.unsigned_contributors_declared {
binding, agent, revision, commits, declaredBy }`,
`repo.integration_created|changed|deleted { integration, fields }`,
`repo.unapproved_publish_content { binding, agent, digest, commit }`,
`secret.created|rotated|revoked|deleted { scope, scopeId, name, version, backend, inherit }`,
`secret.shadowed { name, ownerNode, shadowedNode }`, `secret.access_denied { ref, code }`, and
`credential.issued` gains `scope`, `ownerNode` and `secretVersion`.

### 12. Git interplay (ADR 0010)

#### 12.1 Git candidates become revisions

A Git candidate (ADR 0010 7.4) becomes a **draft revision** with `author_kind = repo` and
`source_commit`; the review of this ADR applies to it like to a console revision. With
`requireApprovalForPublish` effective or an agent rule matching, `publishMode: manual` means
"publish after platform review", and `publishMode: on-merge` publishes only under section 12.2 or
12.3.

#### 12.2 Git integrations and review via Git (owner decision 17)

**Git integration (tenant object).** A tenant admin supplies the repository once per node; teams
and use cases then select it. It reuses ADR 0010 Amendment 1 unchanged: any Git host over plain
Git, HTTPS with a token or SSH with a deploy key, pinned host keys, the hardened Git engine and the
ADR 0011 relay; no host-specific API in the core.

```json
{
  "name": "company-git",
  "url": "https://git.example.com/acme/agents.git",
  "provider": "generic",
  "auth": { "kind": "https-token", "tokenRef": "tenant:git-agents-read", "username": "git" },
  "trust": { "caBundleRef": "tenant:company-git-ca", "mode": "system+extra" },
  "clientCertificate": { "certRef": "tenant:company-git-client-cert", "keyRef": "tenant:company-git-client-key" },
  "knownHosts": []
}
```

- Created, changed and deleted with `repos:write` on the node (`admin`, `integrator`; ADR 0010
  section 10); credentials are secret references of the node (section 13; with the internal store
  the token or key is stored encrypted). A read-only credential is enough for review via Git; a
  write credential is needed only for the optional tag push and PR-back (ADR 0010 section 9).
- **Certificates for company Git (amends ADR 0011 section 3 for this purpose only)**: a tenant may
  supply a CA bundle (PEM, stored as a tenant secret or tenant configuration) and a client
  certificate with key (key as a tenant secret). They are used **only** for TLS from the Git relay
  to this integration's host and port, never added to the platform trust store, never used for
  another tenant, another host or another purpose; `mode: extra-only` trusts only the supplied
  bundle. `OAX_GIT_TENANT_TRUST` defaults to **strict** (follow-up decision F6): tenant-supplied
  trust is available, scoped to the integration's host and port, and every verification failure
  (unknown issuer, expired or mismatched certificate, wrong host name) fails closed; the operator
  can switch the feature off installation-wide (`OAX_GIT_TENANT_TRUST=off`). Certificate expiry is
  shown and notified 14 and 3 days ahead; there is no switch to disable verification.
- One repository serves one tenant node (ADR 0010 A1.9): an integration is **node-local**, also
  when secrets inherit (section 13.3); descendants create their own integration for their own
  repository. Sharing an ancestor's integration with descendants is not part of this ADR: the
  owner's answer to that question (F5) is the separate design direction "tenant structure as code"
  of [ADR 0018](0018-tenant-structure-as-code.md) (Proposed), in which one repository may own a
  subtree root. Until ADR 0018 is decided and built, integrations stay node-local.

**Binding with review via Git.** A binding (ADR 0010 section 6) references an integration and is
scoped to a team or a use case of the node. With `reviewVia: git` it has two branch roles whose
names are free:

```json
{
  "integration": "company-git",
  "paths": ["agents/support/**/*.agents.md"],
  "teamId": "<team uuid or null>",
  "useCase": null,
  "reviewVia": "git",
  "developmentBranch": "develop",
  "publishBranch": "main",
  "trustedSigners": [{ "key": "ssh-ed25519 AAAA...", "userId": "<platform user>" }]
}
```

1. **Development branch** (for example `develop`): every new head is synced (ADR 0010 7.2 and 7.3)
   and each changed agent file becomes a **draft revision** (`source_commit`). This branch is the
   development environment: development runs (section 8) run its revisions.
2. **Contributors from signatures**: when approval is required for the agent, every commit since
   the base version's commit that touches the file must carry a valid signature by a key in
   `trustedSigners` (verified over plain Git as in ADR 0010 A1.7); each key is **linked to a
   platform user**, and those users are contributors (A1). A revision with an unsigned commit or an
   unlinked key cannot be approved (`contributor_unverified`), because the platform could not prove
   that the approver is not the author. Commit author names and e-mail addresses are never trusted.
   Linking a key to a user needs the user's own confirmation (signed challenge) and is audited.
   **Relaxation for non-production only** (follow-up decision F7): when the effective tenant policy
   sets `gitUnsignedContributors: declared-non-production`, a revision with unsigned or unlinked
   commits can be approved only if the agent's use case (union of base version and draft, as for
   `production-only`) matches **none** of the effective `productionUseCases`, and the effective
   `productionUseCases` list is not empty (an empty list means the platform cannot tell production
   apart, so the relaxation is refused). The user who opens the review then declares the platform
   users who authored the unsigned commits; the declared users are contributors (A1), the review
   shows a permanent warning ("contributors declared, not proven by signatures"), and
   `repo.unsigned_contributors_declared` is audited. Any agent rule that matches the agent can set
   `requireSignedCommits: true` to forbid the relaxation for it; production agents never use it.
3. **Review in the platform**: the review of sections 3 to 7 runs on that revision (four-eyes,
   agent rules, comments). Teams may additionally discuss in the host's pull request from the
   development to the publish branch; that pull request has no authority unless section 12.3 is
   configured.
4. **Publish branch** (for example `main`): when a sync of the publish branch finds an agent file
   whose digest equals the digest of an **approved** review of that agent, the platform publishes
   it as `repo:<bindingId>` with that review, after the checks of section 4.3 (digest, expansion,
   secret resolution, policy and rules re-checked, approvals not expired). The version records
   `source_commit` of the publish branch. An approval that arrives after the merge triggers a sync
   of the binding, so the order of "merge" and "approve" does not matter.
5. **Unapproved content on the publish branch** (merged without approval, or changed while
   merging): nothing is published; production keeps the last version; the binding and the agent
   show `unapproved_content_on_publish_branch`, `repo.unapproved_publish_content` is audited and the
   node's admins and the agent's maintainers are notified. The file's revision can still be
   reviewed; once approved, the next sync publishes it.
6. Branch protection on the host (required pull requests, no force push) is recommended and shown
   when the optional host extension can read it, but the platform's guarantee does not depend on
   it: only approved digests are published.
7. Console edits of an agent under review via Git are refused (Git wins, ADR 0010 section 8);
   "Copy as patch" and PR-back stay available.

This is the general Git integration the owner asked for: per use case or team a tenant chooses
"review via Git", the development branch is the development environment, the publish branch holds
the published state, and the tenant admin supplies repository, token or deploy key and optional
certificates.

#### 12.3 Host review as approval (later, S9, owner decision 10)

`acceptGitHostReview: true` (off by default, not in the first release) counts approving reviews of
the host's merged pull request as platform approvals only when **all** hold: the `on-merge`
conditions of ADR 0010 A1.7 (signatures by trusted signers, ancestry, branch protection read
through the **host extension**; an attestation alone is never enough because it cannot be
checked); the host extension reads the merged change request's approving reviews and the commit
authors and committers; every host account involved is mapped to a platform user through a
**verified identity link** (user-initiated link proven by an OIDC claim of the host or a signed
challenge); the mapped approvers satisfy section 5 and every matching agent rule against the mapped
contributors; required reviews on the branch are at least the effective `minApprovals`. Otherwise
the revision waits for a platform review and the binding shows which condition failed.

#### 12.4 Version tags

When published, the platform can push a lightweight tag `agents/<name>/v<version>` to the
repository with the PR-back credential (optional). The tag is informational; the platform's record
is the version row with digest and approvals.

### 13. Secrets: scopes, inheritance, store, encryption and backends

#### 13.1 Scopes

| Scope | Owner | Who may reference it in an agent | Who may use it at run time | Who manages it |
| --- | --- | --- | --- | --- |
| `personal` | one user in one tenant node | only its owner, only in drafts | only runs **started by its owner**, only development runs (unless section 13.5) | the owner (needs `agents:write` somewhere in the node) |
| `team` | a team | agents of that team | runs of agents of that team | `secrets:write` on the team |
| `tenant` | a tenant node | agents of that node **and of all descendant nodes** (inherited top-down by default, section 13.3); `inherit: false` keeps it node-only | runs of those agents | `secrets:write` on the owning node only |
| `platform` | operator | never brokered to nodes (unchanged `platform_secret`); used by platform connections, model proxy, event sources | trusted processes only | operator configuration |

Each secret has `usage: development | production | any` (default `any`), an optional
`allowedDestinations` list (host globs: the broker refuses to issue the secret to a step whose
effective egress or MCP connection URL lies outside it), `inherit` (tenant scope, default `true`),
`allowOverride` (tenant scope; default `false` for secrets owned by a root node and `true` for
secrets on lower nodes, follow-up decision F4), a description, `created_by`, `rotated_at`,
`expires_at` (optional) and a backend pointer. Team and personal secrets never inherit (teams are
node-local, ADR 0014 section 2).

#### 13.2 References in `agents.md`

- Scoped references: `credentials: [{ secret: "team:jira-token", env: JIRA_TOKEN }]`, and in
  connections `headerSecrets: { Authorization: "tenant:jira-basic" }`. The prefix is the scope;
  team references resolve against the **agent's** team, tenant references against the agent's node
  and its ancestors (section 13.3), personal references against the **run's starter**. There is
  **no implicit fallback between scopes** (a `tenant:` reference never resolves to a team or
  personal secret and vice versa). Unprefixed references keep today's meaning (operator env/files,
  tenant prefix and `secret_refs` globs) and are labelled "legacy".
- Values never appear in `agents.md`; the existing inline-secret checks stay. Validation at save
  checks the syntax, publish checks that the referenced secret exists and that the agent may use it
  (`secret_not_usable`), and the review shows every added or removed reference with its scope and
  owning node.

#### 13.3 Inheritance down the tree (owner decision 15)

Tenant secrets inherit **top-down**, like credentials in Jenkins folders: a `tenant:` secret owned
by node N can be referenced by agents of N and of every descendant of N, never by ancestors,
siblings or other organisations (ADR 0014 "never up, never sideways").

- **Resolution**: a `tenant:<name>` reference of an agent on node M resolves to the secret of that
  name on the **nearest** node of M's chain (M, its parent, ..., the root) that has one with
  `inherit: true` (or `inherit: false` when it is M itself). No match is `secret_not_found`.
- **Override (shadowing)**: a node may create a secret with the same name as an inherited one; for
  its subtree the nearer secret wins. An owner can forbid that with `allowOverride: false`: creating
  a same-named secret in the subtree is then `422 secret_name_reserved`. Secrets owned by a **root**
  node default to `allowOverride: false` (F4), so an organisation-wide credential cannot be shadowed
  below unless the root's secret managers allow it explicitly; secrets on lower nodes default to
  `allowOverride: true`. Shadowing is audited
  (`secret.shadowed`) and the admins of the owning node are notified (downward oversight).
- **Restrict at a lower node**: a node may block inherited names for its subtree with the
  narrowing-only setting `settings.secrets.blockInherited` (name globs, union down the tree); a
  blocked inherited name resolves to `secret_not_found` unless the node or a descendant defines its
  own. The owner can keep a secret node-only with `inherit: false`. The existing `secret_refs`
  patterns still narrow what agents of a node may reference.
- **Pinned resolution for production**: the review shows and the approval binds the resolution
  (`resolution_digest`, section 4.2); the published version stores the resolved owning node and
  secret id per reference. Production runs use exactly that secret (its current version after a
  rotation). A secret created later at a lower node therefore **does not silently replace** the
  credential of a published agent: it applies to the next revision, and the review shows "now
  resolved from node X instead of node Y". If the pinned secret is revoked, deleted, blocked or no
  longer on the agent's chain (node move), the run fails closed (`secret_unavailable`,
  `secret_out_of_chain`) and the agent's maintainers are notified; there is no run-time fallback to
  another node. Development runs resolve live.
- **See vs use vs manage**: values are readable by nobody (principle 5). Holders of `secrets:read`
  on a descendant see the **metadata** of inherited secrets (name, owning node as slug path,
  description, usage, destinations, expiry, `allowOverride`), not the creator's identity of an
  ancestor node. Using an inherited secret means referencing it in an agent of the subtree; the
  reference goes through that node's review and rules. Rotating, revoking and deleting happen only
  on the owning node with `secrets:write` there.
- **Audit**: `credential.issued` is written in the run's node partition with `ownerNode`; the
  owning node's secret page lists issuances per descendant node (node, count, last use) for
  `secrets:read` holders there, which is downward oversight and allowed by ADR 0013.
- **Keys and backends**: an inherited secret is encrypted with the **owning** node's data key and
  its AAD names the owning node; operator-wide Vault paths and AWS ARN prefixes are checked against
  the owning node's prefix, and AWS role assumption uses the owning node's id as `ExternalId`.
  Crypto-shredding a descendant does not affect its ancestors' secrets; shredding the owning node
  ends every descendant use (fail closed).
- **Moves** (ADR 0013 section 9): after a node move, inherited resolutions are recomputed;
  published versions whose pinned secret is no longer on the chain fail closed until a new revision
  is approved; moves into another organisation map references with `secretRefMap` as today.
- **Consequence**: a secret on a root is usable by every agent of the organisation after review.
  The documentation recommends `allowedDestinations`, `usage`, `inherit: false` for narrow
  credentials and rules that require an owning-node approver for agents that reference a root
  secret.

#### 13.4 Visibility and use

- `secrets:read` (metadata), `secrets:write` (create, rotate, revoke, delete) are new permissions:
  `admin` and `integrator` on their scope; `agent-developer` and `agent-maintainer` get
  `secrets:read`; personal secrets are managed only by their owner. `auditor` and `pentest` see
  metadata.
- **No API returns a value**, not even to the creator or a platform admin. Values are accepted
  only on create and rotate (request body, never in query strings or logs), are at least 8
  characters long (the redaction minimum) and at most 64 KiB.
- Using a secret means: the broker issues it to a step of an agent that may use it (13.1, 13.3) in a
  run that may use it (13.5, section 8). The issuance is the audit event.

#### 13.5 Personal secrets

- Usable in development runs started by their owner when `allowPersonalSecretsInDevRuns` is
  effective. Reviewers never run with the author's personal secret (confused deputy); they use their
  own personal secret with the same name or a team/tenant secret.
- A revision that references personal secrets can be reviewed, but **publishing it is refused**
  (`personal_secret_in_version`) while `allowPersonalSecretsInPublishedAgents: never` (default,
  owner decision 8).
- With `with-approval`: publish requires one additional approval from an `admin` covering the agent
  (counted separately), the version is flagged `usesPersonalCredentials` (badge, list filter, run
  view, audit), production runs act with the owner's credential whoever triggers them, and the
  flag is part of the approval binding. When the owner is disabled, leaves the tenant, or deletes or
  rotates the secret, runs fail closed (`secret_owner_unavailable`) and tenant admins are notified.
- Personal secrets are deleted when the user is deleted (crypto-shredded with their row, see 13.6).

#### 13.6 Encryption at rest (internal store)

- Envelope encryption with the **key service of ADR 0016 S5 (#235)**: AES-256-GCM, one data key
  (DEK) per tenant node (`tenants.data_key_id`, versioned), DEKs wrapped by a key-encryption key
  (KEK) from operator configuration first (`OAX_KEK_*`, file or env, two slots for rotation) and from
  a KMS later (AWS KMS, Vault Transit, then Azure Key Vault and Google Cloud KMS; customer-managed
  keys per tenant for v1.0, owner decision of 2026-10-04, ADR 0012 open question 4).
- Table `secrets (id, tenant_id, scope, scope_id, name, version, backend, ciphertext, nonce,
  dek_version, aad_digest, usage, allowed_destinations, inherit, allow_override, created_by,
  created_at, rotated_at, expires_at, revoked_at)`; unique `(tenant_id, scope, scope_id, name,
  version)`. Additional authenticated data = `tenant_id | scope | scope_id | name | version`
  (the owning node), so a ciphertext copied to another row or tenant does not decrypt.
- **Rotation**: KEK rotation rewraps DEKs only (no data re-encryption); DEK rotation creates a new
  DEK version, new writes use it, a background job re-encrypts old rows and audits progress; a DEK
  version is destroyed only after no row uses it. Crypto-shredding of a tenant or a user's personal
  secrets destroys the DEK or deletes the rows.
- Plaintext exists only in the api/worker process for one issuance; it is not cached across
  requests (wrapped DEKs may be cached in memory for at most 5 minutes, never in Valkey), never
  logged, never written to telemetry, and registered with the `ContextGuard` and redactor of the
  run.

#### 13.7 Backends (pluggable)

A secret row can hold a value (internal store) or a **pointer** to an external backend. The
backends implement the existing `CredentialSource` interface (`issue(ref, scope)`, optional
`revoke(handle)`) plus `describe()` and `health()`:

| Backend | Pointer | Auth of the platform | Leases |
| --- | --- | --- | --- |
| `internal` | value (13.6) | n/a | static |
| `env` (legacy) | today's `OAX_SECRET_*` / files | n/a | static |
| `vault-kv2` | `{ connection, mount, path, key, version? }` | Kubernetes auth (projected service-account token) and AppRole (role id from config, secret id delivered response-wrapped) first; JWT/OIDC auth next (owner decision 13) | static values; Vault token short TTL, renewed, revoked on shutdown |
| `vault-dynamic` | `{ connection, mount, role }` (database, AWS, other engines) | as above | lease per step: TTL <= step lifetime, revoked by the broker at step end through `credentialHandles` (already persisted per session) |
| `aws-sm` | `{ connection, secretId (ARN), versionStage?, jsonKey? }` | IRSA or instance role, then `AssumeRole` per owning node with `ExternalId = owning node id` | static; rotation by AWS, the platform reads `AWSCURRENT` |

- **Backend connections** are typed connection instances (ADR 0012): `vault` and `aws-sm`, scope
  platform (operator-wide) or tenant (**tenant-owned store**, which gives the separation from
  operators that ADR 0012 7.7 asks for); both are supported (owner decision 14). The operator-wide
  backend has a fixed per-tenant path template (`<mount>/tenants/<tenantId>/...`) or ARN prefix; a
  pointer outside its owning node's prefix is refused at save and at issue
  (`secret_pointer_out_of_scope`). Outbound calls go through the ADR 0011 dispatcher (purpose
  `secrets`, DNS pinning, proxies, trust store); air-gapped mode needs the backend host on the
  allowlist.
- **Caching** (owner decision 16): no caching of static values by default; `cacheTtlSeconds` up to
  60 per backend connection on operator opt-in, in process memory only, keyed by tenant, scope,
  name and version, flushed on rotate and revoke. Dynamic credentials are never cached.
- Failures fail closed with a reason code in the audit entry (`backend_unavailable`,
  `backend_denied`, `pointer_not_found`), never with backend error text in API responses.
- Vault tokens and AWS session credentials live only in the control node and trusted worker
  memory, are never brokered to nodes and are registered with the redactor.

#### 13.8 Delivery to run nodes

Unchanged path: the credential broker (ADR 0008 section 2) issues the values of exactly the
references a step declares, once per step and session, into node memory, and revokes the session at
step end (and dynamic leases through their handles). New checks before issuance: scope, inheritance
and pinned resolution (13.1, 13.3), usage (13.5, section 8), `allowedDestinations` against the
step's egress and MCP URLs, secret not revoked or expired. For HTTP MCP connections the relay of
ADR 0016 S4 keeps header secrets in the control node.

#### 13.9 Exfiltration

- An agent definition cannot read a value: it can only name references, and every new reference is
  visible in the review diff with its scope, owning node and destinations.
- A crafted definition could hand a secret to a tool that sends it elsewhere. Mitigations: the
  review (new references, egress and write tools are highlighted), agent rules that require
  specific approvers for credential and egress changes, `allowedDestinations` per secret,
  per-connection egress (ADR 0016), the policy gate, and the `ContextGuard` redacting registered
  values from tool results and model context.
- An MCP server that receives a secret is the trust boundary: it can do anything the credential
  allows. Least privilege on the credential itself (scoped tokens) remains the owner's job; the
  console says so when a secret is created.

#### 13.10 Rotation, revocation, audit

- Rotate creates a new version; new issuances use it; sessions already issued keep their value
  until the step ends (at most the session lifetime). Revoke blocks new issuances immediately and,
  with `revokeSessions: true`, revokes active sessions that received the secret, in every
  descendant node that uses it.
- `expires_at` warns 14 and 3 days before (notification) and refuses issuance after.
- Audit: section 11; a secret's page lists its issuances (from `credential.issued`) for
  `secrets:read`.

#### 13.11 Migration from today

- Existing `OAX_SECRET_*` and secret-directory references keep working as the `env` backend; the
  tenant `secret_refs` globs keep governing them. Nothing changes for existing agents.
- New agents should use scoped references; Agent Check gains a lint `legacy_secret_ref` (advisory).
- An import helper creates `tenant` or `team` secrets that **point** at existing env names (no value
  copy) so agents can move to scoped references without touching operator configuration.
- Legacy tenant use of env references may be deprecated in a later minor release with a changelog
  entry; not part of this ADR.

### 14. Relation to existing plan items

- **W6-3 (#51)**: this ADR delivers the approval record bound to the source digest, the expansion
  digest, the secret resolution digest and the policy digest. W6-3 extends the binding with the
  model configuration and the evaluation run id, adds staleness on a model or toolbox change and
  adds `eval` to the agent-rule checks. #51 stays open, depends on S3.
- **W7-2 (#54)**: run-time multi-step approvals reuse the rule module of S1 (A1, A2, A5, A8). New
  acceptance item for #54: "the requester and the agent's contributors never approve when the tenant
  enables `runtimeSelfApproval: never`".
- **W9-2 (#90 to #96)**: the review and publish flow of Git-managed agents uses the reviews of this
  ADR; Git integrations and review via Git are slice S12; host review as approval is slice S9.
- **W5-1 (#43)**: SCIM and tenant-scoped identity providers stay there; slice S11 adds the per-node
  directory mapping table that #43's SCIM groups and tenant identity providers feed.
- **W5-3 (#45)**: implemented by S6 (#249, Vault) and S7 (#250, AWS SM); #45 becomes the umbrella
  and is closed when both are merged.
- **ADR 0016 S5 (#235)**: the key service is shared; whichever slice lands first builds it, the
  other reuses it.

### 15. Threat model

| # | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| G1 | **Self-approval** by the author, through a second role, a token or as platform admin | A1/A2 on user id, applied to every role including platform admins; contributors include every revision author since the base, the opener and linked signers of Git commits | a human with two accounts the platform cannot link (G3) |
| G2 | **Collusion** of eligible people | agent rules: `minApprovals` up to 5, required approvals from named roles or teams (for example a security team) for named fields, `other-team` scope, resolved threads and checks required; directory-managed membership; full audit with reviewer identity; notifications to admins | all required approvers colluding; documented; rules make that need more and independent people |
| G3 | **Sock-puppet account** (local account next to a directory account) | `approverIdentitySources` (exclude `local`), A4 (binding not granted by a contributor, also for directory mappings), creation of users, bindings and mappings audited | a directory administrator who creates a second identity or adds an accomplice to a mapped group (outside the platform's control) |
| G4 | **Role-grant bypass**: author grants an approver role or maps a group to an approver role just before approving | A4 `granted_by` (mapping creator) not a contributor, ADR 0014 no-self-grant, self-grant skipped for mappings; re-check at publish; there is no minimum binding age (owner decision 18) | an admin who is not a contributor grants the role to an accomplice (collusion, G2) |
| G5 | **Replay of an approval** onto other content or another agent | approval binds review, revision, digest, expansion digest, resolution digest, policy digest, agent; publish compares inside a transaction; approvals expire | none known |
| G6 | **TOCTOU**: draft changed between approval and publish, profiles widened in the catalog, or a secret shadowed | publish uses the revision source, compares digests under row lock, recomputes expansion and secret resolution; any new revision dismisses approvals | none known |
| G7 | **Policy or rule downgrade** to slip a publish through | policy writes need `settings:write`, are narrowing-only below ancestors; ancestor rules cannot be removed below; loosening a rule needs `admin`; all audited and notified; approvals carry the policy digest; stricter changes re-check | a tenant admin can loosen the own node's policy and rules within the ancestors' bounds |
| G8 | **Emergency bypass** | none exists (owner decision 11): no break-glass, no bypass list, no admin exception; incident tools only reduce reachability; rollback only to approved versions | an urgent fix waits for an eligible second person |
| G9 | **Personal secret leakage into production** | publish refuses personal references by default; `with-approval` needs an extra admin approval, a flag and a badge; personal secrets usable only in runs started by their owner | with `with-approval`, runs act with a person's credential (documented, flagged) |
| G10 | **Confused deputy**: a reviewer's test run, a schedule or another user's run uses the author's personal secret | personal references resolve against the run's starter; draft runs are manual only | none known |
| G11 | **Secret exfiltration via a crafted agent definition** | references visible in the review; rules requiring approvers for credential and egress changes; `allowedDestinations`; per-connection egress; policy gate; redaction | a tool that is allowed to reach a destination can misuse the credential there |
| G12 | **Malicious MCP server** receiving a secret | ADR 0016 egress per connection, tool pinning, relay keeps HTTP header secrets in the control node | the server can use the credential within its scope |
| G13 | **Reading secret values** through API, logs, telemetry, audit, errors | no read API, values only on create/rotate, redaction, audit with names only, telemetry allowlist (ADR 0015) | operators with database and KEK access (separation needs tenant KMS keys or tenant-owned backends) |
| G14 | **Vault token or AWS credential theft** | short TTLs, never brokered to nodes, kept in trusted memory only, response-wrapped AppRole secret id, Kubernetes auth preferred, revocation on shutdown, per-node role with `ExternalId` | compromise of the control node process |
| G15 | **Cross-tenant confused deputy** on a shared backend (tenant A points at tenant B's Vault path or ARN) | per-tenant path template or ARN prefix enforced at save and issue against the owning node; AAD binds ciphertexts to the owning node and name; tenant-owned backend connections | misconfigured operator template (validated at start) |
| G16 | **Comment content abuse** (stored XSS, prompt injection, personal data) | Markdown subset rendered without HTML, comments never sent to a model, length limits, retention and erasure apply | none known |
| G17 | **Denial of service** by review spam or forced re-reviews | one open review per agent, rate limits on decisions and comments, notification batching | none known |
| G18 | **Downgrade via `owner`, name or `labels.useCase` edits** to escape team scoping, rules or `production-only` | team scoping uses the stored `team_id`; `production-only` and rule matching use the union of base and draft; owner, name and use-case changes highlighted | none known |
| G19 | **Shadowing an inherited secret** to redirect a reviewed agent's credential (a lower-node admin creates a same-named secret) | pinned resolution for published versions; resolution digest in the approval; shadowing audited and notified; `allowOverride: false` on sensitive secrets | the lower node's own new revisions use the shadowing secret after review in that subtree (intended) |
| G20 | **Blast radius of inherited secrets** (a root credential usable in every sub-tenant) | `inherit: false`, `blockInherited` at lower nodes, `allowedDestinations`, `usage`, review and rules in every subtree, issuance overview for the owning node | agents of descendants can use the credential within its destinations after their own review |
| G21 | **Escalation through directory mappings** (map a broad group to an approver role, or a group one belongs to) | ADR 0014 grant rules on mapping creation, self-grant skipped, stable group identifiers, audit and notification of mappings and derived bindings | group membership is governed by the directory; a directory administrator can add members (G3) |
| G22 | **Forged contributor identity in review via Git** (an author commits under someone else's name to approve their own change) | contributors only from signatures by keys linked to platform users; unsigned or unlinked commits cannot be approved; commit names never trusted | a stolen signing key of another user |
| G23 | **Unapproved content merged to the publish branch** | only digests with a valid approval are published; anything else is refused, audited and notified; production keeps the last version | the Git branch can differ from production until fixed (visible drift) |
| G24 | **Tenant-supplied CA or client certificate misused** (MITM of other traffic) | trust and client keys used only for one integration's host and purpose, never in the platform trust store, never for other tenants; operator can switch the feature off; no verification switch | a tenant can weaken trust for its own Git connection only |

### 16. Test plan

- **Unit (core)**: rule module A1 to A10 with a table of principals (author, co-author, opener, admin
  author, platform admin author, token, repo actor, guest, local vs OIDC, binding granted by a
  contributor, directory binding from a mapping created by a contributor, directory binding older
  than 15 minutes, agent-developer vs agent-maintainer, `agent-engineer` refused as unknown role
  after the rename); agent-rule matching and aggregation (union of base and
  draft, field rules on the semantic diff, reformatting does not evade); policy resolver narrowing
  (each key, `not_narrowing`), union of production use cases; digest, expansion digest and
  resolution digest stability; secret resolution along the chain (nearest wins, `allowOverride`,
  `blockInherited`, `inherit: false`).
- **API**: full state machine; every refusal code; publish TOCTOU (concurrent draft save during
  publish, expansion change between approval and publish, a shadowing secret created after
  approval, policy or rule tightened after approval, approval expired, binding or mapping revoked
  after approval); the absence of any publish path without approval (route-table test: no
  break-glass parameter or endpoint); rollback by deprecation and `rollback_target_unapproved`;
  dev runs (manual only, dev budget default 10 % and hard stop, `stage` on costs and audit);
  directory mappings (grant rules, self-grant skipped, refresh at login and token refresh, maximum
  age 15 minutes for approvals, overage token yields no group bindings, no collision with grants);
  agent-rule management (maintainer may add and tighten, cannot loosen or delete; mixed changes
  count as loosening); migration test of the `agent-engineer` to `agent-maintainer` rename (every
  binding table, up and down).
- **Git**: review via Git against a real Git server in a container (development and publish
  branches with free names, signed and unsigned commits, linked and unlinked keys, the
  `declared-non-production` relaxation refused for production use cases and for an empty
  `productionUseCases`, approved and
  unapproved digests on the publish branch, approval after merge, tenant CA bundle and client
  certificate on a private-CA server), reusing the hostile-server suite of W9-2-7.
- **Secrets**: no endpoint returns a value (route-table test over the OpenAPI document); AAD swap
  refused; KEK and DEK rotation with mixed rows; crypto-shredding; personal secret refused at publish,
  in a reviewer's run and in a scheduled run; `allowedDestinations` refusal; scope resolution
  without cross-scope fallback; inheritance, shadowing and pinning; node move with pinned
  resolution; leak canaries (a canary secret never appears in logs, audit, telemetry, step outputs,
  error bodies, model context).
- **Backends**: Vault and AWS SM against fakes (HTTP fakes with recorded API shapes, no real
  accounts in CI); lease revocation at step end; failure codes; path/ARN prefix enforcement against
  the owning node; token renewal and expiry. An optional integration job against a local Vault dev
  container (pinned image) is allowed only as a manual workflow.
- **UI**: badges, decision bar eligibility texts, rule requirements, outdated threads, binding
  sources, inherited secrets, i18n en/de, accessibility of the diff comments (keyboard, screen
  reader labels).
- **Audit**: every event of section 11 present, chain verifies, no values or comment texts.
- Coverage of new modules >= 80 %, OpenAPI drift check green.

### 17. Slices

Each slice is one PR for a Sonnet agent; security-review points are checked by an Opus reviewer
before merge; every slice adds its tests, keeps `pnpm test` and the OpenAPI drift check green and
adds its `[Unreleased]` changelog line.

#### Implementation status

**Nothing of this ADR is implemented.** Every slice below is **planned**; no code, migration or
endpoint of this ADR exists on `main` (2026-10-10). This table is updated by each slice's PR.

| # | Slice | State | Content | Depends on | Security review |
| --- | --- | --- | --- | --- | --- |
| S1 (#244) | Lifecycle policy, revisions, reviews and approval records (API only, not enforced) | planned | `agent_draft_revisions`, `agent_reviews`, `agent_review_decisions`; `tenants.settings` (or reuse W13-2) and the lifecycle policy resolver; rule module A1 to A8 and A10; permissions `agents:review`, `agents:approve`; endpoints to open, decide, withdraw; binding of digest, expansion digest, resolution digest (placeholder until S4) and policy digest; publish reports "would be refused" in the response and audit (shadow mode) | S10 | yes: A1/A2 cannot be bypassed by role, token or platform admin; binding fields complete |
| S2 (#245) | Comment threads and review UI | planned | threads and comments API, outdated anchors, Review tab with rule requirements, decision bar, status badges, inbox `GET /v1/me/reviews`, i18n en/de | S1 | yes: rendering without HTML; comment content out of audit and model context |
| S3 (#246) | Enforcement at publish, deprecation and rollback, audit | planned | publish with `reviewId` and `expectedDigest` under row lock, re-checks of section 4.3, no publish path without approval (no break-glass), version deprecation with rollback to approved versions, audit events of section 11 | S1 | yes: TOCTOU tests; no publish path without approval when required |
| S4 (#247) | Secret scopes, inheritance and encrypted store | planned | key service (shared with ADR 0016 S5 #235), `secrets` table, scoped references, top-down inheritance with override, `allowOverride` (default `false` on root nodes, F4), `blockInherited` and pinned resolution, secrets API without read, broker checks, rotation and revocation, leak canaries, migration helper for env pointers | – (coordinates with #235) | yes: no plaintext at rest, AAD binding, no value in any response, shadowing cannot change a published agent's credential |
| S5 (#248) | Personal secrets and development runs | planned | personal scope rules, draft runs of a revision (manual only, dev budget with 10 % default, `stage`), `allowDraftRuns`, `allowProductionSecretsInDraftRuns`, publish refusal and `with-approval` flag path | S3, S4 | yes: confused-deputy tests; personal secret never in a published version by default |
| S6 (#249) | HashiCorp Vault backend | planned | `vault` backend connection, KV v2 and dynamic secrets with leases, Kubernetes and AppRole auth first, JWT/OIDC next, per-tenant path template against the owning node, dispatcher purpose `secrets`, fakes | S4 | yes: tokens never to nodes; lease revocation; path scope |
| S7 (#250) | AWS Secrets Manager backend | planned | `aws-sm` backend connection, IRSA and per-node `AssumeRole` with `ExternalId`, ARN prefix enforcement against the owning node, version stages, fakes | S4 | yes: cross-tenant ARN refusal; no credentials to nodes |
| S8 (#251) | Agent rules | planned | protected-branch-like rules per agent or pattern (section 7): matching, aggregation, `minApprovals`, `requireFrom` with field rules on the semantic diff, `approverScope`, required checks, resolved threads, `restrictPublishers`, `reviewVia`; inheritance down the tree; management with `agents:rules` (maintainers add and tighten; loosening or deleting is admin only and audited, F8) | S3, S10 | yes: rules evaluated on the semantic diff; no bypass; loosening needs admin |
| S9 (#252) | Host review as approval | planned (later, owner decision 10) | verified identity links to host accounts, host review as approval under section 12.3, optional version tag push | S3, S12, W9-2-4 (#93) | yes: no approval from an unverified host account; attestation never counts |
| S10 (#290) | Agent Developer and Agent Maintainer roles | planned | fixed roles `agent-developer`, `agent-maintainer`; `agent-engineer` **renamed** to `agent-maintainer` without an alias, migration of every existing binding in the same migration, CHANGELOG **Breaking** entry (F2); permissions `agents:review`, `agents:approve`, `agents:rules`, role check constraints, role-binding API, group mapping and console accept the new roles | ADR 0014 S4 (merged) | yes: permission matrix; the migration grants nothing beyond the old role; grant rules unchanged |
| S11 (#291) | Directory group mappings per tenant node | planned | `directory_group_mappings`, binding source `directory`, refresh at login and token refresh, maximum age 15 minutes for approvals, no nested groups and no overage lookup (documented limits, F3), grant rules for mappings, self-grant skipped, API and console, audit; installation-wide mapping kept | S10 (coordinates with #43) | yes: escalation through mappings; no collision with grants; stable group identifiers |
| S12 (#292) | Git integrations and review via Git | planned | tenant Git integrations (URL, credential, host keys, tenant CA bundle and client certificate for that host only, `OAX_GIT_TENANT_TRUST` strict by default, F6), bindings with `reviewVia: git`, development and publish branches, contributors from linked signing keys (required when approval is required; `declared-non-production` relaxation with audit and warning, F7), publish of approved digests only, unapproved-content alerts | S3, S4, S8, W9-2-1 (#90), W9-2-2 (#91) | yes: only approved digests publish; signer linking; tenant trust scoped to one host |
| S13 (#293) | Review notifications | planned | notifications for review requested, decisions, comments, expiry, rule and mapping changes, shadowed secrets and unapproved publish-branch content through the in-console inbox and W2-5/W3-1 channels when available | S2, S3 | yes: notifications contain nothing the recipient may not read |

### 18. Roadmap mapping

- `ROADMAP.md` under v0.4 ("Agent lifecycle"): **W14 Agent lifecycle governance: four-eyes
  publish approval with review comments, agent rules, Agent Developer and Agent Maintainer roles
  with directory group mapping, review via Git, development vs published, scoped, inherited and
  encrypted secrets with Vault and AWS Secrets Manager** (design: this ADR, issues #244 to #252 and
  #290 to #293), marked as planned.
- W7-2 (#54): "uses the shared approval rule module of ADR 0017; requester and contributors never
  approve when enabled".
- W6-3 (#51): "builds on ADR 0017 approval records (digest, expansion, secret resolution, policy)".
- W9-2 (#93): "publish of Git-managed agents goes through ADR 0017 reviews; review via Git is ADR
  0017 S12; host review as approval is ADR 0017 S9".
- W5-1 (#43): "per-node directory group mapping is ADR 0017 S11; SCIM feeds it".
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
> reject, much like a pull-request review. Agent rules work like protected branches: per agent or
> name pattern, a tenant can require several approvers, approvers from a given role or team, or a
> security review for changes to credentials and network access. There is no emergency bypass. The
> approval is bound to the exact content; any later edit needs a new approval. Every published
> version carries its version number, a content digest and who approved it in the audit trail.
>
> **Agent Developer and Agent Maintainer roles** *(planned)*
> Developers build and test agents, maintainers approve and publish them, like in code hosting.
> Groups from LDAP, Active Directory, Entra ID and other directories can be mapped to these roles
> per tenant.
>
> **Review via Git** *(planned)*
> Connect a company Git repository over plain Git (HTTPS token or SSH deploy key, optional own
> certificates): a development branch feeds the drafts, and only content that was approved is
> published from the publish branch.
>
> **Credentials like in a CI server, encrypted** *(planned)*
> Store tokens and secrets per team or tenant, encrypted with a key per tenant, and reference them
> by name in agents. Like folder credentials in a CI server, tenant secrets are inherited by
> sub-tenants, which can override or block them. Values can be used by runs but never read back.
> Personal tokens are possible for development and stay out of published agents unless the tenant
> policy explicitly allows it. HashiCorp Vault and AWS Secrets Manager are planned as alternative
> secret backends.
>
> Today: agents have drafts and immutable published versions, and secrets come from the operator's
> environment or mounted files. Review, approval, agent rules, the new roles, review via Git and the
> encrypted secret store are not built yet.

**Deutsch**

> **Vier-Augen-Prinzip beim Veröffentlichen von Agenten** *(geplant)*
> Agenten werden als Entwurf entwickelt und gehen erst mit der Veröffentlichung in Produktion. Ist
> das Vier-Augen-Prinzip für einen Mandanten aktiv, muss eine andere Person die Veröffentlichung
> freigeben: Prüfer sehen die genauen Änderungen an `agents.md`, kommentieren einzelne Zeilen und
> geben frei, fordern Änderungen an oder lehnen ab, ähnlich einem Pull-Request-Review.
> Agenten-Regeln funktionieren wie geschützte Branches: Je Agent oder Namensmuster kann ein Mandant
> mehrere Prüfer verlangen, Prüfer aus einer bestimmten Rolle oder einem Team oder ein
> Sicherheits-Review für Änderungen an Zugangsdaten und Netzwerkzugriffen. Eine Notfall-Umgehung
> gibt es nicht. Die Freigabe gilt genau für diesen Inhalt; jede spätere Änderung braucht eine neue
> Freigabe. Jede veröffentlichte Version trägt ihre Versionsnummer, einen Inhalts-Hash und im
> Audit-Trail, wer sie freigegeben hat.
>
> **Rollen Agent Developer und Agent Maintainer** *(geplant)*
> Developer bauen und testen Agenten, Maintainer geben sie frei und veröffentlichen sie, wie beim
> Code-Hosting. Gruppen aus LDAP, Active Directory, Entra ID und anderen Verzeichnissen lassen sich
> je Mandant auf diese Rollen abbilden.
>
> **Review über Git** *(geplant)*
> Ein Firmen-Git-Repository wird über reines Git angebunden (HTTPS-Token oder SSH-Deploy-Key,
> optional eigene Zertifikate): Ein Entwicklungs-Branch liefert die Entwürfe, und vom
> Veröffentlichungs-Branch wird nur freigegebener Inhalt veröffentlicht.
>
> **Zugangsdaten wie in einem CI-Server, verschlüsselt** *(geplant)*
> Tokens und Secrets werden je Team oder Mandant verschlüsselt gespeichert (eigener Schlüssel je
> Mandant) und in Agenten nur über ihren Namen referenziert. Wie Ordner-Zugangsdaten in einem
> CI-Server erben Unter-Mandanten die Secrets ihres Mandanten und können sie überschreiben oder
> sperren. Läufe können sie nutzen, auslesen kann sie niemand. Persönliche Tokens sind für die
> Entwicklung möglich und bleiben aus veröffentlichten Agenten heraus, solange die
> Mandanten-Richtlinie das nicht ausdrücklich erlaubt. HashiCorp Vault und AWS Secrets Manager sind
> als alternative Secret-Speicher geplant.
>
> Heute: Agenten haben Entwürfe und unveränderliche veröffentlichte Versionen; Secrets kommen aus
> der Umgebung oder eingebundenen Dateien des Betreibers. Review, Freigabe, Agenten-Regeln, die neuen
> Rollen, Review über Git und der verschlüsselte Secret-Speicher sind noch nicht gebaut.

**ROADMAP.md line** (v0.4): "- [ ] **Agent lifecycle governance: four-eyes publish approval with
review comments, agent rules, Agent Developer and Agent Maintainer roles with directory group
mapping, review via Git, development vs published, scoped, inherited and encrypted secrets, Vault
and AWS Secrets Manager backends** (W14, design: [ADR
0017](docs/adr/0017-agent-lifecycle-governance.md), issues #244 to #252 and #290 to #293; planned,
not started) – *As a company with several departments, I want every agent version approved by
another person before it reaches production, and credentials kept per team or tenant, encrypted
and never readable, so that agents follow the same four-eyes rules as our software.*"

## Consequences

- Positive: publishing becomes a controlled, attributable act; approvals are tied to the content,
  the concrete grants, the concrete credentials and the policy; the same rule module hardens
  run-time approvals (W7-2) and version approvals (W6-3).
- Positive: agent rules let each tenant express its own separation of duties (several approvers,
  security team for credential changes, other department) instead of accepting collusion of two
  people as the only limit.
- Positive: companies manage Agent Developers and Agent Maintainers in their directory, per tenant
  node, and can keep agents in their own Git with a development and a publish branch over plain
  Git, without host-specific code.
- Positive: secrets move from operator-only environment variables to a scoped, inherited,
  encrypted, auditable store with external backends, which is the prerequisite for tenant-owned
  keys (v1.0).
- Positive: development runs with real tools become possible without touching production budgets or
  credentials.
- Negative: single-person installations cannot use four-eyes (default `off` in single-tenant mode);
  small teams may find a required second person slow, and without break-glass an urgent fix always
  waits for an eligible approver (rollback and disable help).
- Negative: inherited root secrets widen the set of agents that can use a credential; pinned
  resolution and shadowing rules add concepts that operators must understand.
- Negative: review via Git needs signed commits with keys linked to platform users when approval is
  required, which some teams do not use today.
- Negative: two more fixed roles, and renaming `agent-engineer` to `agent-maintainer` without an
  alias is a breaking change for API clients and group-mapping configuration that use the old name
  (acceptable before 1.0, F2); the first stored secret values and keys bring
  key-management duties (KEK backup, rotation) to operators; documented in
  `docs/configuration.md`.
- Negative: more tables and states in the agent registry; the review page and its comments are
  tenant content subject to retention and erasure.

## Alternatives considered

- **Approval only in the Git host** (PR reviews): rejected as the only path because the platform
  cannot verify who approved, many users build agents in the console, and a tenant policy must be
  enforced by the platform. Review via Git (section 12.2) keeps the Git workflow and lets the
  platform approve the digest; counting host reviews is the opt-in of section 12.3.
- **Platform pushes the approved commit to the publish branch itself**: not in the core, because it
  needs a write credential on a protected branch and conflicts with the read-only sync of ADR 0010;
  may come later as an optional host extension.
- **Approval as a run-time approval of a "publish" tool call**: rejected; run-time approvals have no
  diff, no threads, and their approver roles come from the agent itself.
- **Approval bound to the agent and version number only**: rejected (replay and TOCTOU, G5, G6).
- **Mutable published versions with a "promote" flag**: rejected; immutability of versions is an
  existing guarantee.
- **Break-glass publish with later ratification** (first version of this ADR): rejected by the owner
  (decision 11).
- **Minimum age of approver bindings** (first version of this ADR): rejected by the owner (decision
  18).
- **Custom roles** for developer and maintainer: rejected for now; ADR 0014 keeps a fixed role set,
  two fixed roles cover the requirement.
- **Secrets readable by their creator** (convenience): rejected; use-only is the Jenkins-credentials
  model the owner asked for and removes a whole class of leaks.
- **External secret managers only, no internal store**: rejected; small installations need a
  built-in encrypted store; external backends are pointers on top.
- **`agent-engineer` as a deprecated alias of `agent-maintainer`** (accepted version of this ADR):
  rejected by the owner (follow-up decision F2); the role is renamed outright before 1.0.
- **Nested-group expansion and Entra ID overage lookup in v1**: rejected for v1 (F3); they need
  host-specific directory calls or recursive LDAP queries and are documented limits.
- **Descendants selecting an ancestor's Git integration**: not decided here; replaced by the
  separate design direction of [ADR 0018](0018-tenant-structure-as-code.md) (F5).
- **Node-only tenant secrets with opt-in inheritance** (first version of this ADR): replaced by
  top-down inheritance (owner decision 15).
- **Live resolution of inherited secrets for published versions**: rejected; a lower node could
  change a reviewed agent's credential without review (G19).
- **Implicit fallback between scopes** (personal -> team -> tenant): rejected; it makes it unclear
  which credential a production run uses and enables confused-deputy attacks. Inheritance along the
  node chain within the `tenant:` scope is a different thing and is pinned for production.

## Open questions

### Answered by the owner on 2026-10-10

All 18 questions of the first version are answered; see "Owner decisions (2026-10-10)" in the
Context section. The eight follow-up questions of the accepted version are answered as well; see
"Owner decisions on the follow-up questions (2026-10-10)". In short:

1. Agent Developers as approvers by default: **no**; default approvers are `agent-maintainer` and
   `admin`, tenants widen with agent rules (F1).
2. `agent-engineer` alias: **no alias**; renamed to `agent-maintainer` in S10 with the binding
   migration in the same migration and a CHANGELOG **Breaking** entry (F2).
3. Directory groups: **no nested-group expansion and no Entra ID overage lookup in v1** (documented
   limits); re-evaluation at login and token refresh; a directory binding counts for an approval
   only when verified within the last 15 minutes; SCIM later with #43 (F3).
4. Top-level (root node) tenant secrets default to `allowOverride: false` (F4).
5. Git integrations across the tree: replaced by the new design direction **tenant structure as
   code**, [ADR 0018](0018-tenant-structure-as-code.md) (**Proposed**, not accepted in detail, not
   built); integrations stay node-local until it is decided (F5).
6. `OAX_GIT_TENANT_TRUST` defaults to strict and fails closed (F6).
7. Signed commits by keys linked to platform users are required for review via Git whenever an
   approval is required; relaxable only for non-production use cases with an audit entry and a
   warning (F7).
8. Maintainers may add and tighten agent rules; loosening or deleting is admin only, with an audit
   entry (F8).

### Remaining

Two sub-points of the former question 3 were not part of the answers and stay open; they do not
block S10 and are decided at the latest in S11 (#291):

1. Whether the installation-wide `OAX_OIDC_ROLE_MAPPING` and `OAX_LDAP_ROLE_MAPPING` are migrated
   into `directory_group_mappings` rows on the root node or stay configuration treated as mappings
   on the default tenant's node (the design keeps them as configuration until decided).
2. The order of S11 relative to per-tenant identity providers and SCIM (#43); the design assumes
   S11 first, with #43 feeding the same table later.

Questions about tenant structure as code are listed in ADR 0018.
