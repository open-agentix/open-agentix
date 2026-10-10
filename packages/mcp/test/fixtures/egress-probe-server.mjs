// Stdio MCP server used by the egress tests. Usage: egress-probe-server.mjs <out-file> <label>.
// `probe { host }` records which proxy variables the process received and, when it has a proxy,
// what an HTTP CONNECT to <host>:443 through it answers. It reports the account (user name) only,
// never the password.
import { appendFileSync } from 'node:fs';
import * as net from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const [out, label] = process.argv.slice(2);
const server = new Server(
  { name: 'egress-probe', version: '0.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
    },
  ],
}));

function connectVia(proxy, host) {
  return new Promise((resolve) => {
    const auth = Buffer.from(
      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
    ).toString('base64');
    const s = net.connect(Number(proxy.port), proxy.hostname);
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n')) {
        s.destroy();
        resolve(buf.split('\r\n')[0]);
      }
    });
    s.on('error', () => resolve('error'));
    s.setTimeout(3000, () => (s.destroy(), resolve('timeout')));
    s.write(
      `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
    );
  });
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const host = String(req.params.arguments?.host ?? '');
  const vars = Object.keys(process.env)
    .filter((k) => /proxy/i.test(k))
    .sort();
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const proxy = raw ? new URL(raw) : null;
  const status = proxy ? await connectVia(proxy, host) : null;
  appendFileSync(
    out,
    `${JSON.stringify({ label, host, vars, account: proxy ? decodeURIComponent(proxy.username) : null, status })}\n`,
  );
  return { content: [{ type: 'text', text: 'probed' }] };
});
await server.connect(new StdioServerTransport());
