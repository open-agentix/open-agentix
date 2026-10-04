import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION, runCli, type CliIo } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function io(env: NodeJS.ProcessEnv = {}, files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readFile: async (p) => files[p] ?? readFile(p.startsWith('/') ? p : root + p, 'utf8'),
    env,
  };
  return { cli, out, err };
}

describe('oax CLI', () => {
  it('prints version and usage', async () => {
    const a = io();
    expect(await runCli(['--version'], a.cli)).toBe(0);
    expect(a.out).toEqual([CLI_VERSION]);
    const b = io();
    expect(await runCli([], b.cli)).toBe(2);
    expect(await runCli(['run', '--help'], b.cli)).toBe(0);
    const c = io();
    expect(await runCli(['frobnicate'], c.cli)).toBe(2);
    expect(c.err[0]).toMatch(/unknown command/);
  });

  it('validates agent files', async () => {
    const a = io();
    expect(await runCli(['validate', 'examples/cve-triage.agents.md'], a.cli)).toBe(0);
    expect(a.out).toEqual(['valid: cve-triage@1.0.0']);
    const b = io(
      {},
      {
        'bad.md':
          '---\napiVersion: openagentix.io/v1alpha1\nkind: Agent\nname: x\nversion: one\nowner: t\nagents:\n  - { id: a, provider: p, model: m, instructions: i }\n---\n',
      },
    );
    expect(await runCli(['validate', 'bad.md'], b.cli)).toBe(1);
    expect(b.err.join()).toMatch(/SemVer/);
    expect(await runCli(['validate'], io().cli)).toBe(2);
  });

  it('runs the cve-triage example with human-readable output', async () => {
    const a = io();
    const code = await runCli(
      ['run', 'examples/cve-triage.agents.md', '--event', 'examples/events/trivy-finding.json'],
      a.cli,
    );
    expect(code).toBe(0);
    const text = a.out.join('\n');
    expect(text).toMatch(/\[triage\] model_call/);
    expect(text).toMatch(/status=succeeded steps=\d+ toolCalls=2/);
    expect(text).toMatch(/audit: valid/);
  });

  it('runs with JSON output, policy, prices and providers files', async () => {
    const a = io(
      {},
      {
        'policy.json': JSON.stringify({ forbiddenTools: ['*/delete_*'] }),
        'prices.json': JSON.stringify([
          { provider: 'simulated', model: '*', inputPerMTok: 1, outputPerMTok: 1 },
        ]),
        'providers.json': JSON.stringify([{ kind: 'simulated', name: 'simulated' }]),
        'mcp.json': JSON.stringify([{ name: 'tickets', transport: 'in-memory' }]),
      },
    );
    const code = await runCli(
      [
        'run',
        'examples/ticket-updater.agents.md',
        '--event',
        'examples/events/jira-issue.json',
        '--json',
        '--policy',
        'policy.json',
        '--prices',
        'prices.json',
        '--providers',
        'providers.json',
        '--mcp',
        'mcp.json',
      ],
      a.cli,
    );
    expect(code).toBe(0);
    const last = JSON.parse(a.out.at(-1)!) as { type: string; result: { status: string } };
    expect(last).toMatchObject({ type: 'result', result: { status: 'succeeded' } });
  });

  it('returns 1 for failed runs and 2 for usage errors', async () => {
    const a = io({
      OAX_PROVIDERS: JSON.stringify([
        { kind: 'simulated', name: 'simulated', clearance: 'public' },
      ]),
    });
    expect(
      await runCli(
        [
          'run',
          'examples/cve-triage.agents.md',
          '--event',
          'examples/events/trivy-finding.json',
          '--approve',
          'all',
        ],
        a.cli,
      ),
    ).toBe(1);
    expect(a.out.join('\n')).toMatch(/error=control_classification/);
    const h = io();
    expect(
      await runCli(
        [
          'run',
          'examples/cve-triage.agents.md',
          '--event',
          'examples/events/trivy-finding.json',
          '--harness',
          'opencode',
          '--harness-token-file',
          'x',
        ],
        h.cli,
      ),
    ).toBe(1);
    expect(h.out.join('\n')).toMatch(/error=harness_provider_unsupported/);
    const b = io();
    expect(await runCli(['run', 'examples/cve-triage.agents.md'], b.cli)).toBe(2);
    expect(b.err[0]).toMatch(/usage/);
  });
});
