import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface FakeRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface FakeServer {
  url: string;
  requests: FakeRequest[];
  /** Number of sockets that were closed by the peer or by us. */
  closedSockets: () => number;
  openSockets: () => number;
  /** Resolves once every response object was closed before it finished (client went away). */
  abortedResponses: () => number;
  close(): Promise<void>;
}

export type Handler = (req: FakeRequest, res: ServerResponse, n: number) => void | Promise<void>;

export async function startServer(handler: Handler): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const sockets = new Set<Socket>();
  let closed = 0;
  let aborted = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const fr: FakeRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(fr);
      res.on('close', () => {
        if (!res.writableFinished) aborted++;
      });
      res.on('error', () => undefined);
      void handler(fr, res, requests.length);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('error', () => undefined);
    s.on('close', () => {
      sockets.delete(s);
      closed++;
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    closedSockets: () => closed,
    openSockets: () => sockets.size,
    abortedResponses: () => aborted,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export const sseHead = (res: ServerResponse, status = 200) =>
  res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

export const frame = (event: string | undefined, data: unknown) =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

export async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// Anthropic fixtures --------------------------------------------------------------------------
export const anthropicText = (
  usageStart: Record<string, unknown> = { input_tokens: 25, output_tokens: 1 },
  usageEnd: Record<string, unknown> | null = { output_tokens: 15 },
): string =>
  frame('message_start', {
    type: 'message_start',
    message: { id: 'm1', role: 'assistant', usage: usageStart },
  }) +
  frame('ping', { type: 'ping' }) +
  frame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }) +
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello ' },
  }) +
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'wörld' },
  }) +
  frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    ...(usageEnd ? { usage: usageEnd } : {}),
  }) +
  frame('message_stop', { type: 'message_stop' });

// OpenAI fixtures -----------------------------------------------------------------------------
export const openaiChunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  frame(undefined, {
    id: 'c1',
    object: 'chat.completion.chunk',
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
export const openaiUsage = (usage: Record<string, unknown>) =>
  frame(undefined, { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [], usage });
export const DONE = 'data: [DONE]\n\n';
