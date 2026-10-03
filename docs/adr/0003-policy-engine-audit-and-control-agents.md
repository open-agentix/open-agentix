# ADR 0003: Policy engine, audit agent and control agent

- Status: Accepted
- Date: 2026-10-03

## Context

LLM agents can be prompt-injected or simply wrong. Guardrails expressed in prompts are not
guardrails. We need decisions that are deterministic, explainable and auditable.

## Decision

- **Audit agent (per agent) = deterministic policy engine** (`evaluateToolCall`, pure function,
  no I/O). It runs on the control node **before every tool call** and returns
  `allow | deny | require_approval` with all reasons. Checks in order: global forbidden tools,
  agent allowlist (exact or `prefix*`), argument constraints (`type`, `required`, `pattern`,
  `enum`, `const`, length/range/items, `deny` regexes, unknown arguments rejected by default),
  global forbidden argument patterns, per-run call limits, data classification of the tool and of
  the policy bundle, then approval rules from the agent file or the bundle.
- Tools that are not granted are not even shown to the model (`ToolGateway.exposedTools`).
- **Control agent (global)** evaluates run metrics before every model call and after every tool
  call: token/cost/step/tool-call budgets, timeouts, tool-call rate (pause), identical calls
  (loop), consecutive errors, repeated policy denials and any attempt at a globally forbidden
  action (kill → `blocked_by_policy`), and provider clearance vs data classification. An optional
  reviewer (e.g. an LLM second opinion) can only make a decision **stricter**.
- **Human approvals**: `approval: required` pauses the run (`awaiting_approval`) until a user with
  `runs:approve` and one of the agent's `approverRoles` decides; timeouts fail the run.
- Every decision is written to the audit trail with arguments (redacted) and reasons.

## Consequences

- Decisions are reproducible from the audit trail and testable without models.
- Policy authors must anticipate argument shapes; `allowAdditionalArgs` is an explicit opt-out.
- Regexes in policies are admin-provided; they are compiled on save. ReDoS-safe matching (RE2) is
  on the roadmap.

## Alternatives considered

- OPA/Rego: powerful but another language and runtime for agent authors; an OPA adapter can be
  added behind the same `PolicyGate` interface (ROADMAP v0.3).
- LLM-as-judge as primary gate: non-deterministic and itself injectable; allowed only as a
  stricter second opinion.
