# External agent harnesses

A harness (Claude Code, OpenCode, Hermes, OpenClaw) can execute an agent instead of the built-in
step loop. The platform never requires one. The rule is always the same: **the harness only gets
the openagentix policy gate as its tool source**, so policy decisions, approvals, audit entries,
cost tracking and the control agent apply exactly as for native runs.

| Harness | Status |
| --- | --- |
| `claude-code` | Implemented (`claude -p`, verified for real: [verification](verification/claude-code-harness.md)) |
| `opencode`, `hermes`, `openclaw` | Documented stubs: same `ExternalHarness` interface, `buildInvocation`/`run` throw `NotImplementedError` |

## How a Claude Code run works

`executeWithHarness(run, ctx, harness)` (`packages/runners/src/harness-runner.ts`):

1. Starts the **policy gate as an MCP bridge**: a streamable-HTTP MCP server on `127.0.0.1` with a
   random per-run bearer token (`serveGateHttp`, `packages/mcp/src/gate-http.ts`). It lists only the
   tools the agent is granted.
2. Creates a temporary work directory (mode 0700, deleted afterwards) with `.openagentix/mcp.json`
   pointing at the gate.
3. Runs `claude -p --output-format stream-json --verbose --model <agent.model> --mcp-config ...
   --strict-mcp-config --tools "" --permission-mode dontAsk --allowedTools <exact gate tools>
   --restricted --disable-slash-commands --no-session-persistence --max-turns N --max-budget-usd X`.
   The prompt goes on stdin. No built-in tools exist, MCP servers other than the gate are ignored, and
   `--restricted` ignores settings and `CLAUDE.md` files of the host (also in parent directories).
4. Every tool call arrives at the gate: the policy engine decides (audited as `policy.decision`),
   `require_approval` waits for a human, the call is executed by the MCP gateway and recorded as
   `policy_decision` / `approval` / `tool_call` steps; the control agent can kill the run after each call.
5. The result becomes a `model_call` step (provider `claude-code`, tokens and cost as reported by the
   harness) and an `output` step. If the harness reports any tool outside the gate, the run is
   `blocked_by_policy` (`harness_unmanaged_tool`).

### Limits of the agent contract

| Agent contract | Claude Code | Also enforced by the platform |
| --- | --- | --- |
| `budget.maxSteps` | `--max-turns` | kills the process above the limit; error `control_budget_steps` |
| `budget.maxCostUsd` (remaining run budget) | `--max-budget-usd` | control agent after the call; `control_budget_cost` |
| `budget.timeoutSeconds` (remaining) | - | kills the process; `control_timeout` |
| cancellation | - | kills the process; `cancelled` |

Output volume is capped (16 MiB). Without `maxSteps` the default is 25 turns.

### Environment and credentials

The child process gets only `PATH`, `HOME`, `LANG`, `NO_COLOR` and two Claude Code switches
(`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`): no proxy, cloud, CI or database
variables. Two ways to authenticate, neither is ever logged or stored:

- **Existing login of the host user** (default): `HOME` points at the user whose `claude` login is used.
- **Token file**: `claude setup-token` (done by the owner) writes a long-lived token; mount the file
  read-only and pass `oauthTokenFile` / `oax run --harness-token-file <file>`. It is read at spawn
  time, handed to the child as `CLAUDE_CODE_OAUTH_TOKEN` with an isolated empty `HOME`, and scrubbed
  from everything the harness returns.

### Using it

```bash
oax run examples/cve-triage.agents.md --event examples/events/trivy-finding.json --harness claude-code
```

Agent files name the model in `model:` (for example `haiku`, `sonnet` or a full model id); the
`provider:` field is only used for the data-classification check (a provider with that name, else
`internal` clearance; pass `clearance` in the options to change it).

## Tests

- Unit and integration tests use a fake `claude` binary and a scripted harness (always run in CI).
- `OAX_TEST_CLAUDE=1 pnpm vitest run packages/runners/test/claude-code.integration.test.ts` runs the
  real CLI with hard budgets (a few cents; optional `OAX_TEST_CLAUDE_TOKEN_FILE`,
  `OAX_TEST_CLAUDE_REPORT=<file>` to regenerate the verification report). Skipped otherwise.

## Adding a harness

Implement `ExternalHarness` (`buildInvocation` returns command, args, minimal env, files and stdin;
`run` executes it and returns a `HarnessResult`) and register it in `createHarness`. Keep the three
rules: the gate is the only tool source, a minimal environment, and limits enforced by the platform
as well as by the harness' own flags.
