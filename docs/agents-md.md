# agents.md reference: data flow and isolation fields

The full `agents.md` format (front matter, `## Agent: <id>` sections, tools, budgets, triggers,
runtime) is described on the website's agents.md reference. This page covers the fields added by
[ADR 0008](adr/0008-agents-md-data-flow-and-isolation-contract.md). All of them are optional and
`apiVersion` stays `openagentix.io/v1alpha1`; files without them behave exactly as before.

> **Status:** `schemas`, `input`, `output` and `when` have **runtime effect** (typed handovers and
> conditional steps, W1-1, see [pipelines](pipelines.md)). `access` and `tools[].profile` are enforced
> (see [MCP connections and tool profiles](mcp.md)): a profile grant is expanded into concrete tool
> grants when the version is published, a draft that has not been published grants nothing.
> `credentials` and the per-step `runtime` (`runner: container`, narrower `egress`) have **runtime effect**
> with the opt-in `container` runner (W1-3a, see [runners](runners.md)): the credential broker hands a
> step exactly its declared secrets once per step. Models are not reachable from run nodes yet (W1-3b),
> and the `kubernetes-job` runner follows with W1-4.

| Field | Where | Meaning | Checked at publish |
| --- | --- | --- | --- |
| `schemas` | top level | Named JSON Schemas, referenced as `{ $ref: "#/schemas/<name>" }` (max. 32) | Subset and limits, unused schemas warn |
| `input.schema` | `agents[]` | Validates what the step receives; a violation fails the run (`handover_invalid`) | Subset and limits |
| `input.from` | `agents[]` | `event` and/or ids of earlier steps; the step receives `{ <source>: value }` and nothing else | Sources exist and run earlier, no duplicates |
| `output.schema`, `output.onInvalid` | `agents[]` | Validates the step's JSON output before the next step; `fail` (default) or one `retry` turn with the validation errors | Subset and limits; needs `outputs: [{ format: json }]` |
| `when` | `agents[]` | Condition over `event` and `steps.<id>.output`; false skips the step (status `skipped`, audit `step.skipped`), an evaluation error fails the run (`condition_error`) | Grammar, limits, referenced steps run earlier |
| `access` | `agents[]` | `read-only` or `write` | A read-only step that receives a write tool (directly, by wildcard or through a profile) is refused; the policy gate denies it again at run time (`profile_write_denied`) |
| `tools[].profile` | `agents[].tools[]` | Grant of a named profile of a connection (`{ server: jira, profile: read }`), with optional `approval`, `maxCallsPerRun`, `classification` | Duplicates; the connection and the profile must exist (unknown names are refused) |
| `credentials` | `agents[]` | `[{ secret: <ref>, env?: NAME }]`, references only (max. 16) | Reference format, duplicates, reserved env names (`PATH`, `OAX_*`, `LD_*`, ...) |
| `runtime.runner`, `runtime.egress` | `agents[]` | Runner override for this step; egress can only narrow the pipeline's `runtime.egress` | Egress subset |
| `runtime.harness` | `agents[]` | `claude-code` or `opencode`: the step runs in a run node through that harness, which talks to the model proxy with the step's model token ([harnesses](harnesses.md#through-the-model-proxy-run-nodes)) | Isolating runner (`container`, `kubernetes-job`), no `simulation`; enabled by the operator at publish |

## Tool grants: argument constraints, call limits, wildcards

A tool grant (`agents[].tools[]` with `server` and `tool`) decides one tool. Everything it adds only
**restricts**: a grant never allows more than its `server` and `tool` name.

| Field | Meaning |
| --- | --- |
| `args` | Constraints per top-level argument: `type`, `required`, `enum`, `const`, `pattern` (needs `maxLength`), `minLength`, `maxLength` (code points), `minimum`, `maximum`, `maxItems`, `deny` (patterns that must match no string inside the value) |
| `allowAdditionalArgs` | Default `false`: an argument that `args` does not list denies the call. A grant with neither `args` nor `allowAdditionalArgs: true` only allows calls without arguments |
| `maxCallsPerRun` | Allowed calls of this tool in one run (all steps); denied calls do not count; a reached limit denies with `call_limit` |
| `approval`, `classification` | Human approval; highest data class the tool may receive |

A `pattern` matches when it is found **anywhere** in the value (unanchored, a substring match): write
`^...$` to match the whole value (validation warns when a `pattern` is not anchored). `pattern` and `deny` need
`maxLength` of at most 4096, at most 64 `deny` patterns per argument; matching is linear-time (RE2 semantics:
no backreferences, no lookaround) and bounded in work per call.

