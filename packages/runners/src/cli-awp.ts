import {
  exportAwpManifest,
  jcs,
  validateAgentSource,
  type ExportFinding,
  type ExportWarning,
} from '@openagentix/core';
import type { CliIo } from './cli.js';

export const AWP_USAGE = `
AWP commands (AWP is a draft, v1alpha1; the output is a mapping, not a conformance claim):
  oax awp export <agents.md> --owner-team <team> [--canonical]

Exports the effective AWP manifest of a file as parsed. Profile grants and wildcard tool grants
cannot be enumerated without a published version, so they are refused here; a published version is
exported by the control node: GET /v1/agents/{id}/versions/{version}/awp (the CLI has no client
for the control node yet, so "oax awp export <agent-id>@<version>" is refused with a pointer to it).
--owner-team asserts that the file's owner is a team (an AWP owner is a team); without it the
export is refused. --canonical prints the RFC 8785 form. Exit 1 when the export is refused: one
finding per restricted field is printed on stderr, and no manifest is written.
`;

type Flags = Record<string, string | boolean>;

/** `<agent-id>@<version>`: a published version, which only the control node can export. */
const VERSIONED_AGENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@\S+$/i;

function printReport(findings: ExportFinding[], warnings: ExportWarning[], io: CliIo): void {
  for (const f of findings) io.err(`error   ${f.code} ${f.path}: ${f.message}`);
  for (const w of warnings) io.err(`warning ${w.code} ${w.path}: ${w.message}`);
}

async function exportFile(file: string, flags: Flags, io: CliIo): Promise<number> {
  const validated = validateAgentSource(await io.readFile(file));
  if (!validated.definition) {
    for (const e of validated.errors) io.err(`error   ${e.path || '-'}: ${e.message}`);
    io.out('invalid');
    return 1;
  }
  const team = typeof flags['owner-team'] === 'string' ? flags['owner-team'] : null;
  const result = exportAwpManifest(validated.definition, { ownerTeam: team });
  printReport(result.ok ? [] : result.findings, result.warnings, io);
  if (!result.ok) return 1;
  io.out(
    flags.canonical === true ? jcs(result.manifest) : JSON.stringify(result.manifest, null, 2),
  );
  return 0;
}

/** `oax awp export <file>`; returns the process exit code. */
export async function runAwpCommand(
  sub: string | undefined,
  target: string | undefined,
  flags: Flags,
  io: CliIo,
): Promise<number> {
  if (sub !== 'export' || !target) {
    io.err('usage: oax awp export <agents.md>');
    io.out(AWP_USAGE);
    return 2;
  }
  if (VERSIONED_AGENT.test(target)) {
    const [id, version] = target.split('@');
    io.err(
      `error   a published version is exported by the control node: GET /v1/agents/${id}/versions/${version}/awp`,
    );
    return 2;
  }
  return exportFile(target, flags, io);
}
