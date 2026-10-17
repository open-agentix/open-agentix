import type { AgentSpec } from '../agents/parser.js';
import type { PublishedDefinition } from '../agents/profiles.js';
import type { ToolGrant } from '../agents/schema.js';
import { canonicalJson } from '../canonical.js';
import { toolMatchesGrant } from '../mcp-pin.js';
import { findGrant } from '../policy/engine.js';
import { awpSecretName } from './export-agent.js';
import { EXTENSION_PREFIX } from './types.js';
import type { ExportFinding, JsonObject, JsonValue } from './types.js';

type Obj = { readonly [key: string]: JsonValue };

const obj = (v: JsonValue | undefined): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: JsonValue | undefined): readonly JsonValue[] => (Array.isArray(v) ? v : []);

/**
 * Reads at a position that can carry a grant. `obj()` and `arr()` above turn a value of the wrong
 * type into "empty", which at a grant position would read as "nothing granted" while a reader of the
 * manifest may see something else (a string where a list belongs). These refuse it instead.
 */
function strictObj(v: JsonValue | undefined, path: string, out: ExportFinding[]): Obj {
  if (v === undefined) return {};
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Obj;
  out.push(finding(path, 'expected an object'));
  return {};
}
function strictArr(
  v: JsonValue | undefined,
  path: string,
  out: ExportFinding[],
): readonly JsonValue[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  out.push(finding(path, 'expected a list'));
  return [];
}

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
  toolPermission: set('allow', 'args', 'allowAdditionalArgs', 'maxCalls'),
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

const ext = (name: string): string => `${EXTENSION_PREFIX}${name}`;
const sameValue = (a: unknown, b: unknown): boolean =>
  canonicalJson(a ?? null) === canonicalJson(b ?? null);

export interface WideningOptions {
  /**
   * The pinned AWP version has `metadata.requiredExtensions` (AEP-0011): the list must then exist
   * and name every critical extension the manifest uses. Without it the list is only checked when the
   * manifest carries one.
   */
  requiredExtensions?: boolean;
}

/** The grant of a stored agent that decides a call to `key` (`server.tool`), as at run time. */
function grantFor(source: AgentSpec, key: string): ToolGrant | null {
  const dot = key.indexOf('.');
  return dot < 0 ? null : findGrant(source.tools ?? [], key.slice(0, dot), key.slice(dot + 1));
}

/**
 * Limits of one tool permission entry against the grant of the source. An extension (or the core
 * field that replaces it) is part of what the manifest allows: if its value were not compared, a
 * manifest could carry the grant and a looser limit, or none (a missing limit is "no limit").
 * Equality for the argument constraints, "not looser" for the numbers.
 */
function checkEntryLimits(entry: Obj, grant: ToolGrant, at: string, out: ExportFinding[]): void {
  const coreArgs = entry.args;
  const extArgs = entry[ext('args')];
  if (coreArgs !== undefined && extArgs !== undefined)
    out.push(
      finding(`${at}.args`, 'argument constraints are given twice (core field and extension)'),
    );
  const actualArgs = coreArgs ?? extArgs;
  if (!sameValue(actualArgs === undefined ? {} : actualArgs, grant.args ?? {}))
    out.push(finding(`${at}.args`, 'the argument constraints differ from the source'));

  if (grant.allowAdditionalArgs !== true) {
    // The source allows no argument beyond `args`. The extension must say so with `false`; the core
    // field is closed by default as soon as `args` is present (`args: {}` = no argument at all).
    const closed =
      entry[ext('allowAdditionalArgs')] === false ||
      (coreArgs !== undefined && entry[ext('allowAdditionalArgs')] !== true);
    if (!closed || entry.allowAdditionalArgs === true || entry[ext('allowAdditionalArgs')] === true)
      out.push(
        finding(
          `${at}.allowAdditionalArgs`,
          'the source allows no argument beyond its constraints',
        ),
      );
  }

  const limits = [entry.maxCalls, entry[ext('maxCallsPerRun')]].filter((v) => v !== undefined);
  const invalid = limits.some((v) => typeof v !== 'number' || !Number.isInteger(v) || v < 1);
  if (invalid) out.push(finding(`${at}.maxCalls`, 'a call limit must be a positive integer'));
  else if (grant.maxCallsPerRun !== undefined) {
    const effective = limits.length > 0 ? Math.min(...(limits as number[])) : Infinity;
    if (effective > grant.maxCallsPerRun)
      out.push(
        finding(
          `${at}.maxCalls`,
          `the call limit is missing or above the source (${grant.maxCallsPerRun})`,
        ),
      );
  }

  if (grant.classification !== undefined && entry[ext('classification')] !== grant.classification)
    out.push(finding(`${at}.${ext('classification')}`, 'the data class differs from the source'));
}