Checked at validate and publish: every `pattern` and `deny` entry must compile and must not use a
backreference, a lookaround, or a repeated group that contains a repetition or an alternation
(`(a+)+`, `(a|aa)*`); a `pattern` needs `maxLength`; `pattern`/`minLength`/`maxLength` need type `string`,
`minimum`/`maximum` a numeric type, `maxItems` an array; `minimum <= maximum`, `minLength <= maxLength`.
At run time the checks fail closed: a bound that does not fit the type of the value denies, the
arguments must be an object, only own properties count as arguments, a string longer than `maxLength` is
never run through a pattern, and a `deny` rule that cannot inspect the whole value denies. Denial reasons name
the argument and the rule, never the value. Rationale and the mapping to AWP: [AWP](awp.md#argument-constraints-call-limits-and-action-groups-aep-0002).

**Prefix wildcards are deprecated** (`tool: "get_*"`, `tool: "*"`; AWP decision D4). A prefix grants tools
that do not exist yet. Publish replaces a wildcard by one grant per tool of the approved tool snapshot of a
pinned connection, each with the limits of the wildcard, and fails with `wildcard_unreviewed` when the
connection has no approved snapshot (unpinned connections, unknown servers) or `wildcard_empty` when nothing
matches. Validation warns. Use a profile grant or list the tools. Versions published before keep their
wildcard until they are republished.

## JSON Schema subset

Keywords: `type`, `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`,
`minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`,
`exclusiveMinimum`, `exclusiveMaximum`, `anyOf`, `$ref` (local `#/schemas/<name>` only),
`$schema` (2020-12 only) and the annotations `title`, `description`, `examples`, `default`,
`$comment`. Everything else is refused. A `pattern` needs `maxLength <= 4096` next to it and must
not use backreferences, lookarounds or a repeated group that contains a quantifier (`(a+)+`).
Limits: 32 KiB per schema, depth 12, 512 nodes, 128 properties, 128 enum values; no recursion.

## `when` grammar

```text
expr    := or
or      := and ( "||" and )*
and     := unary ( "&&" unary )*
unary   := "!" unary | compare
compare := operand ( ( "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" ) operand )?
operand := literal | path | list | "exists" "(" path ")" | "(" expr ")"
path    := ( "event" | "steps" "." step-id "." "output" ) ( "." name | "[" index "]" )*
list    := "[" ( literal ( "," literal )* )? "]"
literal := string | number | "true" | "false" | "null"
```

Example: `steps.analysis.output.severity in ["high", "critical"] && exists(event.data.ticket)`.
Comparisons are strictly typed (no truthiness, no coercion): `1 != "1"`, `<` and friends need two
numbers or two strings, `&&`, `||` and `!` need booleans, `in` tests scalar membership in an array.
Reading a path that does not exist (outside `exists()`), comparing an object or an array, a type
mismatch and a non-boolean result are evaluation errors that fail the run; they are never treated as
`false`. `exists(path)` is true when the path resolves, also to `null`. Only own properties are read.

## Runtime behaviour

- **Order**: for each step in `pipeline` order the executor evaluates `when`, assembles the input,
  validates it (`input.schema`), runs the model/tool loop, validates the final output
  (`output.schema`) and only then continues.
- **Input**: without `input.from` the first step receives `event.data` and later steps the previous
  step's output (the prompt is unchanged from earlier versions). With `input.from` the step receives
  exactly `{ <source>: value }` for the listed sources (`event` is the event's `data`) and its prompt
  contains that JSON and nothing else, not the previous step's text. A source that did not run
  (skipped) fails the run with `handover_missing`.
- **Output**: `output.schema` needs `outputs: [{ format: json }]`; the answer must be a JSON document
  (no code fences) that validates. With `onInvalid: retry` the model gets exactly one more turn that
  lists the failed keywords and paths (never the values); a second violation fails the run. Steps
  run by an external harness (Claude Code) cannot be asked again, so `retry` behaves like `fail`
  there.
- **Conditions only restrict.** A false `when` skips the step and grants nothing; a true one does not
  bypass tool grants, policies or approvals of the step. Evaluation is done by the runtime with a
  restricted evaluator, never by a model, and an evaluation error fails the run (`condition_error`)
  instead of skipping or running the step. How `when` is exported to AWP (draft AEP-0001) is described in
  [awp.md](awp.md#step-conditions-when-aep-0001).
- **Skipped steps** have no output: `exists(steps.<id>.output)` is false for later steps and the run
  can still succeed.
- **Validation** uses ajv 8 in strict mode with the subset above: no remote references, no formats,
  no coercion or defaults, at most 20 reported errors; instances over 256 KiB, deeper than 32 levels
  or carrying an own `__proto__` key are refused without being validated.

| Run step | Meaning |
| --- | --- |
| `condition` / `skipped` | `when` was false, the step did not run |
| `condition` / `error` | `when` could not be evaluated, the run failed with `condition_error` |
| `handover` / `error` | input or output violated its schema (`handover_invalid`) or an input source is missing (`handover_missing`) |
| `handover` / `pending` (name `retry`) | the single `onInvalid: retry` turn was started |

| Audit action | Payload (never contains the offending values) |
| --- | --- |
| `step.skipped` | `{ agentId, when, reason: "condition" }` (`when` is the expression text; the values it read are never recorded) |
| `condition.error` | `{ agentId, when, reason }` (the reason names paths and types only) |
| `handover.invalid` | `{ agentId, direction, attempt, schemaDigest, errors: [{ instancePath, keyword, schemaPath }] }` |
| `handover.retry` | same payload, `attempt: 2` |

A complete, runnable three-step pipeline (research, analysis, action with `when`) is
[`examples/ticket-triage.agents.md`](../examples/ticket-triage.agents.md).

## Example

```yaml
schemas:
  Finding:
    type: object
    required: [severity, summary]
    additionalProperties: false
    properties:
      severity: { enum: [low, medium, high, critical] }
      summary: { type: string, maxLength: 2000 }
agents:
  - id: analysis
    provider: simulated
    model: sim-1
    access: read-only
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Finding" }, onInvalid: retry }
    tools:
      - { server: jira, profile: read }
  - id: action
    provider: simulated
    model: sim-1
    access: write
    when: 'steps.analysis.output.severity in ["high", "critical"]'
    input: { from: [event, analysis] }
    credentials:
      - { secret: jira-bot-token, env: JIRA_TOKEN }
    runtime: { runner: container }
    tools:
      - { server: jira, profile: write, approval: required }
pipeline: [analysis, action]
```

## Transition to AWP manifests

> **Status:** AWP is a draft (`v1alpha1`) and openagentix is **not conformant** to any AWP profile; the
> wording stays "built to the AWP schema, conformance in progress (alpha)". A conversion is a mapping,
> not a conformance claim. See [AWP: vendored schema and exporter](awp.md).

The file format `apiVersion: openagentix.io/v1alpha1` (this page) is **deprecated**. The platform moves to
AWP manifests in two releases; the switch is a constant tied to the version of the build
(`LEGACY_FORMAT_REMOVED_IN` in `packages/core/src/awp/legacy.ts`), not a runtime flag, so a given build
always behaves the same.

| Release | Version | Legacy files | Reads | Run |
| --- | --- | --- | --- | --- |
| **N** (this release) | below `0.4.0` | accepted on validate, publish and import (create, draft update) | every read carries the deprecation `legacy_format` | all versions run as before |
| **N+1** | `0.4.0` and later | rejected on every write path with `legacy_format_removed`, naming `oax awp convert` | stored versions stay readable, still with `legacy_format` | a version marked `legacy-unconvertible` is refused with `legacy_format_removed` |

There is no calendar date: the end of the transition is **release `0.4.0`**. Until it ships, nothing
stops working. (The issue asked for a "fixed end date"; a release number is the fixed point because the
project releases when it is ready, and the date follows the release notes of `0.4.0`.)

### What release N does

- **Deprecation on every legacy read.** `deprecations: [{ code: "legacy_format", removedIn: "0.4.0", ... }]`
  in the response of `GET /v1/agents/{id}`, `GET /v1/agents/{id}/versions/{version}` and the write
  responses (create, draft update, publish, disable/enable) and `POST /v1/agents/validate` (exactly one
  entry per legacy `agents.md`, none for an AWP manifest); the header `x-oax-deprecation: legacy_format` on
  `GET /v1/agents/{id}/versions/{version}/awp`; a warning `legacy_format` from `oax validate`. The audit
  event `agent.legacy_format_read` (payload: `surface` = `agent`, `version` or `awp-export`, the version,
  `removedIn`) is written **once per principal, agent, surface (and version) and day**, because every
  audit append takes the global audit lock and a console polls an agent; every read is counted in the
  metric `oax_legacy_format_reads_total{surface}`. The dedupe window is the cache (Valkey when
  configured, otherwise per replica). A request that is denied or finds nothing writes none. The agent list and the console views that do not show the draft or a
  version do not count as a read.
- **One-time conversion (migration `0039_agent_version_awp`).** The migration creates the table
  `agent_version_awp`; right after it (`pnpm --filter @openagentix/api db:migrate`, or migrate-on-start)
  the conversion converts every published version once, **per agent in its own transaction**
  (idempotent: a version with a row is skipped; a re-run converts nothing). Each version gets one row:
  - `converted`: the effective AWP manifest (strict export of the stored definition, RFC 8785
    digest) stored **next to** the version. `agent_versions` is not touched: source, digest and
    definition of a published version stay byte for byte as they were (the table is append-only by
    trigger, and the application role has no `UPDATE`).
  - `legacy-unconvertible`: the conversion was refused; no manifest is stored, only the findings with
    the source path of every field (`critical_extension`, `owner_team_required`,
    `wildcard_expansion_missing`, ...). **No lossy conversion is ever stored.** A definition that the
    exporter cannot read at all is also `legacy-unconvertible` (`conversion_error`).
  New versions are converted when they are published, in the same transaction.
  The conversion rows are append-only: a version is converted once. If an agent was unconvertible
  because it had no team, assign a team and publish a new version.
  Until the conversion ran for a version (a fresh upgrade before `db:migrate` finished), reads of that
  version compute the conversion on the fly and do not store it.
- **The stored manifest is served as stored, but verified:** `GET .../versions/{version}/awp` returns the
  stored bytes (stable even when the exporter changes later) after the live owner-team check, and
  recomputes the digest and re-runs the no-widening check against the stored definition first; a row that
  fails either answers `422 awp_export_refused` (`stored_manifest_invalid` / `grant_widened`). For a
  `legacy-unconvertible` version it answers `422` with the stored findings. A later converter version can
  supersede rows by keying on the column `converter`; that path is not built yet (rows are append-only).
- **Nothing is granted by a conversion.** After the mapping, an independent check compares the manifest with
  the stored definition and refuses the conversion (`grant_widened`) if it names an agent, a tool, an
  approval-free tool that required approval, a network host or a secret that the legacy file did not grant,
  or does not deny by default. The check is a closed allow-list: any field it does not model
  (filesystem, environments, resources, spec-level permissions, MCP servers, action groups, a `ref`
  agent, an unknown `x-` extension, network access that is not `deny`) refuses the conversion. The critical fields that AWP v1alpha1 cannot express (argument constraints,
  call limits, conditions, handovers, runners, ...) make the version `legacy-unconvertible` instead of being
  dropped. Running an agent is unchanged: runs still use the stored definition, not the manifest.

### Commands

```sh
# Convert a legacy file to an AWP manifest (stdout). Refused with one finding per field when a limit
# would be lost. Profile and wildcard grants are expanded when a version is published, so a file that
# uses them is converted from the published version (API below), not from the file.
oax awp convert agents/release-notes.agents.md --owner-team team-docs [--canonical]

# Which of these files would convert? Offline; profile/wildcard grants are listed as "needs publish context".
oax awp legacy-report agents/*.agents.md [--owner-team team-docs]

# Stored versions of the agents you may read: counts, and the unconvertible ones with their reasons.
GET /v1/agents/legacy-report            # the control node (the CLI has no client for it yet)
GET /v1/agents/{id}/versions/{version}  # field "awp": status, manifestDigest, findings
```

`legacy-report` exits `1` when a file is unconvertible. The report of the control node needs `agents:read`
and shows only the agents the caller may read.

### What release N+1 changes

Behind the constant the write paths already behave as follows (tested with the constant forced to
`removed`): `POST /v1/agents`, `PUT /v1/agents/{id}/draft` and `POST /v1/agents/{id}/publish` answer
`400 legacy_format_removed` with a message naming `oax awp convert`; `POST /v1/agents/validate` returns
`valid: false` with the same code; `oax validate` of a legacy file exits `1`; a run of a version marked
`legacy-unconvertible`, or of a version that has no stored conversion and cannot be converted on demand,
is refused with `400 legacy_format_removed` and the audit entry `run.refused` (scheduled and
event-triggered runs included); the gate does not fail open. AWP manifests are validated as before. Storing and running an AWP manifest itself is a later
slice; until it lands, **do not ship the `0.4.0` bump**: the removal is only safe together with it. A
unit test enforces this: it fails while the version of the build (or of the CLI) is `0.4.0` or later and
`AWP_MANIFESTS_STORABLE` (`packages/core/src/awp/legacy.ts`) is `false`. A pre-release of N+1
(`0.4.0-alpha.1`) counts as N+1 by design, so the test fails for it as well.

### Upgrade notes

- The conversion row is written in a savepoint inside the publish transaction: a database error there is
  logged and does not fail the publish (the version is converted later).
- The startup conversion catches and logs errors and never keeps the node from starting.
- Re-run `deploy/sql/roles.sql` (a run-once script) so that the application role also loses
  `UPDATE`/`DELETE` on `agent_version_awp`; the default privileges grant them, and the append-only trigger
  is the guard until then.

### Rollback

The down script `apps/api/drizzle/down/0039_agent_version_awp.down.sql` drops `agent_version_awp`
(stored manifests and markers are lost; no agent, version or run is affected, and the conversion can be
repeated). An application version before this one ignores the table.
