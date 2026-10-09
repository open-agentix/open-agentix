# ADR 0010: Authoring agents: no-code form builder, code view and Git-synced agent repositories

- Status: Proposed
- Date: 2026-10-04
- Plan items: W9-1, W9-2, W9-3 ([implementation plan](../IMPLEMENTATION-PLAN.md), wave 9)
- Builds on: [ADR 0003](0003-policy-engine-audit-and-control-agents.md),
  [ADR 0007](0007-tenants-as-isolation-boundary.md),
  [ADR 0008](0008-agents-md-data-flow-and-isolation-contract.md) (fields, Agent Check),
  [ADR 0011](0011-outbound-network-proxies-and-private-endpoints.md) (outbound routes for Git hosts),
  [ADR 0012](0012-connections-instances-scopes-and-data-protection.md) (connection instances)
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
  "forge": "github",
  "baseUrl": "https://github.com",
  "repository": "acme/agents",
  "branch": "main",
  "paths": ["agents/support/**/*.agents.md"],
  "teamId": "<team uuid or null>",
  "auth": { "kind": "github-app", "appIdSecret": "acme.gh-app-id", "privateKeySecret": "acme.gh-app-key", "installationId": 1234 },
  "webhookSecret": "acme.agents-webhook",
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

- `forge`: `github` (incl. GitHub Enterprise Server via `baseUrl`), `gitlab`, `gitea` in this ADR;
  generic Git over HTTPS/SSH is deferred (Alternatives).
