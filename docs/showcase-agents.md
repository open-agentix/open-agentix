# Concept: showcase agents that help build the platform

- Status: Proposed (concept for plan items NEW-01 and, in section 10, NEW-02; implementation
  follows as NEW-03 and NEW-04)
- Date: 2026-10-09
- Builds on: [demo profile](demo.md), [demo repo agent](demo-repo-agent.md) (W11-1),
  [MCP connections and tool profiles](mcp.md), [budgets](budgets.md), [harnesses](harnesses.md),
  [ADR 0009](adr/0009-model-proxy.md) (model proxy, reservations),
  [ADR 0010](adr/0010-agent-authoring-builder-and-git-sync.md) (Git sync, PR-back),
  [ADR 0011](adr/0011-outbound-network-proxies-and-private-endpoints.md) (private endpoints),
  [ADR 0012](adr/0012-connections-instances-scopes-and-data-protection.md) (connection instances,
  retention), [ADR 0013](adr/0013-hierarchical-tenants-and-setup-modes.md) (tenant tree, caps)

## 1. Goal

The demo becomes more than a demo: a **real installation with a read-only view for visitors**.
Six agents do real work for the openagentix project itself, each in its **own tenant**, and every
visitor can watch what they do, what they cost, which tools they may use and what the audit chain
recorded. Visitors never start, change or approve anything.

| Showcase agent (tenant) | Input -> output | Safety level |
| --- | --- | --- |
| Social media | image + short brief -> Instagram and LinkedIn **drafts** (text, hashtags, alt text) | L1 draft |
| Bug fix | GitHub issue -> analysis -> branch -> **pull request** | L2 pull request |
| CVE fix | Dependabot or Trivy finding -> lockfile update -> **pull request** with test result | L2 pull request |
| Feature research | question or issue -> structured research report | L1 draft (L0 without the comment) |
| Feature development | roadmap issue -> plan (human approval) -> code -> review -> **pull request** | L2 pull request |
| Repo question (demo guest) | visitor question -> answer from the public repository with citations | L0 read-only |

A seventh tenant holds the self-development agent with a local model (section 10, NEW-02); it is
part of the same tree so that its runs are visible next to the others.

Principles, all of them already platform features or listed as gaps in section 3:

1. **Read-only for visitors.** A guest can read runs, costs, budgets, agent definitions, tool
   profiles, policies and the audit chain, and can verify the chain. Every other write is refused
   by the role and, independently, by a read-only guard in front of the API (section 5).
2. **Real agents run under operator identities** (one service principal per tenant), never under
   a visitor's.
3. **Pull request instead of merge.** No agent can merge, push to `main`, push tags, change CI
   workflows or publish anything. A maintainer reviews and merges. Drafts (social media, research)
   are stored as run output; a human publishes them.
4. **Everything is measured.** Each tenant shows its runs, costs against its cap, tokens, tool
   calls (allowed and denied), approvals, and outcome metrics such as "pull requests merged".
5. **No personal data.** Showcase content comes from the public repositories and from
   operator-supplied material that contains no personal data. The simulated copy in the public demo
   uses fictional data on `example.org`.

## 2. Two installations: demo and showcase

| | Public demo (today) | Showcase (this concept) |
| --- | --- | --- |
| Data | fictional, seeded, reset every night | real runs on the project's public repositories, kept for the retention window |
| Models | simulated provider; optional live Claude Code in fixed scenarios | real model providers through the model proxy, plus a local model for the self-development agent |
| Visitors | sign in with shared fake credentials; may start fixed scenarios | anonymous read-only guest session; cannot start anything (one exception, section 8.6) |
| Mode | `OAX_DEMO_MODE=true` | multi-tenant mode (ADR 0013), showcase guard on |

The nightly reset of the demo profile makes it unsuitable for a history of real runs, so the
showcase is a **separate installation** of the same images. The demo additionally gets simulated
copies of the six showcases (same `agents.md` files with `provider: simulated` and fictional events
on `example.org`), so that visitors who only run the demo locally see the same structure.

Where the showcase installation runs is an operator decision (open question 1). The concept only
needs a control node with PostgreSQL, a worker or run node that can reach GitHub and the model
providers, and, for the self-development agent, a private network path to the local model server
(section 10.6).

## 3. What exists and what is missing

| Needed for | Exists on `main` | Missing (proposed item, section 11) |
| --- | --- | --- |
| Own tenant per showcase, nested | flat tenants with monthly budgets (ADR 0007) | tenant tree and caps: W13-1, W13-2, W13-4, W13-6 |
| Visitor can only read | `viewer` role, demo read-only API | guest role and guard for a non-demo installation (S-1) |
| Model calls with hard cost limits | model proxy and reservations (W1-3b-3, W1-3b-4) | passthrough and harness adapters: PLAT-03, PLAT-04, PLAT-05 |
| Coding in a sandbox (edit files, run tests) | container runner, toolbox `git+node` contract, Claude Code and OpenCode harnesses | harness steps in run nodes with workspace tools (PLAT-05), test command allowlist (S-5) |
| Opening pull requests | PR-back for agent definitions only (ADR 0010 section 9) | GitHub connection with a `pr` profile and branch constraints (S-3) |
| Image input for the social media agent | none: providers and handovers carry text and JSON only | image inputs in providers, events and `agents.md` (S-4) |
| Reading the web with an allowlist | egress allowlist per step (runners) | read-only fetch tool with domain allowlist and size cap (S-6) |
| Plans, checks, reviews | Agent Plan and Agent Check (W1-5), deterministic guideline review | automatic hardening review on outputs (W6-4), evals (W2-4) |
| Human approval of a plan before later steps run | approvals on tool calls (`approval: required`) | approval gate between pipeline steps (S-10) |
| Outcome metrics (PR merged, reverted) | run, cost and audit data | read-only outcome sync from GitHub and per-tenant overview (S-7) |

## 4. Tenant tree (ADR 0013)

