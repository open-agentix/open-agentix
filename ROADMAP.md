# Roadmap

Milestones are mirrored as GitHub milestones/issues. Every item has a one-line user story. Dates
are targets, not promises.

## v0.1 – MVP (this release)

- [x] `agents.md` format: versioned, immutable once published, pipelines of 1..n agents, budgets,
  tool allowlists with argument constraints, approvals, data classification, runtime/toolbox.
- [x] Deterministic policy engine (audit agent) before every tool call; control agent guardrails.
- [x] Hash-chained audit trail with Ed25519 checkpoints, verify and NDJSON export.
- [x] Providers: OpenAI-compatible, Ollama, AWS Bedrock (VPC endpoint, proxy, IRSA), Anthropic, simulated.
- [x] Events: HMAC webhooks with replay protection, mail-in, Kafka (SASL/TLS), cron.
- [x] MCP gateway with allowlists, timeouts, size limits; policy gate as MCP proxy.
- [x] Control node API (OpenAPI 3.1), OIDC, LDAP/AD, scoped API tokens, RBAC per route.
- [x] Worker with Postgres `SKIP LOCKED` queue, leases, approvals, cancellation, SSE.
- [x] Runners `in-process` and `local` (`oax run`), typed stubs for remote runners and harnesses.

## v0.2 – Isolation and operations (target: Q1 2027)

Concept v2 follow-ups (data model already in place since v0.1.0)
- **Budgets per run, use case and tenant** – *As a finance owner, I want hard-stop budgets per run, agent, use case, tenant and month with alerts.* (v0.1.0: agent and team budgets, cost lines carry tenant/use case/step.)
- **More change-gate probes (API with secrets, SQL query, MCP read)** – *As an integrator, I want schedules to run only when a database query or an MCP resource changes.* (v0.1.0: HTTP and file probes.)
- **Dark software factory pipeline template** – *As a founder, I want a spec -> code -> tests -> PR pipeline for MVPs with the fixed "MVP/PoC only" notice and merge/deploy approvals kept for production.*
- **LLM second opinion for the hardening agent** – *As a security lead, I want an optional model review of pull requests that can only add findings to the deterministic guideline review.*
- **Guideline evaluation in agent eval suites** – *As an agent engineer, I want guideline compliance measured in every eval run.*
- **Demo resets** – *As the demo operator, I want the public demo data to be rebuilt on a schedule so that it always looks fresh.* (v0.1.0: read-only demo mode.)

Runners and toolboxes
- **Container runner** – *As a platform engineer, I want each run in a short-lived container from its toolbox image so that a compromised tool cannot touch other runs.*
- **Kubernetes Job runner (EKS/IRSA)** – *As an EKS operator, I want one Job per run with its own ServiceAccount, IRSA role and NetworkPolicy so that credentials are scoped per agent.*
- **Toolbox catalog in CI** – *As a security engineer, I want toolbox images built, signed (cosign), SBOM'd (syft) and scanned (trivy) so that only verified binaries run.*
- **Remote worker transport hardening** – *As an operator, I want mTLS between worker nodes and the control node so that run tokens are not the only protection.*
- **Per-run secret injection** – *As an integrator, I want secrets injected per run and revoked afterwards so that leaked credentials expire immediately.*

API follow-ups from the UI integration (deferred from v0.1.0)
- **HTTP/API connections** – *As an integrator, I want plain HTTP API connections (base URL, auth by secret reference, allowed paths) next to MCP servers so that agents can call REST APIs without writing an MCP server.*
- **Policy bindings per agent/team** – *As a security engineer, I want to bind policy bundles to specific teams or agents instead of only globally so that teams can have stricter rules.*
- **Control-agent rule API** – *As a platform owner, I want to change rate, loop and anomaly thresholds per team through the API so that guardrails are tunable without redeploys.*
- **Budget alert API** – *As a team lead, I want to configure alert thresholds and channels for budgets via the API.*
- **Settings write API** – *As an admin, I want to manage providers (incl. Bedrock region, VPC endpoint, proxy) and enabled runners from the UI, audited, instead of environment variables.*
- **Agent archive** – *As an agent engineer, I want to archive agents (hidden, no new runs, history kept) instead of deleting them.*
- **Lighter run list projection and PostgreSQL benchmark in CI** – *As an operator, I want measured p95 numbers on PostgreSQL for every release.*

