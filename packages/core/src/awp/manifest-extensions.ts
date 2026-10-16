import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { SECRET_PATTERNS } from '../secret-patterns.js';
import { EXTENSIONS_SCHEMA } from './generated/extensions-schema.js';
import { pointer } from './manifest-semantic.js';
import type { ManifestFinding } from './manifest-types.js';

/**
 * The `x-openagentix-*` extension fields (docs/awp.md, `openagentix-extensions.v1alpha1.json`).
 *
 * AWP lets every object carry `x-` fields and tells validators to ignore the ones they do not
 * interpret (spec 3.3). This validator interprets its own namespace and is stricter there, because
 * a limit that is silently dropped (a typo such as `x-openagentix-maxCallPerRun`) would let a runtime
 * allow more than the author wrote:
 *
 * - a name in the namespace that is not in the schema: `extension.unknown` (error);
 * - a known name on an object it is not defined for: `extension.misplaced` (error);
 * - an invalid value: `extension.invalid` (error), with the path into the value;
 * - a credential-shaped literal inside an extension value: `extension.secret` (error), because the
 *   AWP rule `secret.literal-field` does not look into `x-` subtrees (namespace rule 3);
 * - `metadata.requiredExtensions` (AEP-0011, not in the pinned schema yet): every name must be known
 *   here (`extension.required-unknown`), and a critical extension must be listed there
 *   (`extension.required-missing`); other `x-` names are not ours and stay ignored.
 *
 * Critical extensions are those that restrict behaviour: a runtime that ignores one allows more than
 * the author wrote. While the pinned schema has no `requiredExtensions`, a manifest cannot say so, and
 * the validator warns (`extension.critical-not-declared`): the manifest is valid but not portable.
 */

export const EXTENSION_NAMESPACE = 'x-openagentix-';

type Location = 'Spec' | 'Agent' | 'Step' | 'ToolPermission';
const LOCATIONS: readonly Location[] = ['Spec', 'Agent', 'Step', 'ToolPermission'];

/** Extensions that restrict behaviour, per location (see the registry in the AWP alignment notes). */
export const CRITICAL_EXTENSIONS: Readonly<Record<Location, readonly string[]>> = {
  Spec: ['x-openagentix-schemas', 'x-openagentix-guidelines'],
  Agent: [],
  Step: [
    'x-openagentix-when',
    'x-openagentix-input',
    'x-openagentix-output',
    'x-openagentix-access',
  ],
  ToolPermission: [
    'x-openagentix-args',
    'x-openagentix-allowAdditionalArgs',
    'x-openagentix-maxCallsPerRun',
    'x-openagentix-classification',
  ],
};
/** Members of `x-openagentix-runtime` that restrict behaviour (the member `harness` does not). */
const CRITICAL_RUNTIME_MEMBERS = ['runner', 'toolbox'] as const;

/** Keys of maps whose own keys are data; their members are not field sets (see the schema). */
const DATA_MAPS: ReadonlySet<string> = new Set([
  'labels',
  'annotations',
  'env',
  'filter',
  'actionGroups',
  'default',
  'enum',
]);

const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'token',
  'password',
  'apiKey',
  'secret',
  'privateKey',
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

interface Registry {
  validators: Record<Location, ValidateFunction>;
  /** Every name defined at some location -> locations that define it. */
  names: Map<string, Location[]>;
}
const registries = new WeakMap<object, Registry>();

function registryOf(schema: Record<string, unknown>): Registry {
  const known = registries.get(schema);
  if (known) return known;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  ajv.addSchema(schema, 'ext');
  const defs = schema.$defs as Record<string, { properties?: Record<string, unknown> }>;
  const names = new Map<string, Location[]>();
  const validators = {} as Record<Location, ValidateFunction>;
  for (const loc of LOCATIONS) {
    const validate = ajv.getSchema(`ext#/$defs/${loc}`);
    if (!validate) throw new Error(`extension schema has no definition ${loc}`);
    validators[loc] = validate;
    for (const name of Object.keys(defs[loc]?.properties ?? {}))
      names.set(name, [...(names.get(name) ?? []), loc]);
  }
  const registry = { validators, names };
  registries.set(schema, registry);
  return registry;
}

