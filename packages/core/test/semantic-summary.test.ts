import { describe, expect, it } from 'vitest';
import {
  diffSummaries,
  expandProfiles,
  loadAgentDefinition,
  summariseDefinition,
  type AccessCatalog,
} from '../src/index.js';

const CATALOG: AccessCatalog = {
  jira: {
    tools: { get_issue: 'read', create_issue: 'write' },
    profiles: { read: ['get_issue'], write: ['create_issue'] },
    version: 'v1',
  },
};

const source = (
  opts: {
    tools?: string;
    egress?: string[];
    creds?: string;
    budget?: string;
    owner?: string;
    classification?: string;
  } = {},
) => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: sample
version: 1.0.0
owner: ${opts.owner ?? 'team-a'}
classification: ${opts.classification ?? 'internal'}
labels:
  useCase: demo/one
runtime:
  runner: in-process
  egress: ${JSON.stringify(opts.egress ?? [])}
${opts.budget ?? ''}
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Do the work.
${opts.creds ?? ''}
    tools:
${opts.tools ?? '      - { server: jira, profile: read }'}
---
Do the work.
`;

const facts = (src: string) => {
  const declared = loadAgentDefinition(src);
  return summariseDefinition(expandProfiles(declared, CATALOG).definition, declared);
};

describe('summariseDefinition', () => {
  it('lists expanded tools with their access class and the profile they came from', () => {
    const f = facts(
      source({
        tools:
          '      - { server: jira, profile: read }\n      - { server: jira, tool: create_issue, approval: required }',
      }),
    );
    expect(f.tools.map((t) => [t.key, t.access, t.approval, t.profile])).toEqual([
      ['jira/create_issue', 'write', 'required', null],
      ['jira/get_issue', 'read', 'none', 'jira:read'],
    ]);
    expect(f.owner).toBe('team-a');
    expect(f.useCase).toBe('demo/one');
  });

  it('marks a tool the catalog does not know as unclassified', () => {
    const f = facts(source({ tools: '      - { server: other, tool: do_it }' }));
    expect(f.tools[0]).toMatchObject({ key: 'other/do_it', access: 'unclassified' });
  });

  it('lists secret references by name only, without any value', () => {
    const f = facts(
      source({ creds: '    credentials:\n      - { secret: jira-token, env: JIRA_TOKEN }' }),
    );
    expect(f.secretReferences).toEqual([
      { name: 'jira-token', scope: 'legacy', ownerNode: null, env: 'JIRA_TOKEN', steps: ['a'] },
    ]);
  });

  it('collects egress hosts and the budget with null for unset limits', () => {
    const f = facts(
      source({ egress: ['b.example.org', 'a.example.org'], budget: 'budget: { maxSteps: 5 }' }),
    );
    expect(f.egress).toEqual(['a.example.org', 'b.example.org']);
    expect(f.budget).toMatchObject({ maxSteps: 5, maxTokens: null });
  });
});

describe('diffSummaries', () => {
  const base = facts(source());

  it('shows added and removed tools, hosts and references and changed scalars', () => {
    const head = facts(
      source({
        tools: '      - { server: jira, profile: write }',
        egress: ['x.example.org'],
        creds: '    credentials:\n      - { secret: token-a }',
        owner: 'team-b',
        classification: 'confidential',
        budget: 'budget: { maxCostUsd: 2 }',
      }),
    );
    const d = diffSummaries(base, head);
    expect(d.tools.added.map((t) => t.key)).toEqual(['jira/create_issue']);
    expect(d.tools.removed.map((t) => t.key)).toEqual(['jira/get_issue']);
    expect(d.egress.added).toEqual(['x.example.org']);
    expect(d.secretReferences.added.map((s) => s.name)).toEqual(['token-a']);
    expect(d.scalars.map((s) => s.field)).toEqual(
      expect.arrayContaining(['owner', 'classification', 'budget.maxCostUsd']),
    );
  });

  it('reports a tool whose access settings changed', () => {
    const head = facts(
      source({ tools: '      - { server: jira, profile: read, approval: required }' }),
    );
    const d = diffSummaries(base, head);
    expect(d.tools.changed.map((c) => c.to.key)).toEqual(['jira/get_issue']);
    expect(d.tools.added).toEqual([]);
  });

  it('treats everything as added without a base and reports no scalar changes', () => {
    const d = diffSummaries(null, base);
    expect(d.tools.added).toHaveLength(1);
    expect(d.scalars).toEqual([]);
  });
});
