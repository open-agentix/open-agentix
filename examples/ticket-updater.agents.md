---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ticket-updater
version: 1.0.0
description: Move triaged security tickets to the next state - with human approval.
owner: team-security
classification: internal
triggers:
  - type: webhook
    source: jira
approvals:
  approverRoles: [operator, admin]
  timeoutSeconds: 3600
budget:
  maxTokens: 20000
  maxCostUsd: 0.2
  maxSteps: 8
  timeoutSeconds: 3900
agents:
  - id: updater
    provider: simulated
    model: sim-1
    outputs:
      - format: ticket-update
    tools:
      - server: tickets
        tool: get_ticket
        args:
          key: { type: string, required: true, pattern: "^SEC-\\d+$" }
      - server: tickets
        tool: update_ticket
        approval: required
        maxCallsPerRun: 1
        args:
          key: { type: string, required: true, pattern: "^SEC-\\d+$" }
          status: { type: string, enum: [triaged, in-progress, done] }
          labels: { type: array, maxItems: 5 }
    simulation:
      responses:
        - toolCalls:
            - server: tickets
              tool: get_ticket
              args: { key: "{{event.data.issue.key}}" }
        - toolCalls:
            - server: tickets
              tool: update_ticket
              args:
                key: "{{event.data.issue.key}}"
                status: triaged
                labels: ["security", "{{event.data.issue.severity}}"]
        - text: "Ticket {{event.data.issue.key}} moved to triaged (labels: security, {{event.data.issue.severity}})."
---

# Ticket updater

## Agent: updater

Read the ticket from the event, then set its status to `triaged` and add the labels `security` and
the severity. Status changes require a human approval; if the approval is rejected, stop and say so.
