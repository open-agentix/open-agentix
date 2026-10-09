# ADR 0010: Authoring agents: no-code form builder, code view and Git-synced agent repositories

- Status: Proposed
- Date: 2026-10-04
- Amended: 2026-10-09, [Amendment 1](#amendment-1-2026-10-04-any-git-host-over-plain-git) (owner
  decision of 2026-10-04: every Git host from the start over plain Git, HTTPS with a token or SSH
  with a deploy key, no host API in the core; host-specific code only as optional extensions such
  as opening a pull request; `on-merge` only with signed commits and branch protection; one
  repository serves exactly one tenant). The passages of sections 6-13 that the amendment changes
  are corrected in place and marked "(Amendment 1)"; where anything still reads differently,
  Amendment 1 wins.
- Plan items: W9-1, W9-2, W9-3 ([implementation plan](../IMPLEMENTATION-PLAN.md), wave 9)
- Builds on: [ADR 0003](0003-policy-engine-audit-and-control-agents.md),
  [ADR 0007](0007-tenants-as-isolation-boundary.md),
  [ADR 0008](0008-agents-md-data-flow-and-isolation-contract.md) (fields, Agent Check),
  [ADR 0011](0011-outbound-network-proxies-and-private-endpoints.md) (outbound routes for Git hosts),
  [ADR 0012](0012-connections-instances-scopes-and-data-protection.md) (connection instances,
  credential rules), [ADR 0013](0013-hierarchical-tenants-and-setup-modes.md) (tenant tree: which
  node owns a binding, moves)
- Related: the real read-only demo agent ([docs/demo-repo-agent.md](../demo-repo-agent.md), W11-1)

## Context

Agents are written as `agents.md` files (YAML front matter plus one `## Agent: <id>` section of
instructions per step). The console offers three ways to get there today:

- the **workflow wizard** (`apps/ui/src/features/wizard/`) asks a business user a few questions
  and generates a draft (`generate.ts`, string templates, no parser in the bundle);
- **Agent Check / Agent Plan** (`packages/core/src/plan/*`, `docs/agent-check.md`) lints a plan
  for least privilege and generates a draft deterministically;
- the **agents.md editor** (`apps/ui/src/features/agents/AgentEditor.tsx`): a monospace
  `textarea` with line numbers and live validation through `POST /v1/agents/validate` (debounced,
  400 ms). It shows errors and warnings by path, nothing else.

After the first draft there is only code. Agent engineers are fine with that; integrators, team
leads and reviewers are not, and the fields added by ADR 0008 (`schemas`, `input`, `output`,
`when`, `access`, `tools[].profile`, `credentials`, `runtime`) made the file harder to write by
hand. Two more facts matter:

1. The Agent Check lint (LP001-LP008) runs on **plans**, not on `agents.md`. An engineer who edits
   the file directly never sees a least-privilege finding before publishing.
2. Agents live only in the platform database (`agents.draft_source`, immutable
   `agent_versions`). Teams that keep everything else in Git (infrastructure, policies, prompts)
   cannot review agents in pull requests, use branch protection, or roll back with a revert.

The owner asked for (a) a graphical no-code builder with a switch to the code view that is
round-trip safe and shows the same validation and lint live, and (b) Git repositories as a source
of agents (GitOps) with a security analysis.

## Decision

### 1. One document, two views

The `agents.md` source stays the single artifact. The builder is a **view** of it, never a second
storage format.

- The editor page gets a **Form | Code** switch (segmented control, keyboard reachable, remembers
  the last choice per user in `localStorage`). Both views edit the same draft string; switching
  never saves and never loses an unsaved change.
- The form never re-generates the file. It applies **targeted patches** to the parsed YAML
  document (front matter) and to the markdown sections (instructions), and serializes the result.
  Everything the form does not know is left byte-for-byte where it was.
- The code view stays the reference. Anything the form cannot express is still possible in code,
  and the form shows such content read-only ("edit in code").

### 2. Source edit model (`packages/core/src/agents/edit.ts`)

A pure module shared by the API and the UI (loaded as a lazy chunk on the editor route only, so
the initial bundle is unchanged):

