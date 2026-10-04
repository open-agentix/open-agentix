# Claude Code harness: real verification

Produced by a real run of the Claude Code CLI `2.1.289` on 2026-10-04:

```bash
OAX_TEST_CLAUDE=1 OAX_TEST_CLAUDE_REPORT=docs/verification/claude-code-harness.md \
  pnpm vitest run packages/runners/test/claude-code.integration.test.ts
```

Authentication: the existing login of the host user (default). No token was passed in, written to a
file or printed; the child process gets a minimal environment (`PATH`, `HOME`, `LANG`, no proxy,
CI or cloud variables) and runs in a temporary directory that is deleted afterwards.

Agent `harness-check`: model `haiku`, one granted tool `cve-db/lookup_cve` (argument `cveId`
must match `^CVE-\d{4}-\d{4,}$`), event `{"question":"How severe is CVE-2024-3094 and in which version is it fixed?"}`.

## Invocation

`claude -p --output-format stream-json --verbose --model haiku --mcp-config .openagentix/mcp.json
--strict-mcp-config --tools "" --permission-mode dontAsk --allowedTools mcp__oax-gate__cve-db__lookup_cve
--restricted --disable-slash-commands --no-session-persistence --max-turns N --max-budget-usd X`

- `--tools ""`: no built-in tools (no Bash, file or web access); the policy gate is the only tool source.
- `--strict-mcp-config` + the gate as streamable-HTTP MCP server on loopback, per-run bearer token.
- `--restricted --disable-slash-commands`: ignores user/project/local settings, CLAUDE.md files (also in
  parent directories) and skills of the host.
- The prompt is passed on stdin; limits are additionally enforced by the platform.

## Scenarios

### 1. Allowed tool call

Limits: `maxSteps: 3` (`--max-turns 3`), `maxCostUsd: 0.1` (`--max-budget-usd 0.1`), `timeoutSeconds: 120`.

| Field | Value |
| --- | --- |
| Run status | `succeeded` (error code: `-`) |
| Wall time | 4.5 s |
| Tokens in / out | 8784 / 280 |
| Cost reported by the harness | $0.0109 |
| Policy-gated tool calls | 1 |
| Audit chain | valid, 5 entries |

Recorded steps: `policy_decision:cve-db/lookup_cve:ok`, `tool_call:cve-db/lookup_cve:ok`, `model_call:claude-code/claude-haiku-4-5-20251001:ok`, `output:markdown:ok`

Answer (sanitized): > CVE-2024-3094 is **CRITICAL** (CVSS 10) and is fixed in version **5.6.2**.

### 2. Turn limit

Limits: `maxSteps: 1` (`--max-turns 1`: one tool call needs two turns).

| Field | Value |
| --- | --- |
| Run status | `failed` (error code: `control_budget_steps`) |
| Wall time | 3.2 s |
| Tokens in / out | 4251 / 171 |
| Cost reported by the harness | $0.0093 |
| Policy-gated tool calls | 1 |
| Audit chain | valid, 4 entries |

Recorded steps: `policy_decision:cve-db/lookup_cve:ok`, `tool_call:cve-db/lookup_cve:ok`, `model_call:claude-code/claude-haiku-4-5-20251001:error`

Answer (sanitized): (none)

### 3. Forbidden tool (global policy)

Limits: as in 1, plus a platform policy that forbids `cve-db/lookup_*`.

| Field | Value |
| --- | --- |
| Run status | `blocked_by_policy` (error code: `control_forbidden_action`) |
| Wall time | 3.2 s |
| Tokens in / out | 0 / 0 |
| Cost reported by the harness | $0.0000 |
| Policy-gated tool calls | 1 |
| Audit chain | valid, 4 entries |

Recorded steps: `policy_decision:cve-db/lookup_cve:denied`, `control:kill:error`, `model_call:claude-code/claude-haiku-4-5-20251001:error`

Answer (sanitized): (none)

## What this proves

- The CLI runs headless and every tool call goes through the policy gate: decided by the policy engine,
  executed by the MCP gateway, recorded as `policy_decision` / `tool_call` steps and chained into the audit log.
- A globally forbidden tool never reaches the tool server (scenario 3).
- Turn limits of the agent contract stop the harness (scenario 2).
- Tokens and cost reported by the harness are recorded on the `model_call` step and counted against the run budget.

## Limits of this verification

- One host, one CLI version, one small model; it shows the mechanism works end to end, not that
  every Claude Code version behaves identically. Re-run the command above after upgrading the CLI.
- When the platform kills a harness (policy kill, timeout, cancel) the cost it had incurred is not
  reported (scenario 3 shows 0 tokens); the per-run budget flag (`--max-budget-usd`) bounds it.
- The check that no built-in tool was used relies on the stream the CLI reports; `--tools ""`
  already removes the built-in tools, so the check is a second line of defence.
- The harness needs its own network access to the Anthropic API; it is not usable in air-gapped
  mode (see `docs/airgapped.md`): in air-gapped mode the harness refuses to start unless `api.anthropic.com` (or `anthropicUrl`) is on `OAX_AIRGAPPED_ALLOW`.
