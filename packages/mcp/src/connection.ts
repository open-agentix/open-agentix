import { OaxError, type SecretResolver } from '@openagentix/core';
import { createProxyAwareFetch } from '@openagentix/providers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from './config.js';

export interface McpTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations (`readOnlyHint`, `destructiveHint`, ...), advisory hints from the server. */
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined;
}

export interface ToolResult {
  /** Text rendering of the MCP content blocks (what the model sees). */
  text: string;
  isError: boolean;
  truncated: boolean;
  bytes: number;
  structured?: unknown;
}

export type InMemoryTransportFactory = (serverName: string) => Promise<Transport> | Transport;

export interface ConnectDeps {
  secrets: SecretResolver;
  /**
   * Resolver for one specific server (by name); wins over `secrets`. Lets a host give platform
   * connections and tenant connections different resolvers.
   */
  secretsFor?: ((server: string) => SecretResolver) | undefined;
  /** Provides transports for `in-memory` servers. */
  inMemory?: InMemoryTransportFactory | undefined;
  /** Environment for proxy resolution (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

export async function createTransport(cfg: McpServerConfig, deps: ConnectDeps): Promise<Transport> {
  switch (cfg.transport) {
    case 'stdio': {
      const env: Record<string, string> = { ...cfg.env };
      for (const [k, ref] of Object.entries(cfg.envSecrets))
        env[k] = await deps.secrets.resolve(ref);
      // Only configured variables reach the server process; the SDK adds a minimal safe set
      // (HOME, PATH, USER, SHELL, TERM, LOGNAME), never the parent's secrets.
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: { PATH: process.env.PATH ?? '', ...env },
        stderr: 'pipe',
      });
    }
    case 'streamable-http': {
      const headers: Record<string, string> = { ...cfg.headers };
      for (const [h, ref] of Object.entries(cfg.headerSecrets))
        headers[h] = await deps.secrets.resolve(ref);
      // Outbound MCP over HTTP honours HTTPS_PROXY/NO_PROXY explicitly.
      return new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers },
        fetch: createProxyAwareFetch({ ...(deps.env ? { env: deps.env } : {}) }),
      });
    }
    case 'in-memory': {
      if (!deps.inMemory)
        throw new OaxError(
          'mcp_unavailable',
          `no in-memory MCP server registered for "${cfg.name}"`,
        );
      return deps.inMemory(cfg.name);
    }
  }
}

/** Renders MCP content blocks into text and enforces the size limit. */
export function renderToolResult(
  raw: { content?: unknown; isError?: unknown; structuredContent?: unknown },
  maxBytes: number,
): ToolResult {
  const parts: string[] = [];
  for (const block of Array.isArray(raw.content)
    ? (raw.content as Record<string, unknown>[])
    : []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (
      block.type === 'resource' &&
      block.resource &&
      typeof (block.resource as { text?: unknown }).text === 'string'
    ) {
      parts.push((block.resource as { text: string }).text);
    } else parts.push(`[${String(block.type)} content omitted]`);
  }
  if (parts.length === 0 && raw.structuredContent !== undefined)
    parts.push(JSON.stringify(raw.structuredContent));
  let text = parts.join('\n');
  const bytes = Buffer.byteLength(text);
  let truncated = false;
  if (bytes > maxBytes) {
    text =
      Buffer.from(text).subarray(0, maxBytes).toString('utf8') +
      `\n[truncated: ${bytes} bytes, limit ${maxBytes}]`;
    truncated = true;
  }
  return {
    text,
    isError: raw.isError === true,
    truncated,
    bytes,
    ...(raw.structuredContent !== undefined ? { structured: raw.structuredContent } : {}),
  };
}

/** One connected MCP server. */
export class McpConnection {
  private tools: McpTool[] | null = null;

  private constructor(
    readonly config: McpServerConfig,
    private readonly client: Client,
  ) {}

  static async connect(config: McpServerConfig, deps: ConnectDeps): Promise<McpConnection> {
    const client = new Client({ name: 'openagentix', version: '0.1.0' }, { capabilities: {} });
    await client.connect(await createTransport(config, deps), { timeout: config.timeoutMs });
    return new McpConnection(config, client);
  }

  async listTools(): Promise<McpTool[]> {
    if (this.tools) return this.tools;
    const out: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : {}, {
        timeout: this.config.timeoutMs,
      });
      for (const t of page.tools)
        out.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
          annotations: t.annotations,
        });
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = out;
    return out;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    try {
      const raw = await this.client.callTool({ name, arguments: args }, undefined, {
        timeout: this.config.timeoutMs,
        ...(signal ? { signal } : {}),
      });
      return renderToolResult(
        raw as { content?: unknown; isError?: unknown; structuredContent?: unknown },
        this.config.maxResultBytes,
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (/timed out|timeout/i.test(msg)) {
        throw new OaxError(
          'tool_timeout',
          `tool ${this.config.name}/${name} timed out after ${this.config.timeoutMs} ms`,
        );
      }
      throw new OaxError('tool_failed', `tool ${this.config.name}/${name} failed: ${msg}`);
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
