import type { McpTool, ToolResult } from '@openagentix/mcp';

/** Largest `tools/list` answer of the relay (a pinned list is far smaller; this bounds the rest). */
export const RELAY_MAX_LIST_BYTES = 1024 * 1024;

/** Versions an `initialize` answer may echo: dated protocol versions only. */
const PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const FALLBACK_PROTOCOL_VERSION = '2025-03-26';

/**
 * The `initialize` result of the relay. It describes the relay, not the upstream server, and offers
 * `tools` only: no resources, prompts, logging or completion exist on this wire, and the client
 * capabilities a node declares (sampling, elicitation, roots) are ignored, never forwarded.
 */
export function initializeResult(params: Record<string, unknown> | undefined, version: string) {
  const asked = params?.protocolVersion;
  return {
    protocolVersion:
      typeof asked === 'string' && PROTOCOL_VERSION.test(asked) ? asked : FALLBACK_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'openagentix-mcp-relay', version },
  };
}

/** The wire form of a tool definition: exactly the fields a definition pin covers. */
function wireTool(t: McpTool) {
  return {
    name: t.name,
    ...(t.title !== undefined ? { title: t.title } : {}),
    description: t.description ?? '',
    inputSchema: t.inputSchema,
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    ...(t.annotations ? { annotations: t.annotations } : {}),
  };
}

/** `tools/list` result, or `null` when it would exceed the cap. The whole list, no pagination. */
export function toolsListResult(tools: readonly McpTool[]): { tools: unknown[] } | null {
  const result = { tools: tools.map(wireTool) };
  return Buffer.byteLength(JSON.stringify(result)) > RELAY_MAX_LIST_BYTES ? null : result;
}

/**
 * `tools/call` result from the guarded result of the gateway. The text is already cut to
 * `maxResultBytes`; the structured content is a second copy of the data, so it must fit the same
 * limit or it is left out (the text stays).
 */
export function toolCallResult(result: ToolResult, maxResultBytes: number) {
  const structured =
    result.structured !== undefined &&
    Buffer.byteLength(JSON.stringify(result.structured)) <= maxResultBytes
      ? result.structured
      : undefined;
  const note =
    result.structured !== undefined && structured === undefined
      ? '\n[structured content omitted: larger than the result limit]'
      : '';
  return {
    content: [{ type: 'text', text: result.text + note }],
    isError: result.isError,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}
