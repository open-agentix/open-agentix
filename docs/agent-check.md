# Agent Check and Agent Plan (v1, advisory)

An **Agent Plan** is a reviewable blueprint: it splits a process into small steps and says, for
each step, which capabilities it needs. The **Agent Check** lints that plan for least privilege
and can turn a clean plan into a **draft** `agents.md`. Everything here is advisory: nothing is
stored, nothing is published, and a finding can only warn, never grant anything. A draft becomes
an agent only through the normal create flow (`POST /v1/agents`, the editor, the wizard), where an
agent engineer reviews and publishes it.

The contract is fixed in [ADR 0008](adr/0008-agents-md-data-flow-and-isolation-contract.md),
section 4. Example: [`examples/plans/`](../examples/plans/).

## The plan format

YAML or JSON, strict (unknown keys are refused), at most 64 KiB.

```yaml
apiVersion: openagentix.io/v1alpha1
kind: AgentPlan
name: payment-ticket-analysis     # slug
version: 0.1.0                    # SemVer
description: ...                  # the process in plain language, max. 4000 characters
schemas: { Finding: { type: object } }   # same JSON Schema subset and limits as agents.md
steps:                            # 1..20, in execution order
  - id: research                  # slug, unique
    purpose: ...                  # max. 1000 characters
    capabilities: [jira:read, crm/get_customer]
    access: read-only             # read-only | write (required: say what the step is for)
    approval: none                # none | required
    input: { from: [event], schema: Ticket }   # `event` or earlier step ids; optional
    output: { schema: Finding }                # schema names from `schemas`; optional
    when: 'steps.research.output.severity == "high"'   # same grammar as agents.md
```

Capabilities are strings:

| Form | Meaning |
| --- | --- |
| `<server>:<profile>` | profile grant of a connection, for example `jira:read` |
| `<server>/<tool>` | a single tool, for example `crm/get_customer` (a trailing `*` is allowed but linted, LP008) |
| `model` | the step only reasons; it holds no tools |

`description` and `purpose` are free text for humans. **The linter never reads them**, and its
messages are fixed templates filled only with validated identifiers (step ids, capability strings),
so text in a plan cannot change a result.

## Lint rules

The lint is a pure function of the plan, the offered connections and the lint version
(`lintVersion: 1`); there is no model, no clock and no network.

| Code | Rule | Severity |
| --- | --- | --- |
| `LP001` | write capability without `approval: required` | warning |
| `LP002` | step reads one system and writes another | warning |
| `LP003` | step holds write capabilities of more than one system | warning |
| `LP004` | capability not offered by the available connections | error |
| `LP005` | step output used by a later step (`from`/`when`) without an output schema | warning |
| `LP006` | `access: read-only` with a write capability | error |
| `LP007` | `when`/`from` invalid or referencing an unknown or later step | error |
| `LP008` | wildcard tool capability (`server/*`, `server/get_*`) | warning |

Access classes come from the offered connections (names, profiles and tool access classes only,
never secrets and never tool descriptions). A connection may declare `tools: { name: { access } }`
and `profiles: { name: [tool, ...] }` in its config. Where nothing is declared the lint fails
closed: profile `read` is read, profile `write` is write, **every tool counts as write**. A
profile is write when any of its tools is write. Unknown capabilities are LP004 errors and are not
counted as read or write.

Structural problems (unknown keys, bad SemVer, duplicate step ids, undefined schema names, schemas
outside the JSON Schema subset) are not findings: the plan is not valid and the response lists
`errors`.

### Output format

```json
{
  "kind": "AgentPlanLint",
  "lintVersion": 1,
  "planDigest": "sha256:<hex of the canonical plan JSON>",
  "findings": [
    { "code": "LP001", "severity": "warning", "path": "steps.2.capabilities.0",
      "message": "write capability jira:write without approval", "source": "lint" }
  ],
  "summary": { "error": 0, "warning": 1, "info": 0 }
}
```

Findings are sorted by `path`, then `code`; numeric path segments compare as numbers
(`steps.2` before `steps.10`). `planDigest` is the SHA-256 of the canonical JSON of the parsed
plan (defaults applied), so YAML and JSON spellings of the same plan have the same digest.

