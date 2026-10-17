import type { PublishedDefinition } from '../agents/profiles.js';
import { toolMatchesGrant } from '../mcp-pin.js';
import { awpSecretName } from './export-agent.js';
import type { ExportFinding, JsonObject, JsonValue } from './types.js';

type Obj = { readonly [key: string]: JsonValue };

const obj = (v: JsonValue | undefined): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: JsonValue | undefined): readonly JsonValue[] => (Array.isArray(v) ? v : []);

function finding(path: string, message: string): ExportFinding {
  return { code: 'grant_widened', path, message };
}

/** What one stored agent may call: explicit tools, plus the recorded expansion of wildcard grants. */
function allowedTools(
  def: PublishedDefinition,
  agent: PublishedDefinition['agents'][number],
): { allowed: Set<string>; approval: Set<string> } {
  const allowed = new Set<string>();
  const approval = new Set<string>();
  for (const grant of agent.tools ?? []) {
    const names = grant.tool.includes('*')
      ? (def.wildcardExpansion?.[`${grant.server}/${grant.tool}`]?.tools ?? []).filter((n) =>
          toolMatchesGrant(grant.tool, n),
        )
      : [grant.tool];
    for (const name of names) {
      const key = `${grant.server}.${name}`;
      allowed.add(key);
      if (grant.approval === 'required') approval.add(key);
    }
  }
  return { allowed, approval };
}

/**
 * Independent check of a converted manifest against the stored definition it came from: the
 * manifest must not grant anything the legacy file did not grant, and every approval the legacy file
 * required must still be required. It does not look at how the exporter built the manifest, so a
 * mapping bug cannot hide itself. Returns one finding per violation (empty = nothing widened).
 *
 * Checked: agents and steps (no agent the source does not have), tool grants (`permissions.tools`
 * and the MCP sources), the default (`deny`), approvals (`spec.approval.requiredFor`), network hosts
 * and secret names. Limits that AWP cannot express are not compared here: the exporter refuses them
 * (critical fields), this check guards the grants.
 */
export function verifyNoWidening(def: PublishedDefinition, manifest: JsonObject): ExportFinding[] {
  const out: ExportFinding[] = [];
  const spec = obj(manifest.spec);
  const sourceAgents = new Map(def.agents.map((a) => [a.id, a]));
  const required = new Set(arr(obj(spec.approval).requiredFor).map(String));
  const knownIds = new Set<string>();
  arr(spec.agents).forEach((raw, i) => {
    const a = obj(raw);
    const id = String(a.id);
    knownIds.add(id);
    const at = `spec.agents.${i}`;
    const source = sourceAgents.get(id);
    if (!source) return void out.push(finding(at, `agent "${id}" does not exist in the source`));
    const { allowed, approval } = allowedTools(def, source);
    const permissions = obj(a.permissions);
    if (permissions.default !== 'deny')
      out.push(
        finding(`${at}.permissions.default`, 'the default of a converted agent must be deny'),
      );
    for (const [key, entry] of Object.entries(obj(permissions.tools))) {
      if (obj(entry).allow === true && !allowed.has(key))
        out.push(
          finding(`${at}.permissions.tools.${key}`, `"${key}" was not granted by the source`),
        );
    }
    for (const src of arr(a.tools)) {
      const s = obj(src);
      for (const tool of arr(s.tools)) {
        const key = `${String(s.server)}.${String(tool)}`;
        if (!allowed.has(key))
          out.push(finding(`${at}.tools`, `"${key}" was not granted by the source`));
      }
    }
    for (const key of approval)
      if (!required.has(key))
        out.push(
          finding(`spec.approval.requiredFor`, `"${key}" required an approval in the source`),
        );
    const egress = new Set(source.runtime?.egress ?? def.runtime?.egress ?? []);
    for (const host of arr(obj(permissions.network).allowHosts))
      if (!egress.has(String(host)))
        out.push(
          finding(
            `${at}.permissions.network`,
            `host "${String(host)}" is not in the source egress list`,
          ),
        );
    const secrets = new Set((source.credentials ?? []).map((c) => awpSecretName(c.secret)));
    for (const name of arr(permissions.secrets))
      if (!secrets.has(String(name)))
        out.push(
          finding(
            `${at}.permissions.secrets`,
            `secret "${String(name)}" is not used by the source agent`,
          ),
        );
  });
  arr(spec.workflow).forEach((raw, i) => {
    const step = obj(raw);
    if (step.type === 'agent' && !sourceAgents.has(String(step.agent)))
      out.push(
        finding(
          `spec.workflow.${i}`,
          `step runs agent "${String(step.agent)}" that the source does not have`,
        ),
      );
  });
  for (const key of required) {
    const owner = [...sourceAgents.values()].some((a) => allowedTools(def, a).allowed.has(key));
    if (!owner)
      out.push(finding('spec.approval.requiredFor', `"${key}" is not granted by the source`));
  }
  return out;
}
