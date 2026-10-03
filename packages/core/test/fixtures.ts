export const PIPELINE_SOURCE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: cve-triage
version: 1.2.0
description: Triage new CVE findings
owner: team-security
classification: internal
triggers:
  - type: webhook
    source: trivy
budget:
  maxTokens: 20000
  maxCostUsd: 0.5
  maxSteps: 12
approvals:
  approverRoles: [operator]
  timeoutSeconds: 600
agents:
  - id: triage
    provider: simulated
    model: sim-1
    tools:
      - server: cve-db
        tool: lookup_cve
        args:
          cveId:
            type: string
            required: true
            pattern: "^CVE-\\\\d{4}-\\\\d{4,}$"
    budget:
      maxSteps: 6
  - id: notify
    provider: simulated
    model: sim-1
    tools:
      - server: tickets
        tool: update_ticket
        approval: required
        args:
          project: { enum: [SEC] }
          comment: { type: string, maxLength: 2000 }
pipeline: [triage, notify]
---

# CVE triage

Looks at CVE findings and updates tickets.

## Agent: triage

You triage CVEs.

\`\`\`
## Agent: not-a-heading (inside a code fence)
\`\`\`

## Agent: notify

You write the ticket comment.

## Notes

Free text.
`;

export function withFrontMatter(fm: string, body = '## Agent: a\n\nDo things.\n'): string {
  return `---\n${fm}\n---\n${body}`;
}

export const MINIMAL_FM = `apiVersion: openagentix.io/v1alpha1
kind: Agent
name: mini
version: 0.1.0
owner: team-a
agents:
  - id: a
    provider: simulated
    model: sim-1`;
