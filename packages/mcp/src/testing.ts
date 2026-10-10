import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { InMemoryTransportFactory } from './connection.js';

export interface MockTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Return a string (text) or any JSON value; throwing produces an `isError` result. */
  handler: (args: Record<string, unknown>, meta?: Record<string, unknown>) => unknown;
  delayMs?: number;
  /** MCP tool annotations advertised by `tools/list` (e.g. `{ readOnlyHint: true }`). */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
  /** Advertised by `tools/list`; a call then returns no structured content, so do not call it. */
  outputSchema?: Record<string, unknown>;
}

/** A small in-process MCP server (tests, the demo and the local CLI). */
export function createMockMcpServer(name: string, tools: readonly MockTool[]): Server {
  const server = new Server({ name, version: '0.2.0-alpha.1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      ...(t.title !== undefined ? { title: t.title } : {}),
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? { type: 'object' }) as { type: 'object' },
      ...(t.outputSchema ? { outputSchema: t.outputSchema as { type: 'object' } } : {}),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool)
      return {
        content: [{ type: 'text', text: `unknown tool ${req.params.name}` }],
        isError: true,
      };
    if (tool.delayMs) await new Promise((r) => setTimeout(r, tool.delayMs));
    try {
      const out = await tool.handler(req.params.arguments ?? {}, req.params._meta);
      return {
        content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  });
  return server;
}

/** Connects a server to a fresh in-memory transport pair and returns the client side. */
export async function linkInMemory(server: Server): Promise<Transport> {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return client;
}

/** Factory for `in-memory` connections: a new server instance per connection. */
export function inMemoryServers(
  servers: Readonly<Record<string, () => Server>>,
): InMemoryTransportFactory {
  return async (name) => {
    const make = servers[name];
    if (!make) throw new Error(`no in-memory MCP server named "${name}"`);
    return linkInMemory(make());
  };
}

/**
 * Answers one request of a stateless streamable-HTTP MCP server in front of a mock server (tests of
 * the HTTP transport and of connection tests). A fresh server and transport serve each request.
 */
export async function handleMockMcpHttp(
  req: Parameters<StreamableHTTPServerTransport['handleRequest']>[0],
  res: Parameters<StreamableHTTPServerTransport['handleRequest']>[1],
  name: string,
  tools: readonly MockTool[],
): Promise<void> {
  const server = createMockMcpServer(name, tools);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => void transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
