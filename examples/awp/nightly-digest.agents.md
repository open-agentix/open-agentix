---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: nightly-digest
version: 1.0.0
description: Write a short digest of the day every night (cron start, no tools).
owner: team-docs
classification: internal
triggers:
  - type: cron
    schedule: "30 22 * * *"
    timezone: Europe/Berlin
budget:
  maxTokens: 10000
  maxCostUsd: 0.08
  timeoutSeconds: 300
agents:
  - id: digester
    provider: simulated
    model: sim-1
    temperature: 0.1
---

# Nightly digest

Started by a schedule with an explicit time zone (a cron trigger without one is refused by the exporter,
because `agents.md` and AWP default differently). No tools, no critical extension.

## Agent: digester

Write a digest of at most ten lines from the notes of the day. State what is open, not what is done.
