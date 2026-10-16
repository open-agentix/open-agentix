import { canonicalJson } from '../canonical.js';
import type { AgentSpec } from '../agents/parser.js';
import type { PublishedDefinition } from '../agents/profiles.js';
import type { ToolGrant } from '../agents/schema.js';
import { rejectUnknownKeys, type ExportContext } from './export-context.js';
import type { JsonObject, JsonValue } from './types.js';

/** AWP action identifier `<server>.<tool>` (schema `ActionIdentifier`, no wildcard segment). */
const ACTION_ID = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/;

const KNOWN_GRANT_KEYS: ReadonlySet<string> = new Set([
  'server',
  'tool',
  'args',
  'allowAdditionalArgs',
  'approval',
  'maxCallsPerRun',
  'classification',
]);

export interface ToolExport {
  /** `tools[]` of the AWP inline agent: one MCP source per server with explicit tool names. */
  sources: JsonObject[];
  /** `permissions.tools` of the inline agent. */
  permissionTools: JsonObject;
  /** Action identifiers that need a human approval (collected into `approval.requiredFor`). */
  approvalRequired: string[];
}

/**
 * Tool names a grant stands for. A wildcard is enumerated from the list recorded at publish
 * (decision D4); without such a list the export is refused rather than guessed.
 */
function toolNames(
  ctx: ExportContext,
  def: PublishedDefinition,
  grant: ToolGrant,
  path: string,
): string[] | null {
  if (!grant.tool.includes('*')) return [grant.tool];
  const record = def.wildcardExpansion?.[`${grant.server}/${grant.tool}`];
  if (record && record.tools.length > 0) return record.tools;
  ctx.refuse(
    'wildcard_expansion_missing',
    `${path}.tool`,
    `"${grant.server}/${grant.tool}" cannot be enumerated: no reviewed tool list of the connection ` +
      'was recorded at publish (republish with a reviewed tool snapshot)',
  );
  return null;
}

/** Restrictions of a grant that AWP v1alpha1 has no field for, as extensions on the grant. */
function grantExtensions(ctx: ExportContext, grant: ToolGrant, path: string): JsonObject {
  const ext: JsonObject = {};
  const args = grant.args ?? {};
  if (Object.keys(args).length > 0) ctx.critical(ext, 'args', `${path}.args`, args as JsonValue);
  // Absent means false: a grant without `args` only allows calls without arguments.
  if (grant.allowAdditionalArgs !== true)
    ctx.critical(ext, 'allowAdditionalArgs', `${path}.allowAdditionalArgs`, false);
  if (grant.maxCallsPerRun !== undefined)
    ctx.critical(ext, 'maxCallsPerRun', `${path}.maxCallsPerRun`, grant.maxCallsPerRun);
  if (grant.classification !== undefined)
    ctx.critical(ext, 'classification', `${path}.classification`, grant.classification);
  return ext;
}

/** Profile grants are expanded at publish; a definition that was never expanded cannot be exported. */
function checkProfileGrants(
  ctx: ExportContext,
  def: PublishedDefinition,
  agent: AgentSpec,
  index: number,
): void {
  (agent.profileGrants ?? []).forEach((p, j) => {
    const expanded = def.expansion?.some(
      (r) => r.agentId === agent.id && r.server === p.server && r.profile === p.profile,
    );
    if (!expanded)
      ctx.refuse(
        'profile_expansion_missing',
        `agents.${index}.profileGrants.${j}`,
        `profile "${p.server}:${p.profile}" was not expanded at publish; its tools are unknown`,
      );
  });
}

/** Exports the tool grants of one agent as MCP sources and `permissions.tools` entries. */
export function exportTools(
  ctx: ExportContext,
  def: PublishedDefinition,
  agent: AgentSpec,
  index: number,
): ToolExport {
  checkProfileGrants(ctx, def, agent, index);
  const byServer = new Map<string, string[]>();
  const permissionTools: JsonObject = {};
  const approvalRequired = new Set<string>();
  (agent.tools ?? []).forEach((grant, j) => {
    const path = `agents.${index}.tools.${j}`;
    rejectUnknownKeys(ctx, grant, KNOWN_GRANT_KEYS, path);
    const names = toolNames(ctx, def, grant, path);
    if (!names) return;
    const ext = grantExtensions(ctx, grant, path);
    for (const tool of names) {
      const key = `${grant.server}.${tool}`;
      if (!ACTION_ID.test(key)) {
        ctx.refuse('tool_name_not_representable', path, `"${key}" is not an AWP action identifier`);
        continue;
      }
      const entry: JsonObject = { allow: true, ...ext };
      const known = permissionTools[key];
      if (known !== undefined && canonicalJson(known) !== canonicalJson(entry))
        ctx.refuse(
          'duplicate_grant_conflict',
          path,
          `"${key}" is granted twice with different limits`,
        );
      permissionTools[key] = entry;
      const listed = byServer.get(grant.server) ?? [];
      if (!listed.includes(tool)) byServer.set(grant.server, [...listed, tool]);
      if (grant.approval === 'required') approvalRequired.add(key);
    }
  });
  const sources = [...byServer].map(([server, tools]): JsonObject => ({
    type: 'mcp',
    server,
    tools,
  }));
  return { sources, permissionTools, approvalRequired: [...approvalRequired] };
}
