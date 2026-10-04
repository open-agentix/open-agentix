# Demo with OAX_DEMO_LLM=claude-code: real verification

A visitor request `POST /v1/demo/scenarios/cve-xz-backdoor/run` (no body, fixed scenario) was
executed by the worker through the Claude Code harness on 2026-10-04
(CLI `2.1.289`, model `haiku`, existing host login, no token printed).

| Field | Value |
| --- | --- |
| Run status | `succeeded` |
| Wall time | 16.0 s |
| Cost (both pipeline agents) | $0.0262 of the $0.05 per-run cap |
| Policy-gated tool calls | 2 |
| Daily budget spent / cap | $0.0262 / $1.00 |
| Audit chain | valid |

Recorded steps: `policy_decision:cve-db/lookup_cve:ok`, `tool_call:cve-db/lookup_cve:ok`, `model_call:claude-code/claude-haiku-4-5-20251001:ok`, `output:json:ok`, `policy_decision:tickets/add_comment:ok`, `tool_call:tickets/add_comment:ok`, `model_call:claude-code/claude-haiku-4-5-20251001:ok`, `output:markdown:ok`

Not covered here: the container images (`worker-claude`) are built by CI; this report ran the same
code in-process against an embedded database.
