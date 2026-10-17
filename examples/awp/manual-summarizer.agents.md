---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: manual-summarizer
version: 1.0.0
description: Summarise a text that a person pastes in (manual start, no tools).
owner: team-docs
classification: internal
triggers:
  - type: manual
budget:
  maxTokens: 8000
  maxCostUsd: 0.05
agents:
  - id: summarizer
    provider: simulated
    model: sim-1
---

# Manual summarizer

Started by a person, uses no tools and writes nothing outside its own result. It exports to an AWP
manifest without any critical extension.

## Agent: summarizer

Summarise the text you are given in five bullet points. Keep names and numbers exactly as written.
