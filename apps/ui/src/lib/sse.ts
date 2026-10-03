import { ApiError, apiBase, authHeaders } from '../api/client';

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** Parses complete SSE blocks from a buffer; returns the messages and the unparsed rest. */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  const messages: SseMessage[] = [];
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    if (data.length)
      messages.push(
        id === undefined ? { event, data: data.join('\n') } : { event, data: data.join('\n'), id },
      );
  }
  return { messages, rest };
}

/**
 * Reads a Server-Sent-Events stream with fetch, so the bearer token can be sent as a header
 * (EventSource cannot set headers). Resolves when the stream ends.
 */
export async function streamSse(
  path: string,
  onMessage: (message: SseMessage) => void,
  { signal, lastEventId }: { signal: AbortSignal; lastEventId?: string | undefined },
): Promise<void> {
  const headers: Record<string, string> = { accept: 'text/event-stream', ...authHeaders() };
  if (lastEventId) headers['last-event-id'] = lastEventId;
  const response = await fetch(apiBase() + path, { headers, signal });
  if (!response.ok || !response.body) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      /* no JSON body */
    }
    const err = body as { error?: string; message?: string } | null;
    throw new ApiError(
      response.status,
      err?.error ?? 'error',
      err?.message ?? `HTTP ${response.status}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { messages, rest } = parseSse(buffer);
    buffer = rest;
    for (const m of messages) onMessage(m);
  }
  const { messages } = parseSse(buffer + '\n\n');
  for (const m of messages) onMessage(m);
}
