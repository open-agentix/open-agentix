import type { AwpManifest } from './generated/awp-types.js';

/**
 * Types of the AWP manifest validator (`manifest-validate.ts`).
 *
 * AWP is a draft (`v1alpha1`). The validator checks a manifest against the pinned schema and rules;
 * an accepted manifest is not a conformance claim: openagentix is not conformant to any profile.
 */

/** Profiles this validator supports (AWP spec 3.3). Fields of any other profile are rejected. */
export const SUPPORTED_AWP_PROFILES = ['core', 'governance', 'mcp'] as const;

/** All profile names of the pinned AWP version (the rule `profile.unsupported` names them). */
export const KNOWN_AWP_PROFILES = [
  'core',
  'governance',
  'audit',
  'security',
  'mcp',
  'a2a',
] as const;

/** Limits applied to every manifest before it is interpreted (it is untrusted input). */
export const AWP_LIMITS = {
  /** Source size in bytes (UTF-8). The API accepts at most 512 000 characters. */
  maxSourceBytes: 524_288,
  /** Nodes (objects, arrays, scalars) of the whole source after YAML alias expansion. */
  maxNodes: 50_000,
  /** YAML documents in one plain file (spec 3.1 allows several). */
  maxDocuments: 16,
  /** Nesting depth; RFC 8785 canonicalization (the digest) allows 64 as well. */
  maxDepth: 64,
  /** Workflow steps and agents per document: closures and cycle search are quadratic in them. */
  maxSteps: 1000,
  maxAgents: 1000,
  /** YAML aliases (`*name`), counted with their expansion by the parser. */
  maxAliasCount: 50,
  /** Findings returned; more are replaced by one `limit.findings` entry. */
  maxFindings: 200,
} as const;

export type ManifestFindingSeverity = 'error' | 'warning';

/**
 * One finding. `code` and `path` are the identifiers of the AWP rule catalogue (`schema/README.md`):
 * the same codes and JSON Pointers any AWP validator reports for the same document. Codes of the
 * form `extension.*`, `wrapper.*` and `limit.*` are OpenAgentix's own (docs/awp.md).
 */
export interface ManifestFinding {
  severity: ManifestFindingSeverity;
  code: string;
  /** RFC 6901 JSON Pointer into the effective manifest ('' = the document). */
  path: string;
  message: string;
  /** Zero-based index of the YAML document the finding belongs to. */
  document?: number;
  /** AWP specification section ('' when the rule is not tied to one). */
  section: string;
}

/** Where the manifest came from: an `agents.md` front matter or a plain JSON/YAML document. */
export type ManifestLayout = 'markdown' | 'document';

export interface ValidateManifestOptions {
  /**
   * `auto` (default): `{`-started text and `---` front matter are recognised; a text that is not
   * an AWP manifest (no `apiVersion: awp.…`) is reported as not applicable, not as invalid.
   * `markdown`: front matter plus `## Agent:` sections. `document`: the whole text is one
   * YAML or JSON document (`.awp.yaml`, `.awp.json`). With `markdown` or `document` the text is
   * always validated as AWP.
   */
  layout?: 'auto' | ManifestLayout;
  /**
   * Profiles the validator supports. Default: `SUPPORTED_AWP_PROFILES`. Tests set it to run the
   * vendored conformance cases, which name their profiles; production code never does.
   */
  profiles?: readonly string[];
  /** Compare a declared `metadata.integrity.digest` with the computed one. Default: true. */
  verifyDigest?: boolean;
  /**
   * Test hook: a replacement for the embedded pinned schemas (the drift tests validate against a
   * schema that gained a property). Never set in production code.
   */
  schemas?: { awp?: Record<string, unknown>; extensions?: Record<string, unknown> };
}

/** Outcome for one YAML document (an `agents.md` file and a JSON file have exactly one). */
export interface ManifestDocumentResult {
  /** No error finding for this document. Warnings do not make a manifest invalid. */
  valid: boolean;
  /** The effective manifest (front matter with the `## Agent:` section texts injected), if valid. */
  manifest: AwpManifest | null;
  /**
   * `sha256:<hex>` over the RFC 8785 form of the effective manifest without `metadata.integrity`,
   * `signature` and `provenance` (AWP spec 9.1). Independent of YAML or JSON formatting. `null` when
   * the document is not a structurally valid manifest.
   */
  digest: string | null;
  /** `metadata.name`, `metadata.version` and `kind` when the manifest is valid. */
  name: string | null;
  version: string | null;
  kind: string | null;
}

export interface ManifestValidation extends ManifestDocumentResult {
  /** All documents valid (and at least one). Same as `documents[0].valid` for a single document. */
  valid: boolean;
  layout: ManifestLayout;
  /** Findings of all documents; `document` is the zero-based index of the YAML document. */
  findings: ManifestFinding[];
  documents: ManifestDocumentResult[];
}
