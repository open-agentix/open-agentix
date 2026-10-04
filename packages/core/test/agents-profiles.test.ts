import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  classifyTool,
  evaluateToolCall,
  expandProfiles,
  loadAgentDefinition,
  toolAccessOf,
  validateAgentSource,
  type AccessCatalog,
} from '../src/index.js';

const JIRA: AccessCatalog = {
  jira: {
    tools: {
      get_issue: 'read',
      search_issues: 'read',
      create_issue: 'write',
      delete_issue: 'write',
    },
    profiles: {
      read: ['get_issue', 'search_issues'],
      write: ['create_issue'],
      triage: ['get_issue', 'create_issue'],
    },
    version: 'v1',
  },
};

const source = (tools: string, access = 'read-only', extra = '') => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: profiled
version: 1.0.0
owner: team-security
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Do the work.
    ${access ? `access: ${access}` : ''}
    ${extra}
    tools:
${tools}
---
Do the work.
`;

const expand = (tools: string, access = 'read-only', catalog = JIRA) =>
  expandProfiles(loadAgentDefinition(source(tools, access)), catalog);

describe('expandProfiles', () => {
  it('expands a profile grant into one concrete grant per tool', () => {
    const r = expand('      - { server: jira, profile: read, maxCallsPerRun: 5 }');
    expect(r.errors).toEqual([]);
    const tools = r.definition.agents[0]!.tools;
    expect(tools.map((t) => `${t.server}/${t.tool}`)).toEqual([
      'jira/get_issue',
      'jira/search_issues',
    ]);
    expect(tools[0]).toMatchObject({
      allowAdditionalArgs: true,
      maxCallsPerRun: 5,
      approval: 'none',
    });
    expect(r.definition.expansion).toEqual([
      {
        agentId: 'a',
        server: 'jira',
        profile: 'read',
        tools: ['get_issue', 'search_issues'],
        connectionVersion: 'v1',
      },
    ]);
    expect(r.definition.toolAccess?.['jira/create_issue']).toBe('write');
    expect(r.definition.expansionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.definition.agents[0]!.profileGrants).toHaveLength(1);
  });

  it('a later profile change does not alter the stored expansion', () => {
    const first = expand('      - { server: jira, profile: read }');
    const widened: AccessCatalog = {
      jira: { ...JIRA.jira!, profiles: { read: ['get_issue', 'search_issues', 'create_issue'] } },
    };
    const stored = canonicalJson(first.definition.agents[0]!.tools);
    expect(canonicalJson(first.definition.agents[0]!.tools)).toBe(stored);
    // Re-expanding against the widened profile is a different (new) expansion with another digest.
    const second = expand('      - { server: jira, profile: read }', '', widened);
    expect(second.definition.expansionDigest).not.toBe(first.definition.expansionDigest);
    expect(first.definition.agents[0]!.tools).toHaveLength(2);
  });

  it('is deterministic', () => {
    const a = expand('      - { server: jira, profile: read }');
    const b = expand('      - { server: jira, profile: read }');
    expect(a.definition.expansionDigest).toBe(b.definition.expansionDigest);
  });

  it('refuses unknown profiles, unknown connections and prototype-like profile names', () => {
    expect(expand('      - { server: jira, profile: admin }').errors[0]!.message).toMatch(
      /no profile "admin"/,
    );
    expect(expand('      - { server: nope, profile: read }').errors[0]!.message).toMatch(
      /connection "nope" is unknown/,
    );
    for (const name of ['constructor', 'prototype']) {
      expect(expand(`      - { server: jira, profile: ${name} }`, '').errors).toHaveLength(1);
    }
  });

  it('refuses a write tool for a read-only step, via a profile', () => {
    for (const p of ['write', 'triage']) {
      const r = expand(`      - { server: jira, profile: ${p} }`);
      expect(
        r.errors.some((e) => /read-only step "a" must not receive write tool/.test(e.message)),
      ).toBe(true);
    }
  });

  it('refuses a write tool for a read-only step, directly and through wildcards', () => {
    expect(expand('      - { server: jira, tool: create_issue }').errors).toHaveLength(1);
    expect(expand('      - { server: jira, tool: "*" }').errors.length).toBeGreaterThanOrEqual(2);
    expect(expand('      - { server: jira, tool: "delete_*" }').errors).toHaveLength(1);
    expect(expand('      - { server: jira, tool: "get_*" }').errors).toEqual([]);
    // undeclared tools count as write
    expect(expand('      - { server: jira, tool: unlisted }').errors).toHaveLength(1);
    // a server that is not in the catalog cannot be classified
    expect(expand('      - { server: other, tool: get_x }').errors[0]!.message).toMatch(/unknown/);
  });

  it('allows write tools for write or undeclared access', () => {
    expect(expand('      - { server: jira, profile: write }', 'write').errors).toEqual([]);
    expect(expand('      - { server: jira, profile: triage }', '').errors).toEqual([]);
    expect(expand('      - { server: other, tool: x }', '').errors).toEqual([]);
  });

  it('lets a concrete grant win over the expansion and merges overlapping profiles', () => {
    const r = expand(
      [
        '      - { server: jira, tool: get_issue, approval: required }',
        '      - { server: jira, profile: read }',
        '      - { server: jira, profile: triage, approval: required, maxCallsPerRun: 2 }',
        '      - { server: jira, profile: write, maxCallsPerRun: 9 }',
      ].join('\n'),
      '',
    );
    const byKey = Object.fromEntries(r.definition.agents[0]!.tools.map((t) => [t.tool, t]));
    expect(byKey.get_issue).toMatchObject({ approval: 'required', allowAdditionalArgs: false });
    expect(byKey.search_issues).toMatchObject({ approval: 'none' });
    expect(byKey.create_issue).toMatchObject({ approval: 'required', maxCallsPerRun: 2 });
    expect(r.definition.agents[0]!.tools).toHaveLength(3);
  });

  it('keeps the classification of the profile grant', () => {
    const r = expand('      - { server: jira, profile: read, classification: public }');
    expect(r.definition.agents[0]!.tools[0]!.classification).toBe('public');
  });
});

describe('validation with the profile catalog', () => {
  it('checkDefinition refuses unknown profile names when the catalog is passed', () => {
    const src = source('      - { server: jira, profile: admin }', '');
    expect(validateAgentSource(src).valid).toBe(true);
    const r = validateAgentSource(src, { profiles: { jira: ['read', 'write'] } });
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toMatch(/no profile "admin"/);
  });
});

describe('classifyTool', () => {
  it('prefers the declaration and trusts only clear read-only annotations', () => {
    expect(classifyTool('read', { readOnlyHint: false })).toBe('read');
    expect(classifyTool('write', { readOnlyHint: true })).toBe('write');
    expect(classifyTool(undefined, { readOnlyHint: true })).toBe('read');
    expect(classifyTool(undefined, { readOnlyHint: true, destructiveHint: true })).toBe('write');
    expect(classifyTool(undefined, { readOnlyHint: 'yes' })).toBe('write');
    expect(classifyTool(undefined, null)).toBe('write');
    expect(classifyTool(undefined)).toBe('write');
  });
  it('treats unknown tools as write', () => {
    expect(toolAccessOf({ 'a/b': 'read' }, 'a', 'b')).toBe('read');
    expect(toolAccessOf({ 'a/b': 'read' }, 'a', 'c')).toBe('write');
    expect(toolAccessOf(undefined, 'a', 'b')).toBe('write');
  });
});

describe('policy gate for read-only agents (second wall)', () => {
  const published = () =>
    expand(
      ['      - { server: jira, profile: read }', '      - { server: jira, tool: "get_*" }'].join(
        '\n',
      ),
    ).definition;
  const decide = (tool: string, over: { access?: 'read-only' | 'write'; noMap?: boolean } = {}) => {
    const def = published();
    const agent = { ...def.agents[0]!, ...(over.access ? { access: over.access } : {}) };
    return evaluateToolCall(
      { server: 'jira', tool, args: {} },
      {
        definition: def,
        agent,
        toolAccess: over.noMap ? undefined : def.toolAccess,
      },
    );
  };
  it('allows classified read tools', () => {
    expect(decide('get_issue').effect).toBe('allow');
  });
  it('denies an unclassified tool matched by a wildcard grant (profile_write_denied)', () => {
    const d = decide('get_unlisted');
    expect(d.effect).toBe('deny');
    expect(d.reasons.map((r) => r.code)).toContain('profile_write_denied');
  });
  it('denies tools that are tampered into the grants of a read-only agent', () => {
    const def = published();
    const agent = {
      ...def.agents[0]!,
      tools: [
        ...def.agents[0]!.tools,
        {
          server: 'jira',
          tool: 'create_issue',
          args: {},
          allowAdditionalArgs: true,
          approval: 'none' as const,
        },
      ],
    };
    const d = evaluateToolCall(
      { server: 'jira', tool: 'create_issue', args: {} },
      { definition: def, agent, toolAccess: def.toolAccess },
    );
    expect(d.effect).toBe('deny');
    expect(d.reasons.map((r) => r.code)).toEqual(['profile_write_denied']);
  });
  it('fails closed without a classification map', () => {
    const d = decide('get_issue', { noMap: true });
    expect(d.effect).toBe('deny');
    expect(d.reasons[0]!.code).toBe('profile_write_denied');
  });
  it('does not restrict agents that are not read-only', () => {
    const def = expand('      - { server: jira, profile: triage }', 'write').definition;
    const d = evaluateToolCall(
      { server: 'jira', tool: 'create_issue', args: {} },
      { definition: def, agent: def.agents[0]!, toolAccess: def.toolAccess },
    );
    expect(d.effect).toBe('allow');
  });
});
