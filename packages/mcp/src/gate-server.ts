import type { ToolCallRequest } from '@openagentix/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ExposedTool, GatewayCallResult, PolicyGate, ToolGateway } from './gateway.js';

export interface GateServerOptions {
  gateway: ToolGateway;
  gate: PolicyGate;
  tools: readonly ExposedTool[];
  /** Called for every call (audit, costs, control agent). */
  onCall?: (call: ToolCallRequest, result: GatewayCallResult) => void | Promise<void>;
}

/**
 * The policy gate as an MCP server ("MCP proxy"). External harnesses (Claude Code, OpenCode, ...)
 * are configured to see ONLY this server, so every tool call they make passes the same policy
 * engine, audit trail and control agent as native runs.
 */
export function createPolicyGateServer(opts: GateServerOptions): Server {
  const server = new Server(
    { name: 'openagentix-gate', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  const byName = new Map(opts.tools.map((t) => [t.modelName, t]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opts.tools.map((t) => ({
      name: t.modelName,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object' },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const exposed = byName.get(req.params.name);
    if (!exposed)
      return {
        content: [{ type: 'text', text: `tool ${req.params.name} is not available` }],
        isError: true,
      };
    const call: ToolCallRequest = {
      server: exposed.server,
      tool: exposed.tool,
      args: req.params.arguments ?? {},
    };
    const result = await opts.gateway.call(call, opts.gate);
    await opts.onCall?.(call, result);
    if (result.status === 'ok')
      return {
        content: [{ type: 'text', text: result.result.text }],
        isError: result.result.isError,
      };
    const reasons = result.decision.reasons.map((r) => r.message).join('; ');
    const text =
      result.status === 'denied'
        ? `Denied by policy: ${reasons}`
        : `Requires human approval: ${reasons}`;
    return { content: [{ type: 'text', text }], isError: true };
  });
  return server;
}
