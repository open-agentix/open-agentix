import { exportAwpManifest, type ExportResult, type PublishedDefinition } from '@openagentix/core';
import type { AgentRow, AgentVersionRow } from './agents.js';

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
  return exportAwpManifest(definition, {
    ownerTeam: agent.teamId === null ? null : definition.owner,
  });
}
