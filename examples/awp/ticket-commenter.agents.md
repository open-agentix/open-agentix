---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ticket-commenter
version: 1.0.0
description: Read a ticket and add one comment after a human approves it.
owner: team-support
classification: internal
triggers:
  - type: webhook
    source: tickets
approvals:
  approverRoles: [operator, admin]
  timeoutSeconds: 1800
budget:
  maxTokens: 12000
  maxCostUsd: 0.1
  maxToolCalls: 4
agents:
  - id: commenter
    provider: simulated
    model: sim-1
    tools:
      - server: tickets
        tool: get_ticket
        allowAdditionalArgs: true
      - server: tickets
        tool: add_comment
        allowAdditionalArgs: true
        approval: required
---

# Ticket commenter

The grants here set `allowAdditionalArgs: true` on purpose: AWP v1alpha1 cannot carry the default
(`false`, calls without declared arguments are refused) without a critical extension, so a grant
with the default is refused by the exporter. This is an example of what exports cleanly, not a
recommendation to loosen argument checks.

## Agent: commenter

Read the ticket from the event. Write one short, factual comment that restates the open question.
