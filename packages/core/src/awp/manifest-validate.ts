import { JcsError } from '../jcs.js';
import { AWP_SCHEMA } from './generated/awp-schema.js';
import type { AwpManifest } from './generated/awp-types.js';
import { extensionFindings } from './manifest-extensions.js';
import { awpManifestDigest } from './manifest-digest.js';
import { injectAgentSections, parseManifestSource } from './manifest-parse.js';
import { pinnedValidator, structuralFindings } from './manifest-schema.js';
import { semanticFindings } from './manifest-semantic.js';
import {
  AWP_LIMITS,
  SUPPORTED_AWP_PROFILES,
  type ManifestDocumentResult,
  type ManifestFinding,
  type ManifestLayout,
  type ManifestValidation,
  type ValidateManifestOptions,
} from './manifest-types.js';
import type { JsonObject } from './types.js';

/**
 * Validates an AWP manifest the way any AWP validator does (YAML restrictions, then the pinned JSON
 * Schema, then the semantic rules; spec 3.1 and `schema/README.md`), plus the OpenAgentix layer for
 * `agents.md` front matter (`## Agent:` sections) and the `x-openagentix-*` fields.
 *
 * Validation only. The result names what the manifest states; nothing is stored, granted or run
 * from it, so accepting a manifest creates no privilege. AWP is a draft (`v1alpha1`); an accepted
 * manifest is not a conformance claim: openagentix is not conformant to any profile.
 */

const error = (code: string, path: string, message: string, section = ''): ManifestFinding => ({
  severity: 'error',
  code,
  path,
  message,
  section,
});

/** Names of the `metadata` fields a schema defines (the pin offers `requiredExtensions` or not). */
export function metadataProperties(schema: Record<string, unknown>): string[] {
  const defs = schema.$defs as Record<string, { properties?: Record<string, unknown> }> | undefined;
  return Object.keys(defs?.Metadata?.properties ?? {});
}

/**
 * Closures and cycle search of a workflow are quadratic in its steps, so a document with more steps
 * or agents than the limit is refused before the semantic rules run (a deliberate divergence from
 * the reference checker, which has no limit; within the limits the findings are identical).
 */
function countLimit(doc: JsonObject): ManifestFinding | null {
  const spec = doc.spec as { workflow?: unknown[]; agents?: unknown[] } | undefined;
  if (doc.kind !== 'Workflow' || !spec) return null;
  if ((spec.workflow?.length ?? 0) > AWP_LIMITS.maxSteps)
    return error(
      'limit.steps',
      '/spec/workflow',
      `more than ${AWP_LIMITS.maxSteps} workflow steps`,
    );
  if ((spec.agents?.length ?? 0) > AWP_LIMITS.maxAgents)
    return error('limit.steps', '/spec/agents', `more than ${AWP_LIMITS.maxAgents} agents`);
  return null;
}

const hasErrors = (findings: ManifestFinding[]): boolean =>
  findings.some((f) => f.severity === 'error');

function documentResult(
  findings: ManifestFinding[],
  manifest: unknown,
  digest: string | null,
): ManifestDocumentResult {
  const valid = !hasErrors(findings);
  const doc = manifest as Partial<AwpManifest> | null;
  const meta = (doc?.metadata ?? {}) as { name?: string; version?: string };
  return {
    valid,
    manifest: valid ? (manifest as AwpManifest) : null,
    digest,
    name: valid ? (meta.name ?? null) : null,
    version: valid ? (meta.version ?? null) : null,
    kind: valid ? (doc?.kind ?? null) : null,
  };
}

/**
 * Validates one parsed (and, for `agents.md`, already assembled) manifest value. `prior` are findings
 * found before (parse, wrapper). Returns all findings of the document and its outcome.
 */
export function validateManifestValue(
  value: unknown,
  prior: ManifestFinding[] = [],
  options: ValidateManifestOptions = {},
): { findings: ManifestFinding[]; result: ManifestDocumentResult } {
  const findings = [...prior];
  const finish = (digest: string | null) => ({
    findings,
    result: documentResult(findings, value, digest),
  });
  const validate = pinnedValidator(options.schemas?.awp);
  let structural: ManifestFinding[];
  try {
    structural = structuralFindings(validate, value);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    findings.push(
      error(
        'limit.validator',
        '',
        'the document could not be checked: it exceeds what the validator can process',
      ),
    );
    return finish(null);
  }
  findings.push(...structural);
  if (structural.length > 0) return finish(null);

  const doc = value as JsonObject;
  const tooMany = countLimit(doc);
  if (tooMany) {
    findings.push(tooMany);
    return finish(null);
  }
  let digest: string | null = null;
  let verifyDigest = options.verifyDigest ?? true;
  try {
    digest = awpManifestDigest(doc);
  } catch (e) {
    if (!(e instanceof JcsError)) throw e;
    verifyDigest = false;
    findings.push(
      error('digest.not-canonicalizable', '', `the digest cannot be computed: ${e.message}`, '9.1'),
    );
  }
  const offered = metadataProperties(options.schemas?.awp ?? AWP_SCHEMA).includes(
    'requiredExtensions',
  );
  findings.push(
    ...extensionFindings(doc, {
      requiredExtensionsOffered: offered,
      ...(options.schemas?.extensions ? { schema: options.schemas.extensions } : {}),
    }),
  );
  findings.push(
    ...semanticFindings(doc, {
      profiles: new Set<string>(options.profiles ?? SUPPORTED_AWP_PROFILES),
      verifyDigest,
      maxFindings: AWP_LIMITS.maxFindings + 1,
    }),
  );
  return finish(digest);
}

/**
 * Validates the text of an `agents.md` file with AWP front matter, or of a plain JSON/YAML manifest.
 * Returns `null` when `layout` is `auto` and the text is not an AWP manifest (no `apiVersion: awp.…`),
 * so the caller can use the legacy `agents.md` parser. Never throws for hostile input.
 */
export function validateManifestSource(
  source: string,
  options: ValidateManifestOptions = {},
): ManifestValidation | null {
  const parsed = parseManifestSource(source, options.layout ?? 'auto');
  if (parsed === null) return null;
  const layout: ManifestLayout = parsed.layout;
  const all: ManifestFinding[] = parsed.findings.map((f) => ({ ...f, document: 0 }));
  const documents: ManifestDocumentResult[] = [];
  parsed.documents.forEach((d, index) => {
    const prior = [...d.findings];
    if (d.value !== undefined && parsed.body !== null)
      prior.push(...injectAgentSections(d.value, parsed.body));
    const { findings, result } =
      d.value === undefined
        ? { findings: prior, result: documentResult(prior, null, null) }
        : validateManifestValue(d.value, prior, options);
    all.push(...findings.map((f) => ({ ...f, document: index })));
    documents.push(result);
  });
  const kept = all.slice(0, AWP_LIMITS.maxFindings);
  if (all.length > kept.length)
    kept.push({
      ...error(
        'limit.findings',
        '',
        `${all.length - kept.length} more findings were left out (limit ${AWP_LIMITS.maxFindings})`,
      ),
      document: 0,
    });
  const valid =
    documents.length > 0 && documents.every((d) => d.valid) && !hasErrors(parsed.findings);
  const single = documents.length === 1 && valid ? documents[0]! : null;
  return {
    valid,
    layout,
    findings: kept,
    documents,
    manifest: single?.manifest ?? null,
    digest: documents.length === 1 ? (documents[0]!.digest ?? null) : null,
    name: single?.name ?? null,
    version: single?.version ?? null,
    kind: single?.kind ?? null,
  };
}
