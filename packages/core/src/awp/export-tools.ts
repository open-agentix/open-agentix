import { canonicalJson } from '../canonical.js';
import { toolMatchesGrant } from '../mcp-pin.js';
import { argConstraintIssues } from '../agents/arg-rules.js';
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
  // Re-filtered: a record that lists a tool the pattern does not match is never trusted.
  const listed = def.wildcardExpansion?.[`${grant.server}/${grant.tool}`]?.tools ?? [];
  const tools = listed.filter((n) => toolMatchesGrant(grant.tool, n));
  if (tools.length > 0) return tools;
  ctx.refuse(
    'wildcard_expansion_missing',
    `${path}.tool`,
    `"${grant.server}/${grant.tool}" cannot be enumerated: no approved tool snapshot of a pinned ` +
      'connection was recorded at publish (republish with an approved snapshot)',
  );
  return null;
}

/**
 * Restrictions of a grant (argument constraints, call limit, data class) on its permission entry.
 *
 * - Constraints that break a static rule of AEP-0002 (a pattern without `maxLength`, a lookaround,
 *   a backreference, a repeated repetition, a bound that does not fit the type) are refused: the
 *   validator would reject the manifest, and a pattern is never rewritten or dropped.
 * - With the pinned schema as it is, they are the critical extensions `x-openagentix-args`,
 *   `x-openagentix-allowAdditionalArgs` and `x-openagentix-maxCallsPerRun`. Once the pin has AEP-0002
 *   (`PINNED_AWP_FEATURES.toolArgs`) the core fields `args`, `allowAdditionalArgs` and `maxCalls`
 *   are written instead. `args` is written for a grant that allows no additional argument even when
 *   it is empty: AEP-0002 ignores `allowAdditionalArgs` without `args`, so `args: {}` is how "no
 *   arguments at all" survives the export.
 * - The values never widen: an absent `allowAdditionalArgs` is `false` in `agents.md` and is written
 *   as `false`; a grant that allows more (`true`) with constraints writes `true` explicitly, so a
 *   reader does not have to know the default of the format.
 */
function grantExtensions(ctx: ExportContext, grant: ToolGrant, path: string): JsonObject {
  const ext: JsonObject = {};
  const args = grant.args ?? {};
  const names = Object.keys(args);
  const open = grant.allowAdditionalArgs === true;
  for (const name of names)
    for (const issue of argConstraintIssues(args[name]!))
      ctx.refuse(
        'constraint_not_representable',
        issue.field === '' ? `${path}.args.${name}` : `${path}.args.${name}.${issue.field}`,
        `${issue.code}: ${issue.message}`,
      );
  if (ctx.toolArgs) {
    if (names.length > 0 || !open) ext.args = args as JsonValue;
    if (open && names.length > 0) ext.allowAdditionalArgs = true;
    if (grant.maxCallsPerRun !== undefined) ext.maxCalls = grant.maxCallsPerRun;
  } else {
    if (names.length > 0) ctx.critical(ext, 'args', `${path}.args`, args as JsonValue);
    // Absent means false: a grant without `args` only allows calls without arguments.
    if (!open) ctx.critical(ext, 'allowAdditionalArgs', `${path}.allowAdditionalArgs`, false);
    else if (names.length > 0)
      ctx.critical(ext, 'allowAdditionalArgs', `${path}.allowAdditionalArgs`, true);
    if (grant.maxCallsPerRun !== undefined)
      ctx.critical(ext, 'maxCallsPerRun', `${path}.maxCallsPerRun`, grant.maxCallsPerRun);
  }
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
  const approvalOf = new Map<string, boolean>();
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
      const needsApproval = grant.approval === 'required';
      // At run time the exact grant wins over a wildcard, so overlapping grants that differ in
      // limits or approval cannot be merged into one claim.
      if (
        known !== undefined &&
        (canonicalJson(known) !== canonicalJson(entry) || approvalOf.get(key) !== needsApproval)
      )
        ctx.refuse(
          'duplicate_grant_conflict',
          path,
          `"${key}" is granted twice with different limits or approval`,
        );
      permissionTools[key] = entry;
      approvalOf.set(key, needsApproval);
      const listed = byServer.get(grant.server) ?? [];
      if (!listed.includes(tool)) byServer.set(grant.server, [...listed, tool]);
    }
  });
  const sources = [...byServer].map(([server, tools]): JsonObject => ({
    type: 'mcp',
    server,
    tools,
  }));
  return {
    sources,
    permissionTools,
    approvalRequired: [...approvalOf].filter(([, v]) => v).map(([k]) => k),
  };
}
