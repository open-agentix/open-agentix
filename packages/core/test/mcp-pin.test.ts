import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_PINNED_TOOLS,
  canonicalTools,
  McpPinError,
  changedToolNames,
  digestMatchesAny,
  expandProfiles,
  grantedTools,
  loadAgentDefinition,
  pinFor,
  pinnedToolsOf,
  reduceTool,
  toolsDigest,
  unknownGrants,
  type AccessCatalog,
  type PinnedTool,
} from '../src/index.js';

const tool = (name: string, extra: Partial<PinnedTool> = {}): PinnedTool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
  ...extra,
});

describe('tool digest', () => {
  it('is independent of list order and of key order inside a tool', () => {
    const a = [tool('b'), tool('a')];
    const b = [
      {
        inputSchema: { properties: { a: { type: 'string' } }, type: 'object' },
        name: 'a',
        description: 'does a',
      },
      tool('b'),
    ];
    expect(toolsDigest(a)).toBe(toolsDigest(b as PinnedTool[]));
    expect(toolsDigest(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['name', (t: PinnedTool) => ({ ...t, name: 'renamed' })],
    ['title', (t: PinnedTool) => ({ ...t, title: 'T' })],
    ['description', (t: PinnedTool) => ({ ...t, description: 'does a, and sends your mail' })],
    [
      'description (invisible character)',
      (t: PinnedTool) => ({ ...t, description: `${t.description}\u200b` }),
    ],
    ['inputSchema', (t: PinnedTool) => ({ ...t, inputSchema: { type: 'object', properties: {} } })],
    ['outputSchema', (t: PinnedTool) => ({ ...t, outputSchema: { type: 'object' } })],
    ['annotations', (t: PinnedTool) => ({ ...t, annotations: { readOnlyHint: true } })],
    ['annotation title', (t: PinnedTool) => ({ ...t, annotations: { title: 'x' } })],
  ])('changes when the %s changes', (_field, change) => {
    const base = tool('a');
    expect(toolsDigest([change(base)])).not.toBe(toolsDigest([base]));
  });

  it('separates an absent field from an explicit empty one', () => {
    expect(toolsDigest([tool('a', { description: '' })])).not.toBe(
      toolsDigest([{ name: 'a', inputSchema: tool('a').inputSchema }]),
    );
  });

  it('covers an added and a removed tool', () => {
    const one = [tool('a')];
    expect(toolsDigest([...one, tool('b')])).not.toBe(toolsDigest(one));
    expect(toolsDigest([])).not.toBe(toolsDigest(one));
  });

  it('is the SHA-256 of the RFC 8785 text of the sorted tools', () => {
    const text =
      '[{"description":"does a","inputSchema":{"properties":{"a":{"type":"string"}},"type":"object"},"name":"a"}]';
    expect(canonicalTools([tool('a')])).toBe(text);
    expect(toolsDigest([tool('a')])).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('refuses duplicate names', () => {
    expect(() => toolsDigest([tool('a'), tool('a')])).toThrow(McpPinError);
  });
});

describe('reduceTool and pinnedToolsOf', () => {
  it('keeps the six model-visible fields and drops everything else', () => {
    const r = reduceTool({
      name: 'x',
      title: 'X',
      description: 'd',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      _meta: { secret: 1 },
      icons: [],
      execution: {},
    });
    expect(Object.keys(r).sort()).toEqual([
      'annotations',
      'description',
      'inputSchema',
      'name',
      'outputSchema',
      'title',
    ]);
  });

  it.each([
    ['not an object', 'x'],
    ['no name', { inputSchema: {} }],
    ['empty name', { name: '', inputSchema: {} }],
    ['name too long', { name: 'x'.repeat(129), inputSchema: {} }],
    ['description is not text', { name: 'x', description: 5, inputSchema: {} }],
    ['inputSchema missing', { name: 'x' }],
    ['annotations is an array', { name: 'x', inputSchema: {}, annotations: [] }],
  ])('refuses a tool with %s', (_l, raw) => {
    expect(() => reduceTool(raw)).toThrow(McpPinError);
  });

  it('bounds the number of tools, one tool and the whole list', () => {
    const many = Array.from({ length: MAX_PINNED_TOOLS + 1 }, (_, i) => tool(`t${i}`));
    expect(() => pinnedToolsOf(many)).toThrow(/more than/);
    expect(() => pinnedToolsOf([tool('big', { description: 'x'.repeat(70 * 1024) })])).toThrow(
      /64 KiB/,
    );
    const medium = Array.from({ length: 40 }, (_, i) =>
      tool(`m${i}`, { description: 'y'.repeat(30 * 1024) }),
    );
    expect(() => pinnedToolsOf(medium)).toThrow(/1 MiB/);
  });

  it('refuses values outside the JSON data model inside a schema', () => {
    expect(() => pinnedToolsOf([tool('a', { inputSchema: { x: undefined } as never })])).toThrow(
      McpPinError,
    );
  });

  it('sorts by name', () => {
    expect(pinnedToolsOf([tool('b'), tool('a')]).map((t) => t.name)).toEqual(['a', 'b']);
  });
});

describe('grants', () => {
  const tools = [tool('get_issue'), tool('get_user'), tool('delete_issue')];
  it('matches exact names and prefix wildcards', () => {
    expect(grantedTools(tools, ['get_*']).map((t) => t.name)).toEqual(['get_issue', 'get_user']);
    expect(grantedTools(tools, ['delete_issue']).map((t) => t.name)).toEqual(['delete_issue']);
    expect(grantedTools(tools, [])).toEqual([]);
  });
  it('reports exact grants the list does not offer, never wildcards', () => {
    expect(unknownGrants(tools, ['get_issue', 'nope', 'zip_*'])).toEqual(['nope']);
  });
  it('lists names that were added, removed or changed', () => {
    const after = [
      tool('get_issue', { description: 'changed' }),
      tool('get_user'),
      tool('new_one'),
    ];
    expect(changedToolNames(tools, after)).toEqual(['delete_issue', 'get_issue', 'new_one']);
  });
});

describe('digestMatchesAny', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  it('accepts a listed digest and nothing else', () => {
    expect(digestMatchesAny(a, [b, a])).toBe(true);
    expect(digestMatchesAny(a, [b])).toBe(false);
    expect(digestMatchesAny(a, [])).toBe(false);
  });
  it('never matches malformed values, not even against each other', () => {
    expect(digestMatchesAny('invalid', ['invalid'])).toBe(false);
    expect(digestMatchesAny('0'.repeat(64), ['not-hex'])).toBe(false);
    expect(digestMatchesAny(a.toUpperCase(), [a])).toBe(false);
  });
});

const source = (tools: string) => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: pinned
version: 1.0.0
owner: team-security
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Work.
    tools:
${tools}
---
Work.
`;

const catalog = (
  snapshot: { digest: string; tools: PinnedTool[] } | null | undefined,
): AccessCatalog => ({
  jira: {
    tools: { get_issue: 'read' },
    profiles: { read: ['get_issue'] },
    version: 'v1',
    ...(snapshot === undefined ? {} : { pin: { snapshot } }),
  },
});

describe('expansion records the tool pins', () => {
  const tools = [tool('get_issue'), tool('other')];
  const snap = { digest: toolsDigest(tools), tools };
  const grant = '      - { server: jira, tool: get_issue }';

  it('records snapshot digest, digest of the granted tools and the grants', () => {
    const r = expandProfiles(loadAgentDefinition(source(grant)), catalog(snap));
    expect(r.errors).toEqual([]);
    expect(r.definition.toolPins).toEqual({
      jira: {
        snapshotDigest: snap.digest,
        toolsDigest: toolsDigest([tool('get_issue')]),
        granted: ['get_issue'],
      },
    });
    expect(r.definition.toolPins!.jira).toEqual(pinFor(snap, ['get_issue']));
  });

  it('pins the tools a profile grant expands to and wildcard matches', () => {
    const viaProfile = expandProfiles(
      loadAgentDefinition(source('      - { server: jira, profile: read }')),
      catalog(snap),
    );
    expect(viaProfile.definition.toolPins!.jira!.granted).toEqual(['get_issue']);
    const wildcard = expandProfiles(
      loadAgentDefinition(source('      - { server: jira, tool: "*" }')),
      catalog(snap),
    );
    expect(wildcard.definition.toolPins!.jira!.toolsDigest).toBe(snap.digest);
  });

  it('makes the pins part of expansionDigest, and only when there are pins', () => {
    const a = expandProfiles(loadAgentDefinition(source(grant)), catalog(snap)).definition;
    const other = [tool('get_issue', { description: 'different' }), tool('other')];
    const b = expandProfiles(
      loadAgentDefinition(source(grant)),
      catalog({ digest: toolsDigest(other), tools: other }),
    ).definition;
    expect(a.expansionDigest).not.toBe(b.expansionDigest);
    const unpinned = expandProfiles(
      loadAgentDefinition(source(grant)),
      catalog(undefined),
    ).definition;
    expect(unpinned.toolPins).toBeUndefined();
    expect('toolPins' in unpinned).toBe(false);
  });

  it('ignores a change to a tool that is not granted', () => {
    const changed = [tool('get_issue'), tool('other', { description: 'rug pulled' })];
    const a = expandProfiles(loadAgentDefinition(source(grant)), catalog(snap)).definition;
    const b = expandProfiles(
      loadAgentDefinition(source(grant)),
      catalog({ digest: toolsDigest(changed), tools: changed }),
    ).definition;
    expect(a.toolPins!.jira!.toolsDigest).toBe(b.toolPins!.jira!.toolsDigest);
  });

  it('refuses a connection without an approved snapshot (mcp_tools_unreviewed)', () => {
    const r = expandProfiles(loadAgentDefinition(source(grant)), catalog(null));
    expect(r.errors.map((e) => e.code)).toEqual(['mcp_tools_unreviewed']);
    expect(r.definition.toolPins).toBeUndefined();
  });

  it('refuses a granted tool the snapshot does not list (mcp_tool_unknown)', () => {
    const r = expandProfiles(
      loadAgentDefinition(source('      - { server: jira, tool: missing_tool }')),
      catalog(snap),
    );
    expect(r.errors.map((e) => e.code)).toEqual(['mcp_tool_unknown']);
  });

  it('leaves connections that cannot be pinned alone', () => {
    const r = expandProfiles(loadAgentDefinition(source(grant)), catalog(undefined));
    expect(r.errors).toEqual([]);
  });
});
