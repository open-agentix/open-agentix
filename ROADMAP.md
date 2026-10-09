# Roadmap

Milestones are mirrored as GitHub milestones and issues (label `roadmap`). Every item has a user
story; the work items, their order (waves), acceptance criteria and the gap analysis behind them
are in [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md). Dates are targets, not promises.

Release status (2026-10-09): `v0.1.0` is tagged (2026-10-04) but there is no GitHub release object, and
no release images are published: GitHub Actions has not run for this organisation's repositories since
2026-10-04, so the release workflow has never run. Only the UI and worker images exist on GHCR; the
API image does not. Everything below marked "on `main`" is built from source (Compose) until the
first release with images.

## v0.1 – Foundations (tagged v0.1.0 on 2026-10-04, built from source; no release images)

- [x] `agents.md` format: versioned, immutable once published, pipelines of 1..n agents, budgets,
  tool allowlists with argument constraints, approvals, data classification, runtime/toolbox.
- [x] Deterministic policy engine (audit agent) before every tool call; control agent guardrails.
- [x] Hash-chained audit trail with Ed25519 checkpoints, verify and NDJSON export.
- [x] Providers: OpenAI-compatible, Ollama, AWS Bedrock (VPC endpoint, proxy, IRSA), Anthropic, simulated.
- [x] Events: HMAC webhooks with replay protection, mail-in, Kafka (SASL/TLS), cron.
- [x] MCP gateway with allowlists, timeouts, size limits; policy gate as MCP proxy.
- [x] Control node API (OpenAPI 3.1), OIDC, LDAP/AD, scoped API tokens, RBAC per route, per-agent role bindings.
- [x] Worker with Postgres `SKIP LOCKED` queue, leases, approvals, cancellation, SSE.
- [x] Runners `in-process` and `local` (`oax run`); typed stubs for remote runners and harnesses.
- [x] Cost lines per tenant, agent, use case, run and step with CSV/JSON export; team budgets.
- [x] Change gate for schedules (HTTP and file probes), versioned development guidelines with a
  deterministic hardening review, opt-in dark-factory mode with its fixed notice.
- [x] Web UI (en/de) and a read-only demo seed.

## Done on `main`, ships with 0.2.0

