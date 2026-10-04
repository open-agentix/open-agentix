# agents.md reference: data flow and isolation fields

The full `agents.md` format (front matter, `## Agent: <id>` sections, tools, budgets, triggers,
runtime) is described on the website's agents.md reference. This page covers the fields added by
[ADR 0008](adr/0008-agents-md-data-flow-and-isolation-contract.md). All of them are optional and
`apiVersion` stays `openagentix.io/v1alpha1`; files without them behave exactly as before.

> **Status:** `schemas`, `input`, `output` and `when` have **runtime effect** (typed handovers and
> conditional steps, W1-1, see [pipelines](pipelines.md)). `access` and `tools[].profile` are parsed
> and validated only until W1-2 lands (a profile grant grants no tool); `credentials` and the
> per-step `runtime` follow with W1-3/W1-4.

| Field | Where | Meaning | Checked at publish |
| --- | --- | --- | --- |
| `schemas` | top level | Named JSON Schemas, referenced as `{ $ref: "#/schemas/<name>" }` (max. 32) | Subset and limits, unused schemas warn |
| `input.schema` | `agents[]` | Validates what the step receives; a violation fails the run (`handover_invalid`) | Subset and limits |
| `input.from` | `agents[]` | `event` and/or ids of earlier steps; the step receives `{ <source>: value }` and nothing else | Sources exist and run earlier, no duplicates |
| `output.schema`, `output.onInvalid` | `agents[]` | Validates the step's JSON output before the next step; `fail` (default) or one `retry` turn with the validation errors | Subset and limits; needs `outputs: [{ format: json }]` |
| `when` | `agents[]` | Condition over `event` and `steps.<id>.output`; false skips the step (status `skipped`, audit `step.skipped`), an evaluation error fails the run (`condition_error`) | Grammar, limits, referenced steps run earlier |
| `access` | `agents[]` | `read-only` or `write` | Read-only steps with write tools are refused once profiles land (W1-2) |
| `tools[].profile` | `agents[].tools[]` | Grant of a named profile of a connection (`{ server: jira, profile: read }`), with optional `approval`, `maxCallsPerRun`, `classification` | Duplicates; profile names when the control node knows the connection |
| `credentials` | `agents[]` | `[{ secret: <ref>, env?: NAME }]`, references only (max. 16) | Reference format, duplicates, reserved env names (`PATH`, `OAX_*`, `LD_*`, ...) |
| `runtime.runner`, `runtime.egress` | `agents[]` | Runner override for this step; egress can only narrow the pipeline's `runtime.egress` | Egress subset |

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
| `step.skipped` | `{ agentId, when }` |
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