```text
showcase                      organisation   cap 60 USD/month; models: anthropic/claude-haiku-4-5,
|                                            anthropic/claude-sonnet-5-5, anthropic/claude-opus-5-5,
|                                            ollama/*; retention 30 days; classification <= public
+-- engineering               cap 45 USD
|   +-- bug-fix               cap 15 USD
|   +-- cve-fix               cap  5 USD;  models: haiku only
|   +-- feature-research      cap 10 USD;  models: haiku, sonnet
|   +-- feature-dev           cap 30 USD
|   +-- self-dev              cap  1 USD (tripwire); models: ollama/* only
+-- marketing
|   +-- social-media          cap  5 USD;  models: haiku, sonnet
+-- public
    +-- repo-guide            cap 15 USD;  models: haiku only; plus the demo daily budget
```

Why this shape:

- It **demonstrates the owner's budget rule** of ADR 0013 section 4 with real numbers. The caps of
  the engineering children add up to 61 USD, more than the 45 USD of `engineering`; that is valid,
  because caps are not added: every child draws from the shared counter of `engineering` and of
  `showcase`. When `engineering` reaches 45 USD, all five engineering tenants stop, while
  `marketing` and `public` keep working until the organisation reaches 60 USD. The console shows
  the "blocked by engineering" banner, which is itself a showcase.
- **Model allowlists only narrow.** `cve-fix` and `repo-guide` cannot use more than Haiku, and
  `self-dev` cannot use any paid model at all, even if its `agents.md` asks for one (publish
  refuses it, ADR 0013 section 3).
- **`self-dev` cap.** Local models get an explicit price of `0` (otherwise they are refused as
  `model_unpriced` whenever a cost limit applies, see [budgets](budgets.md)). A cap of `0` would
  block every run (a budget counts as reached at or above its limit), so `self-dev` gets a
  1 USD tripwire; the model allowlist is the real guarantee, the cap only catches a mistake.
- **Depth 2** below the root, inside the default limit of 4.
- **Connections** are created on the node that needs them and inherited downwards (ADR 0013
  section 6): the read-only GitHub connection on `showcase`, the `pr` connection on `engineering`,
  the model provider instances on `showcase` with narrowing per child.

Before W13 ships, the tree cannot be built, and flat tenants created now could not be nested later
(a root cannot be moved under another root, ADR 0013 section 9). The showcase therefore starts
after W13-1, W13-2, W13-4 and W13-6. NEW-03 is blocked on PLAT-02 to PLAT-05 anyway, so this adds
no delay on the critical path. If an earlier start is wanted, the fallback is one `showcase` tenant
with one team per showcase (team budgets exist today) and a later conversion (ADR 0013 open
question 5).

## 5. Roles and the guest

### 5.1 Who does what

| Actor | Binding | Can |
| --- | --- | --- |
| Guest (anonymous visitor) | `guest` on `showcase` (new role, S-1) | read runs, steps, tool calls, outputs, costs, budgets, effective values, agent definitions, tool profiles, policies, audit entries; verify the audit chain |
| Agent service principal | `operator` restricted to `runs:execute` on its own leaf tenant, API token with matching scopes | start runs of its own agents (cron, webhook) |
| Maintainer | `admin` on `showcase` | publish agents, approve gated steps, change caps, review and merge pull requests on GitHub |
| Platform operator | platform operator | installation, providers, keys |

### 5.2 The guest role and the read-only guard

The fixed role set has no role that fits: `viewer` cannot read the audit log, and `auditor` can
also read users and settings. The concept proposes one new fixed role `guest`:

```text
guest = agents:read, runs:read, events:read, costs:read, policies:read, connections:read,
        audit:read, audit:verify
```

No `users:read` (operator accounts stay invisible), no `settings:read`, no `audit:export`, no
`tokens:*`, nothing with `write`, `execute`, `approve` or `cancel`.

The role is the first wall. The second is a **showcase guard** (`OAX_SHOWCASE_GUEST=true`): a guest
principal may only call `GET` routes and the side-effect-free `POST /v1/audit/verify` (and
`POST /v1/demo/ask` when section 8.6 is enabled); everything else answers `403 guest_read_only`
before any handler runs, so a wrong permission in a new route cannot open a write path. The guard
has its own test that walks the route table.

Guest sessions are anonymous: `POST /v1/showcase/session` issues a short-lived signed cookie for
the `guest` principal, rate-limited per salted IP hash. There are no shared credentials to publish
and no accounts to manage (open question 2: anonymous session vs. shared fake credentials as in the
demo).

### 5.3 What a guest sees and what is hidden

| Visible | Hidden |
| --- | --- |
| run timeline, model calls with token counts and cost, tool calls with arguments and results, policy decisions (allowed, denied, approval), outputs, links to the pull requests | secret values (never stored anywhere), secret reference names, connection endpoints of private servers, operator user names and mail addresses, API tokens |
| effective budgets and caps with "inherited from", counters, blocked banners | the uploaded source image of the social media agent after its retention window |
| agent definitions (`agents.md`), expansions of tool profiles, safety level | raw request digests and internal ids that are not needed for reading |
| audit entries of the showcase tree and the verify result | audit entries of the platform partition |

Content comes from public repositories, so run content is not secret; still, the showcase stores it
with a 30-day retention (ADR 0012 section 7.2) and runs the PII hook (ADR 0012 section 7.3) that
removes mail addresses and replaces GitHub handles of issue authors with `@user` in stored
content. Issue numbers and titles stay.

## 6. Common safety baseline

### 6.1 Safety levels

| Level | Meaning | Who publishes the result |
| --- | --- | --- |
| L0 | read-only, no side effect outside the platform | nobody, the answer is the result |
| L1 | draft: the output is a run artifact; optionally **one** comment, behind `approval: required` | a human copies or posts it |
| L2 | pull request: the agent may create branches in its own namespace and open **draft** pull requests; nothing else | a maintainer reviews and merges |
| L3 | merge or deploy | **not used** in the showcase |

