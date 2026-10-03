import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const example = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${name}`, import.meta.url)), 'utf8');

export const CVE_TRIAGE = example('cve-triage.agents.md');
export const TICKET_UPDATER = example('ticket-updater.agents.md');
export const TRIVY_EVENT = JSON.parse(example('events/trivy-finding.json')) as Record<
  string,
  unknown
>;
export const JIRA_EVENT = JSON.parse(example('events/jira-issue.json')) as Record<string, unknown>;

export function agentSource(
  name: string,
  owner = 'team-security',
  version = '1.0.0',
  extra = '',
): string {
  return `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: ${version}
owner: ${owner}
${extra}
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Summarise the event.
---
`;
}
