---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: approved-publisher
version: 1.0.0
description: Read a pull request and comment on it after a human approves (MCP tool grants).
owner: team-docs
classification: internal
triggers:
  - type: manual
approvals:
  approverRoles: [operator, admin]
  timeoutSeconds: 900
budget:
  maxTokens: 12000
  maxCostUsd: 0.1
  maxToolCalls: 6
agents:
  - id: publisher
    provider: simulated
    model: sim-1
    tools:
      - { server: github-read, profile: read }
      - { server: github-pr, profile: pr-comment, approval: required }
---

# Approved publisher

Two MCP grants: a read-only profile and a write profile whose use needs approval. Profile grants without
limits export cleanly because the exporter writes the explicit tools the profile held when the version
was published (this example needs the connections `github-read` and `github-pr`, see the example
catalog of the conformance harness).

## Agent: publisher

Read the pull request and its changed files. Write one short, factual comment that summarises the change.