## Model-assisted suggestions (optional)

`POST /v1/plans/check` accepts `assist: { provider, model }`. The model gets the plan, the offered
connections (names, profile names, access classes) and the lint codes, as data. Its answer is
untrusted:

- it must be one JSON object `{ "notes": [{ "severity": "info"|"warning", "path"?, "message" }] }`
  (strict: extra keys, `error` severity, more than 20 notes or messages over 500 characters
  discard the **whole** answer and add one fixed `info` finding);
- notes become findings with `source: "model"` and `code: "MODEL"`, appended **after** the lint
  findings. They cannot remove, downgrade or reword a lint finding and never change the plan or
  grant a capability. Control and bidirectional characters are stripped; a `path` that is not a
  step field of this plan becomes `plan`;
- if the model call fails, the lint result is returned unchanged with one `info` finding.

The call needs `agents:write`, a configured provider (platform provider or a `model` connection of
the tenant) cleared for `internal` data, and budget: it is budget-checked like a run step (`402
<scope>_budget_exceeded` when a limit is reached), costed with the tenant's price table, written to
the cost ledger under the use case `agent-check` and audited. With the `simulated` provider the
answer is one fixed note, so tests and the demo need no network.

## Draft generator

`POST /v1/plans/generate` (and `oax plan generate`) turns a plan without error findings into a
draft `agents.md`. It is deterministic (same plan, same text, no timestamps) and validated with
the real parser before it is returned:

- steps become `agents[]` in order, `pipeline` lists them; `access`, `input`, `output`, `when`
  and `schemas` are copied (schema names become `$ref: "#/schemas/<name>"`, an output schema adds
  `outputs: [{ format: json }]`);
- `server:profile` becomes a profile grant, `server/tool` a concrete grant
  (`allowAdditionalArgs: true`, narrow it in review); the step's `approval` is copied to every
  grant; `model` adds nothing, so a read-only step never gets a write tool;
- provider and model default to `simulated`, the owner to `unassigned` (set a real team before
  you create the agent), classification `internal`, a conservative budget, a manual trigger and the
  labels `plan` and `plan-digest`;
- `purpose` becomes one `Purpose: ...` line per agent (control characters and line breaks are
  replaced), the description goes through a YAML writer, so a plan cannot add sections, agents or
  front matter keys.

## API

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `POST /v1/plans/check` | `agents:read` and `connections:read`; `assist` also needs `agents:write` | `{ source, connections?, assist? }` -> `{ valid, errors, plan, lint, usage }` |
| `POST /v1/plans/generate` | `agents:write` and `connections:read` | `{ source, connections?, provider?, model?, owner? }` -> `{ valid, errors, plan, lint, draft }`; `draft` is `null` when the lint has errors |

Limits: `source` at most 64 KiB, request body at most 388 KiB, `OAX_RATE_LIMIT_PLAN_MAX` requests
per minute per token/IP (default 30). Audit entries: `plan.checked` (`planDigest`, `lintVersion`,
`model`, `summary`, `costMicros`) and `plan.generated` (`planDigest`, `summary`, `draftDigest`);
a blocked model call writes `budget.blocked`. Both endpoints are side-effect free and therefore
allowed in the read-only public demo. Plans are not stored yet; storage as versioned drafts is
planned (W2-6).

## CLI

Deterministic and offline, no API or model needed:

```bash
oax plan check examples/plans/payment-ticket-analysis.plan.yaml --connections examples/plans/connections.json
oax plan check plan.yaml --json
oax plan generate plan.yaml --connections connections.json --owner team-support > agents.md
```

`--connections` is a JSON array `[{ "name", "tools": { "<tool>": "read"|"write" }, "profiles":
{ "<name>": ["<tool>"] } }]`. Without it capabilities are not verified (no LP004) and the fail-closed
access classes above apply. `check` exits 1 for an invalid plan or error findings; `generate`
refuses plans with error findings.

## Web UI

**Agent plans** (Build group): paste or upload a plan, see the findings, and (with `agents:write`)
generate the draft. The draft is shown read-only with a copy button; "Open in the new agent editor"
hands it to the normal `New agent` page, where it is saved only if you create the agent. English
and German.
