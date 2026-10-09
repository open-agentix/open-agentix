import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CostModel,
  StaticSecretResolver,
  ToolGrantSchema,
  evaluateToolCall,
  loadAgentDefinition,
  type AgentDefinition,
  type PolicyContext,
} from '@openagentix/core';
import { createEvent } from '@openagentix/events';
import {
  McpServerConfigSchema,
  ToolGateway,
  inMemoryServers,
  toolAccessOfConfigs,
} from '@openagentix/mcp';
import { ProviderRegistry, SimulatedProvider } from '@openagentix/providers';
import {
  LocalControlPlane,
  executeWithHarness,
  type ExternalHarness,
  type HarnessInvocation,
  type HarnessResult,
  type RunnerContext,
} from '@openagentix/runners';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_TOOLS,
  Workspace,
  createWorkspaceMcpServer,
  workspaceToolDeclarations,
  workspaceToolGrants,
} from '../src/index.js';
import { NODE_TESTS, seedDir } from './helpers.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const grants = workspaceToolGrants();

function definition(): AgentDefinition {
  return loadAgentDefinition(`---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: bug-fix
version: 0.1.0
owner: dogfood
budget: { maxSteps: 40, maxToolCalls: 80, timeoutSeconds: 1200 }
agents:
  - id: fix
    provider: simulated
    model: sim-1
    instructions: Fix the bug.
    access: write
    tools: ${JSON.stringify(grants)}
---
`);
}

