import { OaxError, type EgressPolicy } from '@openagentix/core';
import { matchesStdioAllowlist, stdioProgramOf, type McpServerConfig } from '@openagentix/mcp';
import {
  assertWithinCeiling,
  parseEgressEntries,
  parseEgressEntry,
  type EgressRule,
} from '@openagentix/runners';

/**
 * Per-connection egress of stdio MCP servers (ADR 0016 section 4.1, slice S2).
 *
 * Three bounds apply to what a connection may list, from the inside out:
 *  1. the operator's PER-PROGRAM GRANT (`OAX_MCP_STDIO_EGRESS`): for connections that a tenant
 *     defined, the entries must lie inside the grant of the program the connection runs; a program
 *     without a grant gets no network at all (deny by default). A tenant can only narrow;
 *  2. the runner's ceiling (`OAX_CONTAINER_EGRESS_ALLOW`), applied by the container runner and
 *     again by the egress proxy;
 *  3. the air-gapped allowlist (every scope).
 * A private range stays closed even when named: the proxy refuses private, loopback and metadata
 * addresses unless the operator opened that range (`OAX_CONTAINER_EGRESS_PRIVATE_ALLOW`).
 */

export type StdioEgressGrants = ReadonlyMap<string, readonly string[]>;

export interface StdioEgressIssue {
  /** `mcp_egress_invalid` is a malformed entry (400), `egress_denied` a refused one (422). */
  code: 'mcp_egress_invalid' | 'egress_denied';
  path: string;
  message: string;
}

export interface StdioEgressContext {
  grants: StdioEgressGrants;
  /** Present in air-gapped mode only. */
  airgap?: EgressPolicy | undefined;
}

type StdioConfig = Extract<McpServerConfig, { transport: 'stdio' }>;

/** `{"/opt/mcp/bin/jira-mcp": ["*.atlassian.net"]}` -> grants. Strict: a typo fails start-up. */
export function parseStdioEgressGrants(
  raw: string | undefined,
  allowlist: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!raw?.trim()) return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new OaxError('config_invalid', 'OAX_MCP_STDIO_EGRESS must be a JSON object');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new OaxError('config_invalid', 'OAX_MCP_STDIO_EGRESS must be a JSON object');
  for (const [program, entries] of Object.entries(data)) {
    if (!program.startsWith('/') || program.length > 1024 || /[\s\0]/.test(program))
      throw new OaxError(
        'config_invalid',
        `OAX_MCP_STDIO_EGRESS: "${program}" is not an absolute program path`,
      );
    if (!matchesStdioAllowlist(program, allowlist))
      throw new OaxError(
        'config_invalid',
        `OAX_MCP_STDIO_EGRESS: "${program}" is not in OAX_MCP_STDIO_COMMANDS (a grant for a program that cannot run is a mistake)`,
      );
    if (
      !Array.isArray(entries) ||
      entries.length === 0 ||
      entries.length > 64 ||
      !entries.every((e): e is string => typeof e === 'string')
    )
      throw new OaxError(
        'config_invalid',
        `OAX_MCP_STDIO_EGRESS: the grant of "${program}" must be a non-empty list of egress entries`,
      );
    try {
      parseEgressEntries(entries);
    } catch (e) {
      throw new OaxError(
        'config_invalid',
        `OAX_MCP_STDIO_EGRESS: "${program}": ${(e as Error).message}`,
      );
    }
    out.set(
      program,
      entries.map((e) => e.trim().toLowerCase()),
    );
  }
  return out;
}

