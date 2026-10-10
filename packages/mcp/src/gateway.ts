import {
  ContextGuard,
  OaxError,
  classifyTool,
  digestMatchesAny,
  evaluateToolCall,
  findGrant,
  grantedTools,
  isGuardReportEmpty,
  mergeGuardReports,
  pinnedToolsOf,
  toolsDigest,
  type PinnedTool,
  type SecretResolver,
  type GuardReport,
  type PolicyContext,
  type PolicyDecision,
  type ToolAccess,
  type ToolCallRequest,
} from '@openagentix/core';
import type { ConnectDeps, McpTool, ToolResult } from './connection.js';
import { McpConnection } from './connection.js';
import type { McpServerConfig } from './config.js';

/** Model-facing name for an MCP tool (`server__tool`, OpenAI/Anthropic compatible charset). */
export function modelToolName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Decides tool calls. The in-process worker evaluates locally; remote worker nodes use
 * the control node's gate endpoint (same interface, different transport).
 */
export interface PolicyGate {
  decide(call: ToolCallRequest): Promise<PolicyDecision>;
}

export function localPolicyGate(ctx: PolicyContext): PolicyGate {
  return { decide: async (call) => evaluateToolCall(call, ctx) };
}

export interface ExposedTool {
  modelName: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Declared class of the tool, else derived from the MCP annotations (default `write`). */
  access?: ToolAccess | undefined;
}

/**
 * What a published version pinned for one MCP server (ADR 0016 section 5), resolved by the control
 * node for the run: the grants of the version on the server and every digest of the granted tools
 * that the run may accept (the pinned one, plus those of snapshots an admin accepted for existing
 * versions).
 */
export interface ToolPinCheck {
  granted: readonly string[];
  accepted: readonly string[];
}

/**
 * Reported when the granted tools a server offers differ from what was pinned. `tools` is the whole
 * reduced list when it is within the bounds of a snapshot, else `null` (the audit entry then has
 * the digest only). Called once per server and gateway.
 */
export interface ToolsChanged {
  server: string;
  liveDigest: string;
  tools: PinnedTool[] | null;
}

/** A failed tool call: the message is guarded, `guard` says what was removed (counts only). */
export type GuardedToolError = OaxError & { guard?: GuardReport };

export type GatewayCallResult =
  | {
      status: 'ok';
      decision: PolicyDecision;
      result: ToolResult;
      /** Set when the guard removed or replaced something in the result (counts only). */
      guard?: GuardReport;
    }
  | { status: 'denied'; decision: PolicyDecision }
  | { status: 'approval_required'; decision: PolicyDecision };

/**
 * Connection pool + allowlist enforcement. Tools that are not granted are neither shown to the
 * model nor callable; every call is decided by the policy gate BEFORE it reaches the server.
 */
export class ToolGateway {
  private readonly connections = new Map<string, McpConnection>();
  private pins: Readonly<Record<string, ToolPinCheck>> = {};
  private onToolsChanged: ((e: ToolsChanged) => Promise<void> | void) | undefined;
  /**
   * One verdict per pinned server: the first `tools/list` decides for the whole session, and the
   * granted tools of that very list (the ones whose digest matched) are the only definitions of the
   * server that are ever exposed. A later `tools/list` is never read for a pinned server, so a server
   * cannot answer the check with the approved definitions and the model with different ones.
   */
  private readonly verdicts = new Map<string, Promise<McpTool[]>>();

  constructor(
    private readonly configs: readonly McpServerConfig[],
    private readonly deps: ConnectDeps,
    /**
     * Guards every tool result before the caller sees it (invisible Unicode removed, secret values
     * replaced). This is the one place all tool results pass, for inline runs, run nodes and
     * harness steps alike. On by default; secrets resolved for the servers are registered here.
     */
    readonly guard: ContextGuard = new ContextGuard(),
  ) {}

  /** Wraps a resolver so that every value it hands out is known to the guard. */
  private recording(resolver: SecretResolver): SecretResolver {
    return {
      resolve: async (ref) => {
        const value = await resolver.resolve(ref);
        this.guard.addSecret(value);
        return value;
      },
    };
  }

  private async connection(server: string): Promise<McpConnection> {
    const existing = this.connections.get(server);
    if (existing) return existing;
    const cfg = this.configs.find((c) => c.name === server);
    if (!cfg) throw new OaxError('mcp_unknown_server', `MCP server "${server}" is not configured`);
    const deps = {
      ...this.deps,
      secrets: this.recording(
        this.deps.secretsFor ? this.deps.secretsFor(cfg.name) : this.deps.secrets,
      ),
    };
    const conn = await McpConnection.connect(cfg, deps);
    this.connections.set(server, conn);
    return conn;
  }

  /**
   * Pins the tool definitions of MCP servers (ADR 0016 section 5). A pinned server whose granted
   * tools do not match any accepted digest exposes none of its tools and fails every use with
   * `mcp_tools_changed`; the list is read once per session, later `list_changed` notices are not
   * followed. Servers without a pin behave as before.
   */
  pinTools(
    pins: Readonly<Record<string, ToolPinCheck>>,
    onChanged?: (e: ToolsChanged) => Promise<void> | void,
  ): void {
    this.pins = pins;
    this.onToolsChanged = onChanged;
    this.verdicts.clear();
  }

  /** The verified granted tools of a pinned server, `null` for a server without a pin. */
  private verify(server: string): Promise<McpTool[] | null> {
    const pin = this.pins[server];
    if (!pin) return Promise.resolve(null);
    let verdict = this.verdicts.get(server);
    if (!verdict) {
      verdict = this.check(server, pin);
      // A verdict that is a rejection must not surface as unhandled before the first caller awaits.
      verdict.catch(() => undefined);
      this.verdicts.set(server, verdict);
    }
    return verdict;
  }

