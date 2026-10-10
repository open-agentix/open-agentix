import { OaxError, type SecretResolver } from '@openagentix/core';
import {
  sharedOutboundDispatcher,
  type HostLookup,
  type OutboundDispatcher,
} from '@openagentix/providers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from './config.js';
import { assertHttpConfig } from './http-policy.js';
import {
  MCP_PROTOCOL_VERSIONS,
  type McpPropagationPolicy,
  type McpTraceMeta,
} from './trace-context.js';

export interface McpTool {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  /**
   * MCP tool annotations (`readOnlyHint`, `destructiveHint`, `title`, ...), advisory hints from the
   * server. All of them are model-visible and part of the pinned definition (ADR 0016 section 5).
   */
  annotations?:
    ({ readOnlyHint?: unknown; destructiveHint?: unknown } & Record<string, unknown>) | undefined;
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
  /**
   * Called with the config of every stdio server right before its process would be started; it
   * throws to refuse (ADR 0016 S0). The worker uses it to keep tenant-defined commands out of the
   * trusted process, run nodes to apply the command rules to the binaries of their image.
   */
  stdioGuard?: ((cfg: Extract<McpServerConfig, { transport: 'stdio' }>) => void) | undefined;
  /**
   * The outbound dispatcher every HTTP MCP request goes through (ADR 0011, purpose `mcp`). Default:
   * the process-wide dispatcher for `env` (legacy proxy variables, no network configuration), so
   * hosts with a network configuration or an air-gapped egress policy pass their own.
   */
  outbound?: OutboundDispatcher | undefined;
  /**
   * Who defined the server of that name. HTTP servers of a tenant, team or agent connection get the
   * tenant destination rules (TLS only, no private, local or metadata addresses, pinned DNS);
   * only `platform` connections are operator configuration. Unknown means tenant (fail closed).
   */
  originFor?: ((server: string) => 'platform' | 'tenant') | undefined;
  /** See `OutboundContext.proxyChecksDestination`: run nodes behind the control node's proxy. */
  proxyChecksDestination?: boolean | undefined;
  /**
   * Platform switch for MCP trace context propagation (`OAX_OTEL_MCP_PROPAGATION`, ADR 0015 S8).
   * Anything but `allow` (including absent) sends nothing, whatever a connection says.
   */
  tracePropagation?: McpPropagationPolicy | undefined;
  /** Name resolution for the connect-time destination check (tests inject a fake resolver). */
  lookup?: HostLookup | undefined;
}

type HttpConfig = Extract<McpServerConfig, { transport: 'streamable-http' }>;

/**
 * The `fetch` of one HTTP MCP connection. Every request of the SDK transport (POST, the SSE GET
 * stream, session DELETE) passes here and leaves through the outbound dispatcher with purpose
 * `mcp`: route and destination rules, pinned DNS for tenant servers, no redirects, size limit.
 * The request URL must be the connection URL's origin; the SDK never needs another one for the
 * streamable-HTTP transport, so anything else is a bug or an attack (`mcp_egress_denied`).
 */
export function createMcpFetch(
  cfg: HttpConfig,
  deps: Pick<ConnectDeps, 'outbound' | 'originFor' | 'env' | 'proxyChecksDestination' | 'lookup'>,
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const allowed = new URL(cfg.url).origin;
  const origin = deps.originFor?.(cfg.name) ?? 'tenant';
  const outbound = deps.outbound ?? sharedOutboundDispatcher(deps.env ?? process.env);
  return async (input, init) => {
    let target: URL;
    try {
      target = new URL(typeof input === 'string' || input instanceof URL ? input : String(input));
    } catch {
      throw new OaxError('mcp_egress_denied', `MCP server "${cfg.name}": invalid request URL`);
    }
    if (target.origin !== allowed || target.username || target.password)
      throw new OaxError(
        'mcp_egress_denied',
        `MCP server "${cfg.name}": requests are limited to the origin of the connection url`,
      );
    return outbound.fetch(target, init, {
      purpose: 'mcp',
      scope: { origin },
      ...(deps.proxyChecksDestination ? { proxyChecksDestination: true } : {}),
      ...(deps.lookup ? { pin: { lookup: deps.lookup } } : {}),
    });
  };
}

export async function createTransport(cfg: McpServerConfig, deps: ConnectDeps): Promise<Transport> {
  switch (cfg.transport) {
    case 'stdio': {
      deps.stdioGuard?.(cfg);
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
      // Stored connections that predate the rules fail closed here instead of being repaired.
      assertHttpConfig(cfg.name, cfg);
      const headers: Record<string, string> = { ...cfg.headers };
      for (const [h, ref] of Object.entries(cfg.headerSecrets)) {
        const value = await deps.secrets.resolve(ref);
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value))
          throw new OaxError(
            'mcp_header_forbidden',
            `MCP connection "${cfg.name}": the secret of header "${h.toLowerCase()}" is not a valid header value`,
          );
        headers[h] = value;
      }
      return new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers },
        fetch: createMcpFetch(cfg, deps),
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

const MAX_TOOL_PAGES = 50;

/** One connected MCP server. */
export class McpConnection {
  private tools: McpTool[] | null = null;

  private constructor(
    readonly config: McpServerConfig,
    private readonly client: Client,
  ) {}

  static async connect(config: McpServerConfig, deps: ConnectDeps): Promise<McpConnection> {
    const client = new Client(
      { name: 'openagentix', version: '0.2.0-alpha.1' },
      { capabilities: {} },
    );
    await client.connect(await createTransport(config, deps), { timeout: config.timeoutMs });
    return new McpConnection(config, client);
  }

  async listTools(): Promise<McpTool[]> {
    if (this.tools) return this.tools;
    const out: McpTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      // A server that never stops returning cursors must not pin the run (or a connection test).
      if (++pages > MAX_TOOL_PAGES)
        throw new OaxError('tool_failed', `MCP server "${this.config.name}" lists too many pages`);
      const page = await this.client.listTools(cursor ? { cursor } : {}, {
        timeout: this.config.timeoutMs,
      });
      for (const t of page.tools)
        out.push({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
          outputSchema: t.outputSchema as Record<string, unknown> | undefined,
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
    meta?: McpTraceMeta,
  ): Promise<ToolResult> {
    try {
      // `_meta` is rebuilt from the one validated field, so nothing else a caller put on `meta`
      // (a `tracestate`, `baggage`, any other key) can reach the wire.
      const raw = await this.client.callTool(
        {
          name,
          arguments: args,
          ...(meta ? { _meta: { traceparent: meta.traceparent } } : {}),
        },
        undefined,
        {
          timeout: this.config.timeoutMs,
          ...(signal ? { signal } : {}),
        },
      );
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

  /**
   * The negotiated protocol version when it is one of the known ones (closed set for the span
   * attribute `mcp.protocol.version`); `undefined` otherwise. Stdio transports do not report it.
   */
  get protocolVersion(): string | undefined {
    const v = (this.client.transport as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    return typeof v === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(v)
      ? v
      : undefined;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
