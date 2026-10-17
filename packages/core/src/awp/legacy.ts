/**
 * Transition of the legacy `openagentix.io/v1alpha1` file format to AWP manifests (AWP-3b, decision
 * D13 of the AWP decision log). AWP is a draft (`v1alpha1`); nothing here is a conformance claim.
 *
 * Two releases, switched by a constant tied to the version (not by a runtime flag):
 * - release N (every build below {@link LEGACY_FORMAT_REMOVED_IN}): legacy files are accepted on
 *   validate, publish and import, every read reports the deprecation `legacy_format`;
 * - release N+1 (this version and later): the legacy format is rejected on every write path with
 *   `legacy_format_removed`, naming `oax awp convert`, and a version marked `legacy-unconvertible`
 *   is refused at run time with the same error.
 */

/** `apiVersion` of the legacy `agents.md` front matter. */
export const LEGACY_API_VERSION = 'openagentix.io/v1alpha1';

/** First release that no longer accepts the legacy format (release N+1). Pre-1.0: a MINOR. */
export const LEGACY_FORMAT_REMOVED_IN = '0.4.0';

/** The command that converts a legacy file. */
export const LEGACY_CONVERT_COMMAND = 'oax awp convert';

export type LegacyPhase = 'deprecated' | 'removed';

const CORE_VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+].*)?$/;

function core(version: string): [number, number, number] | null {
  const m = CORE_VERSION.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The phase of a build. The comparison is on `MAJOR.MINOR.PATCH` only, so a pre-release of N+1
 * (`0.4.0-alpha.1`) already behaves as N+1. A version that cannot be read counts as `deprecated`:
 * the transition never switches a write path off by accident.
 */
export function legacyFormatPhase(
  version: string,
  removedIn: string = LEGACY_FORMAT_REMOVED_IN,
): LegacyPhase {
  const v = core(version);
  const r = core(removedIn);
  if (!v || !r) return 'deprecated';
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== r[i]!) return v[i]! > r[i]! ? 'removed' : 'deprecated';
  }
  return 'removed';
}

export interface Deprecation {
  /** Stable code. */
  code: 'legacy_format';
  message: string;
  /** First release that rejects the legacy format. */
  removedIn: string;
  /** Where the conversion is documented. */
  docs: string;
}

/** The one deprecation entry every legacy read carries. */
export function legacyDeprecation(removedIn: string = LEGACY_FORMAT_REMOVED_IN): Deprecation {
  return {
    code: 'legacy_format',
    message:
      `the file format ${LEGACY_API_VERSION} is deprecated and is rejected from release ${removedIn}; ` +
      `convert it with "${LEGACY_CONVERT_COMMAND}" (docs/agents-md.md)`,
    removedIn,
    docs: 'docs/agents-md.md#transition-to-awp-manifests',
  };
}

/** The error of a write path (or a run of an unconvertible version) once the format is removed. */
export const LEGACY_REMOVED_CODE = 'legacy_format_removed';

export function legacyRemovedMessage(detail?: string): string {
  return (
    `the file format ${LEGACY_API_VERSION} is no longer accepted${detail ? ` (${detail})` : ''}; ` +
    `convert it with "${LEGACY_CONVERT_COMMAND}"`
  );
}

/** True when a front matter `apiVersion` is the legacy format. */
export const isLegacyApiVersion = (apiVersion: unknown): boolean =>
  apiVersion === LEGACY_API_VERSION;
