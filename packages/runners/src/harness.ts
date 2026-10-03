import { NotImplementedError, type AgentDefinition, type AgentSpec } from '@openagentix/core';
import { modelToolName } from '@openagentix/mcp';

/**
 * Optional external agent harnesses (Claude Code, OpenCode, Hermes, OpenClaw) as executors.
 * The adapter translates an agents.md agent into the harness configuration and points the harness
 * at the openagentix policy gate (MCP proxy) as its ONLY tool source, so policy, audit, control
 * agent and costs stay identical. The platform never requires a harness.
 */

export interface GateEndpoint {
  /** Name of the gate MCP server inside the harness config. */
  serverName: string;
  /** Streamable HTTP URL of the gate for this run (authenticated by the run token). */
  url: string;
  runToken: string;
}

export interface HarnessInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Files to write into the sandbox before starting (path -> content). */
  files: Record<string, string>;
}

export interface ExternalHarness {
  readonly name: 'claude-code' | 'opencode' | 'hermes' | 'openclaw';
  buildInvocation(
    def: AgentDefinition,
    agent: AgentSpec,
    prompt: string,
    gate: GateEndpoint,
  ): HarnessInvocation;
  run(invocation: HarnessInvocation): Promise<never>;
}

function notYet(name: string): Promise<never> {
  return Promise.reject(
    new NotImplementedError(
      `External harness "${name}"`,
      'Harness execution is planned for v0.3; the platform runs agents natively without it.',
    ),
  );
}

/** Claude Code in headless mode with a generated allowlist that only contains gate tools. */
export class ClaudeCodeHarness implements ExternalHarness {
  readonly name = 'claude-code' as const;

  buildInvocation(
    _def: AgentDefinition,
    agent: AgentSpec,
    prompt: string,
    gate: GateEndpoint,
  ): HarnessInvocation {
    const allowed = agent.tools.map(
      (t) =>
        `mcp__${gate.serverName}__${modelToolName(t.server, t.tool.replace(/\*$/, ''))}${t.tool.endsWith('*') ? '*' : ''}`,
    );
    const mcpConfig = {
      mcpServers: {
        [gate.serverName]: {
          type: 'http',
          url: gate.url,
          headers: { Authorization: `Bearer ${gate.runToken}` },
        },
      },
    };
    return {
      command: 'claude',
      args: [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        agent.model,
        '--append-system-prompt',
        agent.instructions,
        '--mcp-config',
        '.openagentix/mcp.json',
        '--strict-mcp-config',
        '--permission-mode',
        'dontAsk',
        '--allowedTools',
        allowed.join(','),
      ],
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      files: { '.openagentix/mcp.json': JSON.stringify(mcpConfig, null, 2) },
    };
  }

  run(): Promise<never> {
    return notYet(this.name);
  }
}

class StubHarness implements ExternalHarness {
  constructor(readonly name: 'opencode' | 'hermes' | 'openclaw') {}

  buildInvocation(): HarnessInvocation {
    throw new NotImplementedError(
      `External harness "${this.name}"`,
      'The configuration adapter is planned for v0.3.',
    );
  }

  run(): Promise<never> {
    return notYet(this.name);
  }
}

export const OpenCodeHarness = () => new StubHarness('opencode');
export const HermesHarness = () => new StubHarness('hermes');
export const OpenClawHarness = () => new StubHarness('openclaw');

export function createHarness(name: ExternalHarness['name']): ExternalHarness {
  switch (name) {
    case 'claude-code':
      return new ClaudeCodeHarness();
    case 'opencode':
      return OpenCodeHarness();
    case 'hermes':
      return HermesHarness();
    case 'openclaw':
      return OpenClawHarness();
  }
}