/** Names of the critical extensions a manifest uses (those a runtime must not ignore). */
function criticalExtensionsUsed(manifest: JsonObject): Set<string> {
  const used = new Set<string>();
  const runtime = (v: JsonValue | undefined): void => {
    const r = v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
    if (r && ('runner' in r || 'toolbox' in r)) used.add(ext('runtime'));
  };
  const spec = obj(manifest.spec);
  for (const name of ['schemas', 'guidelines'])
    if (spec[ext(name)] !== undefined) used.add(ext(name));
  runtime(spec[ext('runtime')]);
  for (const raw of arr(spec.workflow)) {
    const step = obj(raw);
    for (const name of ['when', 'input', 'output', 'access'])
      if (step[ext(name)] !== undefined) used.add(ext(name));
  }
  for (const raw of arr(spec.agents)) {
    const a = obj(raw);
    runtime(a[ext('runtime')]);
    for (const entry of Object.values(obj(obj(a.permissions).tools)))
      for (const name of ['args', 'allowAdditionalArgs', 'maxCallsPerRun', 'classification'])
        if (obj(entry)[ext(name)] !== undefined) used.add(ext(name));
  }
  return used;
}

/** `x-openagentix-runtime` members that restrict (`runner`, `toolbox`) against what the source says. */
function checkRuntime(
  actual: JsonValue | undefined,
  expected: { runner?: string | undefined; toolbox?: string | undefined },
  at: string,
  out: ExportFinding[],
): void {
  const r = obj(actual);
  for (const member of ['runner', 'toolbox'] as const)
    if (expected[member] !== undefined && r[member] !== expected[member])
      out.push(finding(`${at}.${member}`, `the ${member} of the source is missing or differs`));
}

/**
 * Independent check of a converted manifest against the stored definition it came from: the
 * manifest must not grant anything the legacy file did not grant, and every approval the legacy file
 * required must still be required. It does not look at how the exporter built the manifest, so a
 * mapping bug cannot hide itself. Returns one finding per violation (empty = nothing widened).
 *
 * Checked: agents and steps (no agent the source does not have), tool grants (`permissions.tools`
 * and the MCP sources), the default (`deny`), approvals (`spec.approval.requiredFor`), network hosts
 * and secret names, and the **values** of the extensions that restrict: argument constraints,
 * `allowAdditionalArgs`, call limits and data class of every granted tool (also in their core form
 * once the pinned AWP version has them), the access class, input, output, schemas and guidelines and
 * the runner and toolbox. A missing or looser value is a finding, and so is a critical extension that
 * `metadata.requiredExtensions` does not list. A value of the wrong type at a position that can carry
 * a grant (a string where a list belongs) is a finding too, never "empty".
 */
