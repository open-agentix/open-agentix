/** Starting point for a new agent (valid against the agents.md schema). */
export const AGENT_TEMPLATE = `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: my-agent
version: 0.1.0
description: Describe in one sentence what this agent does.
owner: my-team
classification: internal
triggers:
  - type: manual
budget:
  maxCostUsd: 0.5
  maxSteps: 10
agents:
  - id: main
    provider: simulated
    model: sim-1
    outputs:
      - format: markdown
    tools: []
    simulation:
      responses:
        - text: "Hello from the simulated provider."
---

# My agent

## Agent: main

Explain step by step what the agent should check and do.
`;