### 6.2 GitHub access

- **Read**: the pinned read-only GitHub MCP server of the demo repo agent (W11-1-1), connection
  `github-read` on `showcase`, owner and repository allowlist enforced by argument constraints and
  by the runner wrapper. Repositories: `open-agentix/open-agentix`, `open-agentix/open-agentix-helm`
  (open question 3 for more).
- **Write** (`engineering` only): connection `github-pr`, a GitHub App installed only on the
  allowlisted repositories with exactly `contents: write`, `pull_requests: write`,
  `issues: write` (for the one comment) and **no** `workflows`, `administration` or `actions`
  permission. GitHub itself refuses changes to `.github/workflows/**` from a token without the
  `workflows` permission.
- Profile `pr` contains only: create branch, push files to a branch, open pull request, comment on
  an issue. Argument constraints on every grant:
  - branch `pattern: "^oax/<agent>/[a-z0-9-]{1,40}$"` (each agent has its own namespace),
  - pull request `base: { enum: [main] }`, `draft: { const: true }`,
  - file paths: `pattern` that excludes `.github/`, `deploy/`, migrations and lockfiles (except for
    `cve-fix`, which may change only lockfiles and manifests).
- There is no merge, delete, release, label or settings tool in any profile. `maxCallsPerRun: 1`
  for "open pull request" and "comment".
- **Repository rules** (the outer wall, independent of the platform): `main` and tags protected,
  pull requests require a maintainer review and green checks, no bypass for the App; a ruleset
  allows the App to push only to `oax/**`.
- **CI on agent branches** runs with a read-only `GITHUB_TOKEN` and without repository secrets
  (release and deploy workflows only run on `main` and tags). Reason: an agent changes code that the
  CI executes; it must not be able to read CI secrets through a test.
- **Open pull request limit**: a step checks the number of open pull requests on `oax/<agent>/*`
  and skips with `pr_limit_reached` when the agent's limit (2 by default) is reached, so a busy
  agent cannot flood the reviewers.

### 6.3 Untrusted input

Issue texts, comments, web pages, dependency advisories and images are **data, never
instructions**. The prompts say so, but the boundary is the tool profile: a read-only step cannot
write, and a write step can only touch its branch namespace. In addition:

- **Trigger by maintainer label only.** The bug fix, feature and self-development agents act only
  on issues that carry `agent:<name>`, and the trigger checks through the read API that the label
  was added by a user with write permission on the repository. Anybody can open an issue; nobody
  outside the maintainers can make an agent work on it.
- Web reading is limited to an allowlist of documentation hosts, `GET` only, size capped, no
  JavaScript; fetched content never becomes a tool argument for a write tool without a schema check.
- Outputs carry the label "AI-generated by the <agent> showcase agent", the run link and the run
  cost; pull request bodies say which model wrote the change.

### 6.4 Kill switches

Per agent: disable the agent. Per subtree: lower the cap to the current usage (ADR 0013
section 5.4, takes effect on the next call). Global: revoke the GitHub App installation. All three
are audited and visible to guests ("paused by maintainer").

## 7. Common metrics

Every tenant shows the same base metrics; the agent sections add outcome metrics.

| Metric | Source |
| --- | --- |
| runs started, succeeded, failed, blocked by policy, blocked by budget | runs table |
| cost per run (p50, p95), month to date against own cap and tightest ancestor | cost ledger, counters |
| tokens in/out, cache read share | ledger |
| tool calls allowed, denied (`policy.denied`, `profile_write_denied`), approvals and their waiting time | audit |
| wall time per run (p50, p95) | runs |
| **cost per accepted outcome** (merged PR, accepted draft, helpful answer) | ledger plus outcome sync (S-7) |
| audit chain verified (last result, time) | audit verify |

Outcomes come from a read-only sync (S-7): every pull request opened by a showcase agent is linked
to its run; the sync records `merged`, `merged_with_changes` (commits by others on the branch),
`closed_unmerged`, and `reverted_within_30_days` (a revert commit on `main` that references it).
Drafts are marked `accepted` or `discarded` by a maintainer in the console.

## 8. The six showcase agents

The `agents.md` sketches below show the decisive fields; prompts, schemas and simulation blocks are
left out. Model names follow the catalog ids; prices used for the estimates are the list prices per
million tokens (input/output) at the time of writing: Haiku 4.5 1/5 USD, Sonnet 5.5 2/10 USD,
Opus 5.5 4/20 USD. Estimates ignore prompt caching, so real costs should be lower.

### 8.1 Social media agent (`showcase/marketing/social-media`)

Purpose: turn a project image (a screenshot of the console, a diagram, a release banner) and a
short brief into an Instagram post and a LinkedIn post, both as drafts.

```yaml
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: social-media-draft
version: 0.1.0
description: Drafts Instagram and LinkedIn posts from a project image and a short brief.
owner: team-marketing
classification: public
labels: { useCase: social-media, safetyLevel: L1 }
triggers:
  - type: manual                       # maintainer uploads image + brief in the console
budget: { maxTokens: 30000, maxCostUsd: 0.10, maxSteps: 4, maxToolCalls: 0, timeoutSeconds: 120 }
schemas:
  Drafts: { ... }                      # instagram{caption,hashtags[<=15],altText}, linkedin{text,hashtags[<=5],altText}
agents:
  - id: draft
    provider: anthropic
    model: claude-sonnet-5-5
    access: read-only
    input: { from: [event] }           # event.data: { imageRef, brief, language }
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Drafts" }, onInvalid: retry }
  - id: check
    provider: anthropic
    model: claude-haiku-4-5
    access: read-only
    input: { from: [draft] }
    outputs: [{ format: json }]        # { ok, findings[] }: length limits, alt text present,
                                       # no claims about features that are not on main, no people
pipeline: [draft, check]
```

