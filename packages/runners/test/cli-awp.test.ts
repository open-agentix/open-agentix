import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ID = '0b3f6c1e-8a52-4c1e-9d0a-5f6a7b8c9d0e';

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readFile: (p) => readFile(root + p, 'utf8'),
    env,
  };
  return { cli, out, err };
}

describe('oax awp export <file>', () => {
  it('prints the manifest of an exportable example', async () => {
    const a = io();
    const code = await runCli(
      ['awp', 'export', 'examples/awp/ticket-commenter.agents.md', '--owner-team', 'team-support'],
      a.cli,
    );
    expect(code).toBe(0);
    const manifest = JSON.parse(a.out.join('\n')) as {
      metadata: { owner: unknown; integrity: { digest: string } };
    };
    expect(manifest.metadata.owner).toEqual({ team: 'team-support' });
    expect(manifest.metadata.integrity.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.err).toEqual([]);
  });

  it('prints the RFC 8785 form with --canonical, in one line', async () => {
    const a = io();
    const args = ['awp', 'export', 'examples/awp/release-notes.agents.md', '--owner-team', 't'];
    expect(await runCli([...args, '--canonical'], a.cli)).toBe(0);
    expect(a.out).toHaveLength(1);
    expect(a.out[0]).toMatch(/^\{"apiVersion":"awp\./);
  });

  it('refuses without --owner-team (the owner of an AWP manifest is a team)', async () => {
    const a = io();
    expect(await runCli(['awp', 'export', 'examples/awp/release-notes.agents.md'], a.cli)).toBe(1);
    expect(a.err.join('\n')).toContain('owner_team_required');
    expect(a.out).toEqual([]);
  });

  it('refuses with one finding per restricted field and prints no manifest', async () => {
    const a = io();
    const code = await runCli(
      ['awp', 'export', 'examples/ticket-updater.agents.md', '--owner-team', 'team-security'],
      a.cli,
    );
    expect(code).toBe(1);
    expect(a.out).toEqual([]);
    expect(a.err.filter((l) => l.includes('critical_extension'))).toHaveLength(5);
  });

  it('refuses a wildcard grant without a published tool list', async () => {
    const a = io();
    const code = await runCli(
      ['awp', 'export', 'examples/awp/log-reader.agents.md', '--owner-team', 'team-ops'],
      a.cli,
    );
    expect(code).toBe(1);
    expect(a.err.join('\n')).toContain('wildcard_expansion_missing');
  });

  it('reports an invalid file and bad usage', async () => {
    const a = io();
    expect(await runCli(['awp', 'export', 'README.md'], a.cli)).toBe(1);
    expect(a.out).toEqual(['invalid']);
    const b = io();
    expect(await runCli(['awp', 'import', 'x'], b.cli)).toBe(2);
    expect(await runCli(['awp', '--help'], b.cli)).toBe(0);
    expect(b.out.join('\n')).toContain('not a conformance claim');
  });
});

describe('oax awp export <agent-id>@<version>', () => {
  it('points to the control node instead of guessing', async () => {
    const a = io();
    expect(await runCli(['awp', 'export', `${ID}@1.2.3`], a.cli)).toBe(2);
    expect(a.err[0]).toContain(`GET /v1/agents/${ID}/versions/1.2.3/awp`);
    expect(a.out).toEqual([]);
  });
});
