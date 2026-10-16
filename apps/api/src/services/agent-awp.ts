import { exportAwpManifest, type ExportResult, type PublishedDefinition } from '@openagentix/core';
import type { AgentRow, AgentVersionRow } from './agents.js';

/**
 * The AWP manifest of a published version, computed from the stored effective definition (never
 * re-parsed from the source with a newer parser), so every call returns the same bytes.
 *
 * The owner team is the stored `owner` slug when the agent belongs to a team (decision D15). It is
 * not read from the live team record: renaming a team must not change a published export.
 */
export function exportVersionAsAwp(agent: AgentRow, version: AgentVersionRow): ExportResult {
  const definition = version.definition as PublishedDefinition;
  return exportAwpManifest(definition, {
    ownerTeam: agent.teamId === null ? null : definition.owner,
  });
}
