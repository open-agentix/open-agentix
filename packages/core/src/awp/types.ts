/**
 * Types of the AWP manifest exporter (`export.ts`).
 *
 * AWP is a draft (`v1alpha1`). The exporter maps a stored OpenAgentix definition to an AWP
 * manifest built to the pinned schema (`packages/awp/vendor/`). The output is a mapping, not a
 * conformance claim: openagentix is not conformant to any AWP profile.
 */

export const AWP_API_VERSION = 'awp.agenticworkflowprotocol.org/v1alpha1';

/** Prefix of every OpenAgentix extension field (docs/awp.md, AWP `x-` mechanism). */
export const EXTENSION_PREFIX = 'x-openagentix-';

/**
 * What the pinned AWP version offers. `requiredExtensions` is AEP-0011 (draft, not part of
 * `v1alpha1`): while it is `false`, a manifest with a critical extension is refused (decision D3).
 * `packages/core/test/awp-export-pin.test.ts` fails when the vendored schema disagrees, so a pin
 * upgrade cannot silently change what the exporter does.
 */
export const PINNED_AWP_FEATURES = { requiredExtensions: false } as const;

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Stable codes of a refusal; `critical_extension` is one finding per source field (D3). */
export type ExportFindingCode =
  | 'owner_team_required'
  | 'critical_extension'
  | 'wildcard_expansion_missing'
  | 'profile_expansion_missing'
  | 'tool_name_not_representable'
  | 'duplicate_grant_conflict'
  | 'trigger_not_representable'
  | 'egress_not_representable'
  | 'owner_team_mismatch'
  | 'label_not_representable'
  | 'secret_not_representable'
  | 'pipeline_not_representable'
  | 'unknown_field'
  | 'grant_widened'
  | 'conversion_error'
  | 'not_canonicalizable';

export interface ExportFinding {
  code: ExportFindingCode;
  /** Path of the source field in the stored definition (dotted, as in `agents.md` validation). */
  path: string;
  message: string;
  /** For `critical_extension`: the source field and the extension that would carry it. */
  field?: string;
  extension?: string;
}

export interface ExportOptions {
  /**
   * Name of the team that owns the agent (decision D15: an AWP owner is a team). `null` or
   * `undefined`: the agent has no team and the export is refused with `owner_team_required`.
   */
  ownerTeam: string | null | undefined;
  /** Defaults to `PINNED_AWP_FEATURES.requiredExtensions`; overridable for tests only. */
  requiredExtensionsSupported?: boolean;
}

export type ExportResult =
  | {
      ok: true;
      manifest: JsonObject;
      /** `sha256:<hex>` over the JCS form of the manifest (AWP spec 9.1), also in the manifest. */
      digest: string;
      /**
       * SHA-256 (hex) of the normalised `agents.md` source, as stored with the version. It is
       * deliberately not in the manifest: it changes with YAML formatting, the manifest digest
       * must not.
       */
      sourceDigest: string;
      /** Profiles a validator needs for the manifest (`core` plus `mcp` / `governance`). */
      profiles: string[];
    }
  | { ok: false; findings: ExportFinding[] };
