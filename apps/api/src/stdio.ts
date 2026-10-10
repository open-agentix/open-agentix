import type { AgentDefinition } from '@openagentix/core';
import {
  McpServerConfigSchema,
  STDIO_INLINE_RUNNERS,
  checkStdioConfig,
  isTenantScope,
  type StdioIssue,
} from '@openagentix/mcp';

/** A stored connection as far as the stdio rules are concerned. */
export interface StoredConnection {
  id?: string;
  tenantId?: string;
  scope: string;
  name: string;
  kind: string;
  config: unknown;
}

/**
 * Issues of a tenant-defined stdio MCP connection (ADR 0016 S0): the command, argument and
 * environment rules. Empty for platform connections (operator configuration), for other
 * transports and for non-MCP connections. The control node never looks at its own file system
 * here: it does not hold the toolbox binaries, and resolving tenant-chosen paths would tell a
 * tenant which files exist on the api host and where its symlinks point. Run nodes repeat the
 * check against their image with the real path required.
 */
export function stdioIssuesOf(
  c: Pick<StoredConnection, 'scope' | 'kind' | 'config'>,
  allowlist: readonly string[],
): StdioIssue[] {
  if (c.kind !== 'mcp' || !isTenantScope(c.scope)) return [];
  const parsed = McpServerConfigSchema.safeParse(c.config);
  if (!parsed.success || parsed.data.transport !== 'stdio') return [];
  return checkStdioConfig(parsed.data, { allowlist, realpath: 'skip' });
}

/** Stored tenant stdio connections that break the rules, with their issues. */
export function findStdioViolations<T extends StoredConnection>(
  rows: readonly T[],
  allowlist: readonly string[],
): { connection: T; issues: StdioIssue[] }[] {
  return rows
    .map((connection) => ({ connection, issues: stdioIssuesOf(connection, allowlist) }))
    .filter((v) => v.issues.length > 0);
}

/** Servers a step holds grants on (tool grants and profile grants). */
export function serversOfStep(agent: AgentDefinition['agents'][number]): Set<string> {
  return new Set([
    ...agent.tools.map((t) => t.server),
    ...(agent.profileGrants ?? []).map((p) => p.server),
  ]);
}

/**
 * Steps of a definition that run in the orchestrating (trusted) process but hold a grant on a
 * tenant-defined stdio connection (ADR 0016 section 3.1: `mcp_stdio_requires_isolation`).
 */
export function inlineStdioSteps(
  def: AgentDefinition,
  tenantStdio: ReadonlySet<string>,
): { path: string; step: string; runner: string; server: string }[] {
  const out: { path: string; step: string; runner: string; server: string }[] = [];
  def.agents.forEach((a, i) => {
    const runner = a.runtime?.runner ?? def.runtime.runner;
    if (!STDIO_INLINE_RUNNERS.includes(runner)) return;
    for (const server of [...serversOfStep(a)].sort())
      if (tenantStdio.has(server))
        out.push({ path: `agents.${i}.runtime.runner`, step: a.id, runner, server });
  });
  return out;
}

export const stdioIsolationMessage = (v: { step: string; runner: string; server: string }) =>
  `step "${v.step}" runs in the worker process (runner "${v.runner}") but holds a grant on stdio connection "${v.server}", which a tenant defined; tenant stdio servers run only in run nodes (set runtime.runner to "container" or "kubernetes-job")`;
