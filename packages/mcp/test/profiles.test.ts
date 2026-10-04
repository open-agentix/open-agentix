import { StaticSecretResolver, ToolGrantSchema } from '@openagentix/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpServerConfigSchema,
  ToolGateway,
  createMockMcpServer,
  inMemoryServers,
  profileIssues,
} from '../src/index.js';

const parse = (o: object) =>
  McpServerConfigSchema.safeParse({ name: 'jira', transport: 'in-memory', ...o });
const messages = (o: object) => {
  const r = parse(o);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('connection tool classes and profiles', () => {
  it('accepts declared tools and profiles on every transport', () => {
    const body = {
      tools: { get_issue: { access: 'read' }, create_issue: { access: 'write' } },
      profiles: {
        read: ['get_issue'],
        write: ['create_issue'],
        triage: ['get_issue', 'create_issue'],
      },
    };
    expect(parse(body).success).toBe(true);
    expect(
      McpServerConfigSchema.safeParse({ name: 'a', transport: 'stdio', command: 'x', ...body })
        .success,
    ).toBe(true);
    expect(
      McpServerConfigSchema.safeParse({
        name: 'a',
        transport: 'streamable-http',
        url: 'https://x.test/mcp',
        ...body,
      }).success,
    ).toBe(true);
    const bare = parse({});
    expect(bare.success && bare.data.tools).toEqual({});
    expect(bare.success && bare.data.profiles).toEqual({});
  });

  it('refuses unknown tools in a profile', () => {
    expect(
      messages({ tools: { a: { access: 'read' } }, profiles: { read: ['a', 'ghost'] } }),
    ).toEqual(['profile "read" lists unknown tool "ghost"']);
    expect(messages({ profiles: { x: ['a'] } })).toHaveLength(1);
  });

  it('refuses wildcards, bad names and bad access values', () => {
    expect(messages({ tools: { 'get_*': { access: 'read' } } }).join()).toMatch(
      /Invalid key|no wildcards/,
    );
    expect(
      messages({ tools: { a: { access: 'read' } }, profiles: { x: ['*'] } }).length,
    ).toBeGreaterThan(0);
    expect(messages({ tools: { a: { access: 'admin' } } }).length).toBeGreaterThan(0);
    expect(messages({ tools: { a: { access: 'read', extra: 1 } } }).length).toBeGreaterThan(0);
    expect(
      messages({ tools: { a: { access: 'read' } }, profiles: { 'Bad Name': ['a'] } }).length,
    ).toBeGreaterThan(0);
    expect(
      messages({ tools: { a: { access: 'read' } }, profiles: { x: [] } }).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a profile named read that contains a write tool (escalation by naming)', () => {
    expect(
      messages({
        tools: { a: { access: 'read' }, b: { access: 'write' } },
        profiles: { read: ['a', 'b'] },
      }),
    ).toEqual(['profile "read" must not contain write tool "b"']);
  });

  it('refuses duplicates and prototype-key tricks', () => {
    expect(messages({ tools: { a: { access: 'read' } }, profiles: { x: ['a', 'a'] } })).toEqual([
      'duplicate tool "a" in "x"',
    ]);
    expect(
      messages({ tools: { a: { access: 'read' } }, profiles: { x: ['constructor'] } }),
    ).toHaveLength(1);
  });

  it('limits the number of declared tools', () => {
    const tools = Object.fromEntries(
      Array.from({ length: 501 }, (_, i) => [`t${i}`, { access: 'read' }]),
    );
    expect(messages({ tools }).join()).toMatch(/more than 500/);
    expect(profileIssues({ tools: {}, profiles: {} })).toEqual([]);
  });
});

const gateways: ToolGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

describe('gateway tool classes', () => {
  const server = () =>
    createMockMcpServer('jira', [
      { name: 'get_issue', handler: () => 'ok', annotations: { readOnlyHint: true } },
      { name: 'create_issue', handler: () => 'ok' },
      { name: 'declared_read', handler: () => 'ok', annotations: { readOnlyHint: false } },
      {
        name: 'both',
        handler: () => 'ok',
        annotations: { readOnlyHint: true, destructiveHint: true },
      },
    ]);
  it('derives access from the declaration first, then from annotations', async () => {
    const cfg = McpServerConfigSchema.parse({
      name: 'jira',
      transport: 'in-memory',
      tools: { declared_read: { access: 'read' }, get_issue: { access: 'write' } },
    });
    const g = new ToolGateway([cfg], {
      secrets: new StaticSecretResolver({}),
      inMemory: inMemoryServers({ jira: server }),
    });
    gateways.push(g);
    const tools = await g.exposedTools({
      id: 'a',
      tools: [ToolGrantSchema.parse({ server: 'jira', tool: '*' })],
    });
    const access = Object.fromEntries(tools.map((t) => [t.tool, t.access]));
    expect(access).toEqual({
      get_issue: 'write', // declaration wins over the server's hint
      create_issue: 'write',
      declared_read: 'read',
      both: 'write',
    });
  });
  it('treats annotations as read only when nothing is declared', async () => {
    const g = new ToolGateway(
      [McpServerConfigSchema.parse({ name: 'jira', transport: 'in-memory' })],
      {
        secrets: new StaticSecretResolver({}),
        inMemory: inMemoryServers({ jira: server }),
      },
    );
    gateways.push(g);
    const tools = await g.exposedTools({
      id: 'a',
      tools: [ToolGrantSchema.parse({ server: 'jira', tool: 'get_issue' })],
    });
    expect(tools[0]!.access).toBe('read');
  });
});