- `openSource(source) -> EditableSource`: splits front matter and body exactly like the parser
  (`splitFrontMatter`, `normalizeSource`), parses the front matter with `yaml` `parseDocument`
  (the parser's library, CST-preserving, comments kept), and indexes the markdown into the title,
  the overview and the `## Agent: <id>` / other `##` sections.
- `formModel(editable) -> FormModel`: a typed projection of the fields the form knows (section 4)
  plus `unknown: { path, yaml }[]` for everything else (custom keys, fields of a newer schema,
  `simulation`, argument constraints the form cannot render).
- `apply(editable, ops: EditOp[]) -> EditableSource`: operations like
  `{ op: 'set', path: ['agents', 1, 'access'], value: 'read-only' }`, `insertStep`, `moveStep`,
  `removeStep`, `renameStep` (renames the id in `pipeline`, `input.from`, `when` and the section
  heading together, or refuses when a `when` cannot be rewritten safely), `setInstructions`.
  Values are validated against the zod field schemas before they are written; a value the schema
  refuses is not applied.
- `serialize(editable) -> string`: `Document.toString()` with fixed options (indent 2, line width
  0, no flow-style changes on untouched nodes) plus the untouched markdown.

Round-trip contract (tested as properties over every file in `examples/` and the fixtures):

| Case | Guarantee |
| --- | --- |
| open then serialize, no edits | byte-identical to `normalizeSource(source)` |
| a field edit | only the lines of that node change; comments on other nodes, key order, unknown keys and quoting of untouched scalars are kept |
| comments attached to an edited node | kept when the node is edited in place, dropped only when the node is removed |
| instructions | the body of the edited section is replaced; other sections, headings and blank lines are untouched |
| unknown keys | never removed, never reordered; the form lists them read-only |
| invalid YAML in the code view | the form is disabled with "fix the code first" and the parse error; no patching of a document that does not parse |

Security: the module refuses keys `__proto__`, `constructor`, `prototype` in paths and values,
caps the document at the API body limit and the parser's alias limit (`maxAliasCount`), and never
evaluates anything (no custom YAML tags, `yaml` with the core schema only).

### 3. Same validation and lint, live

- `POST /v1/agents/validate` gets an additive response field `lint: AgentPlanLint | null`. The API
  derives an `AgentPlan` from the parsed definition (`planFromDefinition`: one plan step per
  pipeline step, capabilities from concrete grants as `server/tool` and from profile grants as
  `server:profile`, `access`, `approval` from the grants, `input`/`output` schema names, `when`)
  and runs `lintPlan` against the tenant's offered connections. The lint is the same pure function
  as in `docs/agent-check.md`; no model is called.
- Both views show errors (validation, blocking), warnings (validation) and lint findings
  (advisory) in one issues list; in the form view each finding is anchored to the field it names
  (path mapping from plan paths such as `steps.2.capabilities.0` to form fields).
- Publish shows the lint findings in the publish dialog. Lint findings stay advisory in the
  console (ADR 0008 section 4: they can only add warnings). A Git binding can make lint errors
  blocking for synced versions (section 7.4).

### 4. What the form covers

| Section | Fields | Notes |
| --- | --- | --- |
| Metadata | `name` (read-only after first publish), `version` (SemVer, with a "bump patch/minor/major" helper that reads the latest published version), `description`, `owner`, `labels`, `classification` | classification is a select of the four levels |
| Triggers | `triggers[]`: webhook / mail (source picker from event sources), kafka (topic), cron (expression with a next-runs preview computed locally), manual | change-gate fields are shown when present, otherwise "edit in code" |
| Budget | `budget.*` per pipeline, `agents[].budget` per step | numbers with units; the monthly budgets are a link, not part of the file |
| Approvals | `approvals.approverRoles` | role multiselect |
| Steps | list with add, duplicate, remove, drag to reorder (and buttons for keyboard users), per step: `id`, provider instance and model (pickers from the tenant's model provider instances and their configured models, ADR 0012), `access`, instructions (markdown textarea), `outputs[].format` | the pipeline order is the list order |
| Tools | per step: profile grants (picker lists MCP server instances, then their profiles with the access class of each tool; a read-only step only offers profiles without write tools), concrete grants (`server/tool` with `approval`, `maxCallsPerRun`), argument constraints for the common cases (`type`, `required`, `pattern`, `enum`, `maxLength`) | the picker reads names, profiles and access classes only (no secrets, no tool descriptions) |
| Handovers | `schemas` (a builder for the JSON Schema subset: object, properties of type string/number/integer/boolean/enum/array of scalars, `required`, `maxLength`, `minimum`/`maximum`; anything beyond is code-only), `input.from` (multiselect of `event` and earlier steps), `output.schema` and `onInvalid` | the builder writes `$ref: "#/schemas/<name>"` |
| Conditions | `when`: rows of `path operator value` joined by all/any, paths offered from the output schemas of earlier steps and the event schema, values typed by the schema | compiled to the grammar of `docs/agents-md.md`; an expression the rows cannot represent (nested `!`, mixed `&&`/`||` groups) is shown as text and edited in code |
| Credentials | `credentials[]`: secret reference name (picker of names allowed by the tenant's `secret_refs` patterns; values are never shown or requested) and `env` | reserved env names are refused inline |
| Runtime and egress | `runtime.runner`, `runtime.toolbox`, `runtime.egress` (host list with the operator ceiling shown as a hint), per-step `runtime` overrides, `runtime.harness` (ADR 0009) | entries outside the ceiling are flagged before publish |

The form is driven by a hand-written UI descriptor next to the zod schema, not by a generic
JSON-schema form generator: every field gets a label, help text (en/de), and a validation message
the user understands.

Accessibility: every control has a visible label, the issues list is an `aria-live` region, drag
and drop has keyboard equivalents, focus moves to the first invalid field on "Show problems".

### 5. Where builder, wizard and plans meet

- **New agent** opens the form with a minimal valid skeleton; "Start from a plan" and the wizard
  keep producing a draft that opens in the form.
- The wizard stays the guided path for business users; the form is the reference editor; the code
  view is for everything else. No fourth path.
- Read-only users see the form in read-only mode (same rendering, inputs disabled), which is also
  the new "Overview" for complex pipelines.

### 6. Git-synced agent repositories: the model

An **agent repository binding** connects one path of one branch of one repository to one tenant
(and optionally one team). It is a tenant object, not a connection to an MCP server:

```json
{
  "name": "support-agents",
  "url": "ssh://git@git.example.com/acme/agents.git",
  "provider": "generic",
  "branch": "main",
  "paths": ["agents/support/**/*.agents.md"],
  "teamId": "<team uuid or null>",
  "auth": {
    "kind": "ssh-deploy-key",
    "key": "generated",
    "knownHosts": ["git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."]
  },
  "webhook": { "verify": "hmac-sha256", "header": "X-Hub-Signature-256", "secret": "acme.agents-webhook" },
  "trustedSigners": [],
  "publishMode": "manual",
  "lintMode": "block-on-error",
  "ceiling": {
    "connections": ["jira-support", "kb"],
    "secretRefs": ["acme.support.*"],
    "maxClassification": "confidential",
    "runners": ["in-process", "container"],
    "egress": ["jira.example.com"],
    "maxCostUsdPerRun": 2
  },
  "pollSeconds": 300
}
```

- `url` (Amendment 1): any Git host, reached over plain Git: `https://host[:port]/path` (smart
  HTTP) or `ssh://user@host[:port]/path` (the scp-like form `user@host:path` is accepted in the
  form and stored in the canonical `ssh://` form). The earlier fields `forge`, `baseUrl` and
  `repository` are replaced by `url` plus an optional `provider` hint (`generic`, `github`,
  `gitlab`, `gitea`, `forgejo`, `bitbucket`, `azure-devops`) that only pre-fills help texts,
  webhook header names, the token user name and the pre-pinned host keys, and selects the optional
  host extension of Amendment 1 section A1.8. The sync never depends on it.
- `auth` (credential rules of ADR 0012 section 7.4; details in Amendment 1 section A1.2):
  - `https-token`: a read-only token (fine-grained PAT, project/repository access token, deploy
    token, app password) as a secret reference, sent as HTTP Basic (`username` + token) or Bearer;
  - `ssh-deploy-key`: `key: "generated"` (default: an ed25519 key pair generated by the platform
    per binding, stored encrypted by the platform; the user adds the public key as a read-only
    deploy key) or `keyRef` (a secret reference to a key the tenant manages); host keys are pinned
    per binding (`knownHosts`, A1.4);
  - `none`: public HTTPS repositories only.
  A GitHub App installation token is an optional token source of the host extension (A1.8), not
  part of the core path.
- One repository serves exactly one tenant (owner decision, A1.9); several bindings of the same
  tenant may point at different paths or branches of it.
- One binding owns the agents it creates. An agent row gets `source_kind = 'git'`,
  `source_binding_id`, `source_path`, `source_commit` (migration `0011_agent_repositories.sql`,
  section 11). UI-created agents have `source_kind = 'ui'`.
- **Agent identity**: the front matter `name` is the agent name; it must be unique in the tenant.
  A file whose name collides with a UI-managed agent or with an agent of another binding is
  refused (`agent_name_taken`); an admin can **adopt** an existing UI agent into a binding
  explicitly (audited).
- **Team**: the binding's `teamId` is the agent's team. A file cannot choose its team, owner
  scope or role bindings; members (`/v1/agents/{id}/members`) stay a platform setting.

### 7. Sync

#### 7.1 Triggers

- **Poll** (the baseline, works with every host and needs no inbound reachability) every
  `pollSeconds` (default 300, minimum 60, with jitter) by the worker (a `repo-sync` job in the
  existing queue, one in flight per binding, `SKIP LOCKED`). (Amendment 1) The poll is a ref
  advertisement only (`ls-refs` for the bound branch); a fetch follows only when the head moved
  (A1.6).
- **Webhook poke** (optional): `POST /v1/repo-hooks/{bindingId}` checks the request with one of
  three host-neutral verification methods (Amendment 1, A1.6): `hmac-sha256` over the raw body
  (the header name comes from a fixed list), `shared-token` (a header compared in constant time)
  or `basic` (HTTP Basic credentials). These cover the webhook formats of the common hosts without
  host code. A valid request only **enqueues a sync**; the body is not parsed at all (not even for
  the branch name): the sync asks the Git host itself. Replays and floods cost at most one queued
  job per binding.
- **Manual** "Sync now" (`POST /v1/repositories/{id}/sync`, `repos:sync`).

#### 7.2 Fetch

- (Amendment 1) Resolve the branch head SHA with a Git ref advertisement, fetch that commit
  shallow (depth 1, or the verification range of A1.7 for `on-merge`; single branch, no tags,
  blob-less where the host supports it) over plain Git into a throwaway bare repository, read the
  tree at that SHA from the objects and read only blobs whose path matches `paths` (glob, no `..`,
  no absolute paths, at most 16 patterns). No working tree is checked out, so no hooks, filters or
  attributes run; the Git engine and its hardening are in A1.3, the transport in A1.4 and A1.5.
- Limits (configurable, defaults): 200 matching files, 256 KiB per file, 4 MiB of matching
  content per sync, 30 s per sync, tree listing at most 20 000 entries; transfer limits of A1.5
  (pack size, object count, inflated size, tree depth). Exceeding a limit fails the sync
  (`sync_limit`) and changes nothing.
- Files must be regular blobs (mode `100644`/`100755`). Symlinks (`120000`), submodules
  (`160000`), LFS pointers and files with NUL bytes or invalid UTF-8 are refused per file.
- Only the host of `url` is contacted, on the pinned address and port; redirects to another host
  are refused. Outbound routing (proxy, CA bundle, mTLS) follows ADR 0011 with purpose `git`, for
  SSH as well (A1.5); air-gapped mode requires the host on `OAX_AIRGAPPED_ALLOW` (refused at
  binding creation and at sync).

#### 7.3 Checks per file (in this order, each failure is reported per file and nothing of that file is applied)

1. **Secret scan**: the raw file is matched against the secret-value patterns of
   `SecretRefSchema` (`sk-`, `AKIA…`, `ghp_`, `github_pat_`, `xox?-`, PEM private-key headers,
   JWT-shaped strings) and a high-entropy heuristic for YAML string values. A hit refuses the file
   with `secret_detected`; the report and the audit entry name the path, line and rule, never the
   matched text.
2. **Parse and validate** with the same parser and validator as `POST /v1/agents`
   (`parseAgentsMd`, `validateAgentDefinition`), against the tenant's connections and profiles.
3. **Binding ceiling**: every connection or profile used must be in `ceiling.connections`, every
   credential reference must match `ceiling.secretRefs` and the tenant's `secret_refs`, the
   classification must be at most `ceiling.maxClassification`, runners in `ceiling.runners`,
   egress a subset of `ceiling.egress` (and of the operator ceiling), budgets at most
   `ceiling.maxCostUsdPerRun`. A violation is `ceiling_exceeded` with the field path.
4. **Agent Check lint** (section 3). With `lintMode: block-on-error` an LP error refuses the file;
   with `advisory` findings are attached to the candidate.
5. **Version rule**: `version` must be new for that agent, or the same version with the same
   digest (no-op). The same version with a different digest is refused (`version_conflict`):
   published versions are immutable, Git cannot rewrite them.

#### 7.4 Candidates, review and publish

- A file that passes becomes a **candidate**: the agent's draft is set to the file content
  (`draft_source`, read-only in the UI, see section 8) and a row in `agent_sync_candidates`
  (binding, path, commit SHA, digest, version, findings, status) is written.
- `publishMode: manual` (default): a user with `agents:publish` on that agent publishes the
  candidate from the console (the normal publish dialog with diff, findings and the commit link).
  The published version records `source_commit` and the binding.
- `publishMode: on-merge`: the sync publishes candidates itself, as the service actor
  `repo:<bindingId>`. (Amendment 1, owner decision) Allowed only with **both** signed commits and
  branch protection: every commit between the last published commit and the new head carries a
  valid signature by a key in the binding's `trustedSigners`, the new head descends from the last
  synced head (no history rewrite), and branch protection (A1.7: required reviews >= 1, no force
  pushes, no deletion, signed commits required) is either read through the optional host
  extension (A1.8) or covered by an explicit, audited, expiring operator attestation on the
  binding. Signatures and ancestry are verified by the platform itself over plain Git, without
  any host API. If any of this is missing, the
  sync creates candidates but does not publish them, and the binding shows why. This makes the
  host's review the review; the platform still enforces validation, ceiling, lint mode and the
  version rule.
- Removing a file never deletes an agent. The agent is marked `source_missing` and stays runnable
  in its last published version until an admin archives it (W3-6) or detaches it.
- Each sync writes a **sync report** (`GET /v1/repositories/{id}/syncs`): commit, files seen,
  candidates, refusals with codes and paths, duration.

### 8. Drift: when the console and Git disagree

- **Git wins** for Git-managed agents. Their draft is read-only in the console (form and code
  view); "Save draft" is replaced by "Copy as patch" (a unified diff against the synced file) and,
  when PR-back is configured, "Propose change" (section 9).
- **Detach** (admin, audited `repo.agent_detached`): the agent becomes UI-managed from its current
  draft; later commits to its file are refused for that agent (`agent_detached`) until it is
  adopted again.
- Published versions are never touched by a sync; a sync only creates candidates. Rollback is a
  Git revert, which arrives as a **new** version (the version rule forbids re-using a number).
- A binding that is deleted leaves its agents in place as UI-managed (`repo.binding_deleted` lists
  them).

### 9. PR-back (opt-in, W9-3)

- A binding may add a separate **write credential** (`prBack.auth`: an HTTPS token with write
  access, or a second platform-generated SSH deploy key with write access; for the API step below
  a host token or a GitHub App with `contents: write` + `pull_requests: write` on that repository)
  and `prBack.enabled: true`. It is never used by the sync.
- (Amendment 1) PR-back has two steps. **Generic, every host:** "Propose change" on a
  Git-managed agent creates a branch `oax/<agent>/<short-id>` from the last synced commit with one
  commit for the edited file (author: the platform service identity; the console user only as an
  opaque trailer `Proposed-by: <user id>`, so that no name or mail address lands in Git unless the
  tenant opts in) and pushes it over plain Git (`receive-pack`, only `refs/heads/oax/*`, never
  the bound branch, never a force push); the console shows the branch name and the host's "compare"
  hint. **Host extension, optional (A1.8):** where the `provider` has an extension (GitHub, GitLab,
  Gitea/Forgejo first) and an API credential is configured, the platform also opens the pull/merge
  request and shows its state.
- Merge conflicts are the host's problem; the platform only shows the branch and, with the API
  step, the PR link and state.
- Permission: `agents:write` on that agent plus PR-back enabled on the binding.

### 10. RBAC and audit

New permissions (additive in `packages/core/src/rbac.ts`):

| Permission | Roles | Allows |
| --- | --- | --- |
| `repos:read` | admin, agent-engineer, integrator, auditor | list bindings, sync reports, candidates |
| `repos:write` | admin, integrator | create, change, delete bindings (incl. auth references, ceilings, publish mode), adopt and detach agents |
| `repos:sync` | admin, integrator, agent-engineer | trigger a sync |
| `repos:attest` (Amendment 1) | admin | set, renew or withdraw the branch-protection attestation of a binding (A1.7) |

`publishMode: on-merge`, widening a ceiling and changing `trustedSigners` additionally need
`agents:publish` on the bound team (a binding cannot grant itself more than its creator could
publish).

Audit actions (payloads never carry file contents or secret values): `repo.binding_created`,
`repo.binding_changed` (field names only), `repo.binding_deleted`, `repo.sync_started`,
`repo.sync_finished` (commit, counts), `repo.sync_failed` (code), `repo.file_refused` (path,
code, rule), `repo.candidate_created` (agent, version, digest, commit), `agent.published` (gets
`source: { binding, commit, path }`), `repo.agent_adopted`, `repo.agent_detached`,
`repo.webhook_rejected` (rate-limited), `repo.pr_opened`; with Amendment 1 also
`repo.branch_proposed` (branch name, commit), `repo.ssh_key_generated` / `repo.ssh_key_rotated`
(public key fingerprint only), `repo.host_key_pinned` / `repo.host_key_mismatch` (fingerprints),
`repo.protection_attested` / `repo.protection_attestation_expired` (who, statement, expiry),
`repo.signature_refused` (commit, reason code), `repo.history_rewritten` (old and new head),
`repo.signers_changed` (key fingerprints), and in the platform partition
`repo.claim_refused` / `repo.claim_released` (url_key, requesting node; never the holder in the
requester's partition).

### 11. Data model (migration `0011_agent_repositories.sql`)

- `agent_repositories` (tenant-partitioned): id, tenant_id, team_id, name (unique per tenant),
  (Amendment 1) url (canonical form, A1.1), url_key (normalized host + path, A1.9), transport
  (`https|ssh`), provider (hint), branch, paths, auth (kind, references, `ssh_public_key`,
  `known_hosts`), webhook (verify method, header, secret_ref), trusted_signers, protection
  (source `api|attestation|none`, attestation actor, statement, expiry), publish_mode, lint_mode,
  ceiling, poll_seconds, last_sync_at, last_commit, last_published_commit, status. The earlier
  columns forge, base_url and repository are not created.
- (Amendment 1) `agent_repository_claims`: url_key (primary key, unique across the installation),
  tenant_id, created_at: the "one repository, one tenant" claim (A1.9). Platform partition, not
  readable by tenants.
- (Amendment 1) `agent_repository_keys`: binding, purpose (`sync|pr-back`), public key,
  fingerprint, private key encrypted with the tenant data key (ADR 0012 section 7.6), created and
  rotated timestamps. No API returns the private key.
- `agent_sync_runs`: binding, commit, started/finished, counts, report (codes and paths only).
- `agent_sync_candidates`: binding, agent_id, path, commit, digest, version, findings, status
  (`pending|published|superseded|refused`).
- `agents`: `source_kind` (`ui|git`, default `ui`), `source_binding_id`, `source_path`,
  `source_commit`, `source_state` (`synced|source_missing|detached`).
- `agent_versions`: `source_commit`, `source_binding_id` (nullable).

### 12. API (OpenAPI additions, generated by the implementing tasks)

`GET/POST /v1/repositories`, `GET/PATCH/DELETE /v1/repositories/{id}`,
`POST /v1/repositories/{id}/sync`, `GET /v1/repositories/{id}/syncs`,
`GET /v1/repositories/{id}/candidates`, `POST /v1/agents/{id}/adopt`, `POST /v1/agents/{id}/detach`,
`POST /v1/agents/{id}/propose` (PR-back), `POST /v1/repo-hooks/{bindingId}` (unauthenticated,
signature-checked, rate-limited, never on the authenticated API surface). `POST /v1/agents/validate`
gains `lint`. Amendment 1 adds `POST /v1/repositories/{id}/ssh-key` (generate or rotate; returns
the public key and fingerprint only), `POST /v1/repositories/{id}/host-keys/scan` (returns the
offered host keys and fingerprints for confirmation, stores nothing), `PUT
/v1/repositories/{id}/host-keys` (pin confirmed keys), `PUT /v1/repositories/{id}/attestation`
(`repos:attest`) and `POST /v1/repositories/{id}/test` (ref advertisement only, result as a fixed
category, ADR 0011 section 8).

### 13. Security analysis

(Amendment 1) The table covers the agent-level threats of Git sync. The threats of the Git
transport itself (hostile servers, host keys, credentials, signatures) are in A1.10.

| Threat | Where | Mitigation |
| --- | --- | --- |
| **Untrusted repository content** (anyone who can merge to the branch writes agents) | sync | Merge rights on the branch equal `agents:write` on the bound team: documented on the binding page. The binding **ceiling** bounds what such a file can reach (connections, secrets, classification, runners, egress, budget); validation, policy gate, approvals and the run-time checks are unchanged. `on-merge` only with signed commits by trusted signers and branch protection (A1.7); otherwise a human publishes. |
| **Prompt injection via agents.md** (instructions that tell the agent to misuse its tools) | runs | Not new: instructions were always author-controlled. The boundary is the grant (profiles, `access`, argument constraints, approvals) and the gate, not the prose. The Agent Check lint makes over-broad grants visible before publish; `lintMode: block-on-error` is the recommended default for Git bindings. |
| **Injection into the platform** (YAML bombs, aliases, custom tags, huge files, prototype keys) | sync, parser, edit model | `yaml` core schema, alias limit, size limits per file and per sync, refusal of `__proto__`/`constructor` keys, no custom tags, the same strict zod schemas as the API. |
| **Secrets committed to the repository** | sync | Secret scan before parsing; the file is refused, the value never stored, logged or shown; the report tells the user to rotate. `credentials[]` remain references checked against `ceiling.secretRefs` and the tenant patterns, so a file cannot name another team's or the platform's secrets. |
| **SSRF via repository URL** (a `url` pointing at internal services or metadata endpoints) | binding create, sync, PR-back | (Amendment 1) Only `https://` and `ssh://` (A1.1); every connection goes through the ADR 0011 resolver with purpose `git` as a **tenant-supplied destination**: metadata addresses always refused, private ranges only inside `privateAllow`, non-canonical IP spellings refused, resolved addresses checked and pinned (no DNS rebinding), redirects refused, plain `http://` refused. SSH connects through the same relay (A1.5), so SSH cannot be used to reach ports or hosts that HTTPS could not. The "test binding" action does a ref advertisement and reports a fixed category only (ADR 0011 section 8). |
| **Webhook abuse** (forged pokes, floods, replays) | hook endpoint | Verification in constant time (A1.6), unknown binding and bad signature look the same (404, same timing class), the body is never parsed, one queued sync per binding, per-IP and per-binding rate limits; a replay can only cause one more ref advertisement. |
| **Token scope creep** | auth | (Amendment 1) Read-only credentials for the sync (read-only deploy key, read-only token); the write credential for PR-back is separate, limited to `refs/heads/oax/*` by the platform and never used by the sync; host-extension API credentials are separate again and never used for Git transport. GitHub App tokens (extension only) are minted per call for one repository with the minimum permissions. |
| **Supply chain** (a compromised repository or host account publishes a malicious version) | publish | `manual` mode by default; `on-merge` needs signatures by trusted signers on every new commit, an ancestry check against the last synced head and branch protection (A1.7); every published version carries the commit SHA; the version rule prevents silent replacement; emergency overrides (W2-3) can block the agent; the audit chain records who/what published. |
| **Name squatting** (a file takes over an existing agent) | sync | Names owned by a UI agent or another binding are refused; adoption is explicit and audited. |
| **Cross-tenant use of one repository** (two tenants consume or race on the same agent source) | binding create | (Amendment 1) One repository serves exactly one tenant (A1.9): an installation-wide claim on the canonical `url_key`; the refusal does not reveal which tenant holds the claim. |
| **Denial of service** (huge trees, huge packs, endless renames, slow servers) | sync | Limits per sync and per transfer (A1.5), one job per binding, poll minimum 60 s, exponential backoff for failing bindings. |
| **Air gap and egress** | sync | The Git host must be allowlisted; routing through the configured proxy with purpose `git` (HTTPS and SSH); the network guard stays the inner wall. |

## Consequences

- Positive: non-developers can build and review agents without YAML; developers keep the code
  view and lose nothing (round-trip safe); the least-privilege lint shows up where agents are
  actually written.
- Positive: teams can manage agents in Git with reviews, branch protection and reverts, while the
  platform keeps immutability, validation, ceilings and the audit trail.
- Positive (Amendment 1): every Git host works from the first release (GitHub, GitHub Enterprise
  Server, GitLab, Gitea, Forgejo, Bitbucket, Azure DevOps, plain `git` servers, internal mirrors),
  with one code path to secure and test; nothing in the core depends on a vendor API.
- Negative: the `yaml` library and the edit model add a lazy chunk to the editor route (budget:
  at most 60 KiB gzip, measured in CI); keeping the form descriptor in sync with the schema is
  ongoing work (a test fails when a schema field has no descriptor entry or explicit
  "code-only" marker).
- Negative (Amendment 1): the platform runs a Git client against untrusted servers. That is a
  larger attack surface than a forge REST API and needs the sandboxing, relay and limits of
  A1.3-A1.5, a pinned minimum `git` version in the images and a hostile-server test suite. SSH
  adds host-key management for users.
- Negative (Amendment 1): branch protection cannot be read over plain Git. Without a host
  extension it rests on an operator attestation (A1.7), which can become stale; signatures and the
  ancestry check are the parts the platform verifies itself.
- Negative: Git-managed agents cannot be edited in the console without PR-back, which some users
  will find surprising; the UI says so on every such agent. Without a host extension PR-back ends
  at a pushed branch; the user opens the pull request on the host.

## Alternatives considered

- **Store a structured JSON model and generate `agents.md` from it**: loses comments, ordering and
  unknown fields, and splits the truth in two. Rejected.
- **A generic JSON-schema form library**: weak labels and help, poor accessibility for nested
  arrays, no control over code-only fields. Rejected in favour of a descriptor.
- **Forge APIs as the core path** (the first version of this ADR: GitHub, then GitLab and Gitea
  adapters reading heads, trees and blobs over REST, generic Git deferred): smaller parsing
  surface and branch protection via API, but one adapter per vendor, no support for Bitbucket,
  Azure DevOps, plain Git servers and internal mirrors, and vendor rate limits in the sync path.
  Replaced by Amendment 1 (owner decision 2026-10-04); vendor APIs survive only as optional
  extensions (A1.8).
- **A pure JavaScript Git client in the worker process** (e.g. isomorphic-git): no hooks or
  filters by construction, but it parses hostile packs inside the worker process, has no SSH
  transport and no SSH signature verification, and is less battle-tested against malicious
  servers than `git`. Rejected for the core; the engine interface (A1.3) keeps it replaceable.
- **Two-way sync with conflict resolution in the platform**: complex and surprising. Rejected:
  Git wins, changes go back as branches or pull requests.
- **Trust webhook payloads for content**: forgeable and incomplete. Rejected; with Amendment 1 the
  body is not even parsed.
- **Trust on first use for SSH host keys**: silent and invisible to users. Rejected; keys are
  confirmed explicitly or come from the shipped list of well-known hosts (A1.4).

## Open questions

Answered by the owner on 2026-10-04 (Amendment 1):

1. ~~Which forges first?~~ All Git hosts from the start, over plain Git; host APIs only as
   optional extensions (A1.8).
2. ~~Should `on-merge` additionally require signed commits?~~ Yes: signed commits **and** branch
   protection (A1.7).
3. ~~May one repository bind to several tenants?~~ No: one repository serves exactly one tenant
   (A1.9).

Still open:

4. PR-back author identity: platform service identity only, or optionally the console user's
   name and mail (personal data in Git; ADR 0012)?
5. Should the form become the default view for every role, or only for roles without
   `agents:publish`?
6. (Amendment 1) Signature formats for `trustedSigners`: SSH and OpenPGP in the first release;
   X.509/S/MIME (e.g. keyless signing with Sigstore gitsign) later or never?
7. (Amendment 1) Validity of the branch-protection attestation: default 90 days, maximum 365, or
   shorter?
8. (Amendment 1) Should the Git engine run in a separate sync container (or as a short-lived run
   node job) instead of a sandboxed child process of the worker, at least in Kubernetes
   deployments?
9. (Amendment 1) Which host extensions after GitHub, GitLab and Gitea/Forgejo: Bitbucket and
   Azure DevOps in v0.4, or on demand?

## Amendments

### Amendment 1 (2026-10-04): any Git host over plain Git

Owner decision of 2026-10-04 (recorded 2026-10-09, task PLAT-20): **all Git hosts from day one
over the plain Git protocol** (HTTPS with a token, SSH with a deploy key); **no host-specific API
in the core**; host-specific code only as **optional extensions**, such as opening a pull request
back into the repository; **"publish on merge" only with branch protection and signed commits**;
**one repository serves exactly one tenant**. The sections above are corrected in place; this
amendment holds the details.

#### A1.1 Repository URL

- Accepted schemes: `https://host[:port]/path` (Git smart HTTP, protocol v2 preferred, v0/v1
  accepted) and `ssh://user@host[:port]/path`; the scp-like form `user@host:path` is accepted in
  the form and stored as `ssh://user@host/path`. Refused: `http://`, `git://`, `file://`, `ext::`,
  any other transport or remote helper, URLs with userinfo on `https` (credentials only through
  `auth`), query strings, fragments, IP literals that are not public (ADR 0011 section 6) and
  non-canonical numeric spellings (ADR 0011 Amendment 2).
- The path must not contain `..`, control characters, whitespace or a leading `-` in any part
  (option injection); host names are IDNA-normalized and lowercased; the default port is removed.
- The canonical `url` and the derived `url_key` (A1.9) are computed once at creation and are
  immutable; changing the URL means a new binding.

#### A1.2 Credentials

- **HTTPS token** (`https-token`): a secret reference (`tokenRef`) with an optional `username`
  (pre-filled from the `provider` hint, e.g. `x-access-token`, `oauth2`; default `git`) and
  `scheme: basic | bearer`. The token is passed to Git as an `Authorization` header through
  `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` in the child environment: never in the
  URL, never in `argv`, never in a config file, never in a credential helper. Redirects are refused
  (`http.followRedirects=false`), so the header cannot follow to another host.
- **SSH deploy key** (`ssh-deploy-key`): `key: "generated"` (default) creates an ed25519 key pair
  per binding (`POST /v1/repositories/{id}/ssh-key`, also for rotation). The private key is
  encrypted with the tenant data key (ADR 0012 section 7.6) in `agent_repository_keys`, is
  written only for the duration of one Git process to a mode-0600 file on a size-limited tmpfs in
  the sync's throwaway directory and deleted afterwards. The public key and its SHA256 fingerprint
  are shown for the user to add as a **read-only** deploy key. Alternatively `keyRef` names a
  secret reference to a key the tenant manages (OpenSSH format, ed25519, ECDSA or RSA >= 3072
  bits; passphrase-protected keys are refused).
- **Rules (ADR 0012 section 7.4, ADR 0013 section 6)**: Git credentials are tenant credentials.
  They are secret references in the owning node's namespace and `secret_refs` patterns, resolved
  against the node that owns the binding; a tenant cannot name another tenant's or the platform's
  secrets. There are **no central (platform) Git credentials** shared across tenants: they would
  let one credential serve several tenants' repositories, contradicting A1.9. Git credentials are
  never brokered to run nodes and never visible to agent steps; they are used only by the sync and
  PR-back. Git credentials are not connection instances in ADR 0012's sense (agents never bind to
  them), but the processing record (ADR 0012 section 7.5) lists each binding's host as an external
  destination.
- **Separation**: the sync credential (read), the PR-back credential (write, a second generated
  key or token) and the extension API credential (A1.8) are three different references; the code
  path of each takes only its own (asserted by tests).

#### A1.3 Git engine and hardening

The engine is the `git` binary (minimum version pinned in the images and checked at start-up;
start is refused below it, `git_version_unsupported`), called through a narrow interface
(`lsRemote`, `fetch`, `listTree`, `readBlobs`, `verifyRange`, `pushBranch`) so that it can be
replaced. Every call:

- runs as a child process of the worker with an environment built from an allowlist (ADR 0011
  section 7: no inherited proxy variables, no `GIT_*` from the parent), `HOME` and `XDG_CONFIG_HOME`
  pointing into an empty throwaway directory, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_TERMINAL_PROMPT=0`, no askpass, no credential helper;
- works in a fresh **bare** repository in a per-sync directory on a size-limited tmpfs (quota =
  transfer limit x 2), deleted after the sync; nothing persists between syncs;
- forces, through `-c` options that the repository cannot override: `core.hooksPath=/dev/null`,
  `protocol.allow=never` with `protocol.https.allow=always` and `protocol.ssh.allow=always` only,
  `transfer.fsckObjects=true` (rejects malformed objects, `.gitmodules` and path tricks such as
  `.git` components), `fetch.recurseSubmodules=false`, `submodule.recurse=false`,
  `http.followRedirects=false`, `http.sslVerify=true` (no switch exists), `fetch.writeCommitGraph=false`,
  `gc.auto=0`, `maintenance.auto=false`;
- never checks out a working tree: contents are read with `git ls-tree -r -z` and
  `git cat-file --batch` without `--filters`/`--textconv`, so clean/smudge filters, `.gitattributes`,
  LFS and hooks never run. Git LFS is not installed in the images; LFS pointer files are refused
  per file (`lfs_pointer`). Submodules are never fetched; gitlinks (`160000`) in matching paths
  are refused per file, `.gitmodules` is ignored;
- runs under resource limits: wall-clock timeout (the sync limit), CPU and memory limits
  (`ulimit` or the cgroup of the worker container), at most 1 Git process per sync and a global
  concurrency limit (`OAX_GIT_MAX_CONCURRENT`, default 4);
- never echoes server-provided text into reports, audit or UI: stderr of `git` is classified into
  fixed codes (`auth_failed`, `not_found`, `host_key_mismatch`, `transfer_limit`, `protocol_error`,
  `timeout`, ...) and otherwise only logged at debug level with credentials redacted.

#### A1.4 SSH host keys

- Host keys are **pinned per binding** (`knownHosts`). There is no trust on first use and no
  automatic acceptance of new keys (`StrictHostKeyChecking=yes`, `UpdateHostKeys=no`,
  `HostKeyAlias=<canonical host[:port]>`, `CheckHostIP=no`, `UserKnownHostsFile=<per-sync file>`,
  `GlobalKnownHostsFile=/dev/null`, `-F /dev/null`, `IdentitiesOnly=yes`, `BatchMode=yes`,
  `ForwardAgent=no`, `PermitLocalCommand=no`, no `ControlMaster`).
- Pinning: for well-known hosts (github.com, gitlab.com, bitbucket.org, ssh.dev.azure.com,
  codeberg.org) the platform ships a reviewed list of the vendors' published host keys, updated
  with releases; the binding pre-fills them. For other hosts
  `POST /v1/repositories/{id}/host-keys/scan` connects once through the resolver and returns the
  offered keys and their SHA256 fingerprints without storing anything; a user with `repos:write`
  compares them with the fingerprints published by the host's administrators and confirms them
  with `PUT /v1/repositories/{id}/host-keys` (audited `repo.host_key_pinned`). Keys may also be
  pasted in `known_hosts` format.
- Allowed host key algorithms: ed25519, ECDSA (nistp256/384/521), RSA with SHA-2 signatures
  (`rsa-sha2-256/512`, >= 2048 bits); `ssh-rsa` with SHA-1 and DSA are refused, as are weak
  key-exchange algorithms and ciphers (an explicit modern algorithm list is passed to `ssh`).
- A mismatch fails the sync with `host_key_mismatch`, audits `repo.host_key_mismatch` with both
  fingerprints and sets the binding to `failing` until a user re-pins; several pinned keys per
  host allow planned rotation.

#### A1.5 Transport, egress and limits

- **One route decision.** Every Git connection (ref advertisement, fetch, push, host-key scan)
  is resolved by the ADR 0011 resolver with purpose `git` and origin `tenant`. The resolver gains
  the `ssh` scheme (default port 22, host re-parsed and validated like `ldap`, ADR 0011
  Amendment 2) and accepts it for purpose `git` only. `ssh` is tunnelled through an HTTP proxy
  with `CONNECT host:port` like HTTPS; many corporate proxies only allow port 443, so the docs
  point at the hosts' SSH-over-443 endpoints (e.g. `ssh.github.com:443`, `altssh.gitlab.com:443`).
- **Local relay.** The worker opens the upstream connection itself through the ADR 0011
  dispatcher factory (direct to the checked and pinned address, or `CONNECT` through the selected
  proxy with platform proxy credentials) and hands Git only a local stream: for SSH a
  `ProxyCommand` that connects to the relay over a per-sync Unix socket, for HTTPS
  `http.proxy=http://127.0.0.1:<ephemeral port>` with a per-sync relay that accepts exactly one
  `CONNECT` target (the binding's host and port) and nothing else. TLS stays end to end between
  Git and the host; Git gets the ADR 0011 trust bundle as `http.sslCAInfo` and, where a route
  sets one, the client certificate as `http.sslCert`/`http.sslKey` (tmpfs, 0600). Git itself
  never resolves names or opens sockets, so DNS pinning, proxy choice, the air-gapped allowlist
  and the network guard apply to Git exactly as to every other outbound client, and proxy
  credentials never reach the Git process.
- **Transfer limits** (configurable, defaults), enforced by the relay and the engine: 64 MiB
  received per sync (bytes counted in the relay; the connection is cut at the limit), 100 000
  objects and 256 MiB inflated in the throwaway repository (checked after `fetch` and on the
  tmpfs quota), tree depth 32, path length 4 096 bytes, 30 s wall clock per sync (60 s for a
  sync that verifies a range, A1.7). Exceeding any limit is `sync_limit` (or `transfer_limit`)
  and changes nothing. Large monorepos are not the target: the docs recommend a dedicated agents
  repository or a narrow `paths` set; blob-less partial fetch (`--filter=blob:none`, used when the
  server advertises `filter`) keeps the transfer close to the matching files.
- **Shallow fetch.** Depth 1 for `manual` bindings; for `on-merge` the fetch deepens until the
  last published commit is reached, at most `maxVerifyCommits` (default 200) commits (A1.7).
  Tags are never fetched.

#### A1.6 Change detection: polling baseline, optional webhooks

- **Polling is the baseline** and the only mechanism that must work: a ref advertisement for
  `refs/heads/<branch>` every `pollSeconds`; a fetch only when the head differs from
  `last_commit`. It needs no inbound reachability (air-gapped and private installations), no host
  configuration and no shared secret. Failing bindings back off exponentially (up to 1 hour) and
  show `failing` with the error code.
- **Webhooks are optional** and only shorten the delay. Host-neutral verification methods:

  | `webhook.verify` | Check | Covers |
  | --- | --- | --- |
  | `hmac-sha256` | HMAC-SHA256 of the raw body with the secret, hex, optional `sha256=` prefix, constant-time compare; header from a fixed list: `X-Hub-Signature-256`, `X-Gitea-Signature`, `X-Forgejo-Signature`, `X-Hub-Signature`, `X-OAX-Signature` | GitHub, Gitea, Forgejo, Bitbucket and any sender that can sign |
  | `shared-token` | constant-time compare of a header value with the secret; header from a fixed list: `X-Gitlab-Token`, `X-OAX-Token` | GitLab, simple CI senders |
  | `basic` | HTTP Basic credentials compared in constant time | Azure DevOps service hooks, generic senders |

  The secret is a secret reference (at least 32 bytes of entropy for generated secrets). The body
  is read up to 1 MiB for the HMAC and then discarded unparsed. A valid poke enqueues a sync (at
  most one queued per binding); the sync then polls as above. The endpoint is outside the
  authenticated API, rate-limited per IP and per binding, and an unknown binding and a bad
  signature both answer 404.

#### A1.7 Publish on merge: signatures, ancestry, branch protection

`publishMode: on-merge` publishes candidates as `repo:<bindingId>` only when **all** of the
following hold for the new head; otherwise the sync creates candidates for manual publishing and
the binding shows the missing condition:

1. **Signatures, verified by the platform over plain Git.** Every commit reachable from the new
   head and not from `last_published_commit` (all parents, merge commits included) carries a valid
   signature by a key in `trustedSigners`. Verification uses the fetched objects only:
   `gpg.format=ssh` with an `allowedSignersFile` generated from `trustedSigners` for SSH
   signatures, and a throwaway OpenPGP keyring for OpenPGP signatures; `git` reports the
   status per commit (`%G?`, `%GF`). Unsigned commits, unknown keys, expired or revoked keys and
   "good but untrusted" signatures all fail (`repo.signature_refused` with commit and reason code).
   Hosts that sign merges made in their web interface publish their signing key; a team that
   merges in the web interface adds that key to `trustedSigners`, otherwise merges must be made
   and signed locally. `trustedSigners` holds public keys only (with an optional label), is
   changed with `repos:write` plus `agents:publish` on the bound team, and every change is audited.
2. **Ancestry.** The new head descends from `last_commit` (fast-forward). A head that does not
   (force push, history rewrite, branch deleted and recreated) is never published automatically:
   the binding switches to candidates-only and audits `repo.history_rewritten` until an admin
   acknowledges it. If `last_published_commit` is not reached within `maxVerifyCommits`, nothing is published
   automatically either.
3. **Branch protection.** Required reviews >= 1, no force pushes, no deletion and required signed
   commits on the bound branch, established by one of:
   - the **host extension** (A1.8) reading the protection rules with the extension credential at
     every sync; or
   - an **operator attestation** on the binding (`PUT /v1/repositories/{id}/attestation`,
     permission `repos:attest`): a fixed statement of these rules, the actor, and an expiry
     (default 90 days, maximum 365; reminders before expiry; an expired attestation switches the
     binding to candidates-only). The platform cannot check an attestation; the binding page says
     so, and the ancestry and signature checks stay in force regardless.
4. The usual per-file checks of section 7.3 (secret scan, validation, ceiling, lint mode, version
   rule) passed.

#### A1.8 Optional host extensions

Host-specific code lives behind one optional interface and is never needed for sync, validation
or publishing:

```ts
interface GitHostExtension {
  provider: 'github' | 'gitlab' | 'gitea' | 'forgejo' | 'bitbucket' | 'azure-devops';
  capabilities: { openChangeRequest: boolean; readChangeRequest: boolean; readBranchProtection: boolean };
  // the API base is derived from the binding's canonical url by fixed rules per provider
  // (github.com -> api.github.com, GitHub Enterprise Server -> https://<host>/api/v3,
  //  GitLab -> https://<host>/api/v4, Gitea/Forgejo -> https://<host>/api/v1); never user-supplied
  openChangeRequest(input: { sourceBranch: string; targetBranch: string; title: string; body: string }):
    Promise<{ url: string; number: string; state: 'open' }>;
  readChangeRequest(ref: { number: string }): Promise<{ url: string; state: 'open' | 'merged' | 'closed' }>;
  readBranchProtection(branch: string):
    Promise<{ requiredReviews: number; forcePushAllowed: boolean; deletionAllowed: boolean; signedCommitsRequired: boolean } | 'unsupported'>;
}
```

- The extension uses its own credential (`extension.auth`: a token reference or, for GitHub, an
  App with an installation token minted per call for exactly this repository with
  `pull_requests: write` and `administration: read` only where protection is read), the same
  resolver route (purpose `git`, tenant destination) and fixed API paths; the API host must be the
  repository host or the provider's fixed API host. A user can never choose a path.
- Responses are parsed with strict schemas; only the fields above are kept; free text from the
  host (titles, descriptions) is never stored or shown beyond the change-request URL and state.
- Failure of an extension degrades to the generic behaviour (branch pushed without a pull
  request; protection via attestation) and never blocks a sync.
- First extensions: GitHub (incl. Enterprise Server), GitLab, Gitea/Forgejo. Bitbucket and Azure
  DevOps follow on demand (open question 9).

#### A1.9 One repository, one tenant

- `url_key` = lowercase host + port (if not default) + path without a trailing `/` and `.git`;
  `https` and `ssh` URLs of the same repository map to the same key where the host uses the same
  path for both, and the `provider` hint adds the known mappings where it does not (Azure DevOps
  `v3/org/project/repo` vs `org/project/_git/repo`).
- The first binding claims the key installation-wide (`agent_repository_claims`, unique). Further
  bindings of the **same tenant node** may use the same key (other paths or branches); a binding in
  any other node (another organisation, a parent, a child or a sibling, ADR 0013) is refused with
  `repository_unavailable`. The refusal does not name the holder, is only returned after the
  caller's own credentials passed a ref advertisement (so only someone who can already read the
  repository learns that it is bound), is rate-limited and is audited in the platform partition.
  Operators can release a claim (audited).
- The claim follows the node: moves inside an organisation (ADR 0013 section 9.1) keep it; a move
  into another organisation (section 9.2) keeps the claim with the moved node, rotates webhook
  secrets, drops the attestation and sets `on-merge` bindings to candidates-only until a target
  admin confirms them; secret references are mapped like other secret references (`secretRefMap`).
  Converting a team into a sub-tenant (section 9.3) moves bindings whose `teamId` is that team to
  the new node. Deleting the last binding of a key releases the claim.
- Limits: mirrors and forks under another URL are different keys; the platform cannot detect that
  two URLs carry the same content. The documentation says so.

#### A1.10 Threat model of the Git transport

| Threat | Mitigation |
| --- | --- |
| **Hostile Git server** (malicious packs, delta bombs, oversized objects, crafted trees or paths, `.gitmodules` tricks, endless streams) | `transfer.fsckObjects`, byte cap in the relay, object/inflated-size/depth/path limits, tmpfs quota, wall-clock timeout, no checkout, bare throwaway repository, minimum `git` version for known client CVEs, hostile-server test suite (W9-2-7). |
| **Code execution through Git features** (hooks, clean/smudge filters, `core.fsmonitor`, `core.sshCommand`, `ext::` transport, submodule recursion, LFS) | No system/global config, forced `-c` options, `protocol.allow=never` except https/ssh, no working tree, no submodules, no LFS client, repository config of the server is never read (a fetch does not transfer config). |
| **Host impersonation / MITM** | SSH: pinned host keys, no TOFU, modern algorithms only, mismatch fails closed. HTTPS: ADR 0011 trust store, no verification switch, SNI and hostname checks, no redirects. |
| **SSRF and port scanning through Git** | Resolver with tenant-destination rules for both schemes, DNS pinning in the relay, one `CONNECT` target per sync, fixed error categories without server text or timing detail. |
| **Credential leakage** (token in URL, `argv`, logs, error text, remote config, child environment; private key on disk) | Token only via `GIT_CONFIG_*` environment of the one child, never in URL/argv/files; userinfo in URLs refused; stderr classified and redacted; private keys encrypted at rest, on tmpfs only during the call, deleted afterwards; tests search logs, reports, audit payloads and `/proc/<pid>/cmdline` of the child for the values. |
| **Over-privileged credentials** | Read-only deploy key or token for sync; separate write credential for PR-back limited by the platform to new `refs/heads/oax/*` branches without force; extension credential separate. The binding page shows which credential has which purpose. |
| **Forged authorship and history rewrite** | `on-merge` requires trusted signatures on every new commit and fast-forward ancestry; otherwise only candidates. Commit author names are never trusted for anything. |
| **Stale or false branch-protection claim** | Read via extension at every sync where available; otherwise an expiring, audited attestation by `repos:attest`; signatures and ancestry are checked independently. |
| **Cross-tenant data mixing** | One repository per tenant (A1.9); bindings, keys, claims, sync runs and candidates are tenant-partitioned; credentials resolved only against the owning node. |
| **Resource exhaustion by many bindings** | Global Git concurrency limit, poll minimum 60 s with jitter, backoff for failing bindings, per-tenant binding quota (`OAX_REPO_BINDINGS_PER_TENANT`, default 20). |
| **PR-back abuse** (push to the bound branch, overwrite of other branches, path escape) | Fixed refspec `refs/heads/oax/<agent>/<id>`, create-only (push fails if the ref exists), no force, no tags; only files inside the binding's `paths`; the push credential is never used by the sync. |

#### A1.11 Impact on the work breakdown (wave 9)

| Task | Issue | Change |
| --- | --- | --- |
| W9-2-1 | #90 | Retitled "Repository bindings: migration 0011, permissions, URL canonicalization, credentials and host keys". No GitHub adapter. Adds: URL rules (A1.1), `url_key` and claims (A1.9), auth kinds and generated SSH keys (A1.2), host-key scan and pinning with the shipped list (A1.4), `repos:attest`. |
| W9-2-8 (new) | to be created | Git engine and transport relay (A1.3, A1.5): pinned `git`, hardened child process, HTTPS and SSH relay through the ADR 0011 dispatcher factory, transfer limits, error classification. Depends on W9-2-1 and on W10-1-2 (#99, dispatcher factory). W9-2-2 depends on it. |
| W9-2-2 | #91 | Fetch through the engine (ref advertisement, shallow/blob-less fetch, tree and blob reads) instead of forge REST calls; range fetch and signature verification for `on-merge` (A1.7). |
| W9-2-3 | #92 | Host-neutral verification methods (A1.6) instead of per-forge formats; the body is not parsed; no branch filter. |
| W9-2-4 | #93 | `on-merge` conditions of A1.7 (signatures, ancestry, extension or attestation), history-rewrite handling. |
| W9-2-5 | #94 | Retitled "Optional host extensions: GitHub, GitLab, Gitea/Forgejo" (A1.8): change requests and branch-protection reads; moves to v0.4 next to W9-3; no longer a prerequisite of any sync task. |
| W9-2-6 | #95 | Console additions: SSH public key display and rotation, host-key confirmation, `trustedSigners`, attestation with expiry, webhook verify method, claim refusal message. |
| W9-2-7 | #96 | Becomes a hostile **Git server** suite (malicious packs, delta bombs, redirects, host-key change, hooks/filters/submodules/LFS attempts, force push, unsigned and wrongly signed commits, token leakage search) in addition to the hostile repository content cases; runs against real `git` servers in containers (e.g. a test Gitea or `git http-backend` plus `sshd`). |
| W9-3-1 | #97 | Generic branch push over Git for every host; the pull request through the optional extension only. |
| W10-1-2 / W10-1-3 | #99 / #100 | The dispatcher factory exposes a raw stream dialer (direct pinned TCP or `CONNECT` through a proxy) for the Git relay; the resolver accepts `ssh` for purpose `git`. |
| W13-11 / W13-15 / W13-14 | (ADR 0013) | Moves and team conversion carry bindings and claims as in A1.9. |

The implementation plan (wave 9 tables) is updated in the same change; the GitHub issues follow
when the amendment is accepted.

### Amendment 2 (2026-10-09): agent output delivery in the worker (DOG-3a/3b)

The PR-back credential rules of A1.2 and A1.10 extend from the sync's PR-back to **agent output
delivery**: a pipeline step with a `pull-request` output is delivered by the trusted worker, never
by a run node or a model (dogfooding plan D5, `docs/dogfooding-phase-1.md`). The first slice lives
in `apps/worker/src/git/` and implements the subset below; the consumer (`pull-request` output
delivery, operator targets from `OAX_PR_TARGETS`, DOG-3c) and the seed endpoint (DOG-4) follow.

- **Engine subset (A1.3, A1.5), HTTPS only.** `GitEngine`/`GitSession`: `lsRemote`, `fetchCommit`
  (depth 1, by commit id), `snapshot`/`exportSeed` (tree read with `ls-tree` and `cat-file`, no
  checkout; links, gitlinks, LFS pointers, oversized and unsafe-path files are left out and
  listed), `applyAndPushBranch`. Environment allowlist, throwaway `HOME`, forced `-c` options
  (`core.hooksPath=/dev/null`, `protocol.allow=never` plus https, `safe.bareRepository=explicit`,
  `transfer.fsckObjects`, `http.followRedirects=false`, `http.sslVerify=true`, ...), process group
  kill on timeout, output caps, global concurrency limit, version check. The credential travels
  only as `http.<origin>/.extraheader` in `GIT_CONFIG_*` of the one child; tests search argv,
  environment, files, audit entries and errors for the value.
- **Relay (A1.5).** The `git` child gets `http.proxy=http://127.0.0.1:<port>` and a loopback relay
  that accepts exactly one `CONNECT host:port`, dials it through the new
  `OutboundDispatcher.dial()` (route decision, air-gapped allowlist, DNS pinning, operator proxy
  with its credentials) and counts bytes against the transfer limits. TLS stays end to end; the
  trust bundle of the route is written to a 0600 file as `http.sslCAInfo`. `dial()` is the raw
  stream dialer that A1.11 announced for W10-1-2.
- **Patch application.** The worker re-validates the node's patch (`checkPatch`: digest, strict
  line parser with hunk counts, allowlisted paths, no renames, copies, mode changes, special
  modes, binary patches), applies it with `git apply --check` and `git apply --cached` in a
  **temporary index** (a variation of "temporary worktree": no working tree exists, so no filter,
  attribute or hook can run), verifies with `diff-tree` that the result differs from the base by
  exactly the declared files and regular modes, commits with `commit-tree` and pushes
  `<commit>:refs/heads/<branch>` as a **new ref only** (existing branch: `branch_exists`, the
  host also checks the old value; no force, no tags, no deletion).
- **Exfiltration tripwire.** Patch, commit message, pull request title and body are scanned for
  credential-shaped text (patterns, one level of base64/hex/reversal, exact known secrets) before
  delivery; a hit blocks it (`secret_detected`; the audit entry carries pattern names and
  digests only). The test-code exfiltration channel of `docs/workspace-tools.md` stays a residual
  risk that the human review of the draft closes.
- **GitHub extension slice (A1.8).** `GitHubExtension` has exactly two operations on exactly one
  configured repository: `countOpenPullRequests(headPrefix)` and `openDraftPullRequest`. `draft`
  is a constant, base and head prefix come from the target, the open limit is queried before every
  creation, title and body are capped and scanned, answers are reduced to
  `{ number, url, state, draft }`. It has its own credential reference. No endpoint for
  completing, reviewing, labelling or dispatching exists in the code, and a test greps the sources.
  Labels (`POST .../issues/{n}/labels`) are deliberately not part of this slice.
- **Audit.** `git.clone`, `git.apply`, `git.push`, `git.refused` and `git.pr_open` entries carry
  commit ids, digests, counts and codes, never content, URLs with credentials or host text.
- **Limits that remain.** Behind an HTTP proxy the proxy resolves the destination name (ADR 0011
  amendment 3). A delta bomb inside a blob is bounded by the byte cap, the wall clock and
  `GIT_ALLOC_LIMIT`, not by the tmpfs quota (the worker checks the repository size after the
  fetch). SSH is not part of this slice.
