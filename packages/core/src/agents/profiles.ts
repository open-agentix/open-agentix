import { canonicalJson, sha256Hex } from '../canonical.js';
import type { ValidationIssue } from '../errors.js';
import type { AgentDefinition, AgentSpec } from './parser.js';
import { ToolGrantSchema, type ProfileGrant, type ToolGrant } from './schema.js';

/**
 * Named tool profiles (ADR 0008, section 1.3). A connection classifies its tools as `read` or
 * `write` and groups them into named profiles; an agent grants `{ server, profile }`. The control
 * node expands profile grants into concrete tool grants when a version is published, so a later
 * profile edit never widens a published version.
 */

export const TOOL_ACCESS = ['read', 'write'] as const;
export type ToolAccess = (typeof TOOL_ACCESS)[number];

/** What the control node knows about one MCP connection at publish time. */
export interface ConnectionAccess {
  /** Declared access class per tool; a tool that is not listed counts as `write`. */
  tools: Readonly<Record<string, ToolAccess>>;
  /** Profile name -> tool names (all of them declared in `tools`). */
  profiles: Readonly<Record<string, readonly string[]>>;
  /** Identifies the state of the connection the expansion was made from (e.g. `updatedAt`). */
  version: string;
}

/** `server name -> connection access`; servers that are not in the catalog are unknown. */
export type AccessCatalog = Readonly<Record<string, ConnectionAccess>>;

/** One expanded profile grant, stored in the immutable version. */
export interface ExpansionRecord {
  agentId: string;
  server: string;
  profile: string;
  tools: string[];
  connectionVersion: string;
}

/** The part of a published version that profile expansion adds (stored in `definition`). */
export interface PublishedExpansion {
  expansion: ExpansionRecord[];
  /** Classification of every declared tool of the servers the definition uses (`server/tool`). */
  toolAccess: Record<string, ToolAccess>;
  /** SHA-256 over the expanded grants, the records and the classification. */
  expansionDigest: string;
}

/** A stored definition may carry the expansion next to the parsed agents.md. */
export type PublishedDefinition = AgentDefinition & Partial<PublishedExpansion>;

export interface ExpansionResult {
  definition: PublishedDefinition;
  errors: ValidationIssue[];
}

/** Classifies a tool from MCP annotations when the connection does not declare it. */
export function classifyTool(
  declared: ToolAccess | undefined,
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } | null,
): ToolAccess {
  if (declared) return declared;
  // Annotations are hints from the server, so only a clear read-only claim counts as `read`.
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true
    ? 'read'
    : 'write';
}

export function toolAccessOf(
  access: Readonly<Record<string, ToolAccess>> | undefined,
  server: string,
  tool: string,
): ToolAccess {
  return access?.[`${server}/${tool}`] ?? 'write';
}

function matchesGrant(grantTool: string, tool: string): boolean {
  return grantTool.endsWith('*') ? tool.startsWith(grantTool.slice(0, -1)) : grantTool === tool;
}

function mergeGrant(a: ToolGrant, p: ProfileGrant): ToolGrant {
  return {
    ...a,
    approval: a.approval === 'required' || p.approval === 'required' ? 'required' : 'none',
    ...(a.maxCallsPerRun !== undefined || p.maxCallsPerRun !== undefined
      ? { maxCallsPerRun: Math.min(a.maxCallsPerRun ?? Infinity, p.maxCallsPerRun ?? Infinity) }
      : {}),
  };
}

function expandAgent(
  a: AgentSpec,
  index: number,
  catalog: AccessCatalog,
  records: ExpansionRecord[],
  errors: ValidationIssue[],
): AgentSpec {
  const readOnly = a.access === 'read-only';
  const base = `agents.${index}`;
  const concrete = new Map<string, ToolGrant>(a.tools.map((t) => [`${t.server}/${t.tool}`, t]));
  const expanded = new Map<string, ToolGrant>();

  a.tools.forEach((t, j) => {
    if (!readOnly) return;
    const path = `${base}.tools.${j}`;
    const conn = catalog[t.server];
    if (!conn) {
      errors.push({
        path,
        message: `read-only step "${a.id}": connection "${t.server}" is unknown, its tools cannot be classified`,
      });
      return;
    }
    const candidates = t.tool.endsWith('*')
      ? Object.keys(conn.tools).filter((n) => matchesGrant(t.tool, n))
      : [t.tool];
    for (const tool of candidates)
      if ((conn.tools[tool] ?? 'write') !== 'read')
        errors.push({
          path,
          message: `read-only step "${a.id}" must not receive write tool "${t.server}/${tool}"`,
        });
  });

  (a.profileGrants ?? []).forEach((p, j) => {
    const path = `${base}.tools (profile ${j + 1})`;
    const conn = catalog[p.server];
    if (!conn) {
      errors.push({ path, message: `connection "${p.server}" is unknown` });
      return;
    }
    const members = Object.hasOwn(conn.profiles, p.profile) ? conn.profiles[p.profile] : undefined;
    if (!members) {
      errors.push({ path, message: `connection "${p.server}" has no profile "${p.profile}"` });
      return;
    }
    const tools = [...members];
    if (readOnly)
      for (const tool of tools)
        if ((conn.tools[tool] ?? 'write') !== 'read')
          errors.push({
            path,
            message: `read-only step "${a.id}" must not receive write tool "${p.server}/${tool}" (profile "${p.server}:${p.profile}")`,
          });
    records.push({
      agentId: a.id,
      server: p.server,
      profile: p.profile,
      tools,
      connectionVersion: conn.version,
    });
    for (const tool of tools) {
      const key = `${p.server}/${tool}`;
      if (concrete.has(key)) continue; // a concrete grant wins (it may carry constraints)
      const prev = expanded.get(key);
      expanded.set(
        key,
        prev
          ? mergeGrant(prev, p)
          : ToolGrantSchema.parse({
              server: p.server,
              tool,
              allowAdditionalArgs: true,
              approval: p.approval,
              ...(p.maxCallsPerRun !== undefined ? { maxCallsPerRun: p.maxCallsPerRun } : {}),
              ...(p.classification ? { classification: p.classification } : {}),
            }),
      );
    }
  });
  return { ...a, tools: [...a.tools, ...expanded.values()] };
}

/**
 * Expands profile grants into concrete grants and enforces `access: read-only`. Pure: the caller
 * passes the connection catalog. Returns every error (unknown connection/profile, write tool for a
 * read-only step); the definition is only usable when `errors` is empty.
 */
export function expandProfiles(def: AgentDefinition, catalog: AccessCatalog): ExpansionResult {
  const errors: ValidationIssue[] = [];
  const expansion: ExpansionRecord[] = [];
  const agents = def.agents.map((a, i) => expandAgent(a, i, catalog, expansion, errors));
  const servers = new Set(
    def.agents.flatMap((a) => [
      ...a.tools.map((t) => t.server),
      ...(a.profileGrants ?? []).map((p) => p.server),
    ]),
  );
  const toolAccess: Record<string, ToolAccess> = {};
  for (const server of [...servers].sort()) {
    const conn = catalog[server];
    if (conn)
      for (const [tool, access] of Object.entries(conn.tools))
        toolAccess[`${server}/${tool}`] = access;
  }
  const expansionDigest = sha256Hex(
    canonicalJson({
      expansion,
      toolAccess,
      grants: agents.map((a) => ({ id: a.id, access: a.access ?? null, tools: a.tools })),
    }),
  );
  return {
    definition: { ...def, agents, expansion, toolAccess, expansionDigest },
    errors,
  };
}
