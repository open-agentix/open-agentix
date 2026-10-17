#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AWP_LIMITS,
  LEGACY_CONVERT_COMMAND,
  LEGACY_FORMAT_REMOVED_IN,
  LEGACY_REMOVED_CODE,
  PolicyBundleSchema,
  PriceTableSchema,
  legacyFormatPhase,
  legacyRemovedMessage,
  manifestIssues,
  validateAgentSource,
  validateManifestSource,
} from '@openagentix/core';
import { parseProviderConfigs } from '@openagentix/providers';
import { AWP_USAGE, runAwpCommand } from './cli-awp.js';
import { PLAN_USAGE, runPlanCommand } from './cli-plan.js';
import { createHarness } from './harness.js';
import { runLocal } from './local.js';
import type { StepInput } from './types.js';

export const CLI_VERSION = '0.2.0-alpha.1';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  readFile: (path: string) => Promise<string>;
  /** Size in bytes, to refuse an oversized AWP manifest before reading it (optional). */
  fileSize?: (path: string) => Promise<number>;
  env: NodeJS.ProcessEnv;
  /** Version used to pick the phase of the legacy format (tests of release N+1); default: this build. */
  version?: string;
}

const USAGE = `oax ${CLI_VERSION} - run openagentix agents locally

Usage:
  oax run <agents.md> --event <event.json> [options]
  oax validate <agents.md | manifest.awp.yaml | manifest.awp.json>
  oax plan check|generate <plan.yaml> (see "oax plan --help")
  oax awp export|convert <agents.md>, oax awp legacy-report <agents.md>... (see "oax awp --help")
  oax --version

Options for "run":
  --event <file>       CloudEvent or plain JSON payload (required)
  --mcp <file>         JSON array of MCP server configs (default: built-in demo servers)
  --providers <file>   JSON array of provider configs (default: env OAX_PROVIDERS or "simulated")
  --policy <file>      JSON policy bundle applied on top of the agent file
  --prices <file>      JSON price table for cost calculation
  --approve <all|none> answer to approval requests (default: none = reject)
  --harness <name>     run through an external harness instead of the built-in loop
                       (claude-code, opencode; hermes and openclaw are documented stubs)
  --harness-token-file <file>  token from "claude setup-token" (default: login of this user)
                       opencode: model connection from --providers/OAX_PROVIDERS (the agent's
                       provider: name), binary OAX_OPENCODE_BIN, pin OAX_OPENCODE_SHA256
  --json               print steps and the result as JSON lines
`;