/** Behaves like Claude Code: only gate tools, as `server__tool` names. */
class Scripted implements ExternalHarness {
  readonly name = 'claude-code' as const;
  constructor(
    private readonly script: (
      call: (n: string, a: Record<string, unknown>) => Promise<string>,
    ) => Promise<void>,
  ) {}
  buildInvocation(
    _d: AgentDefinition,
    _a: unknown,
    prompt: string,
    gate: { url: string; runToken: string },
  ): HarnessInvocation {
    return {
      command: 'scripted',
      args: [],
      env: {},
      files: { 'gate.json': JSON.stringify(gate) },
      stdin: prompt,
      limits: { maxTurns: 40 },
    };
  }
  async run(inv: HarnessInvocation): Promise<HarnessResult> {
    const gate = JSON.parse(inv.files['gate.json']!) as { url: string; runToken: string };
    const called: HarnessResult['toolCalls'] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(gate.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${gate.runToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: called.length + 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const r = (
        (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
      ).result;
      const text = r.content.map((c) => c.text).join('\n');
      called.push({
        id: String(called.length),
        name: `mcp__oax-gate__${name}`,
        input: args,
        isError: r.isError === true,
        output: text,
      });
      return text;
    };
    await this.script(call);
    return {
      exitCode: 0,
      text: 'fixed',
      isError: false,
      turns: 3,
      costUsd: 0,
      tokensIn: 1,
      tokensOut: 1,
      toolCalls: called,
      terminated: 'none',
    };
  }
}

async function run(script: ConstructorParameters<typeof Scripted>[0]) {
  const root = await seedDir();
  const ws = await Workspace.open({ root, tests: NODE_TESTS });
  const def = definition();
  const cfg = McpServerConfigSchema.parse({
    name: 'workspace',
    transport: 'in-memory',
    tools: workspaceToolDeclarations(),
  });
  const tools = new ToolGateway([cfg], {
    secrets: new StaticSecretResolver({}),
    inMemory: inMemoryServers({ workspace: () => createWorkspaceMcpServer(ws) }),
  });
  const control = new LocalControlPlane({
    definition: def,
    toolAccess: toolAccessOfConfigs([cfg]),
  });
  const ctx: RunnerContext = {
    providers: ProviderRegistry.of([new SimulatedProvider({ name: 'simulated' })]),
    tools,
    control,
    costModel: new CostModel([]),
    sleep: async () => undefined,
  };
  const result = await executeWithHarness(
    {
      runId: 'run-1',
      definition: def,
      event: createEvent({ source: '/t', type: 't', data: {} }),
      policies: [],
    },
    ctx,
    new Scripted(script),
    {},
  );
  await tools.close();
  return { result, control, ws, root };
}

describe('workspace tools behind the policy gate', () => {
  it('every call is a policy decision plus a tool call step; the node computes the patch', async () => {
    const { result, control, ws } = await run(async (call) => {
      expect(await call('workspace__list_files', { path: 'src' })).toContain('src/price.js');
      expect(await call('workspace__read_file', { path: 'src/price.js' })).toContain('Math.floor');
      expect(
        await call('workspace__edit_file', {
          path: 'src/price.js',
          old: 'Math.floor',
          new: 'Math.round',
        }),
      ).toContain('"bytes"');
      expect(await call('workspace__run_tests', {})).toContain('"passed":true');
      expect(await call('workspace__diff', {})).toContain('Math.round');
      await call('workspace__search', { pattern: 'Math' });
    });
    expect(result.error ?? null).toBeNull();
    expect(result.status).toBe('succeeded');
    const kinds = control.steps.map((s) => `${s.kind}:${s.status}`);
    expect(kinds.filter((k) => k === 'policy_decision:ok')).toHaveLength(6);
    expect(kinds.filter((k) => k === 'tool_call:ok')).toHaveLength(6);
    expect(control.verifyAudit().valid).toBe(true);
    const final = await ws.finalize();
    expect(final).toMatchObject({ toolCalls: 6, testedFinalTree: true });
    expect(final.patch.ok && final.patch.changedFiles.map((f) => f.path)).toEqual(['src/price.js']);
  });

  const ATTACKS: [string, Record<string, unknown>][] = [
    ['workspace__write_file', { path: '.github/workflows/release.yml', content: 'name: x' }],
    ['workspace__write_file', { path: 'package.json', content: '{}' }],
    ['workspace__edit_file', { path: 'src/../package.json', old: 'bakery', new: 'x' }],
    ['workspace__write_file', { path: '.git/hooks/pre-commit', content: 'x' }],
    ['workspace__run_tests', { file: '--eval=process.exit(0)' }],
    ['workspace__run_tests', { file: 'test/../../x.test.js' }],
    ['workspace__read_file', { path: 'src/price.js', command: 'rm -rf /' }],
    ['workspace__read_file', { path: '../../etc/passwd' }],
    ['workspace__search', { pattern: 'x', path: '/etc' }],
    ['workspace__bash', { command: 'id' }],
  ];

  it.each(ATTACKS)('the gate denies %s %j before the tool runs (audited)', async (tool, args) => {
    const { result, control, ws, root } = await run(async (call) => {
      expect(await call(tool, args)).toMatch(/denied|not available/i);
      await call('workspace__list_files', {});
    });
    expect(result.error ?? null).toBeNull();
    expect(result.status).toBe('succeeded');
    const unknown = tool.endsWith('__bash');
    if (!unknown)
      expect(
        control.steps.filter((s) => s.kind === 'policy_decision' && s.status === 'denied'),
      ).toHaveLength(1);
    expect(control.steps.filter((s) => s.kind === 'tool_call')).toHaveLength(1); // only the list_files
    expect((await ws.finalize()).toolCalls).toBe(1);
    expect(await readdir(root)).not.toContain('.git');
    expect(await readFile(join(root, 'package.json'), 'utf8')).toContain('bakery');
    expect(control.verifyAudit().valid).toBe(true);
  });

  it('three denied calls end the run (injection that keeps pushing is stopped)', async () => {
    const { result } = await run(async (call) => {
      for (let i = 0; i < 4; i += 1)
        await call('workspace__write_file', { path: `.github/workflows/x${i}.yml`, content: 'x' });
    });
    expect(result.status).toBe('blocked_by_policy');
    expect(['control_error_streak', 'control_policy_denials']).toContain(result.error?.code);
  });

  it('the server enforces the same rules even when the gate would allow (second wall)', async () => {
    const root = await seedDir();
    const ws = await Workspace.open({ root });
    const server = createWorkspaceMcpServer(ws);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      return {
        isError: r.isError === true,
        body: JSON.parse(r.content[0]!.text) as Record<string, unknown>,
      };
    };
    expect(
      await call('write_file', { path: '.github/workflows/x.yml', content: 'x' }),
    ).toMatchObject({ isError: true, body: { code: 'path_forbidden' } });
    expect(await call('read_file', { path: '../../etc/passwd' })).toMatchObject({
      isError: true,
      body: { code: 'invalid_path' },
    });
    expect(await call('read_file', { path: 'src/price.js', extra: 1 })).toMatchObject({
      isError: true,
      body: { code: 'invalid_arguments' },
    });
    expect(await call('read_file', { path: 42 })).toMatchObject({
      isError: true,
      body: { code: 'invalid_arguments' },
    });
    expect(await call('bash', { command: 'id' })).toMatchObject({
      isError: true,
      body: { code: 'unknown_tool' },
    });
    expect(await call('run_tests', {})).toMatchObject({
      isError: true,
      body: { code: 'tests_not_configured' },
    });
    expect(await call('toString', {})).toMatchObject({
      isError: true,
      body: { code: 'unknown_tool' },
    });
    const ok = await call('read_file', { path: 'src/hours.js' });
    expect(ok.isError).toBe(false);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...WORKSPACE_TOOLS].sort());
    expect(tools.tools.find((t) => t.name === 'edit_file')?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools.find((t) => t.name === 'read_file')?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it('call caps of the grants are enforced by the policy engine', () => {
    const ctx = (used: number): PolicyContext => ({
      definition: { classification: 'internal' },
      agent: { id: 'fix', tools: grants.map((g) => ToolGrantSchema.parse(g)) },
      callCounts: new Map([['workspace/run_tests', used]]),
    });
    expect(
      evaluateToolCall({ server: 'workspace', tool: 'run_tests', args: {} }, ctx(7)).effect,
    ).toBe('allow');
    const d = evaluateToolCall({ server: 'workspace', tool: 'run_tests', args: {} }, ctx(8));
    expect(d.effect).toBe('deny');
    expect(d.reasons[0]?.code).toBe('call_limit');
  });

  it('declares write tools as write and read tools as read', () => {
    const decl = workspaceToolDeclarations();
    expect(decl).toMatchObject({
      read_file: { access: 'read' },
      list_files: { access: 'read' },
      search: { access: 'read' },
      diff: { access: 'read' },
      edit_file: { access: 'write' },
      write_file: { access: 'write' },
      run_tests: { access: 'write' },
    });
    expect(
      workspaceToolGrants({ caps: { run_tests: 3 }, testFilePattern: '^test/x\\.js$' }).find(
        (g) => g.tool === 'run_tests',
      ),
    ).toMatchObject({ maxCallsPerRun: 3 });
  });
});