/** All extension names this validator knows (for `requiredExtensions`). */
export function knownExtensionNames(schema: Record<string, unknown> = EXTENSIONS_SCHEMA): string[] {
  return [...registryOf(schema).names.keys()].sort();
}

/** Location of the object at `path` in a structurally valid manifest; undefined = none is defined. */
function locationOf(kind: unknown, path: (string | number)[], node: Obj): Location | undefined {
  const [a, b, c, d, e] = path;
  if (path.length === 1 && a === 'spec')
    return kind === 'Agent' ? 'Agent' : kind === 'Workflow' ? 'Spec' : undefined;
  if (kind === 'Workflow' && a === 'spec') {
    if (b === 'workflow' && typeof c === 'number' && path.length === 3) return 'Step';
    if (b === 'agents' && typeof c === 'number' && path.length === 3)
      return 'ref' in node || 'protocol' in node ? undefined : 'Agent';
    if (b === 'permissions' && c === 'tools' && path.length === 4) return 'ToolPermission';
    if (
      b === 'agents' &&
      typeof c === 'number' &&
      d === 'permissions' &&
      e === 'tools' &&
      path.length === 6
    )
      return 'ToolPermission';
  }
  if (kind === 'Agent' && a === 'spec' && b === 'permissions' && c === 'tools' && path.length === 4)
    return 'ToolPermission';
  return undefined;
}

interface Hit {
  path: (string | number)[];
  node: Obj;
}

/** Finds every object (outside other vendors' `x-` subtrees and data maps) with `x-openagentix-` members. */
function objectsWithExtensions(root: unknown): Hit[] {
  const hits: Hit[] = [];
  const todo: { node: unknown; path: (string | number)[] }[] = [{ node: root, path: [] }];
  while (todo.length > 0) {
    const { node, path } = todo.pop()!;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) todo.push({ node: node[i], path: [...path, i] });
      continue;
    }
    if (!isObj(node)) continue;
    const last = path[path.length - 1];
    if (typeof last === 'string' && DATA_MAPS.has(last)) continue; // all keys and values are data
    // The keys of `permissions.tools` and `environments` are names; their members are field sets.
    const keysAreNames =
      last === 'environments' || (last === 'tools' && path[path.length - 2] === 'permissions');
    if (!keysAreNames && Object.keys(node).some((k) => k.startsWith(EXTENSION_NAMESPACE)))
      hits.push({ path, node });
    // reversed, so that the objects are visited in document order
    const entries = Object.entries(node);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [k, v] = entries[i]!;
      if (keysAreNames || !k.startsWith('x-')) todo.push({ node: v, path: [...path, k] });
    }
  }
  return hits;
}

function literalSecrets(
  value: unknown,
  base: (string | number)[],
  skipKeys: boolean,
): ManifestFinding[] {
  const out: ManifestFinding[] = [];
  const todo: { node: unknown; path: (string | number)[] }[] = [{ node: value, path: base }];
  while (todo.length > 0) {
    const { node, path } = todo.pop()!;
    if (typeof node === 'string') {
      const hit = SECRET_PATTERNS.find(([, re]) => re.test(node));
      if (hit)
        out.push({
          severity: 'error',
          code: 'extension.secret',
          section: '',
          path: pointer(...path),
          message: `an extension value contains a ${hit[0]}-shaped string; secrets MUST NOT appear in manifests, use secretRef`,
        });
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => todo.push({ node: v, path: [...path, i] }));
    } else if (isObj(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (!skipKeys && SECRET_FIELD_NAMES.has(k) && v !== null && typeof v !== 'object')
          out.push({
            severity: 'error',
            code: 'extension.secret',
            section: '',
            path: pointer(...path, k),
            message: `field "${k}" with a literal value inside an extension; secrets MUST NOT appear in manifests, use secretRef`,
          });
        todo.push({ node: v, path: [...path, k] });
      }
    }
  }
  return out;
}