| Aspect | Value |
| --- | --- |
| Tools | none. No posting tool exists; the result is a run artifact |
| Safety level | L1 draft |
| Model, cost | Sonnet 5.5 (vision) for the draft, Haiku 4.5 (vision) for the check. About 4k input (image, brief, instructions) and 1k output per draft: about 0.02 USD per post including the check |
| Budgets | 0.10 USD per run, 5 USD per month (about 200 posts; realistic use is a few per week) |
| Data | images are operator-supplied project material without identifiable people; metadata (EXIF) stripped on upload; image retention 7 days, the drafts 30 days |
| Metrics | drafts per month, accepted without edit, accepted with edit, discarded; check findings per draft; alt text present (target 100 %); cost per accepted draft |
| Gap | image input (S-4): providers, the event store and handovers carry text and JSON only today |

### 8.2 Bug fix agent (`showcase/engineering/bug-fix`)

Purpose: take a labelled bug report, find the cause, write a fix with a regression test, and open a
draft pull request.

```yaml
name: bug-fix
classification: public
labels: { useCase: bug-fix, safetyLevel: L2 }
triggers:
  - type: webhook
    source: github-issues              # label "agent:bug-fix" added by a maintainer (checked)
runtime: { runner: container, toolbox: git+node, egress: [api.github.com, registry.npmjs.org] }
budget: { maxTokens: 600000, maxCostUsd: 1.50, maxSteps: 60, maxToolCalls: 80, timeoutSeconds: 2700 }
agents:
  - id: triage
    provider: anthropic
    model: claude-haiku-4-5
    access: read-only
    outputs: [{ format: json }]        # { reproducible, suspectedFiles[], plan, confidence }
    tools:
      - { server: github-read, profile: read, maxCallsPerRun: 12 }
  - id: fix
    when: 'steps.triage.output.confidence in ["medium", "high"]'
    runtime: { harness: claude-code }  # PLAT-04/05: harness through the model proxy, in the run node
    provider: anthropic
    model: claude-sonnet-5-5
    access: write                      # writes only inside the run node's workspace
    input: { from: [event, triage] }
    tools:
      - { server: workspace, profile: edit }            # read/write files in the checkout (S-5)
      - { server: workspace, profile: test }            # allowlisted commands: pnpm lint, typecheck, test <path>
  - id: publish
    provider: anthropic
    model: claude-haiku-4-5
    access: write
    input: { from: [fix] }
    tools:
      - { server: github-pr, profile: pr, maxCallsPerRun: 3 }   # branch, push, draft PR (constraints in 6.2)
pipeline: [triage, fix, publish]
```

| Aspect | Value |
| --- | --- |
| Tools | `github-read/read` (triage), workspace `edit` and `test` inside the run node (fix), `github-pr/pr` (publish). The model never holds a GitHub token: the MCP server and the credential broker do |
| Safety level | L2: draft pull request on `oax/bug-fix/*`; the publish step refuses unless the last test run in the workspace was green (`when` on the fix output) |
| Model, cost | Haiku 4.5 for triage (about 30k in, 2k out: 0.04 USD), Sonnet 5.5 for the fix (about 150k in, 15k out: 0.45 USD), Haiku for publish (0.01 USD). About 0.50 USD per attempt; the run cap of 1.50 USD stops loops. The owner's note "local model plus Claude for hard cases" maps to triage on a local model once the evaluation of section 10.7 shows it is good enough |
| Budgets | 1.50 USD per run, 15 USD per month (about 30 attempts) |
| Escalation | low confidence or two red test runs: no pull request, one issue comment draft "needs a human" (approval required) |
| Metrics | issue-to-PR time, PRs opened, merged unchanged, merged with changes, closed, reverted within 30 days; tests green at open (target 100 %); review comments per PR; cost per merged PR |

### 8.3 CVE fix agent (`showcase/engineering/cve-fix`)

Purpose: turn a Dependabot alert or a Trivy finding into a minimal dependency update with test
evidence. Most of the work is deterministic; the model decides and explains.

```yaml
name: cve-fix
classification: public
labels: { useCase: vulnerability-management, safetyLevel: L2 }
triggers:
  - type: webhook
    source: github-dependabot          # also: trivy (as in examples/cve-triage.agents.md)
runtime: { runner: container, toolbox: git+node, egress: [api.github.com, registry.npmjs.org] }
budget: { maxTokens: 80000, maxCostUsd: 0.25, maxSteps: 16, maxToolCalls: 20, timeoutSeconds: 1800 }
agents:
  - id: assess
    provider: anthropic
    model: claude-haiku-4-5
    access: read-only
    outputs: [{ format: json }]        # { package, from, to, bump: patch|minor|major, runtimeDependency, duplicateOf }
    tools:
      - { server: github-read, profile: read, maxCallsPerRun: 8 }
  - id: update
    when: 'steps.assess.output.bump in ["patch", "minor"] && steps.assess.output.duplicateOf == null'
    provider: anthropic
    model: claude-haiku-4-5
    access: write
    tools:
      - { server: workspace, profile: deps }  # pnpm update <pkg>, pnpm install --frozen-lockfile, pnpm test
  - id: publish
    when: 'steps.update.output.testsGreen == true'
    provider: anthropic
    model: claude-haiku-4-5
    access: write
    tools:
      - { server: github-pr, profile: pr, maxCallsPerRun: 3 }   # title "fix(deps): ..."; lockfile and manifests only
pipeline: [assess, update, publish]
```

| Aspect | Value |
| --- | --- |
| Rules | SemVer rule of the project: patch and minor as a draft pull request with green tests; **major only as a report** (a comment draft), never a code change. Skip when Dependabot already has an open pull request for the same package (`duplicateOf`) |
| Safety level | L2; path constraint allows only `package.json`, `pnpm-lock.yaml` and workspace manifests |
| Model, cost | Haiku 4.5 throughout, about 20k in and 2k out: about 0.03 USD per finding |
| Budgets | 0.25 USD per run, 5 USD per month |
| Metrics | advisory-to-PR time, PRs green at open, merged, majors reported, duplicates skipped, findings that were dev-only (no runtime impact), open critical/high findings over time |

