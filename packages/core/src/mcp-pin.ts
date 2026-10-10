import { timingSafeEqual } from 'node:crypto';
import { sha256Hex } from './canonical.js';
import { OaxError } from './errors.js';
import { JcsError, jcs } from './jcs.js';

/**
 * Pinning of MCP tool definitions (ADR 0016 section 5, "rug pull" protection).
 *
 * A tool definition comes from a server the platform does not control. What the model sees of it
 * (name, title, description, input and output schema, annotations) is reduced to one canonical
 * form and hashed; a published agent version pins the hash of the tools it is granted, and a run
 * refuses to expose them when the server answers with something else.
 */

/** The model-visible part of one MCP tool (every other field of the wire format is dropped). */
export interface PinnedTool {
  name: string;
  title?: string | null;
  description?: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  annotations?: Record<string, unknown> | null;
}

/** What a published version records per MCP connection (stored in the immutable definition). */
export interface ToolPinRecord {
  /** Digest of the whole approved snapshot the version was published against. */
  snapshotDigest: string;
  /** Digest over the granted tools of that snapshot; compared with the live tools at run time. */
  toolsDigest: string;
  /** The grants of the version on this connection: exact tool names and `prefix*` patterns. */
  granted: string[];
}

/** Bounds of an untrusted tool list (a hostile server must not fill the database or the worker). */
export const MAX_PINNED_TOOLS = 500;
export const MAX_PINNED_TOOL_BYTES = 64 * 1024;
export const MAX_PINNED_SNAPSHOT_BYTES = 1024 * 1024;

export class McpPinError extends OaxError {
  constructor(code: 'mcp_tool_invalid' | 'mcp_tools_too_large', message: string) {
    super(code, message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Shortest checks first; the canonical form itself rejects anything outside the JSON data model. */
export function reduceTool(raw: unknown): PinnedTool {
  if (!isRecord(raw))
    throw new McpPinError('mcp_tool_invalid', 'a tool definition is not an object');
  const { name, title, description, inputSchema, outputSchema, annotations } = raw;
  if (typeof name !== 'string' || name.length === 0 || name.length > 128)
    throw new McpPinError('mcp_tool_invalid', 'a tool has no valid name');
  const optionalText = (v: unknown, field: string): string | null | undefined => {
    if (v === undefined || v === null || typeof v === 'string') return v;
    throw new McpPinError('mcp_tool_invalid', `tool "${name}": ${field} is not a string`);
  };
  const optionalObject = (
    v: unknown,
    field: string,
  ): Record<string, unknown> | null | undefined => {
    if (v === undefined || v === null || isRecord(v)) return v;
    throw new McpPinError('mcp_tool_invalid', `tool "${name}": ${field} is not an object`);
  };
  if (!isRecord(inputSchema))
    throw new McpPinError('mcp_tool_invalid', `tool "${name}": inputSchema is not an object`);
  const t = optionalText(title, 'title');
  const d = optionalText(description, 'description');
  const o = optionalObject(outputSchema, 'outputSchema');
  const a = optionalObject(annotations, 'annotations');
  const out: PinnedTool = { name, inputSchema };
  if (t !== undefined) out.title = t;
  if (d !== undefined) out.description = d;
  if (o !== undefined) out.outputSchema = o;
  if (a !== undefined) out.annotations = a;
  return out;
}

const byName = (a: PinnedTool, b: PinnedTool): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** The canonical form of a (possibly unsorted) list: sorted by name, RFC 8785. */
export function canonicalTools(tools: readonly PinnedTool[]): string {
  const sorted = [...tools].sort(byName);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i]!.name === sorted[i - 1]!.name)
      throw new McpPinError('mcp_tool_invalid', `duplicate tool "${sorted[i]!.name}"`);
  try {
    return jcs(sorted);
  } catch (e) {
    if (e instanceof JcsError) throw new McpPinError('mcp_tool_invalid', e.message);
    throw e;
  }
}

/** SHA-256 (hex) over the RFC 8785 JSON of the tools, sorted by name. */
export function toolsDigest(tools: readonly PinnedTool[]): string {
  return sha256Hex(canonicalTools(tools));
}

/**
 * Reduces and bounds a raw `tools/list` result. Throws `mcp_tool_invalid` or `mcp_tools_too_large`;
 * the message never contains tool text.
 */
export function pinnedToolsOf(raw: readonly unknown[]): PinnedTool[] {
  if (raw.length > MAX_PINNED_TOOLS)
    throw new McpPinError('mcp_tools_too_large', `more than ${MAX_PINNED_TOOLS} tools`);
  const tools = raw.map(reduceTool);
  let total = 0;
  for (const t of tools) {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(jcs(t));
    } catch (e) {
      if (e instanceof JcsError) throw new McpPinError('mcp_tool_invalid', e.message);
      throw e;
    }
    if (bytes > MAX_PINNED_TOOL_BYTES)
      throw new McpPinError('mcp_tools_too_large', 'a tool definition is larger than 64 KiB');
    total += bytes;
  }
  if (total > MAX_PINNED_SNAPSHOT_BYTES)
    throw new McpPinError('mcp_tools_too_large', 'the tool list is larger than 1 MiB');
  return tools.sort(byName);
}

/** `prefix*` matches by prefix, anything else by equality (the grammar of agents.md grants). */
export function toolMatchesGrant(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

export function grantedTools(
  tools: readonly PinnedTool[],
  patterns: readonly string[],
): PinnedTool[] {
  return tools.filter((t) => patterns.some((p) => toolMatchesGrant(p, t.name)));
}

/** Exact tool names of `patterns` (no wildcard) that the list does not offer. */
export function unknownGrants(tools: readonly PinnedTool[], patterns: readonly string[]): string[] {
  const names = new Set(tools.map((t) => t.name));
  return patterns.filter((p) => !p.endsWith('*') && !names.has(p));
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * True when `live` equals any of `expected`. The comparison does not branch on the position of the
 * first differing character and always looks at every candidate, so its duration says nothing
 * about how close a guess was (digests are not secrets, but the shape of the check should not
 * become an oracle for what a connection pinned).
 */
export function digestMatchesAny(live: string, expected: readonly string[]): boolean {
  const l = Buffer.from(HEX64.test(live) ? live : '0'.repeat(64), 'hex');
  let hit = 0;
  for (const e of expected) {
    const ok = HEX64.test(e);
    const b = Buffer.from(ok ? e : '0'.repeat(64), 'hex');
    hit |= timingSafeEqual(l, b) && ok ? 1 : 0;
  }
  return hit === 1 && HEX64.test(live);
}

/** Names of tools that differ between two lists (added, removed or changed); names only. */
export function changedToolNames(
  before: readonly PinnedTool[],
  after: readonly PinnedTool[],
): string[] {
  const a = new Map(before.map((t) => [t.name, canonicalTools([t])]));
  const b = new Map(after.map((t) => [t.name, canonicalTools([t])]));
  const names = new Set<string>();
  for (const [n, c] of a) if (b.get(n) !== c) names.add(n);
  for (const n of b.keys()) if (!a.has(n)) names.add(n);
  return [...names].sort();
}

/** The pin of a version for one connection, computed from the snapshot it is published against. */
export function pinFor(
  snapshot: { digest: string; tools: readonly PinnedTool[] },
  patterns: readonly string[],
): ToolPinRecord {
  const granted = [...new Set(patterns)].sort();
  return {
    snapshotDigest: snapshot.digest,
    toolsDigest: toolsDigest(grantedTools(snapshot.tools, granted)),
    granted,
  };
}