export interface ExtensionOptions {
  /** Whether the pinned AWP schema defines `metadata.requiredExtensions` (AEP-0011). */
  requiredExtensionsOffered: boolean;
  schema?: Record<string, unknown>;
}

/** Findings for the `x-openagentix-*` fields of a structurally valid manifest. */
export function extensionFindings(doc: Obj, opts: ExtensionOptions): ManifestFinding[] {
  const registry = registryOf(opts.schema ?? EXTENSIONS_SCHEMA);
  const out: ManifestFinding[] = [];
  const used = new Set<string>();
  const criticalUsed: { name: string; path: string }[] = [];
  const bad = (code: string, path: string, message: string): void => {
    out.push({ severity: 'error', code, path, message, section: '' });
  };

  for (const { path, node } of objectsWithExtensions(doc)) {
    const location = locationOf(doc.kind, path, node);
    const present = Object.keys(node).filter((k) => k.startsWith(EXTENSION_NAMESPACE));
    const own: Obj = {};
    for (const name of present) {
      const definedAt = registry.names.get(name);
      if (!definedAt) {
        bad(
          'extension.unknown',
          pointer(...path, name),
          `"${name}" is not a field of the ${EXTENSION_NAMESPACE}* namespace of this version; it would be ignored, so it is rejected`,
        );
      } else if (!location || !definedAt.includes(location)) {
        bad(
          'extension.misplaced',
          pointer(...path, name),
          `"${name}" is not defined for this object (it belongs on: ${definedAt.join(', ')})`,
        );
      } else {
        Object.defineProperty(own, name, {
          value: node[name],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    if (!location || Object.keys(own).length === 0) continue;
    const validate = registry.validators[location];
    if (!validate(own)) {
      const seen = new Set<string>();
      for (const e of validate.errors ?? []) {
        if (e.keyword === 'if') continue;
        const rel =
          e.keyword === 'additionalProperties'
            ? `${e.instancePath}/${String(e.params.additionalProperty).replace(/~/g, '~0').replace(/\//g, '~1')}`
            : e.keyword === 'propertyNames'
              ? `${e.instancePath}/${String(e.params.propertyName)}`
              : e.instancePath;
        const at = `${pointer(...path)}${rel}`;
        const key = `${at}|${e.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bad('extension.invalid', at, `${e.keyword}: ${e.message}`);
      }
      continue;
    }
    for (const name of Object.keys(own)) {
      used.add(name);
      const value = own[name];
      out.push(...literalSecrets(value, [...path, name], name === 'x-openagentix-credentialEnv'));
      const runtimeCritical =
        name === 'x-openagentix-runtime' &&
        isObj(value) &&
        CRITICAL_RUNTIME_MEMBERS.some((m) => m in value);
      if (CRITICAL_EXTENSIONS[location].includes(name) || runtimeCritical)
        criticalUsed.push({ name, path: pointer(...path, name) });
    }
  }

  const meta = isObj(doc.metadata) ? doc.metadata : {};
  const required = Array.isArray(meta.requiredExtensions)
    ? (meta.requiredExtensions as unknown[])
    : [];
  required.forEach((name, i) => {
    if (typeof name !== 'string' || !registry.names.has(name))
      bad(
        'extension.required-unknown',
        pointer('metadata', 'requiredExtensions', i),
        `required extension ${JSON.stringify(name)} is not known to this validator; a manifest that requires it is rejected`,
      );
  });
  for (const { name, path } of criticalUsed) {
    if (opts.requiredExtensionsOffered) {
      if (!required.includes(name))
        bad(
          'extension.required-missing',
          path,
          `"${name}" restricts behaviour and must be listed in metadata.requiredExtensions`,
        );
    } else {
      out.push({
        severity: 'warning',
        code: 'extension.critical-not-declared',
        section: '',
        path,
        message:
          `"${name}" restricts behaviour, but the pinned AWP version has no metadata.requiredExtensions ` +
          'to say so: a runtime that ignores it allows more than this manifest states (valid, not portable)',
      });
    }
  }
  return out;
}