### 8.4 Feature research agent (`showcase/engineering/feature-research`)

Purpose: answer "how do others solve X, what does it mean for us" with a structured report that
cites the repository and allowlisted documentation.

```yaml
name: feature-research
classification: public
labels: { useCase: research, safetyLevel: L1 }
triggers:
  - type: webhook
    source: github-issues              # label "agent:research" by a maintainer
  - type: manual
budget: { maxTokens: 200000, maxCostUsd: 0.75, maxSteps: 30, maxToolCalls: 30, timeoutSeconds: 900 }
agents:
  - id: research
    provider: anthropic
    model: claude-sonnet-5-5
    access: read-only
    outputs: [{ format: json }]        # { question, findings[{claim, sources[]}], options[], recommendation, openQuestions[] }
    tools:
      - { server: github-read, profile: read, maxCallsPerRun: 15 }
      - { server: docs-fetch, profile: read, maxCallsPerRun: 10 }   # S-6: GET, host allowlist, 200 KiB cap
  - id: comment
    provider: anthropic
    model: claude-haiku-4-5
    access: write
    input: { from: [research] }
    tools:
      - { server: github-pr, tool: add_issue_comment, approval: required, maxCallsPerRun: 1 }
pipeline: [research, comment]
```

| Aspect | Value |
| --- | --- |
| Safety level | L1: the report is a run artifact; the one issue comment needs a maintainer's approval |
| Sources | repository, issues, ADRs; documentation hosts on an allowlist kept in the connection (open question 4). Citations in the report are checked against the tool log: a source the agent did not actually read is flagged |
| Model, cost | Sonnet 5.5, about 80k in and 6k out: about 0.22 USD per report |
| Budgets | 0.75 USD per run, 10 USD per month |
| Metrics | reports per month, maintainer rating (1 to 5), citations verified (target 100 %), follow-up issues created from a report, cost per report |

### 8.5 Feature development agent (`showcase/engineering/feature-dev`)

Purpose: implement a roadmap item end to end with the platform's own lifecycle: plan, human
approval, implementation, review, draft pull request.

```yaml
name: feature-dev
classification: public
labels: { useCase: feature-development, safetyLevel: L2 }
triggers:
  - type: webhook
    source: github-issues              # label "agent:feature" by a maintainer; issue links the plan item
runtime: { runner: container, toolbox: git+node, egress: [api.github.com, registry.npmjs.org] }
budget: { maxTokens: 1500000, maxCostUsd: 6.00, maxSteps: 150, maxToolCalls: 200, timeoutSeconds: 5400 }
agents:
  - id: plan
    provider: anthropic
    model: claude-opus-5-5
    access: read-only
    outputs: [{ format: json }]        # Agent Plan (W1-5): tasks, files, tests, risks
    tools:
      - { server: github-read, profile: read, maxCallsPerRun: 25 }
  # plan gate: the run pauses until a maintainer approves the plan (runs:approve); gap S-10
  - id: implement
    runtime: { harness: claude-code }
    provider: anthropic
    model: claude-sonnet-5-5
    access: write
    input: { from: [event, plan] }
    tools:
      - { server: workspace, profile: edit }
      - { server: workspace, profile: test }
  - id: review
    provider: anthropic
    model: claude-opus-5-5
    access: read-only
    input: { from: [plan, implement] } # diff + test report; guideline review + hardening checklist (W6-4)
    outputs: [{ format: json }]        # { verdict: pass|changes, findings[] }
  - id: publish
    when: 'steps.review.output.verdict == "pass"'
    provider: anthropic
    model: claude-haiku-4-5
    access: write
    tools:
      - { server: github-pr, profile: pr, maxCallsPerRun: 3 }
pipeline: [plan, implement, review, publish]
```

| Aspect | Value |
| --- | --- |
| Safety level | L2, plus a human approval **before** any code is written; the review step can stop the pull request; the path constraint excludes migrations, accounting, policy and auth code unless the plan item names them and the approval says so |
| Model, cost | Opus 5.5 for plan (about 60k in, 8k out: 0.40 USD) and review (100k in, 5k out: 0.50 USD), Sonnet 5.5 for implementation (about 400k in, 40k out: 1.20 USD). About 2 to 3 USD per feature attempt; run cap 6 USD |
| Budgets | 6 USD per run, 30 USD per month; `engineering` (45 USD) bounds it together with its siblings |
| Metrics | plans approved or rejected, PRs merged, review rounds, review findings by category, coverage delta, guideline violations found after merge, maintainer time per PR (self-reported), cost per merged feature |

### 8.6 Repo question agent for demo guests (`showcase/public/repo-guide`)

This is the agent of [demo-repo-agent.md](demo-repo-agent.md) (W11-1) moved into its own tenant;
its design, abuse analysis and tests apply unchanged.

| Aspect | Value |
| --- | --- |
| Tools | `github-read/read`: six read tools, no search, owner and repository allowlist enforced twice |
| Safety level | L0 |
| Model, cost | Haiku 4.5, about 20k in and 1.5k out: about 0.03 USD per answer; run cap 0.05 USD |
| Budgets | per visitor 3 questions per 10 minutes, daily budget 0.50 USD, monthly cap 15 USD on the tenant; the tightest wins |
| Guest exception | this is the only place where a guest causes a run: `POST /v1/demo/ask` queues a run of this one fixed agent under the tenant's service principal. The guest still has no `runs:execute`, cannot choose the agent, the model or the tools. Default `questions` mode (curated questions); `free-text` only when the owner enables it |
| Metrics | questions per day, "I don't know" share, citations matching the tool log (target 100 %), answer reports, days with the daily budget used up, p95 latency |

### 8.7 Summary

