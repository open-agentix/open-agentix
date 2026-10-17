import type { PublishedDefinition } from '../agents/profiles.js';
import { JcsError } from '../jcs.js';
import { exportAgent, type AgentExport } from './export-agent.js';
import { exportBudget } from './export-budget.js';
import { ExportContext, rejectUnknownKeys } from './export-context.js';
import { exportApproval, exportSecrets, exportSteps, exportTriggers } from './export-workflow.js';
import { verifyNoWidening } from './legacy-widening.js';
import { awpManifestDigest } from './manifest-digest.js';
import {
  AWP_API_VERSION,
  EXTENSION_PREFIX,
  PINNED_AWP_FEATURES,
  type ExportOptions,
  type ExportResult,
  type JsonObject,
  type JsonValue,
} from './types.js';

const KNOWN_DEFINITION_KEYS: ReadonlySet<string> = new Set([
  'apiVersion',
  'kind',
  'name',
  'version',
  'description',
  'owner',
  'classification',
  'labels',
  'triggers',
  'budget',
  'approvals',
  'mode',
  'guidelines',
  'runtime',
  'schemas',
  'agents',
  'pipeline',
  'overview',
  'sections',
  'digest',
  // Added by publish (profile expansion, ADR 0008 / 0016):
  'expansion',
  'toolAccess',
  'expansionDigest',
  'toolPins',
  'wildcardExpansion',
]);

/** Same pattern as the schema's label and annotation keys. */
const LABEL_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;

function exportMetadata(
  ctx: ExportContext,
  def: PublishedDefinition,
  ownerTeam: string | null | undefined,
): JsonObject {
  if (!ownerTeam)
    ctx.refuse(
      'owner_team_required',
      'owner',
      'an AWP owner is a team: assign the agent to a team before exporting',
    );
  const metadata: JsonObject = { name: def.name, version: def.version };
  if (def.description !== undefined) metadata.description = def.description;
  metadata.owner = { team: ownerTeam ?? '' };
  metadata.classification = def.classification;
  const labels = Object.entries(def.labels ?? {});
  for (const [key] of labels)
    if (!LABEL_KEY.test(key))
      ctx.refuse('label_not_representable', `labels.${key}`, `label key "${key}" is not allowed`);
  if (labels.length > 0) metadata.labels = Object.fromEntries(labels);
  return metadata;
}

/** Pipeline-level restrictions that AWP v1alpha1 has no field for. */
function exportSpecExtensions(
  ctx: ExportContext,
  def: PublishedDefinition,
  spec: JsonObject,
): void {
  if (def.mode === 'dark-factory') spec[`${EXTENSION_PREFIX}mode`] = def.mode;
  if (def.schemas && Object.keys(def.schemas).length > 0)
    ctx.critical(spec, 'schemas', 'schemas', def.schemas as JsonValue);
  if ((def.guidelines ?? []).length > 0)
    ctx.critical(spec, 'guidelines', 'guidelines', [...def.guidelines]);
  const runtime: JsonObject = {};
  const runner = def.runtime?.runner;
  // `in-process` is the default and restricts nothing; any other runner is isolation to keep.
  if (runner !== undefined && runner !== 'in-process') {
    runtime.runner = runner;
    ctx.noteCritical('runtime.runner', 'runtime.runner');
  }
  if (def.runtime?.toolbox !== undefined) {
    runtime.toolbox = def.runtime.toolbox;
    ctx.noteCritical('runtime.toolbox', 'runtime.toolbox');
  }
  if (Object.keys(runtime).length > 0) spec[`${EXTENSION_PREFIX}runtime`] = runtime;
}

function exportSpec(
  ctx: ExportContext,
  def: PublishedDefinition,
): { spec: JsonObject; agents: AgentExport[] } {
  const exports = def.agents.map((a, i) => exportAgent(ctx, def, a, i));
  const { triggers, hasEvent } = exportTriggers(ctx, def);
  const byId = new Map(exports.map((e) => [String(e.agent.id), e]));
  const spec: JsonObject = { triggers };
  if (hasEvent)
    spec.inputs = [
      {
        name: 'event',
        type: 'object',
        description: 'Payload of the triggering event (untrusted external data).',
      },
    ];
  const budget = exportBudget(def.budget);
  if (budget) spec.budget = budget;
  spec.agents = exports.map((e) => e.agent);
  spec.workflow = exportSteps(ctx, def, byId, hasEvent);
  const secrets = exportSecrets(
    ctx,
    exports.flatMap((e) => e.secrets),
  );
  if (secrets.length > 0) spec.secrets = secrets;
  const approval = exportApproval(def, exports);
  if (approval) spec.approval = approval;
  exportSpecExtensions(ctx, def, spec);
  return { spec, agents: exports };
}

/** Profiles a validator needs for the `spec` of a manifest (`core` plus `mcp` / `governance`). */
export function profilesOf(spec: JsonObject): string[] {
  const agents = spec.agents as JsonObject[];
  const usesMcp = agents.some((a) => Array.isArray(a.tools) && a.tools.length > 0);
  return ['core', ...(spec.approval ? ['governance'] : []), ...(usesMcp ? ['mcp'] : [])].sort();
}

/**
 * Exports a stored (published) definition as the effective AWP manifest of kind `Workflow`.
 *
 * Pure and deterministic: the same stored definition and options always give the same manifest and
 * digest, independent of YAML formatting or key order of the source. Nothing is re-parsed. Whatever
 * cannot be carried is a finding (the export is refused, fail closed) or a warning for a loss that
 * is not a restriction. While the pinned AWP version has no `metadata.requiredExtensions`, every
 * critical extension is a finding; afterwards they are listed there (decision D3).
 *
 * The result is a mapping to the AWP schema. It is not a conformance claim.
 */
export function exportAwpManifest(def: PublishedDefinition, options: ExportOptions): ExportResult {
  const ctx = new ExportContext();
  rejectUnknownKeys(ctx, def, KNOWN_DEFINITION_KEYS, '');
  const metadata = exportMetadata(ctx, def, options.ownerTeam);
  const { spec } = exportSpec(ctx, def);
  const supported = options.requiredExtensionsSupported ?? PINNED_AWP_FEATURES.requiredExtensions;
  const required = ctx.requiredExtensions();
  if (supported && required.length > 0) metadata.requiredExtensions = required;
  const findings = [...ctx.findings, ...(supported ? [] : ctx.criticalFindings())];
  const refused = (more: typeof findings = []) => ({
    ok: false as const,
    findings: [...findings, ...more],
  });
  if (findings.length > 0) return refused();
  const manifest: JsonObject = { apiVersion: AWP_API_VERSION, kind: 'Workflow', metadata, spec };
  // Safety net, independent of the mapping above: a conversion never grants more than the source.
  const widened = verifyNoWidening(def, manifest);
  if (widened.length > 0) return refused(widened);
  try {
    const digest = awpManifestDigest(manifest);
    metadata.integrity = { digest };
    return {
      ok: true,
      manifest,
      digest,
      sourceDigest: def.digest,
      profiles: profilesOf(spec),
    };
  } catch (e) {
    if (!(e instanceof JcsError)) throw e;
    return refused([{ code: 'not_canonicalizable', path: '', message: e.message }]);
  }
}
