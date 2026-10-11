// Scriptable "malicious" server for the opt-in real-engine abuse suite (ADR 0016 S8). It runs
// inside a throwaway container and is passed to `node --input-type=module -e` as text.
//
// Data port (DATA_PORT, default 443; TLS when LAB_TLS_CERT and LAB_TLS_KEY are set): what the
// platform talks to. Control port (CONTROL_PORT, default 9000, plain http): what the test talks to.
//   POST /set     {path, status?, headers?, body?, json?, redirect?, delayMs?, bytes?}  script one path
//   POST /tools   {tools: [...], whoami?: bool, expectToken?: string}                   MCP behaviour
//   GET  /hits    every request seen on the data port
//   POST /reset   forget hits and scripted paths
// `/mcp` on the data port is a minimal stateless streamable-HTTP MCP server (JSON replies only).
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';

const hits = [];
const routes = new Map();
const mcp = { tools: [], whoami: false, expectToken: undefined, resourceMetadata: undefined };

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
const reply = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

async function data(req, res) {
  const body = await readBody(req);
  hits.push({
    method: req.method,
    url: req.url,
    host: req.headers.host,
    authorization: req.headers.authorization ?? null,
    bytes: body.length,
  });
  let rpc = null;
  try {
    rpc = JSON.parse(body).method ?? null;
  } catch {
    // not JSON-RPC
  }
  hits[hits.length - 1].rpc = rpc;
  const path = (req.url ?? '/').split('?')[0];
  const scripted = routes.get(path);
  if (scripted) {
    if (scripted.delayMs) await new Promise((r) => setTimeout(r, scripted.delayMs));
    if (scripted.redirect)
      return reply(res, scripted.status ?? 302, '', { location: scripted.redirect });
    if (scripted.bytes) return reply(res, scripted.status ?? 200, 'x'.repeat(scripted.bytes));
    return reply(
      res,
      scripted.status ?? 200,
      scripted.json ?? scripted.body ?? '{}',
      scripted.headers ?? {},
    );
  }
  if (path === '/mcp') return mcpHandler(req, res, body);
  return reply(res, 404, { error: 'not found' });
}

function mcpHandler(req, res, body) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
  const auth = req.headers.authorization;
  if (mcp.expectToken !== undefined && auth !== `Bearer ${mcp.expectToken}`)
    return reply(
      res,
      401,
      { error: 'unauthorized' },
      {
        'www-authenticate': `Bearer resource_metadata="${mcp.resourceMetadata ?? ''}"`,
      },
    );
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    return reply(res, 400, { error: 'bad json' });
  }
  if (msg.id === undefined) return reply(res, 202, '');
  const ok = (result) => reply(res, 200, { jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize')
    return ok({
      protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'lab', version: '1.0.0' },
    });
  if (msg.method === 'ping') return ok({});
  const tools = [...mcp.tools];
  if (mcp.whoami)
    tools.push({
      name: 'fail_echo',
      description: 'fails with an error that quotes the authorization header',
      inputSchema: { type: 'object', properties: {} },
    });
  if (mcp.whoami)
    tools.push({
      name: 'whoami',
      description: 'echoes the authorization header it received',
      inputSchema: { type: 'object', properties: {} },
    });
  if (msg.method === 'tools/list') return ok({ tools });
  if (msg.method === 'tools/call') {
    if (msg.params?.name === 'whoami')
      return ok({ content: [{ type: 'text', text: `header was ${auth ?? 'none'}` }] });
    if (msg.params?.name === 'fail_echo')
      return reply(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: `upstream rejected ${auth ?? 'none'}` },
      });
    return ok({ content: [{ type: 'text', text: `ran ${msg.params?.name}` }] });
  }
  return reply(res, 200, {
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `no such method ${msg.method}` },
  });
}

const tls = process.env.LAB_TLS_CERT && process.env.LAB_TLS_KEY;
const dataServer = tls
  ? createHttps(
      { cert: process.env.LAB_TLS_CERT, key: process.env.LAB_TLS_KEY },
      (q, s) => void data(q, s),
    )
  : createHttp((q, s) => void data(q, s));
dataServer.listen(Number(process.env.DATA_PORT ?? 443), '0.0.0.0');

createHttp(async (req, res) => {
  const body = await readBody(req);
  const j = body ? JSON.parse(body) : {};
  if (req.url === '/hits') return reply(res, 200, hits);
  if (req.url === '/reset') {
    hits.length = 0;
    routes.clear();
    Object.assign(mcp, {
      tools: [],
      whoami: false,
      expectToken: undefined,
      resourceMetadata: undefined,
    });
    return reply(res, 200, {});
  }
  if (req.url === '/set') {
    routes.set(j.path, j);
    return reply(res, 200, {});
  }
  if (req.url === '/tools') {
    Object.assign(mcp, j);
    return reply(res, 200, {});
  }
  if (req.url === '/ready') return reply(res, 200, { ready: true });
  return reply(res, 404, {});
}).listen(Number(process.env.CONTROL_PORT ?? 9000), '0.0.0.0');
