---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: ticket-triage
version: 1.0.0
description: Research a CVE finding, analyse it and only comment on the ticket when it is severe.
owner: team-security
classification: internal
labels:
  domain: security
  useCase: ticket-triage
triggers:
  - type: webhook
    source: trivy
budget:
  maxTokens: 50000
  maxCostUsd: 0.5
  maxSteps: 16
  maxToolCalls: 6
  timeoutSeconds: 300
schemas:
  Finding:
    type: object
    required: [cveId, severity, cvss, package]
    additionalProperties: false
    properties:
      cveId: { type: string, maxLength: 32 }
      severity: { enum: [LOW, MEDIUM, HIGH, CRITICAL] }
      cvss: { type: number, minimum: 0, maximum: 10 }
      fixedIn: { type: string, maxLength: 64 }
      package: { type: string, maxLength: 128 }
  Analysis:
    type: object
    required: [severity, action, reason]
    additionalProperties: false
    properties:
      severity: { enum: [LOW, MEDIUM, HIGH, CRITICAL] }
      action: { enum: [comment, ignore] }
      reason: { type: string, maxLength: 500 }
agents:
  - id: research
    provider: simulated
    model: sim-1
    access: read-only
    input:
      schema:
        type: object
        required: [finding, ticket]
        properties:
          finding: { type: object, required: [cveId] }
          ticket: { type: string, maxLength: 32 }
    outputs:
      - format: json
    output:
      schema: { $ref: "#/schemas/Finding" }
      onInvalid: retry
    tools:
      - server: cve-db
        tool: lookup_cve
        args:
          cveId:
            type: string
            required: true
            pattern: "^CVE-\\d{4}-\\d{4,}$"
    simulation:
      responses:
        - toolCalls:
            - server: cve-db
              tool: lookup_cve
              args:
                cveId: "{{event.data.finding.cveId}}"
        - text: '{"cveId":"{{lastToolResult.cveId}}","severity":"{{lastToolResult.severity}}","cvss":{{lastToolResult.cvss}},"fixedIn":"{{lastToolResult.fixedIn}}","package":"{{event.data.finding.package}}"}'
  - id: analysis
    provider: simulated
    model: sim-1
    access: read-only
    input:
      from: [research]
    outputs:
      - format: json
    output:
      schema: { $ref: "#/schemas/Analysis" }
    simulation:
      responses:
        - text: '{"severity":"{{input.research.severity}}","action":"comment","reason":"{{input.research.cveId}} scores CVSS {{input.research.cvss}}."}'
  - id: action
    provider: simulated
    model: sim-1
    access: write
    when: 'steps.analysis.output.action == "comment" && steps.analysis.output.severity in ["HIGH", "CRITICAL"]'
    input:
      from: [event, analysis]
    outputs:
      - format: markdown
    tools:
      - server: tickets
        tool: add_comment
        maxCallsPerRun: 1
        args:
          key:
            type: string
            required: true
            pattern: "^SEC-\\d+$"
          comment:
            type: string
            required: true
            maxLength: 2000
    simulation:
      responses:
        - toolCalls:
            - server: tickets
              tool: add_comment
              args:
                key: "{{input.event.ticket}}"
                comment: "{{input.analysis.severity}}: {{input.analysis.reason}}"
        - text: "Commented on {{input.event.ticket}}."
pipeline: [research, analysis, action]
---

# Ticket triage

A three-step pipeline with typed handovers. Each step receives only what it names in `input.from`
and hands over JSON that is validated against its `output.schema` before the next step starts.
The last step has a `when` condition: for a low or medium finding it is skipped and the run still
succeeds.

## Agent: research

Look up the CVE of the finding with the `cve-db` tool and answer with a single JSON object that
matches the `Finding` schema. Do not guess values the tool did not return.

## Agent: analysis

Using the finding from the previous step, decide whether the ticket needs a comment. Answer with a
single JSON object that matches the `Analysis` schema.

## Agent: action

Add exactly one comment to the ticket named in the event (only `SEC-*` tickets), then reply with a
one-line markdown confirmation.

## Notes

Runs against the simulated provider and the built-in demo MCP servers:
`oax run examples/ticket-triage.agents.md --event examples/events/trivy-finding.json`.
