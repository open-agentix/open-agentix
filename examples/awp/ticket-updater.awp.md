---
apiVersion: awp.agenticworkflowprotocol.org/v1alpha1
kind: Workflow
metadata:
  name: ticket-updater
  version: 2.0.0
  owner:
    team: team-security
  classification: internal
spec:
  triggers:
    - type: event
      source: tickets
      eventType: webhook.received
  inputs:
    - name: event
      type: object
  agents:
    - id: updater
      model:
        provider: simulated
        name: sim-1
      tools:
        - type: mcp
          server: tickets
          tools: [get_ticket, update_ticket]
      permissions:
        default: deny
        tools:
          tickets.get_ticket:
            allow: true
            x-openagentix-args:
              key: { type: string, required: true, pattern: "^SEC-\\d+$", maxLength: 32 }
            x-openagentix-allowAdditionalArgs: false
          tickets.update_ticket:
            allow: true
            x-openagentix-maxCallsPerRun: 1
            x-openagentix-args:
              key: { type: string, required: true, pattern: "^SEC-\\d+$", maxLength: 32 }
              status: { type: string, enum: [triaged, in-progress, done] }
            x-openagentix-allowAdditionalArgs: false
      x-openagentix-outputs:
        - format: ticket-update
  approval:
    requiredFor: [tickets.update_ticket]
    approvers:
      - role: operator
    timeout: 1h
    onTimeout: fail
  workflow:
    - id: updater
      agent: updater
      task: ${{ inputs.event }}
---

# Ticket updater

An `agents.md` file whose front matter is an AWP manifest (AWP is a draft, v1alpha1). The argument
constraints and the call limit are `x-openagentix-*` extensions that the pinned AWP version cannot
mark as required: the file validates, with warnings, and is not portable to another runtime.

## Agent: updater

Read the ticket from the event, then set its status to `triaged`.
