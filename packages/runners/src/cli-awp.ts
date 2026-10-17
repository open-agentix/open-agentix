import {
  AWP_LIMITS,
  LEGACY_CONVERT_COMMAND,
  LEGACY_FORMAT_REMOVED_IN,
  exportAwpManifest,
  jcs,
  validateAgentSource,
  validateManifestSource,
  type ExportFinding,
} from '@openagentix/core';
import type { CliIo } from './cli.js';

export const AWP_USAGE = `
AWP commands (AWP is a draft, v1alpha1; the output is a mapping, not a conformance claim):
  oax awp export <agents.md> --owner-team <team> [--canonical]
  oax awp convert <agents.md> --owner-team <team> [--canonical]
  oax awp legacy-report <agents.md>... [--owner-team <team>]

Exports the effective AWP manifest of a file as parsed. Profile grants and wildcard tool grants
cannot be enumerated without a published version, so they are refused here; a published version is
exported by the control node: GET /v1/agents/{id}/versions/{version}/awp (the CLI has no client
for the control node yet, so "oax awp export <agent-id>@<version>" is refused with a pointer to it).
--owner-team asserts that the file's owner is a team (an AWP owner is a team); without it the
export is refused. --canonical prints the RFC 8785 form. Exit 1 when the export is refused: one
finding per restricted field is printed on stderr, and no manifest is written.

"convert" is the one-time conversion of a legacy openagentix.io/v1alpha1 file to an AWP manifest
(the legacy format is deprecated and is rejected from release ${LEGACY_FORMAT_REMOVED_IN}; docs/agents-md.md).
It is the strict export: a file whose limits AWP v1alpha1 cannot express is refused with one finding
per field, never converted lossy, and a conversion never grants more than the file granted.

"legacy-report" runs that conversion for every file given and lists which would convert and which
are refused, with the field-level reasons. Offline, so profile and wildcard grants (which are
expanded when a version is published) are listed as "needs publish context" instead of failing.
Without --owner-team the \`owner\` of each file is assumed to be its team. Stored versions: the
control node reports them at GET /v1/agents/legacy-report. Exit 1 when a file is refused.
`;

type Flags = Record<string, string | boolean>;

/** `<agent-id>@<version>`: a published version, which only the control node can export. */
const VERSIONED_AGENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@\S+$/i;

/** Reads a file after checking its size (untrusted input); null when it is too large. */
async function readBounded(file: string, io: CliIo): Promise<string | null> {
  if (io.fileSize && (await io.fileSize(file)) > AWP_LIMITS.maxSourceBytes) {
    io.err(`error   limit.size -: ${file} is larger than ${AWP_LIMITS.maxSourceBytes} bytes`);
    return null;
  }
  return io.readFile(file);
}

function printReport(findings: ExportFinding[], io: CliIo): void {
  for (const f of findings) io.err(`error   ${f.code} ${f.path}: ${f.message}`);
}

async function exportFile(
  file: string,
  flags: Flags,
  io: CliIo,
  mode: 'export' | 'convert',
): Promise<number> {
  const text = await readBounded(file, io);
  if (text === null) return 1;
  if (mode === 'convert' && validateManifestSource(text, { layout: 'auto' })) {
    io.err('error   the file is already an AWP manifest: nothing to convert');
    return 1;
  }
  const validated = validateAgentSource(text);
  if (!validated.definition) {
    for (const e of validated.errors) io.err(`error   ${e.path || '-'}: ${e.message}`);
    io.out('invalid');
    return 1;
  }
  const team = typeof flags['owner-team'] === 'string' ? flags['owner-team'] : null;
  const result = exportAwpManifest(validated.definition, { ownerTeam: team });
  printReport(result.ok ? [] : result.findings, io);
  if (!result.ok) {
    if (mode === 'convert')
      io.err(
        'error   the file cannot be converted without losing a limit: nothing was written (docs/agents-md.md)',
      );
    return 1;
  }
  if (mode === 'convert')
    io.err(
      `converted to an AWP v1alpha1 manifest (a draft; built to the schema, conformance in progress); review it, then replace the legacy file. "${LEGACY_CONVERT_COMMAND}" never grants more than the file granted.`,
    );
  io.out(
    flags.canonical === true ? jcs(result.manifest) : JSON.stringify(result.manifest, null, 2),
  );
  return 0;
}

/** Findings that only a publish can resolve (profile and wildcard grants are expanded there). */
const NEEDS_PUBLISH = new Set(['profile_expansion_missing', 'wildcard_expansion_missing']);

async function legacyReport(files: string[], flags: Flags, io: CliIo): Promise<number> {
  const team = typeof flags['owner-team'] === 'string' ? flags['owner-team'] : null;
  let convertible = 0;
  let refused = 0;
  let needsPublish = 0;
  for (const file of files) {
    const text = await readBounded(file, io);
    if (text === null) {
      refused += 1;
      io.out(`invalid       ${file}`);
      continue;
    }
    const validated = validateAgentSource(text);
    if (!validated.definition) {
      refused += 1;
      io.out(`invalid       ${file}`);
      for (const e of validated.errors) io.err(`  error   ${e.path || '-'}: ${e.message}`);
      continue;
    }
    const result = exportAwpManifest(validated.definition, {
      ownerTeam: team ?? validated.definition.owner,
    });
    if (result.ok) {
      convertible += 1;
      io.out(`convertible   ${file}`);
      continue;
    }
    const onlyContext = result.findings.every((f) => NEEDS_PUBLISH.has(f.code));
    if (onlyContext) needsPublish += 1;
    else refused += 1;
    io.out(`${onlyContext ? 'needs-publish-context' : 'unconvertible '} ${file}`);
    for (const f of result.findings) io.err(`  ${f.code} ${f.path}: ${f.message}`);
  }
  io.out(
    `${files.length} file(s): ${convertible} convertible, ${refused} unconvertible, ${needsPublish} need publish context`,
  );
  return refused > 0 ? 1 : 0;
}

/** `oax awp export|convert <file>`, `oax awp legacy-report <file>...`; returns the exit code. */
export async function runAwpCommand(
  sub: string | undefined,
  target: string | undefined,
  flags: Flags,
  io: CliIo,
  rest: string[] = [],
): Promise<number> {
  if (sub === 'legacy-report' && target) return legacyReport([target, ...rest], flags, io);
  if ((sub !== 'export' && sub !== 'convert') || !target) {
    io.err('usage: oax awp export|convert <agents.md> | oax awp legacy-report <agents.md>...');
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
  return exportFile(target, flags, io, sub);
}