export function verifyNoWidening(
  def: PublishedDefinition,
  manifest: JsonObject,
  options: WideningOptions = {},
): ExportFinding[] {
  const out: ExportFinding[] = unmodelled(manifest);
  const spec = obj(manifest.spec);
  const sourceAgents = new Map(def.agents.map((a) => [a.id, a]));
  const required = new Set(
    strictArr(obj(spec.approval).requiredFor, 'spec.approval.requiredFor', out).map(String),
  );
  const knownIds = new Set<string>();
  arr(spec.agents).forEach((raw, i) => {
    const a = obj(raw);
    const id = String(a.id);
    knownIds.add(id);
    const at = `spec.agents.${i}`;
    const source = sourceAgents.get(id);
    if (!source) return void out.push(finding(at, `agent "${id}" does not exist in the source`));
    const { allowed, approval } = allowedTools(def, source);
    const permissions = strictObj(a.permissions, `${at}.permissions`, out);
    if (permissions.default !== 'deny')
      out.push(
        finding(`${at}.permissions.default`, 'the default of a converted agent must be deny'),
      );
    const toolEntries = strictObj(permissions.tools, `${at}.permissions.tools`, out);
    for (const [key, raw] of Object.entries(toolEntries)) {
      const entry = obj(raw);
      // Only booleans mean something to a reader: `"true"` or `1` must not pass for "not allowed".
      for (const field of ['allow', 'allowAdditionalArgs', ext('allowAdditionalArgs')])
        if (entry[field] !== undefined && typeof entry[field] !== 'boolean')
          out.push(
            finding(`${at}.permissions.tools.${key}.${field}`, `"${field}" must be a boolean`),
          );
      if (entry.allow === true && !allowed.has(key))
        out.push(
          finding(`${at}.permissions.tools.${key}`, `"${key}" was not granted by the source`),
        );
      const grant = entry.allow === true ? grantFor(source, key) : null;
      if (grant) checkEntryLimits(entry, grant, `${at}.permissions.tools.${key}`, out);
    }
    // A granted tool without a permission entry carries none of its limits: the entry is required.
    for (const key of allowed)
      if (obj(toolEntries[key]).allow !== true && sourceHasLimits(grantFor(source, key)))
        out.push(
          finding(
            `${at}.permissions.tools.${key}`,
            `"${key}" is listed as a tool source but its limits are not carried by a permission entry`,
          ),
        );
    arr(a.tools).forEach((src, j) => {
      const s = obj(src);
      for (const tool of strictArr(s.tools, `${at}.tools.${j}.tools`, out)) {
        const key = `${String(s.server)}.${String(tool)}`;
        if (!allowed.has(key))
          out.push(finding(`${at}.tools`, `"${key}" was not granted by the source`));
      }
    });
    for (const key of approval)
      if (!required.has(key))
        out.push(
          finding(`spec.approval.requiredFor`, `"${key}" required an approval in the source`),
        );
    const egress = new Set(source.runtime?.egress ?? def.runtime?.egress ?? []);
    const network = strictObj(permissions.network, `${at}.permissions.network`, out);
    for (const host of strictArr(network.allowHosts, `${at}.permissions.network.allowHosts`, out))
      if (!egress.has(String(host)))
        out.push(
          finding(
            `${at}.permissions.network`,
            `host "${String(host)}" is not in the source egress list`,
          ),
        );
    const secrets = new Set((source.credentials ?? []).map((c) => awpSecretName(c.secret)));
    for (const name of strictArr(permissions.secrets, `${at}.permissions.secrets`, out))
      if (!secrets.has(String(name)))
        out.push(
          finding(
            `${at}.permissions.secrets`,
            `secret "${String(name)}" is not used by the source agent`,
          ),
        );
    if (source.runtime?.runner !== undefined || source.toolbox !== undefined)
      checkRuntime(
        a[ext('runtime')],
        { runner: source.runtime?.runner, toolbox: source.toolbox },
        `${at}.${ext('runtime')}`,
        out,
      );
  });
  arr(spec.workflow).forEach((raw, i) => {
    const step = obj(raw);
    const at = `spec.workflow.${i}`;
    const source = sourceAgents.get(String(step.agent));
    // The exporter writes agent steps only. A step of another type that names an agent could be read
    // as running it, so it must not name one the source lacks; and it is not a step it writes.
    if (step.type !== 'agent')
      out.push(finding(`${at}.type`, 'only agent steps are written by a conversion'));
    if (step.agent !== undefined && !source)
      out.push(
        finding(at, `step runs agent "${String(step.agent)}" that the source does not have`),
      );
    // A condition only restricts a step: dropping it would run a step the source skips.
    if (
      source?.when !== undefined &&
      typeof step.when !== 'string' &&
      typeof step[ext('when')] !== 'string'
    )
      out.push(
        finding(at, `the condition of agent "${String(step.agent)}" is missing from its step`),
      );
    if (source) {
      if (source.access !== undefined && step[ext('access')] !== source.access)
        out.push(
          finding(`${at}.${ext('access')}`, 'the access class of the source is missing or differs'),
        );
      for (const name of ['input', 'output'] as const)
        if (source[name] !== undefined && !sameValue(step[ext(name)], source[name]))
          out.push(
            finding(
              `${at}.${ext(name)}`,
              `the ${name} contract of the source is missing or differs`,
            ),
          );
    }
  });
  for (const key of required) {
    const owner = [...sourceAgents.values()].some((a) => allowedTools(def, a).allowed.has(key));
    if (!owner)
      out.push(finding('spec.approval.requiredFor', `"${key}" is not granted by the source`));
  }
  if (
    def.schemas &&
    Object.keys(def.schemas).length > 0 &&
    !sameValue(spec[ext('schemas')], def.schemas)
  )
    out.push(finding(`spec.${ext('schemas')}`, 'the schemas of the source are missing or differ'));
  if ((def.guidelines ?? []).length > 0 && !sameValue(spec[ext('guidelines')], def.guidelines))
    out.push(
      finding(`spec.${ext('guidelines')}`, 'the guidelines of the source are missing or differ'),
    );
  const specRuntime = {
    runner: def.runtime?.runner !== 'in-process' ? def.runtime?.runner : undefined,
    toolbox: def.runtime?.toolbox,
  };
  if (specRuntime.runner !== undefined || specRuntime.toolbox !== undefined)
    checkRuntime(spec[ext('runtime')], specRuntime, `spec.${ext('runtime')}`, out);

  const used = criticalExtensionsUsed(manifest);
  const declared = obj(manifest.metadata).requiredExtensions;
  if (declared !== undefined || (options.requiredExtensions === true && used.size > 0)) {
    const list = Array.isArray(declared) ? declared.map(String) : null;
    if (list === null)
      out.push(
        finding(
          'metadata.requiredExtensions',
          'critical extensions are used but not declared as required',
        ),
      );
    else
      for (const name of [...used].sort())
        if (!list.includes(name))
          out.push(
            finding(
              'metadata.requiredExtensions',
              `"${name}" restricts behaviour and is not listed`,
            ),
          );
  }
  return out;
}

const sourceHasLimits = (g: ToolGrant | null): boolean =>
  g !== null &&
  (Object.keys(g.args ?? {}).length > 0 ||
    g.allowAdditionalArgs !== true ||
    g.maxCallsPerRun !== undefined ||
    g.classification !== undefined);
