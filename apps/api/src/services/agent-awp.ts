import {
  awpManifestDigest,
  exportAwpManifest,
  verifyNoWidening,
  type ExportFinding,
  profilesOf,
  type ExportResult,
  type JsonObject,
  type PublishedDefinition,
} from '@openagentix/core';
import type { AgentRow, AgentVersionRow } from './agents.js';
import type { StoredAwpRow } from './legacy-awp.js';

/**
 * The AWP manifest of a published version, computed from the stored effective definition (never
 * re-parsed from the source with a newer parser). The bytes are recomputed on every call: they are
 * stable for one exporter version, and a later exporter version may change them.
 *
 * Decision D15: an AWP owner is a team. `definition.owner` is a slug the author wrote and publish
 * does not tie it to the agent's team, so it is only exported when it resolves to the team the agent
 * belongs to (checked now, so a renamed team makes the export refuse rather than name another team).
 */
export async function exportVersionAsAwp(
  agent: AgentRow,
  version: AgentVersionRow,
  teamIdOfOwner: (slug: string) => Promise<string | null>,
  stored?: StoredAwpRow,
): Promise<ExportResult> {
  const definition = version.definition as PublishedDefinition;
  if (agent.teamId !== null && (await teamIdOfOwner(definition.owner)) !== agent.teamId)
    return {
      ok: false,
      findings: [
        {
          code: 'owner_team_mismatch',
          path: 'owner',
          message: `owner "${definition.owner}" is not the team of this agent`,
        },
      ],
    };
  // AWP-3b: the manifest stored next to the version is the effective one (stable across exporter
  // versions); a version the conversion refused stays refused, with the stored reasons.
  if (stored?.status === 'legacy-unconvertible')
    return {
      ok: false,
      findings: stored.findings as unknown as Extract<ExportResult, { ok: false }>['findings'],
    };
  if (stored?.status === 'converted' && stored.manifest && stored.manifestDigest) {
    // The stored row is served only if it still stands on its own: the digest is recomputed (a row
    // changed behind the application's back no longer matches) and the no-widening check runs
    // again. A new converter version can supersede a row by keying on `converter`; not built yet.
    const manifest = stored.manifest as JsonObject;
    const integrity = ((manifest.metadata ?? {}) as { integrity?: { digest?: unknown } }).integrity;
    const findings: ExportFinding[] = [];
    let recomputed: string | null = null;
    try {
      recomputed = awpManifestDigest(manifest);
    } catch {
      /* reported below */
    }
    if (recomputed !== stored.manifestDigest || integrity?.digest !== stored.manifestDigest)
      findings.push({
        code: 'stored_manifest_invalid',
        path: 'metadata.integrity.digest',
        message: 'the stored manifest does not match its digest',
      });
    findings.push(...verifyNoWidening(definition, manifest));
    if (findings.length > 0) return { ok: false, findings };
    return {
      ok: true,
      manifest,
      digest: stored.manifestDigest,
      sourceDigest: version.digest,
      profiles: profilesOf(manifest.spec as JsonObject),
    };
  }
  return exportAwpManifest(definition, {
    ownerTeam: agent.teamId === null ? null : definition.owner,
  });
}