/** Issues of a stdio connection's `egress` (`[]` = fine). Pure: no DNS, no file system. */
export function stdioEgressIssues(
  cfg: StdioConfig,
  tenant: boolean,
  ctx: StdioEgressContext,
): StdioEgressIssue[] {
  const list = cfg.egress ?? [];
  const out: StdioEgressIssue[] = [];
  if (list.length === 0) return out;
  const rules: (EgressRule | null)[] = list.map((raw, i) => {
    try {
      return parseEgressEntry(raw);
    } catch (e) {
      out.push({ code: 'mcp_egress_invalid', path: `egress.${i}`, message: (e as Error).message });
      return null;
    }
  });
  if (out.length > 0) return out;
  const grant = tenant ? (ctx.grants.get(stdioProgramOf(cfg)) ?? []) : null;
  const grantRules = grant ? parseEgressEntries([...grant]) : [];
  list.forEach((raw, i) => {
    const path = `egress.${i}`;
    const rule = rules[i]!;
    if (tenant) {
      try {
        assertWithinCeiling([raw], grantRules);
      } catch {
        return void out.push({
          code: 'egress_denied',
          path,
          message:
            grantRules.length === 0
              ? `the operator granted no network to this program (OAX_MCP_STDIO_EGRESS), so "${raw}" is refused`
              : `"${raw}" is outside the operator's egress grant for this program (OAX_MCP_STDIO_EGRESS)`,
        });
      }
    }
    if (ctx.airgap?.airgapped) {
      // Only plain hosts can be judged against the allowlist; a wildcard or a CIDR cannot, so it
      // is refused (fail closed) instead of being matched loosely.
      if (rule.kind === 'suffix' || rule.kind === 'cidr')
        return void out.push({
          code: 'egress_denied',
          path,
          message: `"${raw}": wildcard and CIDR egress entries are not accepted in air-gapped mode (list the hosts)`,
        });
      if (!ctx.airgap.isAllowed(rule.host, rule.port ?? 443))
        return void out.push({
          code: 'egress_denied',
          path,
          message: `"${raw}" is not on OAX_AIRGAPPED_ALLOW`,
        });
    }
  });
  return out;
}

/** The egress a stdio server really gets: its own list, nothing inherited (empty = no network). */
export function effectiveStdioEgress(cfg: StdioConfig): string[] {
  return [...new Set((cfg.egress ?? []).map((e) => e.trim().toLowerCase()))];
}

const canonicalEntry = (e: string): string => e.trim().toLowerCase().replace(/:443$/, '');

/**
 * Agent Check lint `egress_unused` (ADR 0016 section 9): a host in a step's `runtime.egress` that
 * only serves a stdio MCP server, which now has its own grant from the `egress` of its connection.
 * The step's account no longer reaches the server, so the entry opens the node's own network for
 * nothing. HTTP servers are not reported: until the relay of S4 the node still reaches them with
 * the step's account, so their host is still used. Only steps on the container runner are checked:
 * the Kubernetes runner requires a server's entries to stay in the step's `runtime.egress` (one
 * NetworkPolicy per Pod), and in-process steps have no per-server grants at all. Advisory only.
 */
export function egressUnusedWarnings(
  def: {
    runtime: { runner?: string | undefined; egress: readonly string[] };
    agents: readonly {
      id: string;
      runtime?: { runner?: string | undefined; egress?: readonly string[] | undefined } | undefined;
      tools: readonly { server: string }[];
      profileGrants?: readonly { server: string }[] | undefined;
    }[];
  },
  configs: readonly McpServerConfig[],
): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const byName = new Map(configs.map((c) => [c.name, c]));
  def.agents.forEach((a, i) => {
    if ((a.runtime?.runner ?? def.runtime.runner ?? 'in-process') !== 'container') return;
    const entries = a.runtime?.egress ?? def.runtime.egress;
    if (entries.length === 0) return;
    const servers = new Set([
      ...a.tools.map((t) => t.server),
      ...(a.profileGrants ?? []).map((p) => p.server),
    ]);
    const used = [...servers].flatMap((s) => {
      const c = byName.get(s);
      return c ? [c] : [];
    });
    const httpHosts = new Set<string>();
    for (const c of used)
      if (c.transport === 'streamable-http')
        try {
          httpHosts.add(canonicalEntry(new URL(c.url).host));
        } catch {
          // an invalid url is reported elsewhere
        }
    entries.forEach((raw, j) => {
      const entry = canonicalEntry(raw);
      if (httpHosts.has(entry)) return;
      const owners = used
        .filter(
          (c) =>
            c.transport === 'stdio' && (c.egress ?? []).some((e) => canonicalEntry(e) === entry),
        )
        .map((c) => c.name);
      if (owners.length > 0)
        out.push({
          path: `agents.${i}.runtime.egress.${j}`,
          message: `egress_unused: "${raw}" in runtime.egress of step "${a.id}" only serves MCP server ${owners.map((n) => `"${n}"`).join(', ')}, which gets its own egress grant from its connection; the step's account no longer reaches it, so the entry can be removed`,
        });
    });
  });
  return out;
}
