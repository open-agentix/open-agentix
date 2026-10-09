// Fixed demo agent definitions (simulated provider, demo MCP servers only).

export const CVE_TRIAGE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: cve-triage
version: 1.0.0
description: Triage a container image CVE finding and document it on the security ticket.
owner: team-security
classification: internal
labels:
  domain: security
  useCase: vulnerability-management
triggers:
  - type: webhook
    source: trivy
runtime:
  runner: in-process
  toolbox: trivy
budget:
  maxTokens: 50000
  maxCostUsd: 0.5
  maxSteps: 12
  maxToolCalls: 6
  timeoutSeconds: 300
agents:
  - id: triage
    provider: simulated
    model: sim-1
    outputs:
      - format: json
    tools:
      - server: cve-db
        tool: lookup_cve
        args:
          cveId:
            type: string
            required: true
            pattern: "^CVE-\\\\d{4}-\\\\d{4,}$"
    simulation:
      responses:
        - toolCalls:
            - server: cve-db
              tool: lookup_cve
              args:
                cveId: "{{event.data.finding.cveId}}"
        - text: '{"cveId":"{{lastToolResult.cveId}}","severity":"{{lastToolResult.severity}}","cvss":{{lastToolResult.cvss}},"fixedIn":"{{lastToolResult.fixedIn}}","image":"{{event.data.image}}","package":"{{event.data.finding.package}}"}'
  - id: notify
    provider: simulated
    model: sim-1
    outputs:
      - format: markdown
    tools:
      - server: tickets
        tool: add_comment
        maxCallsPerRun: 1
        args:
          key:
            type: string
            required: true
            pattern: "^SEC-\\\\d+$"
          comment:
            type: string
            required: true
            maxLength: 2000
    simulation:
      responses:
        - toolCalls:
            - server: tickets
              tool: add_comment
              args:
                key: "{{event.data.ticket}}"
                comment: "{{input.cveId}} ({{input.severity}}, CVSS {{input.cvss}}) affects {{input.package}} in {{input.image}}. Fixed in {{input.fixedIn}}."
        - text: "## {{input.cveId}}: {{input.severity}}\\n\\n- Image: \`{{input.image}}\`\\n- Package: {{input.package}}\\n- Fixed in: {{input.fixedIn}}\\n- Ticket {{event.data.ticket}} updated."
pipeline: [triage, notify]
---

# CVE triage

Takes a vulnerability finding from a container image scan (e.g. Trivy), looks up the CVE, rates
it and writes a short, factual comment on the security ticket.

## Agent: triage

You are a security analyst. Look up the CVE from the finding with the \`cve-db\` tool and answer
with a single JSON object with the fields \`cveId\`, \`severity\`, \`cvss\`, \`fixedIn\`, \`image\` and
\`package\`. Do not guess values the tool did not return.

## Agent: notify

You write ticket comments for engineers. Using the triage result, add exactly one comment to the
ticket named in the event (only \`SEC-*\` tickets), then reply with a short markdown report.

## Notes

Runs against the simulated provider and the built-in demo MCP servers by default:
\`oax run examples/cve-triage.agents.md --event examples/events/trivy-finding.json\`.
`;

export const TICKET_UPDATER = `---
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
          key: { type: string, required: true, pattern: "^SEC-\\\\d+$" }
      - server: tickets
        tool: update_ticket
        approval: required
        maxCallsPerRun: 1
        args:
          key: { type: string, required: true, pattern: "^SEC-\\\\d+$" }
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

Read the ticket from the event, then set its status to \`triaged\` and add the labels \`security\` and
the severity. Status changes require a human approval; if the approval is rejected, stop and say so.
`;

export const FEATURE_BUILDER = `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: feature-builder
version: 0.3.0
description: Dark software factory demo - turns a small feature ticket into a pull request summary.
owner: team-platform
classification: internal
mode: dark-factory
guidelines: [secure-coding@1.0.0]
labels:
  useCase: software-factory
triggers:
  - type: manual
budget: { maxTokens: 40000, maxCostUsd: 0.5, maxSteps: 10 }
agents:
  - id: builder
    provider: simulated
    model: sim-1
    outputs: [{ format: pull-request }]
    tools:
      - server: tickets
        tool: get_ticket
        args: { key: { type: string, required: true, pattern: "^DEV-\\\\d+$" } }
      - server: tickets
        tool: add_comment
        args:
          key: { type: string, required: true, pattern: "^DEV-\\\\d+$" }
          comment: { type: string, maxLength: 2000 }
    simulation:
      responses:
        - toolCalls: [{ server: tickets, tool: get_ticket, args: { key: "{{event.data.ticket}}" } }]
        - toolCalls:
            - server: tickets
              tool: add_comment
              args: { key: "{{event.data.ticket}}", comment: "Draft PR opened on branch feat/{{event.data.slug}} (dark-factory demo, review required before merge)." }
        - text: "## PR: {{event.data.title}}\\n\\n- Branch: \`feat/{{event.data.slug}}\`\\n- Tests added, coverage 86 %\\n- Waiting for human review (production changes need approval)."
---

# Feature builder (dark software factory)

## Agent: builder

Read the ticket, implement the smallest change that satisfies it, add tests, and open a pull
request. Never merge or deploy yourself.
`;

export const HARDENING_REVIEW = `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: hardening-review
version: 1.0.0
description: Global hardening agent - reviews development agent output against company guidelines.
owner: team-security
classification: internal
labels:
  useCase: governance
triggers:
  - type: manual
budget: { maxTokens: 10000, maxSteps: 4 }
agents:
  - id: reviewer
    provider: simulated
    model: sim-1
    outputs: [{ format: report }]
    simulation:
      responses:
        - text: "## Hardening review\\n\\n- Guidelines: company@1.0.0, secure-coding@1.0.0\\n- Findings: 0 blocking, 1 note (prefer pinned versions)\\n- Decision: stricter rules applied, nothing relaxed."
---

# Hardening review

## Agent: reviewer

Review pull requests of development agents against the resolved guidelines (global, tenant,
agent). You may only make decisions stricter.
`;

export const RELEASE_WATCH = `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: release-watch
version: 1.0.0
description: Change-gated schedule - runs only when the watched release feed changes.
owner: team-operations
classification: internal
labels:
  useCase: vulnerability-management
triggers:
  - type: cron
    schedule: "*/30 * * * *"
budget: { maxTokens: 10000, maxSteps: 4 }
agents:
  - id: watcher
    provider: simulated
    model: sim-1
    tools:
      - server: cve-db
        tool: lookup_cve
        args: { cveId: { type: string, required: true, pattern: "^CVE-\\\\d{4}-\\\\d{4,}$" } }
    simulation:
      responses:
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-2023-44487 } }]
        - text: "New release detected; CVE-2023-44487 is fixed in it ({{lastToolResult.severity}})."
---

# Release watch

## Agent: watcher

When the release feed changed, check whether the new release fixes known CVEs.
`;

export const LOG_SUMMARY = `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: log-summary
version: 1.0.0
description: Homelab ops agent - summarises unusual log patterns.
owner: team-platform
classification: internal
labels:
  useCase: operations
triggers:
  - type: cron
    schedule: "0 */6 * * *"
budget: { maxTokens: 8000, maxSteps: 3 }
agents:
  - id: summariser
    provider: simulated
    model: sim-1
    simulation:
      responses:
        - text: "## Log summary (last 6 h)\\n\\n- 3 restarts of \`media-transcoder\` (OOM)\\n- TLS renewals OK\\n- No authentication anomalies."
---

# Log summary

## Agent: summariser

Summarise unusual log patterns of the last six hours for the operator.
`;