Product
- **UI v1** – *As a business user, I want to describe a workflow and see runs, approvals and costs in a browser.*
- **Approval inbox + notifications** – *As an operator, I want approvals in Slack/Teams/mail with one-click decisions so that agents do not wait for me to open the UI.*
- **Agent test suites (`## Tests` in agents.md)** – *As an agent engineer, I want scripted test cases run against the simulated provider on every publish so that regressions are caught before production.*
- **Budget alerts** – *As a team lead, I want alerts at 50/80/100 % of a monthly budget so that the hard stop is never a surprise.*
- **RE2 regex engine for policies** – *As a security engineer, I want ReDoS-safe policy patterns.*

Homelab / small shop ("servDash"-style ops agents, shipped as example agents)
- **CVE triage of container images** – *As a homelab owner, I want Trivy findings triaged and summarised daily so that I only look at what is exploitable.*
- **Log anomaly summaries** – *As a self-hoster, I want an agent to summarise unusual log patterns every 6 hours so that I notice problems without reading logs.*
- **Auto-repair pull requests** – *As a maintainer, I want minor/patch dependency fixes opened as PRs with green builds so that security debt shrinks automatically.*
- **Uptime incident summaries** – *As an on-call person, I want an incident summary (timeline, probable cause, next steps) when a monitor fires.*
- **Backup verification** – *As a homelab owner, I want an agent to restore-test the latest backup weekly and report the result so that I trust my backups.*

## v0.3 – Enterprise integration (target: Q2 2027)

- **AWS Lambda runner** – *As a serverless team, I want one function per agent version inside our VPC so that runs scale to zero and reach Bedrock through VPC endpoints.*
- **GitHub Actions / GitLab CI runners** – *As a developer, I want code-changing agents to run in CI next to the repository with signed callbacks so that results arrive as reviewed PRs.*
- **External harnesses (Claude Code, OpenCode, Hermes, OpenClaw)** – *As an agent engineer, I want to run an existing harness under openagentix so that its tool calls are policy-checked, audited and costed like native runs.*
- **SSO/SCIM** – *As an IT admin, I want users and groups provisioned via SCIM from Entra ID/Okta so that leavers lose access immediately.*
- **SIEM export** – *As a SOC analyst, I want audit entries streamed to Splunk/Elastic/Sentinel (syslog, HTTP, S3) so that agent activity is part of our detections.*
- **Secrets managers (Vault, AWS Secrets Manager)** – *As a security engineer, I want secret references resolved from Vault/AWS SM with short-lived leases.*
- **Model routing** – *As a platform owner, I want rules (classification, cost, latency) to choose the provider/model per step so that sensitive data stays on private models and cheap tasks use cheap models.*
- **OPA adapter for the policy gate** – *As a compliance team, I want to reuse Rego policies.*
- **Valkey-backed event bus / Kafka run queue** – *As an operator of large installations, I want higher run throughput than a Postgres queue provides.*
- **Mail via IMAP, Slack/Teams adapters** – *As a support lead, I want tickets created from shared mailboxes and chat messages.*

## v1.0 – Enterprise ready (target: H2 2027)

- **Multi-tenancy** – *As a service provider, I want hard tenant isolation (data, keys, audit chains, quotas) so that I can run openagentix for several customers.*
- **Data residency** – *As an EU company, I want tenant data, models and audit storage pinned to a region so that we meet residency requirements.*
- **Approval workflows** – *As a risk officer, I want multi-step approvals (four-eyes, role chains, time windows) for dangerous tools.*
- **Cost chargeback** – *As a finance controller, I want monthly cost reports per team/cost center with export to our ERP.*
- **Eval and regression suites for agents** – *As an agent engineer, I want golden datasets and graders run on every new version and model so that quality regressions block promotion.*
- **Red-teaming of agents** – *As a security engineer, I want automated prompt-injection and tool-abuse campaigns against staging agents so that guardrail gaps are found before attackers find them.*
- **Private model hosting** – *As a regulated enterprise, I want vLLM/Ollama deployments managed by the Helm chart with GPU scheduling so that restricted data never leaves our cluster.*
- **Air-gapped installs** – *As a defence/critical-infrastructure operator, I want an offline bundle (images, charts, SBOMs, signatures) and no outbound calls at all.*
- **Per-tenant audit chains + Merkle proofs** – *As an auditor, I want compact proofs for single entries.*
- **Stable `v1` API and `openagentix.io/v1` agents.md** with a deprecation policy.
