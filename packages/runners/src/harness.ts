import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  NotImplementedError,
  OaxError,
  effectiveBudget,
  getEgressPolicy,
  type AgentDefinition,
  type AgentSpec,
} from '@openagentix/core';
import { modelToolName, type ExposedTool } from '@openagentix/mcp';
import { buildSystemPrompt } from './executor.js';
import { OpenCodeHarness, type OpenCodeOptions } from './harness/opencode.js';
import { prepareWorkdir, runHarnessProcess, type OutputParser } from './harness/process.js';

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

/** Limits of the agent contract, mapped to harness flags AND enforced by the platform itself. */
export interface HarnessLimits {
  /** Agent turns (model round trips). From `budget.maxSteps`. */
  maxTurns?: number;
  /** From `budget.maxCostUsd`. */
  maxBudgetUsd?: number;
  /** From `budget.timeoutSeconds`. */
  timeoutMs?: number;
}

export interface HarnessInvocation {
  command: string;
  args: string[];
  /** Minimal environment of the child process (never contains credentials). */
  env: Record<string, string>;
  /** Files to write into the sandbox before starting (path -> content). */
  files: Record<string, string>;
  /** Prompt, passed on stdin so event data never shows up in the process list. */
  stdin?: string;
  limits?: HarnessLimits;
}

export interface HarnessToolEvent {
  id: string;
  name: string;
  input: unknown;
  isError: boolean;
  /** Truncated tool result text. */
  output: string;
}

export type HarnessTermination =
  'none' | 'turns' | 'budget' | 'timeout' | 'cancelled' | 'output_limit';

export interface HarnessResult {
  exitCode: number | null;
  /** Final answer text. */
  text: string;
  isError: boolean;
  errorMessage?: string;
  turns: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  model?: string;
  sessionId?: string;
  /** Every tool call the harness reported (built-in tools would show up here, too). */
  toolCalls: HarnessToolEvent[];
  terminated: HarnessTermination;
}

export interface HarnessRunOptions {
  /** Work directory of the run (created if missing); the harness starts here. */
  cwd: string;
  signal?: AbortSignal | undefined;
}

export interface ExternalHarness {
  readonly name: 'claude-code' | 'opencode' | 'hermes' | 'openclaw';
  buildInvocation(
    def: AgentDefinition,
    agent: AgentSpec,
    prompt: string,
    gate: GateEndpoint,
    tools?: readonly ExposedTool[],
  ): HarnessInvocation;
  run(invocation: HarnessInvocation, opts: HarnessRunOptions): Promise<HarnessResult>;
}

function notYet(name: string): Promise<never> {
  return Promise.reject(
    new NotImplementedError(
      `External harness "${name}"`,
      'The adapter is a documented stub (see docs/harnesses.md); the platform runs agents natively without it.',
    ),
  );
}

// ---------- stream-json parsing (Claude Code) ----------

const MAX_TOOL_OUTPUT = 2_000;

interface StreamState {
  text: string;
  isError: boolean;
  errorMessage: string | undefined;
  turnIds: Set<string>;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  model: string | undefined;
  sessionId: string | undefined;
  tools: Map<string, HarnessToolEvent>;
  gotResult: boolean;
  subtype: string | undefined;
  reportedTurns: number | undefined;
}

export function newStreamState(): StreamState {
  return {
    text: '',
    isError: false,
    errorMessage: undefined,
    turnIds: new Set(),
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    model: undefined,
    sessionId: undefined,
    tools: new Map(),
    gotResult: false,
    subtype: undefined,
    reportedTurns: undefined,
  };
}

type Json = Record<string, unknown>;

