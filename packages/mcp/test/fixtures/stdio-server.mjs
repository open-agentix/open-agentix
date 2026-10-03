// Minimal stdio MCP server used by tests (no network). Echoes arguments and an env variable.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'stdio-echo', version: '0.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        args: req.params.arguments,
        token: process.env.ECHO_TOKEN ?? null,
        leaked: process.env.OAX_TEST_PARENT_SECRET ?? null,
      }),
    },
  ],
}));
await server.connect(new StdioServerTransport());
