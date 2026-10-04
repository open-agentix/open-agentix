# ADR 0005: Runners and external harnesses

- Status: Accepted
- Date: 2026-10-03

## Context

Runs must execute in very different places: inside the worker process, on a developer laptop, in
a short-lived container with only the tools it needs, as a Kubernetes Job on EKS with IRSA, as an
AWS Lambda inside a VPC, or in a CI system next to the code. Some teams also want existing agent
harnesses (Claude Code, OpenCode, Hermes, OpenClaw) as executors.

## Decision

- **Runner contract** (`packages/runners`): `Runner.execute(PreparedRun, RunnerContext)` where
  `PreparedRun` = agent definition + event + policy bundles + limits, and the context carries a
  **ControlPlane** (policy gate, step recording, approvals, cancellation, completion). Every runner
  uses the same step executor, so policy engine, audit chain and budgets are identical everywhere.
- v0.1 implements `in-process` (worker) and `local` (CLI `oax run agents.md --event file.json`,
  simulated provider and demo MCP servers by default, in-memory audit chain verified at the end).
- `container`, `kubernetes-job`, `aws-lambda`, `github-actions`, `gitlab-ci` exist as **typed
  stubs** with final configuration schemas; `execute` throws `NotImplementedError` naming the
  milestone (v0.2 / v0.3).
- **External harnesses** implement `ExternalHarness`: translate an agents.md agent into the
  harness configuration and point the harness at the **policy gate MCP proxy** as its only tool
  source (`createPolicyGateServer`). The Claude Code adapter already generates the invocation
  (`claude -p … --strict-mcp-config --allowedTools mcp__oax-gate__…`) and **runs it** through
  `executeWithHarness` (policy gate as loopback MCP bridge, limits enforced by flags and by the
  platform, see `docs/harnesses.md`). OpenCode, Hermes and OpenClaw are documented stubs with the
  same interface. The platform works fully without any harness.

## Consequences

- Moving a run from in-process to a container or Job changes only transport and isolation.
- Harnesses can only reach tools through the gate, so audit and costs stay complete; model costs
  inside a harness are taken from the harness' report and counted against the run budget.

## Alternatives considered

- Separate executors per target: duplicates the step loop and the guardrails.
- Allowing harnesses their own tools: breaks the audit guarantee.
