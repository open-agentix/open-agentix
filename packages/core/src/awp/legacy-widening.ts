import type { PublishedDefinition } from '../agents/profiles.js';
import { toolMatchesGrant } from '../mcp-pin.js';
import { awpSecretName } from './export-agent.js';
import { EXTENSION_PREFIX } from './types.js';
import type { ExportFinding, JsonObject, JsonValue } from './types.js';

type Obj = { readonly [key: string]: JsonValue };

const obj = (v: JsonValue | undefined): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: JsonValue | undefined): readonly JsonValue[] => (Array.isArray(v) ? v : []);

/** Extensions the exporter writes (docs/awp.md). Any other `x-` field is not checked and refused. */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    'description',
    'model',
    'outputs',
    'simulation',
    'credentialEnv',
    'runtime',
    'mode',
    'schemas',
    'guidelines',
    'when',
    'input',
    'output',
    'access',
    'args',
    'allowAdditionalArgs',
    'maxCallsPerRun',
    'classification',
  ].map((n) => `${EXTENSION_PREFIX}${n}`),
);

const set = (...keys: string[]): ReadonlySet<string> => new Set(keys);
const ALLOWED = {
  manifest: set('apiVersion', 'kind', 'metadata', 'spec'),
  metadata: set(
    'name',
    'version',
    'description',
    'owner',
    'classification',
    'labels',
    'integrity',
    'requiredExtensions',
  ),
  spec: set('triggers', 'inputs', 'budget', 'agents', 'workflow', 'secrets', 'approval'),
  agent: set('id', 'model', 'instructions', 'tools', 'permissions', 'budget'),
  permissions: set('default', 'network', 'tools', 'secrets'),
  network: set('egress', 'allowHosts'),
  toolPermission: set('allow'),
  source: set('type', 'server', 'tools'),
  step: set('id', 'type', 'agent', 'outputs', 'dependsOn', 'task', 'when'),
  approval: set('requiredFor', 'approvers', 'timeout', 'onTimeout'),
  secret: set('name', 'source', 'scope', 'key'),
} as const;

/**
 * Fail closed on structure: a field the check does not model could carry a grant (filesystem,
 * environments, resources, spec-level permissions, MCP servers, action groups, a `ref` agent, a
 * foreign extension). Every object a conversion writes has an allow-list; anything else is refused.
 */
function unmodelled(manifest: JsonObject): ExportFinding[] {
  const out: ExportFinding[] = [];
  const check = (value: JsonValue | undefined, allowed: ReadonlySet<string>, path: string) => {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      out.push(finding(path, 'expected an object'));
      return;
    }
    for (const key of Object.keys(value)) {
      if (allowed.has(key) || KNOWN_EXTENSIONS.has(key)) continue;
      out.push(
        finding(
          path ? `${path}.${key}` : key,
          `field "${key}" is not part of what a conversion writes and is not checked`,
        ),
      );
    }
  };
  const each = (value: JsonValue | undefined, allowed: ReadonlySet<string>, path: string) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) return void out.push(finding(path, 'expected a list'));
    value.forEach((v, i) => check(v, allowed, `${path}.${i}`));
  };
  check(manifest, ALLOWED.manifest, '');
  check(manifest.metadata, ALLOWED.metadata, 'metadata');
  const spec = obj(manifest.spec);
  check(manifest.spec, ALLOWED.spec, 'spec');
  each(spec.agents, ALLOWED.agent, 'spec.agents');
  each(spec.workflow, ALLOWED.step, 'spec.workflow');
  each(spec.secrets, ALLOWED.secret, 'spec.secrets');
  check(spec.approval, ALLOWED.approval, 'spec.approval');
  arr(spec.agents).forEach((raw, i) => {
    const at = `spec.agents.${i}`;
    const a = obj(raw);
    check(a.permissions, ALLOWED.permissions, `${at}.permissions`);
    const permissions = obj(a.permissions);
    check(permissions.network, ALLOWED.network, `${at}.permissions.network`);
    if (permissions.network !== undefined && obj(permissions.network).egress !== 'deny')
      out.push(
        finding(`${at}.permissions.network.egress`, 'network access must be denied by default'),
      );
    // Keys of permissions.tools are tool names: each value is checked, the names by the grant check.
    for (const [name, entry] of Object.entries(obj(permissions.tools)))
      check(entry, ALLOWED.toolPermission, `${at}.permissions.tools.${name}`);
    each(a.tools, ALLOWED.source, `${at}.tools`);
    arr(a.tools).forEach((src, j) => {
      if (obj(src).type !== 'mcp')
        out.push(
          finding(`${at}.tools.${j}.type`, 'only MCP tool sources are written by a conversion'),
        );
    });
  });
  return out;
}

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
  const out: ExportFinding[] = unmodelled(manifest);
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
    // A condition only restricts a step: dropping it would run a step the source skips.
    const condition = sourceAgents.get(String(step.agent))?.when;
    if (
      step.type === 'agent' &&
      condition !== undefined &&
      typeof step.when !== 'string' &&
      typeof step[`${EXTENSION_PREFIX}when`] !== 'string'
    )
      out.push(
        finding(
          `spec.workflow.${i}`,
          `the condition of agent "${String(step.agent)}" is missing from its step`,
        ),
      );
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