| Agent | Tools (read / write) | Level | Main model | Cost per run | Monthly cap |
| --- | --- | --- | --- | --- | --- |
| social-media | - / - | L1 | Sonnet 5.5 (vision) | ~0.02 USD | 5 USD |
| bug-fix | repo read / workspace, branch + draft PR | L2 | Sonnet 5.5 | ~0.50 USD | 15 USD |
| cve-fix | repo read / workspace deps, branch + draft PR | L2 | Haiku 4.5 | ~0.03 USD | 5 USD |
| feature-research | repo + docs read / one comment (approval) | L1 | Sonnet 5.5 | ~0.22 USD | 10 USD |
| feature-dev | repo read / workspace, branch + draft PR | L2 + plan approval | Opus 5.5 + Sonnet 5.5 | ~2-3 USD | 30 USD |
| repo-guide | repo read / - | L0 | Haiku 4.5 | ~0.03 USD | 15 USD |
| self-dev (section 10) | repo read / workspace, branch + draft PR | L2, shadow first | local model | 0 USD (API) | 1 USD tripwire |

Expected total for a normal month: 15 to 40 USD, hard-capped at 60 USD by the organisation cap.

## 9. Per-tenant overview

Every tenant page (and the organisation page with the tree) shows, for guests and maintainers
alike:

- **Header**: tenant path, safety level badge, models allowed (effective, with "inherited from"),
  status (`active`, `blocked by <node>`, `paused by maintainer`).
- **Budget**: month-to-date spend as a bar with three marks: own usage, subtree usage, cap of the
  node and headroom of the tightest ancestor (`GET /v1/tenants/{id}/usage`).
- **Runs**: list with status, trigger, cost, tokens, duration, outcome (merged, draft accepted,
  ...), filters by agent and status (`GET /v1/runs?scope=subtree`).
- **Costs**: per agent, per model, per day; cost per accepted outcome (`GET /v1/costs?scope=subtree`).
- **Agents**: definitions, published versions, tool profile expansions with read/write badges.
- **Audit**: recent entries with filters (policy decisions, approvals, budget events), "verify
  chain" button and last verification result.
- **Outcomes**: the metrics of section 7 and of the agent's section.

The organisation page adds the tree with a usage bar per node and a summary that the website can
embed (`GET /v1/showcase/summary`: counts and sums only, cacheable, no content).

## 10. NEW-02 feasibility: a self-development agent with a local model

### 10.1 The idea

A long-running agent on a homelab that **develops the platform every day**, **monitors features**
and **tracks GitHub issues**, using a local model through Ollama, so that the API cost is zero. Its
runs are visible in the showcase (`engineering/self-dev`).

### 10.2 Hardware assumptions

- GPU: GTX 1050 Ti, 4 GB VRAM (Pascal, compute capability 6.1), **shared** with media transcoding.
- CPU: 6 cores, shared with other containers (CI builds, databases, web services).
- RAM: a few GB available for the model at best; the host has no large free memory headroom.
- Ollama already runs as a container in the same network.

### 10.3 What fits and how fast (realistic orders of magnitude, to be measured in NEW-20)

| Setup | Models that fit | Generation speed | Prompt processing | Verdict |
| --- | --- | --- | --- | --- |
| GPU only, 4 GB | 1.5B to 4B parameters at 4-bit quantisation (for example the small Qwen coder and Llama 3.2 classes) with 4k to 8k context | tens of tokens per second | a few hundred tokens per second | usable for short, structured tasks, if the GPU is free |
| GPU + CPU offload | 7B to 8B at 4-bit (about 4.5 to 5 GB) does not fit fully; layers split | single-digit tokens per second | slow | not worth it on a shared card |
| CPU only, 6 cores | 3B fast enough; 7B to 8B at 4-bit possible | about 2 to 6 tokens per second for 7B | tens of tokens per second: an 8k-token prompt takes minutes | usable only as a nightly batch with small prompts |
| CPU only, 14B+ | needs about 9 GB+ RAM | about 1 to 2 tokens per second | very slow | not realistic on this host |

Further constraints:

- **VRAM contention**: when transcoding holds VRAM, Ollama falls back to CPU or fails to load the
  model. The agent must treat the GPU as optional and run a CPU-only configuration by default.
- **Driver and toolchain support for Pascal**: recent CUDA toolchains deprecate or drop older GPU
  generations. The Ollama image must be pinned to a version whose CUDA build still supports compute
  capability 6.1, verified once and recorded; otherwise CPU-only.
- **Context is the real limit**: on CPU, prompt processing dominates. A task needs a context pack of
  at most about 4k tokens to finish in a reasonable time, which rules out "read the repository and
  decide".
- **Model tags in Ollama are mutable**: the agent pins the model by digest, and a change of digest is
  treated like a model upgrade (re-run the evaluation set, section 10.7).

### 10.4 Quality limits of small models (honest view)

- Tool calling and JSON output are less reliable: wrong argument names, extra text around JSON,
  repeated calls. Mitigation: JSON-only outputs with schema validation and one retry
  (`onInvalid: retry`), Ollama's JSON format option, very few tools per step.
- They invent file paths, function names and APIs they have not seen. Mitigation: give them the
  exact file content; verify every claim by execution (tests, type check, grep).
- They cannot hold the architecture of a TypeScript monorepo with 1 600 tests in mind; multi-file
  changes, concurrency, accounting, security and migrations are out of reach.
- Code review by a small model finds style issues, rarely real bugs, and produces false positives.

The platform's code is security-sensitive (policy gate, model proxy, budgets). A small model that
"develops the platform daily" without these limits would produce mostly red builds and noise and
would cost maintainers more review time than it saves.

### 10.5 Task decomposition so that a small model does useful work

Rule: **deterministic tools do the finding, the model does one small judgement, execution does the
verification.**