- `auth` (secret references only, ADR 0004 rules and the tenant's `secret_refs` patterns apply):
  - `github-app` (preferred): app id and private key; the platform mints a short-lived
    installation token per sync with `contents: read` and `metadata: read` (and nothing else; the
    token request names the single repository);
  - `token`: a fine-grained PAT / GitLab project access token / Gitea token with read-only
    contents scope;
  - `none`: public repositories only (rate limits apply).
  SSH deploy keys come with the generic Git adapter (deferred); the forge adapters use HTTPS.
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

- **Poll** every `pollSeconds` (default 300, minimum 60) by the worker (a `repo-sync` job in the
  existing queue, one in flight per binding, `SKIP LOCKED`).
- **Webhook poke**: `POST /v1/repo-hooks/{bindingId}` verifies the forge signature
  (GitHub `X-Hub-Signature-256` HMAC, GitLab `X-Gitlab-Token` compared in constant time, Gitea
  `X-Gitea-Signature` HMAC) with the binding's `webhookSecret`, checks the event is a push to the
  bound branch, and only **enqueues a sync**. The payload is never trusted for content: the sync
  fetches the branch head itself. Replays and floods cost at most one queued job per binding.
- **Manual** "Sync now" (`POST /v1/repositories/{id}/sync`, `repos:sync`).

#### 7.2 Fetch

- Resolve the branch head SHA through the forge API, then read the tree at that SHA and fetch only
  blobs whose path matches `paths` (glob, no `..`, no absolute paths, at most 16 patterns).
- Limits (configurable, defaults): 200 matching files, 256 KiB per file, 4 MiB per sync, 30 s per
  sync, tree listing at most 20 000 entries. Exceeding a limit fails the sync (`sync_limit`) and
  changes nothing.
- Files must be regular blobs (mode `100644`/`100755`). Symlinks (`120000`), submodules
  (`160000`), LFS pointers and files with NUL bytes or invalid UTF-8 are refused per file.
- Only the forge host of `baseUrl` is contacted; redirects to another host are refused. Outbound
  routing (proxy, CA bundle, mTLS) follows ADR 0011 with purpose `git`; air-gapped mode requires
  the host on `OAX_AIRGAPPED_ALLOW` (refused at binding creation and at sync).

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
  `repo:<bindingId>`. Allowed only when the binding asserts that the branch is protected (the sync
  checks the forge's branch protection API where available: required reviews >= 1, no force
  pushes; otherwise the binding stays `manual` and shows why). This makes the forge review the
  review; the platform still enforces validation, ceiling, lint mode and the version rule.
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

- A binding may add a separate **write credential** (`prBack.auth`, GitHub App with
  `contents: write` + `pull_requests: write` on that repository, or a token) and
  `prBack.enabled: true`. It is never used by the sync.
- "Propose change" on a Git-managed agent creates a branch `oax/<agent>/<short-id>` from the last
  synced commit, commits the edited file (author: the platform service identity; the console user
  only as an opaque trailer `Proposed-by: <user id>`, so that no name or mail address lands in Git
  unless the tenant opts in), and opens a pull request against the bound branch. It never pushes
  to the bound branch.
- Merge conflicts are the forge's problem; the platform only shows the PR link and state.
- Permission: `agents:write` on that agent plus PR-back enabled on the binding.

### 10. RBAC and audit

New permissions (additive in `packages/core/src/rbac.ts`):

| Permission | Roles | Allows |
| --- | --- | --- |
| `repos:read` | admin, agent-engineer, integrator, auditor | list bindings, sync reports, candidates |
| `repos:write` | admin, integrator | create, change, delete bindings (incl. auth references, ceilings, publish mode), adopt and detach agents |
| `repos:sync` | admin, integrator, agent-engineer | trigger a sync |

`publishMode: on-merge` and widening a ceiling additionally need `agents:publish` on the bound
team (a binding cannot grant itself more than its creator could publish).

Audit actions (payloads never carry file contents or secret values): `repo.binding_created`,
`repo.binding_changed` (field names only), `repo.binding_deleted`, `repo.sync_started`,
`repo.sync_finished` (commit, counts), `repo.sync_failed` (code), `repo.file_refused` (path,
code, rule), `repo.candidate_created` (agent, version, digest, commit), `agent.published` (gets
`source: { binding, commit, path }`), `repo.agent_adopted`, `repo.agent_detached`,
`repo.webhook_rejected` (rate-limited), `repo.pr_opened`.

### 11. Data model (migration `0011_agent_repositories.sql`)

- `agent_repositories` (tenant-partitioned): id, tenant_id, team_id, name (unique per tenant),
  forge, base_url, repository, branch, paths, auth (references), webhook_secret_ref, publish_mode,
  lint_mode, ceiling, poll_seconds, last_sync_at, last_commit, status.
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
gains `lint`.

### 13. Security analysis

| Threat | Where | Mitigation |
| --- | --- | --- |
| **Untrusted repository content** (anyone who can merge to the branch writes agents) | sync | Merge rights on the branch equal `agents:write` on the bound team: documented on the binding page. The binding **ceiling** bounds what such a file can reach (connections, secrets, classification, runners, egress, budget); validation, policy gate, approvals and the run-time checks are unchanged. `on-merge` only with branch protection; otherwise a human publishes. |
| **Prompt injection via agents.md** (instructions that tell the agent to misuse its tools) | runs | Not new: instructions were always author-controlled. The boundary is the grant (profiles, `access`, argument constraints, approvals) and the gate, not the prose. The Agent Check lint makes over-broad grants visible before publish; `lintMode: block-on-error` is the recommended default for Git bindings. |
| **Injection into the platform** (YAML bombs, aliases, custom tags, huge files, prototype keys) | sync, parser, edit model | `yaml` core schema, alias limit, size limits per file and per sync, refusal of `__proto__`/`constructor` keys, no custom tags, the same strict zod schemas as the API. |
| **Secrets committed to the repository** | sync | Secret scan before parsing; the file is refused, the value never stored, logged or shown; the report tells the user to rotate. `credentials[]` remain references checked against `ceiling.secretRefs` and the tenant patterns, so a file cannot name another team's or the platform's secrets. |
| **SSRF via repository URL** (`baseUrl` pointing at internal services or metadata endpoints) | binding create, sync | `https` only (plain `http` only for an operator-allowed internal forge); host must not be an IP literal of a private, loopback, link-local or metadata range and every resolved address is checked numerically like the run-node egress proxy (ADR 0011 section 6); the connection is made to the checked address (no second lookup, no DNS rebinding); redirects to another host refused; the forge API paths are fixed by the adapter (a user cannot choose a path); the "test binding" button reports a fixed category only (ADR 0011 section 8). |
| **Webhook abuse** (forged pushes, floods) | hook endpoint | Signature check in constant time, unknown binding = 404 without timing difference, payload never used for content, one queued sync per binding, per-IP and per-binding rate limits. |
| **Token scope creep** | auth | GitHub App tokens minted per sync for one repository with `contents: read`; PATs are documented as read-only fine-grained tokens; the write credential for PR-back is separate and never used by the sync. |
| **Supply chain** (a compromised repository or forge account publishes a malicious version) | publish | `manual` mode by default; `on-merge` needs branch protection; every published version carries the commit SHA; the version rule prevents silent replacement; emergency overrides (W2-3) can block the agent; the audit chain records who/what published. Signed commits as an optional requirement are an open question. |
| **Name squatting** (a file takes over an existing agent) | sync | Names owned by a UI agent or another binding are refused; adoption is explicit and audited. |
| **Denial of service** (huge trees, endless renames) | sync | Limits per sync, one job per binding, poll minimum 60 s. |
| **Air gap and egress** | sync | The forge host must be allowlisted; routing through the configured proxy with purpose `git`; the network guard stays the inner wall. |

## Consequences

- Positive: non-developers can build and review agents without YAML; developers keep the code
  view and lose nothing (round-trip safe); the least-privilege lint shows up where agents are
  actually written.
- Positive: teams can manage agents in Git with reviews, branch protection and reverts, while the
  platform keeps immutability, validation, ceilings and the audit trail.
- Negative: the `yaml` library and the edit model add a lazy chunk to the editor route (budget:
  at most 60 KiB gzip, measured in CI); keeping the form descriptor in sync with the schema is
  ongoing work (a test fails when a schema field has no descriptor entry or explicit
  "code-only" marker).
- Negative: three forge adapters to maintain; generic Git is deferred.
- Negative: Git-managed agents cannot be edited in the console without PR-back, which some users
  will find surprising; the UI says so on every such agent.

## Alternatives considered

- **Store a structured JSON model and generate `agents.md` from it**: loses comments, ordering and
  unknown fields, and splits the truth in two. Rejected.
- **A generic JSON-schema form library**: weak labels and help, poor accessibility for nested
  arrays, no control over code-only fields. Rejected in favour of a descriptor.
- **Generic Git (smart HTTP/SSH) first**: SSH host keys, hooks, filters and pack parsing are a
  larger attack surface; forge APIs give branch protection, App tokens, webhooks and PRs. Deferred
  to a later item with a sandboxed `git` binary (no hooks, no filters, `GIT_CONFIG_NOSYSTEM`,
  pinned known hosts).
- **Two-way sync with conflict resolution in the platform**: complex and surprising. Rejected:
  Git wins, changes go back as PRs.
- **Trust webhook payloads for content**: forgeable and incomplete. Rejected.

## Open questions

1. Which forges first: GitHub only for the first release of W9-2, or GitHub and GitLab together?
2. Should `publishMode: on-merge` additionally require signed commits (GitHub verified signatures)?
3. May one repository bind to several tenants (a shared catalogue of agents), or is one tenant per
   binding enough? This ADR assumes one tenant per binding.
4. PR-back author identity: platform service identity only, or optionally the console user's
   name and mail (personal data in Git; ADR 0012)?
5. Should the form become the default view for every role, or only for roles without
   `agents:publish`?
