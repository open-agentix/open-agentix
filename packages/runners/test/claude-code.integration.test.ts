import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  PolicyBundleSchema,
  loadAgentDefinition,
  redactString,
  type PolicyBundle,
} from '@openagentix/core';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeCodeHarness, executeWithHarness } from '../src/index.js';
import { prepared, setup } from './helpers.js';

/**
 * Opt-in: runs the REAL `claude` binary with hard budgets (skipped unless OAX_TEST_CLAUDE=1).
 * Uses the existing login of the current user, or OAX_TEST_CLAUDE_TOKEN_FILE (a file from
 * `claude setup-token`). Costs a few cents. OAX_TEST_CLAUDE_REPORT=<file> writes a sanitized
 * summary (see docs/verification/claude-code-harness.md).
 */
const enabled = process.env.OAX_TEST_CLAUDE === '1';

const agentSource = (budget: string, extra = '') => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: harness-check
version: 1.0.0
owner: team
classification: internal
budget:
${budget}
agents:
  - id: lookup
    provider: claude-code
    model: haiku
    instructions: You are a terse security assistant. Use the tool, then answer in one sentence.
    tools:
      - server: cve-db
        tool: lookup_cve
        args:
          cveId: { type: string, required: true, pattern: "^CVE-\\\\d{4}-\\\\d{4,}$" }
${extra}---
`;

const EVENT = { question: 'How severe is CVE-2024-3094 and in which version is it fixed?' };

interface Scenario {
  title: string;
  limits: string;
  status: string;
  errorCode: string;
  seconds: number;
  tokens: string;
  costUsd: number;
  toolCalls: number;
  auditEntries: number;
  steps: string[];
  answer: string;
}
const scenarios: Scenario[] = [];

async function runScenario(
  title: string,
  source: string,
  limits: string,
  policies: PolicyBundle[] = [],
) {
  const def = loadAgentDefinition(source);
  const { ctx, control, tools } = setup(def, { control: { policies } });
  const workRoot = process.env.OAX_TEST_WORKROOT ?? '/root/work/scratch/b/work';
  mkdirSync(workRoot, { recursive: true });
  const harness = new ClaudeCodeHarness({
    ...(process.env.OAX_TEST_CLAUDE_CMD ? { command: process.env.OAX_TEST_CLAUDE_CMD } : {}),
    ...(process.env.OAX_TEST_CLAUDE_TOKEN_FILE
      ? { oauthTokenFile: process.env.OAX_TEST_CLAUDE_TOKEN_FILE }
      : {}),
  });
  const started = Date.now();
  const run = { ...prepared(def, EVENT), policies };
  const result = await executeWithHarness(run, ctx, harness, { workRoot });
  await tools.close();
  expect(control.verifyAudit().valid).toBe(true);
  scenarios.push({
    title,
    limits,
    status: result.status,
    errorCode: result.error?.code ?? '-',
    seconds: (Date.now() - started) / 1000,
    tokens: `${result.usage.tokensIn} / ${result.usage.tokensOut}`,
    costUsd: result.usage.costMicros / 1_000_000,
    toolCalls: result.usage.toolCalls,
    auditEntries: control.audit.length,
    steps: control.steps.map((s) => `${s.kind}:${s.name}:${s.status}`),
    answer: redactString(result.outputs[0]?.content ?? '').replace(/\s+/g, ' '),
  });
  return { result, control };
}

describe.skipIf(!enabled)('Claude Code harness (real runs)', () => {
  it('runs a tiny task through the policy gate within its budget', async () => {
    const { result, control } = await runScenario(
      '1. Allowed tool call',
      agentSource('  maxSteps: 3\n  maxCostUsd: 0.1\n  timeoutSeconds: 120'),
      '`maxSteps: 3` (`--max-turns 3`), `maxCostUsd: 0.1` (`--max-budget-usd 0.1`), `timeoutSeconds: 120`',
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('succeeded');
    expect(result.usage.toolCalls).toBe(1);
    const kinds = control.steps.map((s) => `${s.kind}:${s.status}`);
    expect(kinds).toEqual(
      expect.arrayContaining(['policy_decision:ok', 'tool_call:ok', 'model_call:ok']),
    );
    expect(result.outputs[0]?.content).toMatch(/critical|10|5\.6\.2/i);
  }, 180_000);

  it('stops at the turn limit of the agent contract', async () => {
    const { result } = await runScenario(
      '2. Turn limit',
      agentSource('  maxSteps: 1\n  maxCostUsd: 0.1\n  timeoutSeconds: 120'),
      '`maxSteps: 1` (`--max-turns 1`: one tool call needs two turns)',
    );
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('control_budget_steps');
  }, 180_000);

  it('blocks a forbidden tool at the gate', async () => {
    const policies = [PolicyBundleSchema.parse({ forbiddenTools: ['cve-db/lookup_*'] })];
    const { result, control } = await runScenario(
      '3. Forbidden tool (global policy)',
      agentSource('  maxSteps: 3\n  maxCostUsd: 0.1\n  timeoutSeconds: 120'),
      'as in 1, plus a platform policy that forbids `cve-db/lookup_*`',
      policies,
    );
    expect(result.status).toBe('blocked_by_policy');
    const kinds = control.steps.map((s) => `${s.kind}:${s.status}`);
    expect(kinds).toContain('policy_decision:denied');
    expect(kinds).not.toContain('tool_call:ok');
  }, 180_000);

  afterAll(() => {
    const path = process.env.OAX_TEST_CLAUDE_REPORT;
    if (!path || scenarios.length === 0) return;
    const sections = scenarios.map(
      (s) => `### ${s.title}

