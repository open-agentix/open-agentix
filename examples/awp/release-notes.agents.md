---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: release-notes
version: 1.0.0
description: Draft weekly release notes from a changelog excerpt and proofread them.
owner: team-docs
classification: internal
labels:
  domain: documentation
  useCase: release-communication
triggers:
  - type: cron
    schedule: "0 8 * * 1"
    timezone: Europe/Berlin
  - type: manual
runtime:
  egress: [api.example.org]
budget:
  maxTokens: 30000
  maxCostUsd: 0.25
  maxSteps: 10
  timeoutSeconds: 600
agents:
  - id: drafter
    description: Writes the first draft.
    provider: simulated
    model: sim-1
    temperature: 0.2
    maxTokensPerCall: 2000
    credentials:
      - { secret: changelog-reader, env: CHANGELOG_TOKEN }
    outputs:
      - format: markdown
  - id: proofreader
    provider: simulated
    model: sim-1
    budget:
      maxTokens: 8000
    outputs:
      - format: report
pipeline: [drafter, proofreader]
---

# Release notes

This example has no tool grants and no handover constraints, so it exports to an AWP manifest
without any critical extension.

## Agent: drafter

Write release notes from the changelog excerpt you are given. Group changes by theme.

## Agent: proofreader

Fix spelling and tone in the draft. Do not change facts.