| Task class | Deterministic part | Model part (context <= 4k tokens) | Verification | Output |
| --- | --- | --- | --- | --- |
| Daily repo digest | list issues, PRs, CI runs, Dependabot alerts since the last run (read API) | summarise and group, 1 to 2 sentences per item | links must exist in the tool log | run artifact (L0) |
| Issue triage suggestions | new issues, existing labels, similar titles (string similarity) | suggest labels, duplicate candidate, "good first issue" | suggestion only; a maintainer applies it | run artifact (L0) |
| CI failure summary | failing job log, cut to the first error and 50 lines around it | explain the error, name the likely file | none needed (advisory) | run artifact (L0) |
| Feature monitoring | read the status table of the implementation plan; for each "done" row, check that the named files exist and the named tests pass; GET probes of the demo endpoints | explain drift in one paragraph per finding | the deterministic check is the source of truth | run artifact (L0), weekly |
| Docs drift | env variables in `docs/configuration.md` vs. those read in code (grep), links in docs (link checker) | propose the missing table row or wording for one variable | docs lint and link check green | draft PR (L2) |
| Small test additions | coverage report: uncovered branches in **pure** functions in `packages/core` | write one test for one function | test passes, coverage rises, no source change | draft PR (L2) |
| Lint and typo fixes | linter output, spell check on docs | fix one finding in one file | lint, type check, tests green | draft PR (L2) |

Each attempt is one file, at most about 50 changed lines, at most 3 attempts per task, and is
discarded unless the verification is green. Attempts cost no API money, so the budget that matters
is **wall time**: the batch runs in a nightly window with a timeout and concurrency 1.

### 10.6 Guardrails

Everything of section 6 applies (maintainer label for development tasks, PR-only GitHub App, no
workflow permission, branch namespace `oax/self-dev/*`, draft pull requests, CI without secrets).
In addition:

- **Model allowlist `ollama/*` on the tenant** (narrowing only), local models priced at 0, 1 USD
  cap as a tripwire: no path to a paid model by mistake.
- **File allowlist** for changes: `docs/**`, `packages/*/test/**`, `apps/*/test/**`, and only for
  lint fixes the reported file. Never: migrations, `packages/core/src/policy`, accounting, model
  proxy, runners, auth, `deploy/`, lockfiles, `.github/`.
- **At most 2 open pull requests** at a time and at most 1 new per day; every pull request carries
  the label `local-llm` and the model digest.
- **Shadow mode first**: the agent produces patches as run artifacts and opens no pull request
  until the evaluation gate (10.7) is passed.
- **Host protection**: concurrency 1, nightly schedule, run timeout, and a pre-check step that skips
  the run when the host is under memory or IO pressure (`skipped: host_busy`), so the agent never
  competes with other workloads during the day.
- **Network**: the Ollama endpoint is never exposed publicly. The model proxy reaches it over a
  private network as a private destination (ADR 0011 section 6); if the control node runs elsewhere,
  a worker node next to Ollama plus an allowlisted private endpoint is required (open question 7).
- **Instructions**: issue text and logs are data. The agent never installs anything from the
  internet at run time; the toolbox image and the model are pinned.

### 10.7 Evaluation plan

1. **Baseline set** (before any live run): 40 historical tasks from the repository's own history in
   the task classes of 10.5 (docs fixes, added tests, lint fixes, CI failure explanations, triage of
   closed issues), each with the parent commit and the accepted change or label as reference.
2. **Candidates**: local 3B on GPU, local 7B on CPU, and Claude Haiku 4.5 as a reference (shared with
   NEW-21).
3. **Measures**: verification green at first attempt and within 3 attempts; blind maintainer rating
   of the diff or text (accept, accept with edits, reject); wall time; tokens; guardrail violations
   (must be 0); for triage, precision of suggested labels and duplicates.
4. **Gates**:
   - monitoring and triage go live when maintainers rate at least 70 % of digest items and
     suggestions as useful;
   - draft PRs (after 2 weeks of shadow mode) only for task classes with at least 60 % green and
     accepted patches; other classes stay in shadow mode or are dropped.
5. **Ongoing**: weekly metrics on the tenant page (PRs opened, merged, closed, reviewer minutes,
   share of discarded attempts, nightly wall time); the 40 tasks become golden runs that are
   re-run on every model digest or prompt change (model drift, NEW-32).

### 10.8 Recommendation

- **Feasible now** with a 3B to 4B model on the GPU or a 7B model on the CPU in a nightly window:
  the daily digest, issue triage suggestions, CI failure summaries and feature monitoring (all L0),
  and, after shadow mode, tiny docs and test pull requests. This is useful and an honest showcase of
  what a local model can and cannot do, with visible zero API cost and visible wall time.
- **Not feasible** on this hardware: developing platform features, bug fixes beyond one-line
  changes, anything touching security, accounting, policy or migrations, multi-file changes, and
  useful code review. Expect most code attempts to fail verification; keep the pull request budget
  tiny so reviewers are not flooded.
- **With a stronger model**: either a hosted model under a small budget (the bug fix agent of 8.2
  already covers fixes; a maintainer label hands over from `self-dev` to `bug-fix`) or a local 14B
  to 32B coder model on a GPU with at least 16 to 24 GB VRAM. Then small bug fixes and focused
  features become realistic for a local agent.
- **Hybrid default**: local model for monitoring and triage (cost 0), escalation to the hosted bug
  fix agent by maintainer label, never automatically. "Cost 0" means no API cost; electricity and
  the shared host's capacity are the real price.

### 10.9 Draft GitHub issue (to be created by the owner or the main agent)

**Title:** `feat(showcase): self-development agent with a local LLM for daily monitoring, issue triage and small PRs`

**Body:**