/** Folds one `--output-format stream-json` line into the state; returns the turn count. */
export function applyStreamEvent(s: StreamState, ev: Json): void {
  const type = ev.type;
  if (type === 'system' && ev.subtype === 'init') {
    if (typeof ev.model === 'string') s.model = ev.model;
    if (typeof ev.session_id === 'string') s.sessionId = ev.session_id;
  } else if (type === 'assistant') {
    const msg = (ev.message ?? {}) as Json;
    if (typeof msg.id === 'string') s.turnIds.add(msg.id);
    else s.turnIds.add(`anon-${s.turnIds.size}`);
    for (const block of Array.isArray(msg.content) ? (msg.content as Json[]) : []) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        s.tools.set(block.id, {
          id: block.id,
          name: String(block.name ?? ''),
          input: block.input ?? {},
          isError: false,
          output: '',
        });
      }
    }
  } else if (type === 'user') {
    const msg = (ev.message ?? {}) as Json;
    for (const block of Array.isArray(msg.content) ? (msg.content as Json[]) : []) {
      if (block.type !== 'tool_result') continue;
      const t = s.tools.get(String(block.tool_use_id));
      if (!t) continue;
      t.isError = block.is_error === true;
      const c = block.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? (c as Json[]).map((x) => String(x.text ?? '')).join('')
            : '';
      t.output = text.slice(0, MAX_TOOL_OUTPUT);
    }
  } else if (type === 'result') {
    s.gotResult = true;
    if (typeof ev.subtype === 'string') s.subtype = ev.subtype;
    if (typeof ev.num_turns === 'number') s.reportedTurns = ev.num_turns;
    s.isError = ev.is_error === true;
    if (typeof ev.result === 'string') s.text = ev.result;
    if (typeof ev.total_cost_usd === 'number') s.costUsd = ev.total_cost_usd;
    if (typeof ev.session_id === 'string') s.sessionId = ev.session_id;
    const u = (ev.usage ?? {}) as Json;
    const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
    s.tokensIn =
      n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
    s.tokensOut = n('output_tokens');
    if (s.isError) s.errorMessage = `harness reported ${String(ev.subtype ?? 'error')}`;
  }
}

// ---------- Claude Code ----------

export interface ClaudeCodeOptions {
  /** Binary, default `claude`. */
  command?: string;
  /**
   * File with a long-lived token from `claude setup-token` (mounted read-only). It is read at
   * spawn time, handed to the child only and never printed or stored. Without it the existing
   * login of the host user (`HOME`) is used.
   */
  oauthTokenFile?: string;
  /** HOME of the existing login (default: the current user's). Ignored with `oauthTokenFile`. */
  home?: string;
  /** Endpoint the CLI contacts (default https://api.anthropic.com); checked in air-gapped mode. */
  anthropicUrl?: string;
  /** Platform default when the agent sets no step budget. */
  defaultMaxTurns?: number;
}

/** Claude Code in headless mode with a generated allowlist that only contains gate tools. */
export class ClaudeCodeHarness implements ExternalHarness {
  readonly name = 'claude-code' as const;

  constructor(private readonly options: ClaudeCodeOptions = {}) {}

