# Pipelines: typed handovers and conditional steps

A pipeline is the ordered list `pipeline: [a, b, c]` of steps (`agents[]` entries) of an
`agents.md`. Since W1-1 the steps can hand over **schema-validated JSON** and a step can run **only
when a condition holds**, so plans can branch without an orchestrator agent. The field reference is
[agents-md.md](agents-md.md); the contract is
[ADR 0008](adr/0008-agents-md-data-flow-and-isolation-contract.md).

## A step, in order

```text
when?  -> skipped (step.skipped)            evaluation error -> run fails (condition_error)
input  -> assemble (input.from or legacy)   missing source   -> run fails (handover_missing)
       -> validate input.schema             violation        -> run fails (handover_invalid)
model/tool loop (policy gate, approvals, budgets)
output -> parse + validate output.schema    violation        -> fail, or one retry turn
       -> the validated value is what later steps and `when` conditions read
```

## Example

```yaml
schemas:
  Finding:
    type: object
    required: [severity]
    additionalProperties: false
    properties:
      severity: { enum: [LOW, MEDIUM, HIGH, CRITICAL] }
agents:
  - id: research
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Finding" }, onInvalid: retry }
  - id: action
    when: 'steps.research.output.severity in ["HIGH", "CRITICAL"]'
    input: { from: [event, research] }
pipeline: [research, action]
```

`examples/ticket-triage.agents.md` is the runnable version
(`oax run examples/ticket-triage.agents.md --event examples/events/trivy-finding.json`).

## Failure codes

| Code | When |
| --- | --- |
| `handover_invalid` | input or output does not match its schema (after the single retry, if configured) |
| `handover_missing` | `input.from` names a step that did not run (skipped) |
| `condition_error` | a `when` condition cannot be evaluated or no longer parses; never treated as `false` |

Every failure is a run step (`handover`, `condition`) and an audit entry (`handover.invalid`,
`handover.retry`, `step.skipped`, `condition.error`). The payloads carry paths, keywords and a schema
digest, never the offending values. The step output itself stays in the run's steps with the usual
redaction.

## Authoring tips

- Keep schemas strict (`additionalProperties: false`, bounded strings and arrays): a step that
  hands over exactly what the next step needs is the cheapest guard against prompt injection
  travelling through a pipeline.
- Guard optional paths with `exists()`; a missing path in a comparison is an error, not `false`.
- Reference a step in `when` only when it has an `output.schema`; otherwise its output is unvalidated
  (publish warns).
