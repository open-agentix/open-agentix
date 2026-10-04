import {
  OfferedConnectionsSchema,
  generateAgentsMd,
  lintPlan,
  parsePlan,
  type AgentPlanLint,
  type OfferedConnection,
} from '@openagentix/core';
import type { CliIo } from './cli.js';

export const PLAN_USAGE = `
Plan commands (deterministic, no model, nothing is stored or published):
  oax plan check <plan.yaml> [--connections <file>] [--json]
  oax plan generate <plan.yaml> [--connections <file>] [--provider <name>] [--model <id>] [--owner <slug>]

Options:
  --connections <file>  JSON array of offered connections: [{ "name": "jira",
                        "tools": { "get_issue": "read" }, "profiles": { "read": ["get_issue"] } }].
                        Without it capabilities are not verified (no LP004) and profile "read" is
                        the only read capability; every tool counts as write.
  --json                print the AgentPlanLint document as JSON ("check" only)
  --provider/--model/--owner  values written to the generated agents.md (default simulated/simulated/unassigned)

"check" exits 1 when the plan is invalid or has error findings; "generate" prints the draft to
stdout and refuses plans with error findings.
`;

type Flags = Record<string, string | boolean>;

const text = (flags: Flags, key: string): string | undefined =>
  typeof flags[key] === 'string' ? flags[key] : undefined;

function printLint(lint: AgentPlanLint, io: CliIo, to: 'out' | 'err'): void {
  const write = to === 'out' ? io.out : io.err;
  for (const f of lint.findings) write(`${f.severity.padEnd(7)} ${f.code} ${f.path}: ${f.message}`);
}

/** `oax plan check|generate <file>`; returns the process exit code. */
export async function runPlanCommand(
  sub: string | undefined,
  file: string | undefined,
  flags: Flags,
  io: CliIo,
): Promise<number> {
  if ((sub !== 'check' && sub !== 'generate') || !file) {
    io.err('usage: oax plan check|generate <plan.yaml>');
    io.out(PLAN_USAGE);
    return 2;
  }
  const parsed = parsePlan(await io.readFile(file));
  if (!parsed.plan) {
    for (const e of parsed.errors) io.err(`error   ${e.path || '-'}: ${e.message}`);
    io.out('invalid plan');
    return 1;
  }
  let offered: OfferedConnection[] | undefined;
  const connectionsFile = text(flags, 'connections');
  if (connectionsFile) {
    offered = OfferedConnectionsSchema.parse(JSON.parse(await io.readFile(connectionsFile)));
  } else {
    io.err('note: capabilities are not verified against connections (use --connections <file>)');
  }
  const lint = lintPlan(parsed.plan, offered);
  if (sub === 'check') {
    if (flags.json === true) io.out(JSON.stringify(lint, null, 2));
    else {
      printLint(lint, io, 'out');
      const s = lint.summary;
      io.out(`${lint.planDigest} errors=${s.error} warnings=${s.warning} info=${s.info}`);
    }
    return lint.summary.error > 0 ? 1 : 0;
  }
  if (lint.summary.error > 0) {
    printLint(lint, io, 'err');
    io.out('no draft: the plan has error findings');
    return 1;
  }
  printLint(lint, io, 'err');
  io.out(
    generateAgentsMd(parsed.plan, lint, {
      ...(text(flags, 'provider') ? { provider: text(flags, 'provider') as string } : {}),
      ...(text(flags, 'model') ? { model: text(flags, 'model') as string } : {}),
      ...(text(flags, 'owner') ? { owner: text(flags, 'owner') as string } : {}),
    }).trimEnd(),
  );
  return 0;
}