  private async check(server: string, pin: ToolPinCheck): Promise<McpTool[]> {
    const tools = await (await this.connection(server)).listTools();
    let live: string;
    let verified: PinnedTool[] = [];
    try {
      // Only the granted tools count: a change to any other tool of the server does not matter.
      verified = pinnedToolsOf(grantedTools(tools as PinnedTool[], pin.granted));
      live = toolsDigest(verified);
    } catch {
      // Unreadable or oversized definitions can never match a pin.
      live = 'invalid';
    }
    if (digestMatchesAny(live, pin.accepted))
      // Exactly the reduced definitions that were hashed (deep copies: nothing that held a
      // reference to the server's answer can change them afterwards).
      return verified.map((t) => {
        const c = structuredClone(t);
        return {
          name: c.name,
          ...(typeof c.title === 'string' ? { title: c.title } : {}),
          ...(typeof c.description === 'string' ? { description: c.description } : {}),
          inputSchema: c.inputSchema,
          ...(c.outputSchema ? { outputSchema: c.outputSchema } : {}),
          ...(c.annotations ? { annotations: c.annotations as McpTool['annotations'] } : {}),
        };
      });
    let all: PinnedTool[] | null;
    try {
      all = pinnedToolsOf(tools);
    } catch {
      all = null;
    }
    // Reporting must not decide the outcome: a failing report still fails the step closed.
    try {
      await this.onToolsChanged?.({ server, liveDigest: live, tools: all });
    } catch {
      /* the caller logs; the step fails below */
    }
    throw new OaxError(
      'mcp_tools_changed',
      `the tool definitions of MCP server "${server}" changed since they were approved; none of its tools is available until an admin approves them again`,
    );
  }

  /** Lists the granted tools of an agent (intersection of grants and what the servers offer). */
  async exposedTools(agent: PolicyContext['agent']): Promise<ExposedTool[]> {
    const servers = [...new Set(agent.tools.map((t) => t.server))];
    const out: ExposedTool[] = [];
    for (const server of servers) {
      // Fail closed before a single definition of this server can reach the model; a pinned server
      // exposes the verified list itself, never a second answer of the server.
      const verified = await this.verify(server);
      const tools: McpTool[] = verified ?? (await (await this.connection(server)).listTools());
      const declared = this.configs.find((c) => c.name === server)?.tools ?? {};
      for (const t of tools) {
        if (!findGrant(agent.tools, server, t.name)) continue;
        out.push({
          modelName: modelToolName(server, t.name),
          server,
          tool: t.name,
          // Descriptions and schemas come from the server and enter the model context as tool
          // specs (natively and through the harness gate): guarded like a tool result.
          description: this.guard.text(t.description ?? '').text,
          inputSchema: this.guard.value(t.inputSchema).value,
          access: classifyTool(
            Object.hasOwn(declared, t.name) ? declared[t.name]!.access : undefined,
            t.annotations,
          ),
        });
      }
    }
    return out;
  }

  /**
   * Executes a tool call after the gate allowed it. With `approved: true` a `require_approval`
   * decision is treated as allowed (the approval was granted by a human).
   */
  async call(
    call: ToolCallRequest,
    gate: PolicyGate,
    opts: { approved?: boolean; signal?: AbortSignal } = {},
  ): Promise<GatewayCallResult> {
    const decision = await gate.decide(call);
    if (decision.effect === 'deny') return { status: 'denied', decision };
    if (decision.effect === 'require_approval' && !opts.approved)
      return { status: 'approval_required', decision };
    let raw: ToolResult;
    // A call never reaches a pinned server whose definitions changed, whatever the caller did before,
    // nor a tool of it that was not in the verified (pinned) list.
    const verified = await this.verify(call.server);
    if (verified && !verified.some((t) => t.name === call.tool))
      throw new OaxError(
        'mcp_tools_changed',
        `tool "${call.server}/${call.tool}" is not part of the approved tool definitions of MCP server "${call.server}"`,
      );
    try {
      const conn = await this.connection(call.server);
      raw = await conn.callTool(call.tool, call.args, opts.signal);
    } catch (e) {
      // The message of a failed call carries server text (a JSON-RPC error, a crash message) and
      // reaches the model like a result: the executor shows it, the harness gate returns it.
      throw this.guardedError(e);
    }
    const text = this.guard.text(raw.text);
    if (raw.structured === undefined && isGuardReportEmpty(text.report))
      return { status: 'ok', decision, result: raw };
    const structured = raw.structured === undefined ? undefined : this.guard.value(raw.structured);
    const report = text.report;
    if (structured) mergeGuardReports(report, structured.report);
    const result: ToolResult = { ...raw, text: text.text };
    if (structured) result.structured = structured.value;
    return isGuardReportEmpty(report)
      ? { status: 'ok', decision, result }
      : { status: 'ok', decision, result, guard: report };
  }

  /** The error of a failed call with its message guarded; content-bearing details are dropped. */
  private guardedError(e: unknown): GuardedToolError {
    const message = e instanceof Error ? e.message : String(e);
    const guarded = this.guard.text(message);
    const out: GuardedToolError = new OaxError(
      e instanceof OaxError ? e.code : 'tool_failed',
      guarded.text,
    );
    if (!isGuardReportEmpty(guarded.report)) out.guard = guarded.report;
    return out;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((c) => c.close()));
    this.connections.clear();
  }
}