- [x] Tenant isolation in every query and API (#1, PR #13).
- [x] BYOK model connections scoped to platform, tenant, team or agent (#2, PR #15).
- [x] Model catalog from a pinned models.dev snapshot and a weekly reviewed refresh PR (#5, PR #15).
- [x] Monthly budgets per tenant, use case and team with hard stop; alerts at 50/80/100 % as events
  and audit entries (#3, PR #18).
- [x] Air-gapped mode with a fail-closed egress policy (PR #16).
- [x] Claude Code as an external harness behind the policy gate (PR #17).
- [x] Runnable demo profile with fixed scenarios and an optional Claude Code mode (PR #21).

## v0.2 – Isolation, typed pipelines and operations (target: Q1 2027)

Wave 0:

- [x] **ADR 0008: agents.md data flow and isolation contract (handovers, when, tool profiles, per-step credentials, run node)** (W0-1, #23) – *As an agent engineer, I want one reviewed design for the new agents.md fields and the worker contract so that the wave 1 items can be built in parallel without redesigning each other's interfaces.*
- [ ] **Website and blog wording sync with the code (status badges, released features, planned items)** (W0-2, #24) – *As a reader of openagentix.si and the blog, I want every status claim to match the code so that I can trust what is marked available and what is planned.*

Wave 1:

- [x] **Typed handovers with JSON Schema validation and conditional steps (`when`)** (W1-1, #25) – *As an agent engineer, I want each step to hand over a schema-validated JSON artifact and to run only when its condition holds so that agents never pass free text between each other and plans can branch without an orchestrator agent.*
- [x] **Named read/write tool profiles per MCP server** (W1-2, #26) – *As an integrator, I want to publish named profiles per MCP server (for example `read` and `write`) with each tool classified as read or write so that agent engineers grant `jira:read` instead of hand-picking tools and a read-only step can never receive a write tool.*
- [x] **Remote run node, per-step credential broker and the container runner** (W1-3, #10, PR #76; opt-in, hardening follow-ups below) – *As a platform engineer, I want each run step in a short-lived container that receives only its own credentials and a short-lived run token so that a compromised tool cannot touch other runs or other steps' secrets.*
- [ ] **Model proxy on the control node: model access for run nodes, measured cost, budget reservations, harnesses through the proxy** (W1-3b, design: [ADR 0009](docs/adr/0009-model-proxy.md); in progress: W1-3b-1 to -7 merged, PRs #78, #80, #81, #79, #126, #127, #129; -8 partly, run-node image and harness settings in PR #138; -9 (docs, observability) and -10 (end-to-end abuse suite) open) – *As a platform engineer, I want isolated run nodes to call models only through a model proxy on the control node so that provider keys never reach a node, cost is measured by the platform instead of reported by the node, and budgets are hard limits even with concurrent calls.*
- [x] **Kubernetes Job runner (EKS/IRSA) with per-step credentials** (W1-4, #11) – *As an EKS operator, I want one Job per run step with its own ServiceAccount, IRSA role and NetworkPolicy so that credentials are scoped per agent step and nothing outlives the run.*
- [x] **Agent Check and Agent Plan v1 (advisory plan generation with a least-privilege lint)** (W1-5, #27) – *As a business user, I want to describe a process in plain language and get a reviewable Agent Plan that splits it into least-privilege steps so that an agent engineer starts from a safe blueprint instead of a god agent.*
- [x] **OpenCode harness adapter behind the policy gate** (W1-6, #28) – *As an agent engineer, I want to run an agent with OpenCode under openagentix so that its tool calls are policy-checked, approved, audited and costed exactly like native runs and like the Claude Code adapter.*

Wave 2:

- [ ] **Wave 1 hardening of the container runner: isolate test code from the node (separate UID, seccomp, patch secret scan)** (#140) – open; currently test code runs as the node's UID (ADR 0008 amendment 3). Rootless Podman instead of a Docker socket proxy is under consideration.
- [ ] **Toolbox images in CI: build, cosign signing, SBOM, Trivy scan, digest pinning and verification** (W2-1, #29) – *As a security engineer, I want toolbox images built, signed (cosign), SBOM'd (syft) and scanned (trivy) so that only verified binaries run as worker nodes.*
- [ ] **mTLS between remote worker nodes and the control node** (W2-2, #30) – *As an operator, I want mTLS between worker nodes and the control node so that run tokens are not the only protection.*
- [ ] **Emergency security overrides (kill switch that always wins)** (W2-3, #31) – *As a security lead, I want to block a tool, server, agent or tenant immediately during an incident, without editing reviewed policies, so that a security block always wins and takes effect within seconds.*
- [ ] **Agent test suites (`## Tests` in agents.md) and eval runner v1 incl. guideline evaluation** (W2-4, #8) – *As an agent engineer, I want scripted test cases run against the simulated provider on every publish, and guideline compliance measured in every eval run, so that regressions are caught before production.*
- [ ] **Notification channels, budget alert delivery and per-agent monthly budgets** (W2-5, #32) – *As a finance owner, I want a monthly limit per agent and budget alerts pushed to chat or mail, configured through the API, so that the hard stop is never a surprise.*
- [ ] **Console support for wave 1: plans, handovers and conditions, tool profiles, runners and credentials** (W2-6, #33) – *As an agent engineer, I want to see Agent Plans, step handovers, skipped steps, tool profiles and the runner of each step in the console so that every run is visible step by step.*

Release and verification gaps (found in the 2026-10-09 gap analysis against the website; none built yet):

- [ ] **First pre-release `v0.2.0-alpha.1`: API image on GHCR, GitHub release, signed images (cosign, SBOM), Helm install test on kind** – blocked while GitHub Actions is disabled for the account; the release workflow exists (`.github/workflows/release.yml`) but has never run.
- [ ] **Wire the Kubernetes Job runner into the worker** – the worker wiring is done (opt-in, fail closed, unit-tested with a fake client, see `docs/kubernetes-job-runner.md`); still open: a run against a real kind cluster (the test exists, skipped by default, because kind needs a privileged node container), the remaining review follow-ups (orphan sweeper, harness steps) and the Helm values.
- [ ] **Real-run verification of providers and harnesses** – OpenCode with a pinned binary; Claude Code through the model proxy inside a run node (the verified path of 2026-10-04 ran in-process); OpenAI, Azure OpenAI, OpenRouter, Bedrock with real accounts. Only Claude Code in-process is verified with real runs today.
- [ ] **Visibility of platform connections across tenants (known gap, ADR 0012)** – tracked by W12-1 (#113, #114).
- [ ] **Demo on the release images** (W8-4, #62) – the live demo runs on images built from source.

Dogfooding phase 1 (design: [docs/dogfooding-phase-1.md](docs/dogfooding-phase-1.md)): a bug-fix agent that works on a separate sandbox repository and proposes draft pull requests.

- [x] **DOG-0 design** (PR #137)
- [x] **DOG-1 run-node image `run-node-claude-code` and harness runtime settings** (PR #138)
- [ ] **DOG-1b subscription credential at the control node** – not built, by owner decision.
- [x] **DOG-2 confined workspace tools and node-computed patch** (PR #139)
- [x] **DOG-3a/3b hardened Git delivery and draft pull request extension** (PR #141)
- [ ] **DOG-3c/DOG-4 seed endpoint, `pull-request` output delivery and the bug-fix agent** (PR #144, open)
- [ ] **DOG-4a sandbox repository, DOG-4b stack and images, DOG-5 first real run** – need an API key with a spend limit and a token limited to the sandbox repository.

Wave 3:

- [ ] **Approval inbox with notifications and one-click decisions in Slack, Teams and mail** (W3-1, #34) – *As an operator, I want approvals in Slack/Teams/mail with one-click decisions so that agents do not wait for me to open the UI.*
- [ ] **More change-gate probes: API with secrets, SQL query, MCP read** (W3-2, #4; the code comment and the website documentation name v0.3, the plan names v0.2: to be aligned) – *As an integrator, I want schedules to run only when an authenticated API response, a database query or an MCP resource changes.*
- [ ] **Policy bindings per team and agent, control-agent rule API and RE2 patterns** (W3-3, #35) – *As a security engineer, I want to bind policy bundles to teams or agents, tune control-agent thresholds per team through the API and use ReDoS-safe patterns.*
- [ ] **HTTP/API connections and delivery of agent outputs to targets** (W3-4, #36) – *As an integrator, I want plain HTTP API connections next to MCP servers, and agent outputs delivered to their declared target, so that agents call REST APIs and post results without writing an MCP server.*
- [ ] **Observability completion: step, model and tool spans and the missing metrics** (W3-5, #37) – *As an operator, I want traces per run step, model call and tool call and metrics for tool calls, approvals, tokens and budget exhaustion so that I can see every run in my own monitoring.*
- [ ] **Operations API: settings write API, agent archive, demo resets, lighter run list and PostgreSQL benchmark in CI** (W3-6, #9) – *As an admin, I want to manage providers and enabled runners from the UI (audited), archive agents instead of deleting them, a demo that resets itself and measured p95 numbers on PostgreSQL for every release.*

Wave 4:

- [ ] **Homelab example agents: CVE triage, log anomalies, auto-repair PRs, uptime incidents, backup verification** (W4-4, #41) – *As a homelab owner, I want ready-made, tested example agents for daily CVE triage, log anomaly summaries, auto-repair PRs, incident summaries and backup restore tests.*

## v0.3 – External runtimes and enterprise integration (target: Q2 2027)

Wave 4:

- [ ] **Hermes and OpenClaw harness adapters** (W4-1, #38) – *As an agent engineer, I want to run Hermes or OpenClaw agents under openagentix with the same policy gate, audit and costs as native runs.*
- [ ] **GitHub Actions and GitLab CI runners with signed callbacks** (W4-2, #39) – *As a developer, I want code-changing agents to run in CI next to the repository with signed callbacks so that results arrive as reviewed PRs.*
- [ ] **AWS Lambda runner** (W4-3, #40) – *As a serverless team, I want one function per agent version inside our VPC so that runs scale to zero and reach Bedrock through VPC endpoints.*
- [ ] **Model routing per step (classification, cost, latency)** (W4-5, #42) – *As a platform owner, I want rules that choose the provider/model per step so that sensitive data stays on private models and cheap tasks use cheap models.*

Wave 5:

- [ ] **SCIM provisioning and tenant-scoped identity providers** (W5-1, #43) – *As an IT admin, I want users and groups provisioned via SCIM from Entra ID/Okta, per tenant, so that leavers lose access immediately.*
- [ ] **SIEM export of the audit trail (syslog, HTTP, S3)** (W5-2, #44) – *As a SOC analyst, I want audit entries streamed to Splunk/Elastic/Sentinel so that agent activity is part of our detections.*
- [ ] **Secret managers: HashiCorp Vault and AWS Secrets Manager with short-lived leases** (W5-3, #45) – *As a security engineer, I want secret references resolved from Vault/AWS SM with short-lived leases that the credential broker revokes after each step.*
- [ ] **Inbound Slack and Teams adapters and IMAP polling for mail** (W5-4, #46) – *As a support lead, I want tasks created from shared mailboxes and chat mentions without writing a relay.*
- [ ] **MCP catalog governance: review states, per-server egress and container MCP servers** (W5-5, #47) – *As a platform admin, I want a catalog with review states that decides which MCP servers a tenant may register and use, with network rules per server, and MCP servers that run as containers.*
- [ ] **OPA (Rego) adapter for the policy gate** (W5-6, #48) – *As a compliance team, I want to reuse Rego policies in the gate, which can only make decisions stricter.*

<!-- roadmap-v0.3-9-12:start -->
Waves 9-12 (added 2026-10-04, parallel tracks):

- [ ] **No-code agent builder with a round-trip code view and live Agent Check lint** (W9-1, design: [ADR 0010](docs/adr/0010-agent-authoring-builder-and-git-sync.md), issues #84, #85, #86, #87, #88, #89) – *As an integrator or team lead, I want to build and change agents in a form (metadata, triggers, budget, steps, tools by profile, handovers, conditions, runtime, classification) and switch to the code view at any time without losing comments or unknown fields so that I do not need to write YAML and engineers can still work in code.*
- [ ] **Git-synced agent repositories (GitOps): bindings, sync, review and publish, drift** (W9-2, design: [ADR 0010](docs/adr/0010-agent-authoring-builder-and-git-sync.md), issues #90, #91, #92, #93, #94, #95, #96) – *As a platform team, I want to connect a Git repository path as the source of a team's agents, with validation and Agent Check in the sync and publishing after review, so that agents are reviewed in pull requests, protected by branch rules and rolled back with a revert.*
- [ ] **Central outbound network configuration: per-destination proxies, trust store, mTLS, safe connectivity tests** (W10-1; in progress: W10-1-1 route resolver merged in PR #130, W10-1-2 dispatcher factory with DNS pinning merged in PR #133; design: [ADR 0011](docs/adr/0011-outbound-network-proxies-and-private-endpoints.md), issues #98, #99, #100, #101, #102, #103, #104, #105) – *As a platform operator in a corporate network, I want to define per destination which proxy (with credentials from the secret store), which CA bundle and which client certificate is used, and test connectivity safely, so that every outbound call of openagentix follows our network rules without code changes.*
- [ ] **Private model endpoints: Bedrock PrivateLink and Azure OpenAI private endpoints** (W10-2, design: [ADR 0011](docs/adr/0011-outbound-network-proxies-and-private-endpoints.md), issues #106, #107) – *As a cloud platform owner, I want model calls to reach Bedrock and Azure OpenAI over private connectivity (VPC interface endpoints, private endpoints) with correct signing and identity-based auth so that prompts never cross the public internet.*
- [ ] **Real read-only demo agent that answers questions about the project from its public repository** (W11-1, design: [demo-repo-agent.md](docs/demo-repo-agent.md), issues #109, #110, #111, #112) – *As a visitor of the demo, I want to ask a question about openagentix and get an answer with citations from the public repository so that I see a real agent work under the policy gate, read-only profile, budget and audit chain.*
- [ ] **Connections: MCP servers and model providers as separate areas, typed instances, central grants** (W12-1, design: [ADR 0012](docs/adr/0012-connections-instances-scopes-and-data-protection.md), issues #113, #114, #115, #116) – *As a tenant admin, I want MCP servers and model providers in their own console areas, several instances of the same server type with their own credentials, profiles, policies and budgets, and central connections only when the operator grants them, so that each use case gets exactly the access it needs and nothing is shared by accident.*
- [ ] **Data protection: data flow rules, retention, PII hooks, processing record, export and erasure, operator separation** (W12-2, design: [ADR 0012](docs/adr/0012-connections-instances-scopes-and-data-protection.md), issues #117, #118, #119, #120, #121, #122, #123, #124) – *As a data protection officer, I want classification, region and personal-data rules per connection, retention per tenant, a processing record of every external service, export and erasure, and operators kept away from tenant content, so that the platform supports GDPR obligations by design.*
<!-- roadmap-v0.3-9-12:end -->

## v0.4 – Agent lifecycle: Check, Plan, Build, Evaluate, Approve (target: Q3 2027)

Wave 6:

- [ ] **Agent Build v1: Agent Plan to agent scaffolding with schemas, tool bindings and eval cases** (W6-1, #49) – *As an agent engineer, I want an approved Agent Plan turned into agents.md files with schemas, profile-based tool bindings, budgets, approvals and starter test cases so that I tune behaviour instead of writing boilerplate.*
- [ ] **Evaluations v2: golden datasets, graders and a promotion gate** (W6-2, #50) – *As an agent engineer, I want golden datasets and graders run on every new version and model so that quality regressions block promotion.*
- [ ] **Version approval bound to digest, model, eval set and policy, with re-evaluation on material change** (W6-3, #51) – *As a risk officer, I want an agent version approved for production only together with its model configuration, evaluation set and policy, and re-evaluated when any of them changes.*
- [ ] **Dark software factory pipeline template, automatic hardening review of PRs and the LLM second opinion** (W6-4, #6) – *As a founder, I want a spec -> code -> tests -> PR template for prototypes with the fixed notice, and the hardening agent reviewing every development agent's PR automatically (optionally with a model that can only add findings).*
- [ ] **Console for the lifecycle: plans, evaluations, approvals of versions, guidelines and tenant admin** (W6-5, #52) – *As a platform admin, I want Agent Plans, evaluations, version approvals, guidelines and tenants in the console so that the whole path from process to production is visible in one place.*

- [ ] **Hierarchical tenants and setup modes** (W13, design: [ADR 0013](docs/adr/0013-hierarchical-tenants-and-setup-modes.md); in progress: W13-1 first slice, the tenant tree data model, merged in PR #136; sub-tenants cannot be created over HTTP yet; W13-2 onward not started).

<!-- roadmap-v0.4-9-12:start -->
Wave 9:

- [ ] **PR-back: propose console edits of Git-managed agents as pull requests** (W9-3, design: [ADR 0010](docs/adr/0010-agent-authoring-builder-and-git-sync.md), issues #97) – *As an agent engineer, I want to change a Git-managed agent in the console and get a pull request instead of a conflict so that Git stays the source of truth without forcing everyone into an editor.*
<!-- roadmap-v0.4-9-12:end -->

## v1.0 – Enterprise ready (target: H2 2027)

Wave 7:

- [ ] **Per-tenant audit chains and Merkle proofs** (W7-1, #53) – *As an auditor, I want one chain per tenant and compact proofs for single entries.*
- [ ] **Multi-step approval workflows (four-eyes, role chains, time windows)** (W7-2, #54) – *As a risk officer, I want multi-step approvals for dangerous tools.*
- [ ] **Cost chargeback reports per team and cost centre with ERP export** (W7-3, #55) – *As a finance controller, I want monthly cost reports per team/cost centre with export to our ERP.*
- [ ] **Data residency: region pinning of tenant data, models and audit storage** (W7-4, #56) – *As an EU company, I want tenant data, models and audit storage pinned to a region.*
- [ ] **Scale-out run queue on Valkey or Kafka** (W7-5, #57) – *As an operator of large installations, I want higher run throughput than a Postgres queue provides.*
- [ ] **Red-teaming campaigns against staging agents** (W7-6, #58) – *As a security engineer, I want automated prompt-injection and tool-abuse campaigns against staging agents so that guardrail gaps are found before attackers find them.*

Wave 8:

- [ ] **Stable v1 API and `openagentix.io/v1` agents.md with a deprecation policy and documented upgrades** (W8-1, #59) – *As an integrator, I want stable APIs and a stable agents.md schema with a deprecation policy so that upgrades do not break my automations.*
- [ ] **Air-gapped offline bundle: images, charts, SBOMs, signatures** (W8-2, #60) – *As a defence/critical-infrastructure operator, I want an offline bundle and no outbound calls at all.*
- [ ] **Private model hosting managed by the Helm chart (vLLM/Ollama with GPU scheduling)** (W8-3, #61) – *As a regulated enterprise, I want vLLM/Ollama deployments managed by the Helm chart with GPU scheduling so that restricted data never leaves our cluster.*
- [ ] **Public demo at demo.openagentix.si on the release images** (W8-4, #62) – *As a visitor, I want a live demo that I can trigger by curl or e-mail and whose audit chain I can verify.*

<!-- roadmap-v1.0-9-12:start -->
Wave 10:

- [ ] **Google Vertex AI provider with Private Service Connect** (W10-3, design: [ADR 0011](docs/adr/0011-outbound-network-proxies-and-private-endpoints.md), issues #108) – *As a GCP customer, I want Vertex AI models through a Private Service Connect endpoint with workload identity federation so that model traffic stays private like on AWS and Azure.*
<!-- roadmap-v1.0-9-12:end -->

Chart work (OCI publishing, signing, Kubernetes Job runner wiring, KEDA, multi-tenancy,
dashboards, private model hosting, offline bundle) is tracked in
[open-agentix-helm](https://github.com/open-agentix/open-agentix-helm/blob/main/ROADMAP.md).
