# agents.md reference: data flow and isolation fields

The full `agents.md` format (front matter, `## Agent: <id>` sections, tools, budgets, triggers,
runtime) is described on the website's agents.md reference. This page covers the fields added by
[ADR 0008](adr/0008-agents-md-data-flow-and-isolation-contract.md). All of them are optional and
`apiVersion` stays `openagentix.io/v1alpha1`; files without them behave exactly as before.

> **Status:** these fields are parsed and validated when a version is validated or published.
> Tool profiles and `access` are enforced (see [MCP connections and tool profiles](mcp.md)). The
> other fields have **no runtime effect yet**: handovers and `when` arrive with W1-1, per-step
> credentials and runners with W1-3/W1-4. A profile grant is expanded into concrete tool grants
> when the version is published; a draft that has not been published grants nothing.

| Field | Where | Meaning | Checked at publish |
| --- | --- | --- | --- |
| `schemas` | top level | Named JSON Schemas, referenced as `{ $ref: "#/schemas/<name>" }` (max. 32) | Subset and limits, unused schemas warn |
| `input.schema` | `agents[]` | Validates what the step receives | Subset and limits |
| `input.from` | `agents[]` | `event` and/or ids of earlier steps; the step receives `{ <source>: value }` and nothing else | Sources exist and run earlier, no duplicates |
| `output.schema`, `output.onInvalid` | `agents[]` | Validates the step's JSON output; `fail` (default) or one `retry` | Subset and limits; needs `outputs: [{ format: json }]` |
| `when` | `agents[]` | Condition over `event` and `steps.<id>.output`; false skips the step, an evaluation error fails the run | Grammar, limits, referenced steps run earlier |
| `access` | `agents[]` | `read-only` or `write` | A read-only step that receives a write tool (directly, by wildcard or through a profile) is refused; the policy gate denies it again at run time (`profile_write_denied`) |
| `tools[].profile` | `agents[].tools[]` | Grant of a named profile of a connection (`{ server: jira, profile: read }`), with optional `approval`, `maxCallsPerRun`, `classification` | Duplicates; the connection and the profile must exist (unknown names are refused) |
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
Comparisons are strictly typed (no truthiness); see the ADR for the evaluation rules.

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
