import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function io(version?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readFile: (p) => readFile(root + p, 'utf8'),
    env: {},
    ...(version ? { version } : {}),
  };
  return { cli, out, err };
}

const LEGACY = 'examples/awp/release-notes.agents.md';
const REFUSED = 'examples/ticket-updater.agents.md';

describe('oax validate of a legacy file (release N)', () => {
  it('stays valid and prints exactly one legacy_format warning', async () => {
    const a = io();
    expect(await runCli(['validate', LEGACY], a.cli)).toBe(0);
    const warnings = a.err.filter((l) => l.includes('legacy_format'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('oax awp convert');
    expect(warnings[0]).toContain('0.4.0');
    expect(a.out.join()).toContain('valid:');
  });

  it('does not warn for an AWP manifest', async () => {
    const a = io();
    expect(await runCli(['validate', 'examples/awp/log-reader.awp.json'], a.cli)).toBe(0);
    expect(a.err.join()).not.toContain('legacy_format');
  });
});

describe('oax validate of a legacy file (release N+1)', () => {
  it('rejects it with legacy_format_removed, naming oax awp convert', async () => {
    const a = io('0.4.0');
    expect(await runCli(['validate', LEGACY], a.cli)).toBe(1);
    expect(a.err.join('\n')).toContain('legacy_format_removed');
    expect(a.err.join('\n')).toContain('oax awp convert');
    expect(a.out).toEqual(['invalid']);
  });

  it('still validates an AWP manifest', async () => {
    const a = io('0.4.0');
    expect(await runCli(['validate', 'examples/awp/log-reader.awp.json'], a.cli)).toBe(0);
  });
});

describe('oax awp convert', () => {
  it('converts like export and says how to continue', async () => {
    const a = io();
    const code = await runCli(['awp', 'convert', LEGACY, '--owner-team', 'team-docs'], a.cli);
    expect(code).toBe(0);
    const manifest = JSON.parse(a.out.join('\n')) as { kind: string };
    expect(manifest.kind).toBe('Workflow');
    expect(a.err.join('\n')).toContain('never grants more');
    expect(a.err.join('\n')).not.toMatch(/conformant|compliant/i);
  });

  it('still converts in release N+1', async () => {
    const a = io('0.4.0');
    expect(await runCli(['awp', 'convert', LEGACY, '--owner-team', 'team-docs'], a.cli)).toBe(0);
  });

  it('refuses a file that would lose a limit, with field-level reasons, and writes nothing', async () => {
    const a = io();
    expect(await runCli(['awp', 'convert', REFUSED, '--owner-team', 'team-support'], a.cli)).toBe(
      1,
    );
    expect(a.out).toEqual([]);
    const err = a.err.join('\n');
    expect(err).toContain('critical_extension');
    expect(err).toContain('nothing was written');
  });

  it('refuses an AWP manifest as input', async () => {
    const a = io();
    expect(await runCli(['awp', 'convert', 'examples/awp/ticket-updater.awp.md'], a.cli)).toBe(1);
    expect(a.err.join()).toContain('already an AWP manifest');
  });

  it('points to the control node for a published version', async () => {
    const a = io();
    const id = '0b3f6c1e-8a52-4c1e-9d0a-5f6a7b8c9d0e';
    expect(await runCli(['awp', 'convert', `${id}@1.0.0`], a.cli)).toBe(2);
    expect(a.err.join()).toContain(`/v1/agents/${id}/versions/1.0.0/awp`);
  });
});

describe('oax awp legacy-report', () => {
  it('lists convertible and unconvertible files with reasons and exits 1', async () => {
    const a = io();
    const code = await runCli(['awp', 'legacy-report', LEGACY, REFUSED], a.cli);
    expect(code).toBe(1);
    const out = a.out.join('\n');
    expect(out).toContain(`convertible   ${LEGACY}`);
    expect(out).toMatch(/unconvertible\s+examples\/ticket-updater/);
    expect(out).toContain('2 file(s): 1 convertible, 1 unconvertible');
    expect(a.err.join('\n')).toContain('critical_extension');
  });

  it('exits 0 when every file converts', async () => {
    const a = io();
    expect(
      await runCli(['awp', 'legacy-report', LEGACY, 'examples/awp/log-reader.agents.md'], a.cli),
    ).toBe(0);
  });

  it('reports an invalid file as unconvertible', async () => {
    const a = io();
    expect(
      await runCli(['awp', 'legacy-report', 'examples/awp/ticket-updater.awp.md'], a.cli),
    ).toBe(1);
    expect(a.out.join()).toContain('invalid');
  });
});