/** Front matter of the legacy file format. */
const LEGACY_FILE = /(?:^|[{,])\s*["']?apiVersion["']?\s*:\s*["']?openagentix\.io\/v1alpha1/m;

/** The one deprecation warning of a legacy file (`legacy_format`). */
const legacyWarning = (): string =>
  `warning legacy_format -: the file format openagentix.io/v1alpha1 is deprecated and is rejected from release ${LEGACY_FORMAT_REMOVED_IN}; convert it with "${LEGACY_CONVERT_COMMAND}" (docs/agents-md.md)`;

function parseArgs(argv: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (
        key === 'json' ||
        key === 'version' ||
        key === 'help' ||
        key === 'canonical' ||
        next === undefined ||
        next.startsWith('--')
      )
        flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function formatStep(s: StepInput): string {
  const cost = s.costMicros ? ` cost=$${(s.costMicros / 1e6).toFixed(6)}` : '';
  const tokens = s.tokensIn || s.tokensOut ? ` tokens=${s.tokensIn ?? 0}/${s.tokensOut ?? 0}` : '';
  return `[${s.agentId ?? '-'}] ${s.kind.padEnd(15)} ${s.status.padEnd(8)} ${s.name}${tokens}${cost}`;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, file, file2, ...more] = positional;
  if (flags.version) {
    io.out(CLI_VERSION);
    return 0;
  }
  if (cmd === 'plan' && flags.help) {
    io.out(USAGE + PLAN_USAGE);
    return 0;
  }
  if (cmd === 'awp' && flags.help) {
    io.out(USAGE + AWP_USAGE);
    return 0;
  }
  if (!cmd || flags.help) {
    io.out(USAGE);
    return cmd ? 0 : 2;
  }
  try {
    if (cmd === 'validate') {
      if (!file) throw new Error('missing <agents.md>');
      // Only *.awp.yaml, *.awp.yml and *.awp.json are AWP documents; an .md file is read as AWP when
      // its front matter says apiVersion: awp.…; any other file keeps the legacy agents.md message.
      const isAwpFile = /\.awp\.(?:ya?ml|json)$/i.test(file);
      if (isAwpFile && io.fileSize) {
        const size = await io.fileSize(file);
        if (size > AWP_LIMITS.maxSourceBytes) {
          io.err(
            `error   limit.size -: the file is larger than ${AWP_LIMITS.maxSourceBytes} bytes`,
          );
          io.out('invalid');
          return 1;
        }
      }
      const text = await io.readFile(file);
      const awp = isAwpFile
        ? validateManifestSource(text, { layout: 'document' })
        : /\.md$/i.test(file)
          ? validateManifestSource(text, { layout: 'auto' })
          : null;
      if (awp) {
        const { errors, warnings } = manifestIssues(awp);
        for (const e of errors) io.err(`error   ${e.code} ${e.path || '-'}: ${e.message}`);
        for (const w of warnings) io.err(`warning ${w.code} ${w.path || '-'}: ${w.message}`);
        io.out(
          awp.valid
            ? `valid: ${awp.documents.length === 1 ? `${awp.name}@${awp.version} ${awp.digest}` : `${awp.documents.length} documents`} (AWP draft v1alpha1, built to the schema, conformance in progress)`
            : 'invalid',
        );
        return awp.valid ? 0 : 1;
      }
      // AWP-3b: the legacy format is deprecated (release N) and rejected from release N+1.
      if (LEGACY_FILE.test(text) && legacyFormatPhase(io.version ?? CLI_VERSION) === 'removed') {
        io.err(`error   ${LEGACY_REMOVED_CODE} apiVersion: ${legacyRemovedMessage()}`);
        io.out('invalid');
        return 1;
      }
      const r = validateAgentSource(text);
      if (LEGACY_FILE.test(text)) io.err(legacyWarning());
      for (const e of r.errors) io.err(`error   ${e.path}: ${e.message}`);
      for (const w of r.warnings) io.err(`warning ${w.path}: ${w.message}`);
      io.out(r.valid ? `valid: ${r.definition?.name}@${r.definition?.version}` : 'invalid');
      return r.valid ? 0 : 1;
    }
    if (cmd === 'plan') return await runPlanCommand(file, file2, flags, io);
    if (cmd === 'awp') return await runAwpCommand(file, file2, flags, io, more);
    if (cmd !== 'run') {
      io.err(`unknown command "${cmd}"`);
      io.out(USAGE);
      return 2;
    }
    if (!file || typeof flags.event !== 'string')
      throw new Error('usage: oax run <agents.md> --event <event.json>');
    const json = flags.json === true;
    const readJson = async (key: string) =>
      typeof flags[key] === 'string'
        ? (JSON.parse(await io.readFile(flags[key])) as unknown)
        : undefined;
    const providersJson =
      typeof flags.providers === 'string'
        ? await io.readFile(flags.providers)
        : io.env.OAX_PROVIDERS;
    const policy = await readJson('policy');
    const prices = await readJson('prices');
    const report = await runLocal({
      agentsSource: await io.readFile(file),
      event: await readJson('event'),
      providers: parseProviderConfigs(providersJson),
      ...(flags.mcp ? { mcpServers: (await readJson('mcp')) as never } : {}),
      ...(policy ? { policies: [PolicyBundleSchema.parse(policy)] } : {}),
      ...(prices ? { prices: PriceTableSchema.parse(prices) } : {}),
      ...(typeof flags.harness === 'string'
        ? {
            harness: createHarness(flags.harness as never, {
              ...(typeof flags['harness-token-file'] === 'string'
                ? { oauthTokenFile: flags['harness-token-file'] }
                : {}),
              opencode: {
                providers: parseProviderConfigs(providersJson),
                ...(io.env.OAX_OPENCODE_BIN ? { command: io.env.OAX_OPENCODE_BIN } : {}),
                ...(io.env.OAX_OPENCODE_SHA256
                  ? { expectedSha256: io.env.OAX_OPENCODE_SHA256 }
                  : {}),
              },
            }),
          }
        : {}),
      approve: flags.approve === 'all' ? 'all' : 'none',
      onStep: (s) => io.out(json ? JSON.stringify({ type: 'step', step: s }) : formatStep(s)),
    });
    if (json) {
      io.out(
        JSON.stringify({
          type: 'result',
          runId: report.runId,
          result: report.result,
          audit: report.audit,
        }),
      );
    } else {
      io.out('');
      for (const o of report.result.outputs)
        io.out(`--- output of ${o.agentId} (${o.format}) ---\n${o.content}`);
      const u = report.result.usage;
      io.out(
        `status=${report.result.status} steps=${u.steps} toolCalls=${u.toolCalls} tokens=${u.tokensIn}/${u.tokensOut} cost=$${(u.costMicros / 1e6).toFixed(6)}`,
      );
      if (report.result.error)
        io.out(`error=${report.result.error.code}: ${report.result.error.message}`);
      io.out(
        `audit: ${report.audit.valid ? 'valid' : 'INVALID'} (${report.audit.checkedEntries} entries, head ${report.audit.headHash.slice(0, 12)})`,
      );
    }
    return report.result.status === 'succeeded' ? 0 : 1;
  } catch (e) {
    io.err(`oax: ${(e as Error).message}`);
    return 2;
  }
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/* v8 ignore start */
if (isMain()) {
  runCli(process.argv.slice(2), {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    readFile: (p) => readFile(p, 'utf8'),
    fileSize: async (p) => (await stat(p)).size,
    env: process.env,
  }).then((code) => {
    process.exitCode = code;
  });
}
/* v8 ignore stop */
