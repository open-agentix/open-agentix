import {
  API_VERSION,
  type AgentPlan,
  type OfferedConnection,
  type PlanStep,
} from '../src/index.js';

export const OFFERED: OfferedConnection[] = [
  {
    name: 'jira',
    tools: { get_issue: 'read', search: 'read', add_comment: 'write', transition: 'write' },
    profiles: { read: ['get_issue', 'search'], write: ['add_comment', 'transition'] },
  },
  { name: 'crm', tools: { get_customer: 'read', update_customer: 'write' } },
  { name: 'wiki' },
];

export const step = (over: Partial<PlanStep> & { id: string }): PlanStep => ({
  purpose: 'do a thing',
  capabilities: [],
  access: 'read-only',
  approval: 'none',
  ...over,
});

export const plan = (steps: PlanStep[], extra: Partial<AgentPlan> = {}): AgentPlan => ({
  apiVersion: API_VERSION,
  kind: 'AgentPlan',
  name: 'ticket-analysis',
  version: '0.1.0',
  description: 'Analyse a ticket and answer it.',
  steps,
  ...extra,
});

/** A clean three-step plan: no finding expected. */
export const cleanPlan = (): AgentPlan =>
  plan(
    [
      step({
        id: 'research',
        capabilities: ['jira:read', 'crm/get_customer'],
        input: { from: ['event'], schema: 'Ticket' },
        output: { schema: 'Finding' },
      }),
      step({
        id: 'analysis',
        capabilities: ['model'],
        input: { from: ['research'] },
        output: { schema: 'Finding' },
      }),
      step({
        id: 'action',
        access: 'write',
        approval: 'required',
        capabilities: ['jira:write'],
        input: { from: ['analysis'] },
        when: 'steps.analysis.output.severity == "high"',
      }),
    ],
    {
      schemas: {
        Ticket: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        Finding: {
          type: 'object',
          required: ['severity'],
          properties: { severity: { enum: ['low', 'high'] } },
        },
      },
    },
  );