  buildInvocation(
    def: AgentDefinition,
    agent: AgentSpec,
    prompt: string,
    gate: GateEndpoint,
    tools?: readonly ExposedTool[],
  ): HarnessInvocation {
    const prefix = `mcp__${gate.serverName}__`;
    // Prefer the exact tools the gate serves for this run; fall back to the declared grants.
    const allowed = tools
      ? tools.map((t) => `${prefix}${t.modelName}`)
      : agent.tools.map(
          (t) =>
            `${prefix}${modelToolName(t.server, t.tool.replace(/\*$/, ''))}${t.tool.endsWith('*') ? '*' : ''}`,
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
    const budget = effectiveBudget(def.budget, agent.budget);
    const maxTurns = budget.maxSteps ?? this.options.defaultMaxTurns ?? 25;
    const limits: HarnessLimits = {
      maxTurns,
      ...(budget.maxCostUsd !== undefined ? { maxBudgetUsd: budget.maxCostUsd } : {}),
      ...(budget.timeoutSeconds !== undefined ? { timeoutMs: budget.timeoutSeconds * 1000 } : {}),
    };
    const home = this.options.oauthTokenFile ? undefined : (this.options.home ?? process.env.HOME);
    return {
      command: this.options.command ?? 'claude',
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        agent.model,
        '--append-system-prompt',
        buildSystemPrompt(agent),
        '--mcp-config',
        '.openagentix/mcp.json',
        '--strict-mcp-config',
        // No built-in tools (Bash, Edit, WebFetch, ...): the gate is the only tool source.
        '--tools',
        '',
        '--permission-mode',
        'dontAsk',
        '--allowedTools',
        allowed.join(','),
        // Ignore user/project/local settings and CLAUDE.md files of the host (also of parent
        // directories), confine file tools and drop skills/slash commands.
        '--restricted',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--max-turns',
        String(maxTurns),
        ...(limits.maxBudgetUsd !== undefined
          ? ['--max-budget-usd', String(limits.maxBudgetUsd)]
          : []),
      ],
      // Minimal environment: no host secrets, no proxies, no editor/CI variables.
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        ...(home ? { HOME: home } : {}),
      },
      files: { '.openagentix/mcp.json': JSON.stringify(mcpConfig, null, 2) },
      stdin: prompt,
      limits,
    };
  }

  async run(inv: HarnessInvocation, opts: HarnessRunOptions): Promise<HarnessResult> {
    // The CLI is a separate process that talks to the Anthropic API itself, so the in-process
    // network guard cannot see it: in air-gapped mode refuse unless that endpoint is allowlisted.
    getEgressPolicy().assert(
      this.options.anthropicUrl ?? 'https://api.anthropic.com',
      'Claude Code harness (Anthropic API)',
    );
    const cwd = await prepareWorkdir(opts.cwd, inv.files);
    const env: Record<string, string> = { ...inv.env };
    const secrets: string[] = [];
    for (const v of Object.values(inv.files)) {
      const m = /"Authorization":\s*"Bearer ([^"]+)"/.exec(v);
      if (m?.[1]) secrets.push(m[1]);
    }
    if (this.options.oauthTokenFile) {
      const token = (await readFile(this.options.oauthTokenFile, 'utf8')).trim();
      if (!token) throw new OaxError('harness_auth', 'the OAuth token file is empty');
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      env.HOME = join(cwd, '.home');
      await mkdir(env.HOME, { recursive: true, mode: 0o700 });
      secrets.push(token);
    }
    return runHarnessProcess(
      inv,
      { cwd, env, secrets, signal: opts.signal },
      new ClaudeOutputParser(),
    );
  }
}

/** Parses `--output-format stream-json` lines of Claude Code. */
class ClaudeOutputParser implements OutputParser {
  private readonly state = newStreamState();

  feed(line: string): void {
    try {
      applyStreamEvent(this.state, JSON.parse(line) as Json);
    } catch {
      // non-JSON noise
    }
  }

  turnCount(): number {
    return this.state.turnIds.size;
  }

  costUsd(): number {
    return this.state.costUsd;
  }

  finalize() {
    const s = this.state;
    return {
      text: s.text,
      isError: s.isError,
      errorMessage: s.errorMessage,
      // The harness' own limits (flags) surface as result subtypes.
      terminated:
        s.subtype === 'error_max_turns'
          ? ('turns' as const)
          : s.subtype === 'error_max_budget_usd'
            ? ('budget' as const)
            : undefined,
      complete: s.gotResult,
      turns: Math.max(s.turnIds.size, s.reportedTurns ?? 0),
      costUsd: s.costUsd,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      model: s.model,
      sessionId: s.sessionId,
      toolCalls: [...s.tools.values()],
    };
  }
}

// ---------- documented stubs ----------

class StubHarness implements ExternalHarness {
  constructor(readonly name: 'hermes' | 'openclaw') {}

  buildInvocation(): HarnessInvocation {
    throw new NotImplementedError(
      `External harness "${this.name}"`,
      'The configuration adapter is a documented stub (see docs/harnesses.md).',
    );
  }

  run(): Promise<never> {
    return notYet(this.name);
  }
}

export const HermesHarness = () => new StubHarness('hermes');
export const OpenClawHarness = () => new StubHarness('openclaw');

export interface HarnessFactoryOptions extends ClaudeCodeOptions {
  /** Options of the OpenCode adapter (model connections, binary, checksum). */
  opencode?: OpenCodeOptions;
}

export function createHarness(
  name: ExternalHarness['name'],
  options: HarnessFactoryOptions = {},
): ExternalHarness {
  switch (name) {
    case 'claude-code':
      return new ClaudeCodeHarness(options);
    case 'opencode':
      return new OpenCodeHarness(options.opencode);
    case 'hermes':
      return HermesHarness();
    case 'openclaw':
      return OpenClawHarness();
  }
}
