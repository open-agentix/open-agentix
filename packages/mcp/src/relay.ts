import { OaxError } from '@openagentix/core';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpServerConfig } from './config.js';

type HttpConfig = Extract<McpServerConfig, { transport: 'streamable-http' }>;

/**
 * The control-node MCP relay protocol (ADR 0016 section 6), shared by both ends.
 *
 * A run node never connects to an HTTP MCP server. Its MCP client talks to a {@link RelayTransport}
 * that posts every JSON-RPC message to `POST /v1/worker/runs/{id}/mcp/{server}` with the step's run
 * token; the control node answers from its own connection to the server (credentials resolved
 * there, gate decision, tool pin and egress checks applied there). Only the methods below exist on
 * the wire: this is a relay for one protocol, not an HTTP proxy.
 */

/**
 * The host of the connection url the run node sees. The real url (it may carry a token in its
 * query string) stays on the control node; the node never needs it.
 */
export const RELAY_PLACEHOLDER_URL = 'https://mcp-relay.invalid/';

/**
 * What a run node is told about an HTTP connection: the shape of the stored configuration, without
 * the url (a token may sit in its query string), headers, secret references and egress list. The
 * node reaches the server through the relay and needs none of them.
 */
export function relayConfigFor(cfg: HttpConfig): HttpConfig {
  const { egress: _egress, ...rest } = cfg;
  return { ...rest, url: RELAY_PLACEHOLDER_URL, headers: {}, headerSecrets: {} };
}

/** JSON-RPC methods the relay answers. Anything else is refused. */
export const RELAY_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'notifications/cancelled',
  'ping',
  'tools/list',
  'tools/call',
]);

/**
 * Methods of the client features the relay does not carry (sampling, elicitation, roots): a server
 * that needs them fails the call with `mcp_capability_unsupported`. Closed list for the refusal text.
 */
export const RELAY_UNSUPPORTED_CLIENT_METHODS: ReadonlySet<string> = new Set([
  'sampling/createMessage',
  'elicitation/create',
  'roots/list',
]);

/** JSON-RPC error codes the relay answers with. */
export const RELAY_RPC = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Implementation defined: a refusal or a failure that carries an `oaxCode`. */
  refused: -32001,
  failed: -32000,
} as const;

/** One JSON-RPC message on the relay wire; strict, so a node cannot smuggle further fields. */
export const RelayMessageSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().min(1).max(128), z.number().int()]).optional(),
  method: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type RelayMessage = z.infer<typeof RelayMessageSchema>;

/** Closed set for the metric label of a relayed method. */
export type RelayMethodClass = 'initialize' | 'tools_list' | 'tools_call' | 'other';

export function relayMethodClass(method: string): RelayMethodClass {
  if (method === 'initialize') return 'initialize';
  if (method === 'tools/list') return 'tools_list';
  if (method === 'tools/call') return 'tools_call';
  return 'other';
}

/** A JSON-RPC error response; `oaxCode` lets the node raise the platform's error code again. */
export function relayError(
  id: string | number | null,
  code: number,
  message: string,
  oaxCode?: string,
): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id: id ?? 0,
    error: { code, message, ...(oaxCode ? { data: { oaxCode } } : {}) },
  } as JSONRPCMessage;
}

/** Error codes a node may re-raise from a relay answer (anything else becomes `tool_failed`). */
const OAX_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** The platform error code carried by a relay error, or `undefined`. */
export function oaxCodeOf(error: unknown): string | undefined {
  const data = (error as { data?: { oaxCode?: unknown } } | null | undefined)?.data;
  return typeof data?.oaxCode === 'string' && OAX_CODE.test(data.oaxCode)
    ? data.oaxCode
    : undefined;
}

/**
 * Posts one message of the node's MCP client to the control node. Resolves with the JSON-RPC
 * answer, or `undefined` for a notification. Rejects with the platform error of a refusal.
 */
export type RelayPost = (
  server: string,
  message: JSONRPCMessage,
  signal?: AbortSignal,
) => Promise<JSONRPCMessage | undefined>;

const isRequest = (m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number } =>
  'method' in m && 'id' in m;

/**
 * The MCP client transport of a run node for an HTTP server: no socket, no header, no credential.
 * Every request is one POST to the relay; a failed POST becomes a JSON-RPC error answer so the
 * client rejects that one request and keeps working for the others.
 */
export class RelayTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private closed = false;
  private readonly abort = new AbortController();

  constructor(
    private readonly server: string,
    private readonly post: RelayPost,
    /** Hard stop of one POST; the client's own request timeout normally fires first. */
    private readonly timeoutMs: number,
  ) {}

  async start(): Promise<void> {
    // Nothing to open: the first message creates the session on the control node.
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new OaxError('mcp_relay_closed', 'the MCP relay transport is closed');
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const reply = await this.post(this.server, message, signal);
      if (isRequest(message) && reply) this.onmessage?.(reply);
    } catch (e) {
      const code = e instanceof OaxError ? e.code : undefined;
      const text = e instanceof Error ? e.message : String(e);
      if (isRequest(message))
        this.onmessage?.(
          relayError(
            message.id,
            RELAY_RPC.failed,
            text.slice(0, 500),
            code && OAX_CODE.test(code) ? code : 'mcp_relay_failed',
          ),
        );
      else this.onerror?.(e instanceof Error ? e : new Error(text));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.onclose?.();
  }
}