```markdown
## Context

The showcase concept (docs/showcase-agents.md, section 10) assessed a self-development agent that
runs on a homelab with a local model through Ollama (4 GB Pascal GPU shared with other workloads,
6 shared CPU cores). Small local models can do useful work only on short, structured tasks that are
verified by execution. This issue tracks a phased rollout with an evaluation gate.

## Goal

A daily agent in the showcase tenant `showcase/engineering/self-dev` that:

- writes a daily digest of issues, pull requests, CI runs and Dependabot alerts;
- suggests labels and duplicates for new issues (suggestions only);
- monitors features: checks the status table of the implementation plan against files, tests and
  demo endpoints, and reports drift weekly;
- after an evaluation gate, opens at most one small draft pull request per day for docs drift,
  lint fixes or a missing test of a pure function.

All runs, tokens, wall time and (zero) cost are visible to showcase guests.

## Non-goals

- Feature development, bug fixes beyond trivial ones, changes to policy, accounting, model proxy,
  runners, auth, migrations, deploy files, lockfiles or workflows.
- Any merge, push to `main`, label or settings change by the agent.
- Automatic escalation to a paid model.

## Phases

1. **Evaluation** - 40 historical tasks (docs fixes, tests, lint fixes, CI failure explanations,
   triage of closed issues); candidates: local 3B (GPU), local 7B (CPU), Claude Haiku 4.5 as
   reference; measure green at first attempt and within 3, maintainer rating, wall time, guardrail
   violations (must be 0). Report in `docs/verification/self-dev-agent.md`.
2. **Monitoring live (L0)** - digest, triage suggestions, CI summaries, feature monitoring as run
   artifacts. Gate: >= 70 % rated useful over 2 weeks.
3. **Shadow mode** - patches as run artifacts, no pull requests, 2 weeks.
4. **Draft pull requests (L2)** - only for task classes with >= 60 % green and accepted patches.

## Guardrails (acceptance criteria)

- [ ] Tenant model allowlist `ollama/*` only; local models priced at 0; 1 USD cap as tripwire.
- [ ] Ollama image and model pinned by digest; Pascal support verified, CPU-only fallback works.
- [ ] Ollama is reachable only over a private network (ADR 0011 private destinations), never
      publicly.
- [ ] GitHub App with `contents`, `pull_requests`, `issues` write only on the allowlisted
      repositories; no `workflows`/`administration`; ruleset limits pushes to `oax/self-dev/**`.
- [ ] Tool profile constraints: branch pattern, `base: main`, `draft: true`, file path allowlist
      (`docs/**`, `packages/*/test/**`, `apps/*/test/**`, reported lint file).
- [ ] At most 2 open pull requests, at most 1 new per day, label `local-llm` and model digest in the
      body.
- [ ] Development tasks only from issues labelled `agent:self-dev` by a maintainer (labeler
      permission checked).
- [ ] Nightly schedule, concurrency 1, run timeout, skip when the host is under memory or IO
      pressure.
- [ ] CI on agent branches without repository secrets.
- [ ] Golden runs re-run on every model digest or prompt change.

## Metrics on the tenant page

Runs, wall time, tokens, discarded attempts, PRs opened/merged/closed/reverted, reviewer minutes,
triage precision, digest usefulness rating.

## Dependencies

- Showcase tenant tree and guest view (wave 13: W13-1, W13-2, W13-4, W13-6; showcase items S-1, S-3,
  S-5, S-7)
- Harness steps in run nodes through the model proxy (PLAT-04, PLAT-05)
- Ollama operations and provider tests (NEW-20, NEW-21)

## Open questions

- Which host runs the control node, and is a worker node next to Ollama needed?
- GPU or CPU-only as the default, given the shared card?
- Is one draft PR per day the right ceiling for reviewer capacity?
```

## 11. Proposed work items (input for NEW-03 and NEW-04)

| Item | Content | Depends on |
| --- | --- | --- |
| S-1 | `guest` role, showcase guard (`OAX_SHOWCASE_GUEST`), anonymous guest session, route-table test | W13-6 |
| S-2 | Showcase seed: tenant tree, caps, model allowlists, connections, service principals; simulated copies of the six agents for the public demo (fictional `example.org` data) | W13-1, W13-2, W13-4 |
| S-3 | GitHub `pr` connection: App credentials via the credential broker, profile `pr`, branch/base/draft/path constraints, open-PR limit step | ADR 0012 instances (W12) |
| S-4 | Image inputs: event attachment references, handover of images to vision-capable providers, size and type limits, EXIF stripping, retention | PLAT-02 |
| S-5 | Workspace tools in run nodes: file edit profile, test command allowlist, diff export for the publish step | PLAT-05 |
| S-6 | Read-only documentation fetch tool: `GET` only, host allowlist, size cap, text extraction, no scripts | W10 resolver (ADR 0011) |
| S-7 | Outcome sync (PR state, reverts) and per-tenant overview; `GET /v1/showcase/summary` | S-3, W13-10 |
| S-8 | The six `agents.md` files under `examples/showcase/`, verification docs with real runs | S-1 to S-7, PLAT-04 |
| S-9 | Self-development agent (NEW-04), phased as in 10.9 | S-1 to S-5, S-7, NEW-20, NEW-21 |

| S-10 | Approval gate between pipeline steps (run pauses after a step until `runs:approve`), audited, visible to guests as "waiting for approval" | W1-5 |

## 12. Open questions

1. Where does the showcase installation run (control node, PostgreSQL, worker), given that the
   project's website, demo pages, images and CI live on GitHub-hosted services? A live installation
   with real runs needs a server; GitHub-hosted runners could execute scheduled agent runs but not
   host the console.
2. Guests: anonymous read-only session (proposed) or shared fake credentials as in the demo?
3. Repositories for the agents: only `open-agentix/open-agentix` and `open-agentix-helm`, or also
   the website and the blog?
4. Documentation hosts on the research agent's allowlist.
5. Caps: are 60 USD for the organisation and the per-tenant values of section 4 acceptable? Display
   in USD (as stored) or EUR (ADR 0013 open question 8)?
6. A new fixed role `guest` (proposed) or reuse of `viewer` plus `audit:read`?
7. Self-development agent: which host runs the control node relative to Ollama, GPU or CPU-only
   default, and the reviewer capacity (one draft PR per day)?
8. Should the social media drafts be in English only, or English and German?