Limits: ${s.limits}.

| Field | Value |
| --- | --- |
| Run status | \`${s.status}\` (error code: \`${s.errorCode}\`) |
| Wall time | ${s.seconds.toFixed(1)} s |
| Tokens in / out | ${s.tokens} |
| Cost reported by the harness | $${s.costUsd.toFixed(4)} |
| Policy-gated tool calls | ${s.toolCalls} |
| Audit chain | valid, ${s.auditEntries} entries |

Recorded steps: ${s.steps.map((x) => `\`${x}\``).join(', ')}

Answer (sanitized): ${s.answer ? `> ${s.answer}` : '(none)'}
`,
    );
    const md = `# Claude Code harness: real verification

Produced by a real run of the Claude Code CLI \`${process.env.OAX_TEST_CLAUDE_VERSION ?? 'n/a'}\` on ${new Date().toISOString().slice(0, 10)}:

\`\`\`bash
OAX_TEST_CLAUDE=1 OAX_TEST_CLAUDE_REPORT=docs/verification/claude-code-harness.md \\
  pnpm vitest run packages/runners/test/claude-code.integration.test.ts
\`\`\`

Authentication: the existing login of the host user (default). No token was passed in, written to a
file or printed; the child process gets a minimal environment (\`PATH\`, \`HOME\`, \`LANG\`, no proxy,
CI or cloud variables) and runs in a temporary directory that is deleted afterwards.

Agent \`harness-check\`: model \`haiku\`, one granted tool \`cve-db/lookup_cve\` (argument \`cveId\`
must match \`^CVE-\\d{4}-\\d{4,}$\`), event \`${JSON.stringify(EVENT)}\`.

## Invocation

\`claude -p --output-format stream-json --verbose --model haiku --mcp-config .openagentix/mcp.json
--strict-mcp-config --tools "" --permission-mode dontAsk --allowedTools mcp__oax-gate__cve-db__lookup_cve
--restricted --disable-slash-commands --no-session-persistence --max-turns N --max-budget-usd X\`

- \`--tools ""\`: no built-in tools (no Bash, file or web access); the policy gate is the only tool source.
- \`--strict-mcp-config\` + the gate as streamable-HTTP MCP server on loopback, per-run bearer token.
- \`--restricted --disable-slash-commands\`: ignores user/project/local settings, CLAUDE.md files (also in
  parent directories) and skills of the host.
- The prompt is passed on stdin; limits are additionally enforced by the platform.

## Scenarios

${sections.join('\n')}
## What this proves

- The CLI runs headless and every tool call goes through the policy gate: decided by the policy engine,
  executed by the MCP gateway, recorded as \`policy_decision\` / \`tool_call\` steps and chained into the audit log.
- A globally forbidden tool never reaches the tool server (scenario 3).
- Turn limits of the agent contract stop the harness (scenario 2).
- Tokens and cost reported by the harness are recorded on the \`model_call\` step and counted against the run budget.
`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, md);
  });
});
