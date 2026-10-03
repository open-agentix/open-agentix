/** Turns the answers of the workflow wizard into a draft agents.md for an agent engineer. */
export type TriggerKind = 'webhook' | 'mail' | 'kafka' | 'cron' | 'manual';
export type OutputFormat =
  'message' | 'ticket-update' | 'report' | 'pull-request' | 'markdown' | 'json';

export interface WizardStep {
  text: string;
  /** Connection (MCP server) name; empty = no tool, just reasoning. */
  server: string;
  tool: string;
  approval: boolean;
}

export interface WizardAnswers {
  title: string;
  description: string;
  owner: string;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  trigger: { kind: TriggerKind; value: string };
  steps: WizardStep[];
  output: { format: OutputFormat; target: string };
  provider: string;
  model: string;
  maxCostUsd: number;
}

export function slugify(input: string, fallback = 'my-agent'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return slug || fallback;
}

/** YAML scalar: JSON strings are valid YAML double-quoted scalars. */
const q = (s: string) => JSON.stringify(s);

export function triggerYaml(trigger: WizardAnswers['trigger']): string {
  switch (trigger.kind) {
    case 'webhook':
    case 'mail':
      return `  - type: ${trigger.kind}\n    source: ${slugify(trigger.value, 'events')}`;
    case 'kafka':
      return `  - type: kafka\n    topic: ${q(trigger.value || 'events')}`;
    case 'cron':
      return `  - type: cron\n    schedule: ${q(trigger.value || '0 9 * * 1-5')}`;
    default:
      return '  - type: manual';
  }
}

export function toolGrants(
  steps: WizardStep[],
): { server: string; tool: string; approval: boolean }[] {
  const grants = new Map<string, { server: string; tool: string; approval: boolean }>();
  for (const s of steps) {
    if (!s.server || !s.tool) continue;
    const key = `${s.server}/${s.tool}`;
    const existing = grants.get(key);
    grants.set(key, {
      server: s.server,
      tool: s.tool,
      approval: (existing?.approval ?? false) || s.approval,
    });
  }
  return [...grants.values()];
}

export function generateAgentsMd(a: WizardAnswers): string {
  const name = slugify(a.title);
  const tools = toolGrants(a.steps);
  const toolsYaml = tools.length
    ? `\n${tools
        .map(
          (g) =>
            `      - server: ${slugify(g.server, 'tools')}\n        tool: ${q(g.tool)}\n        approval: ${
              g.approval ? 'required' : 'none'
            }`,
        )
        .join('\n')}`
    : ' []';
  const outputYaml = `      - format: ${a.output.format}${a.output.target ? `\n        target: ${q(a.output.target)}` : ''}`;
  const simulation =
    a.provider === 'simulated'
      ? `\n    simulation:\n      responses:\n        - text: ${q(`Simulated result of "${a.title || name}".`)}`
      : '';
  const steps = a.steps
    .filter((s) => s.text.trim())
    .map((s, i) => {
      const tool =
        s.server && s.tool
          ? ` (tool \`${s.server}/${s.tool}\`${s.approval ? ', needs human approval' : ''})`
          : '';
      return `${i + 1}. ${s.text.trim()}${tool}`;
    })
    .join('\n');
  return `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: 0.1.0
description: ${q(a.description || a.title || name)}
owner: ${slugify(a.owner, 'my-team')}
classification: ${a.classification}
labels:
  created-with: workflow-wizard
triggers:
${triggerYaml(a.trigger)}
budget:
  maxCostUsd: ${a.maxCostUsd > 0 ? a.maxCostUsd : 0.5}
  maxSteps: ${Math.max(4, a.steps.length * 3)}
agents:
  - id: main
    provider: ${a.provider || 'simulated'}
    model: ${q(a.model || 'sim-1')}
    outputs:
${outputYaml}
    tools:${toolsYaml}${simulation}
---

# ${a.title || name}

${a.description || ''}

## Agent: main

${steps || '1. Describe what the agent should do.'}

Finally, reply as **${a.output.format}**${a.output.target ? ` to \`${a.output.target}\`` : ''}.
`;
}
