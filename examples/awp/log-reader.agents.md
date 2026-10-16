---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: log-reader
version: 1.0.0
description: Summarise recent log lines of a service (read tools only).
owner: team-ops
classification: internal
triggers:
  - type: manual
budget:
  maxTokens: 10000
agents:
  - id: reader
    provider: simulated
    model: sim-1
    tools:
      - server: logs
        tool: get_*
        allowAdditionalArgs: true
---

# Log reader

The grant `get_*` is a prefix wildcard. The AWP export never carries a wildcard: it enumerates the
tools from the reviewed tool list of the connection `logs` that was recorded when the version was
published. Without such a list (for example when this file is exported directly) the export is
refused.

## Agent: reader

Summarise the log lines you can read. Name the three most frequent errors.
