import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, AgentSpec } from '@openagentix/core';
import {
  HttpControlPlane,
  type ExternalHarness,
  type FetchFn,
  type HarnessInvocation,
  type HarnessResult,
} from '@openagentix/runners';
import { Workspace } from '@openagentix/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packSeed } from '../src/git/seed.js';
import { runNode } from '../src/run-node.js';

const RUN = '99999999-2222-4333-8444-555555555555';
const TOKEN = 'oaxmt.eyJ2IjoxfQ.c2lnbmF0dXJl';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const PRICE_BEFORE =
  'export function applyDiscount(cents, percent) {\n  return Math.floor((cents * (100 - percent)) / 100);\n}\n';
const TEST_FILE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';
test('half up', () => assert.equal(applyDiscount(1005, 10), 905));
`;
const SEED = packSeed([
  { path: 'src/price.js', mode: '100644', content: Buffer.from(PRICE_BEFORE) },
  { path: 'package.json', mode: '100644', content: Buffer.from('{"type":"module"}\n') },
  { path: 'test/placeholder.test.js', mode: '100644', content: Buffer.from('') },
]);

const env = (): NodeJS.ProcessEnv => ({
  OAX_CONTROL_URL: 'http://api:8080',
  OAX_RUN_ID: RUN,
  OAX_NODE_ID: 'n-1',
  OAX_STEP_IDS: 'fix',
  OAX_RUN_TOKEN_FILE: '/run/oax/token',
});

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  auth: string | null;
}

interface Seed {
  status?: number;
  archive?: Buffer;
  digest?: string | null;
  headers?: Record<string, string>;
}

function control(seed: Seed = {}, outputs: unknown[] = [{ format: 'pull-request', target: 't' }]) {
  const calls: Call[] = [];
  const handover = {
    agentId: 'fix',
    agent: {
      id: 'fix',
      provider: 'claude',
      model: 'claude-x',
      instructions: 'Fix.',
      outputs,
      tools: [],
      runtime: { runner: 'container', harness: 'claude-code' },
    },
    input: { issue: { number: 7, title: 'x' } },
    attempt: 1,
    run: { name: 'p', version: '1.0.0', classification: 'internal', budget: {} },
    mcp: [],
  };
  const fetchImpl: FetchFn = async (url, init) => {
    const u = new URL(url);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, body, auth });
    switch (`${init?.method ?? 'GET'} ${u.pathname.replace(RUN, ':id')}`) {
      case 'GET /v1/worker/runs/:id/handover':
        return Response.json(handover);
      case 'POST /v1/worker/runs/:id/credentials':
        return Response.json({ agentId: 'fix', expiresAt: 'x', credentials: [], connections: [] });
      case 'GET /v1/worker/runs/:id/workspace': {
        const archive = seed.archive ?? SEED;
        const digest = seed.digest === undefined ? sha(archive) : seed.digest;
        return new Response(seed.status && seed.status >= 400 ? '{}' : archive, {
          status: seed.status ?? 200,
          headers: { ...(digest ? { 'x-oax-seed-sha256': digest } : {}), ...seed.headers },
        });
      }
      case 'POST /v1/worker/runs/:id/model-token':
        return Response.json({
          token: TOKEN,
          expiresAt: '2030-01-01T00:00:00.000Z',
          protocol: 'anthropic',
          baseUrl: 'http://api:8080/v1/model-proxy/anthropic',
          model: 'claude-x',
        });
      case 'GET /v1/worker/runs/:id/status':
        return Response.json({ cancelled: false });
      default:
        return new Response(null, { status: 204 });
    }
  };
  return { calls, fetchImpl };
}

/**
 * Plays the part of the harness plus the `oax-workspace` server: it opens the real Workspace on
 * the unpacked root with the config the node wrote, lets the test edit through it and leaves the
 * result file the server would leave at shutdown.
 */
class FakeHarness implements ExternalHarness {
  readonly name = 'claude-code' as const;
  seenRoot: string | undefined;
  constructor(
    private readonly stateDir: string,
    private readonly act: (ws: Workspace, root: string) => Promise<void> | void,
    private readonly writeResult = true,
    private readonly raw?: string,
  ) {}
  buildInvocation(): HarnessInvocation {
    return {
      command: 'fake',
      args: [],
      env: {},
      files: {},
      stdin: '',
      limits: { timeoutMs: 1000 },
    };
  }
  async run(): Promise<HarnessResult> {
    const cfg = JSON.parse(readFileSync(join(this.stateDir, 'config.json'), 'utf8')) as {
      root: string;
    };
    this.seenRoot = cfg.root;
    const ws = await Workspace.open(cfg as never);
    await this.act(ws, cfg.root);
    if (this.raw !== undefined) writeFileSync(join(this.stateDir, 'result.json'), this.raw);
    else if (this.writeResult)
      writeFileSync(join(this.stateDir, 'result.json'), JSON.stringify(await ws.finalize()));
    return {
      exitCode: 0,
      text: 'I fixed the rounding.',
      isError: false,
      turns: 2,
      costUsd: 0.01,
      tokensIn: 10,
      tokensOut: 5,
      toolCalls: [],
      terminated: 'none',
    };
  }
}

let dir: string;
let root: string;
let stateDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oax-node-ws-'));
  root = join(dir, 'workspace');
  stateDir = join(dir, 'state');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = (
  fetchImpl: FetchFn,
  harness: ExternalHarness,
  over: Record<string, unknown> = {},
) => ({
  env: env(),
  fetchImpl,
  readFile: async () => 'oaxrt.a.b\n',
  sleep: async () => undefined,
  log: () => undefined,
  harnessFactory: () => harness,
  workspace: {
    root,
    stateDir,
    resultWaitMs: 300,
    tests: {
      command: process.execPath,
      args: ['--test'],
      filePattern: '^test/[a-z0-9-]+\\.test\\.js$',
    },
  },
  ...over,
});
const results = (calls: Call[]) =>
  calls.filter((c) => c.path.endsWith('/handover/result')).map((c) => c.body!);

const fixAndTest = async (ws: Workspace) => {
  await ws.editFile('src/price.js', 'Math.floor', 'Math.round');
  await ws.writeFile('test/price.test.js', TEST_FILE);
  const run = await ws.runTests();
  expect(run.passed, JSON.stringify(run)).toBe(true);
};

describe('runNode with a pull-request output', () => {
  it('fetches the seed with the step token, unpacks it, and attaches the node-computed patch', async () => {
    const c = control();
    const h = new FakeHarness(stateDir, fixAndTest);
    const code = await runNode(base(c.fetchImpl, h));
    expect(code).toBe(0);
    const seedCall = c.calls.find((x) => x.path.endsWith('/workspace'))!;
    expect(seedCall.auth).toBe('Bearer oaxrt.a.b');
    expect(h.seenRoot).toBe(root);
    const [res] = results(c.calls);
    expect(res).toMatchObject({
      agentId: 'fix',
      format: 'pull-request',
      content: 'I fixed the rounding.',
    });
    const patch = res!.patch as Record<string, unknown>;
    expect(patch.patchSha256).toBe(sha(Buffer.from(patch.patch as string)));
    expect(patch.patch).toContain('+  return Math.round(');
    expect(patch.patch).toContain('test/price.test.js');
    expect(patch).toMatchObject({
      testedFinalTree: true,
      fullSuitePassed: true,
      treeMatchesLastRun: true,
      lastTestRun: { passed: true, exitCode: 0, timedOut: false, file: null },
    });
    expect((patch.changedFiles as { path: string }[]).map((f) => f.path).sort()).toEqual([
      'src/price.js',
      'test/price.test.js',
    ]);
    // the workspace and the state are removed afterwards
    expect(existsSync(root)).toBe(false);
    expect(existsSync(stateDir)).toBe(false);
  });

  it('writes the server configuration itself: fixed test command, no model-controlled value', async () => {
    const c = control();
    let seen: Record<string, unknown> | undefined;
    const h = new FakeHarness(stateDir, (ws) => {
      seen = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
      return void ws;
    });
    await runNode(base(c.fetchImpl, h));
    expect(seen).toMatchObject({
      root,
      tests: { command: process.execPath, args: ['--test'], timeoutMs: 60000, maxRuns: 8 },
    });
  });

  it('reports a failure (and no patch) when the agent changed nothing', async () => {
    const c = control();
    const code = await runNode(base(c.fetchImpl, new FakeHarness(stateDir, () => undefined)));
    expect(code).toBe(0);
    const [res] = results(c.calls);
    expect(res!.patch).toBeUndefined();
    expect(res!.failure).toMatchObject({ status: 'failed', code: 'no_changes' });
  });

  it('turns a refused patch of the workspace into a failure with its code', async () => {
    const c = control();
    // a change outside the writable area (planted by test code, not by a tool) is refused at finalize
    const h = new FakeHarness(stateDir, (_ws, r) => {
      writeFileSync(join(r, 'README.md'), 'changed\n');
    });
    await runNode(base(c.fetchImpl, h));
    const [res] = results(c.calls);
    expect(res!.failure).toMatchObject({
      status: 'failed',
      code: 'workspace_forbidden_path_changed',
    });
    expect(res!.patch).toBeUndefined();
  });

  it('fails when the workspace server leaves no result, or garbage', async () => {
    for (const [h, code] of [
      [new FakeHarness(stateDir, () => undefined, false), 'workspace_result_missing'],
      [new FakeHarness(stateDir, () => undefined, true, '{not json'), 'workspace_result_invalid'],
      [
        new FakeHarness(stateDir, () => undefined, true, '{"patch":{"ok":true,"patch":"x"}}'),
        'workspace_result_invalid',
      ],
      [new FakeHarness(stateDir, () => undefined, true, '[]'), 'workspace_result_invalid'],
    ] as const) {
      const c = control();
      await runNode(base(c.fetchImpl, h));
      expect(results(c.calls)[0]!.failure, code).toMatchObject({ code });
    }
  });

  it('refuses a result file that is a link', async () => {
    const c = control();
    const { symlinkSync } = await import('node:fs');
    const h = new FakeHarness(
      stateDir,
      () => {
        writeFileSync(join(dir, 'elsewhere.json'), '{}');
        symlinkSync(join(dir, 'elsewhere.json'), join(stateDir, 'result.json'));
      },
      false,
    );
    await runNode(base(c.fetchImpl, h));
    expect(results(c.calls)[0]!.failure).toMatchObject({ code: 'workspace_result_missing' });
  });

  describe('seed problems end the step before the harness starts', () => {
    const failsWith = async (seed: Seed, code: string, message?: RegExp) => {
      const c = control(seed);
      let started = false;
      const h = new FakeHarness(stateDir, () => void (started = true));
      expect(await runNode(base(c.fetchImpl, h))).toBe(1);
      const [res] = results(c.calls);
      expect(res!.failure).toMatchObject({ status: 'failed', code });
      if (message) expect(String((res!.failure as { message: string }).message)).toMatch(message);
      expect(started).toBe(false);
      expect(c.calls.some((x) => x.path.endsWith('/model-token'))).toBe(false);
      expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
    };

    it('digest mismatch', () => failsWith({ digest: 'f'.repeat(64) }, 'seed_invalid', /digest/));
    it('no digest header', () => failsWith({ digest: null }, 'workspace_seed_invalid'));
    it('seed already fetched (409)', () =>
      failsWith({ status: 409 }, 'workspace_seed_unavailable'));
    it('seed missing (404)', () => failsWith({ status: 404 }, 'workspace_seed_unavailable'));
    it('declared size above the limit', () =>
      failsWith(
        { headers: { 'content-length': String(6 * 1024 * 1024) } },
        'workspace_seed_invalid',
      ));
    it('a hostile archive (parent path) is refused whole', async () => {
      const evil = packSeed([{ path: 'a.txt', mode: '100644', content: Buffer.from('x') }]);
      evil.write('../evil.txt\0', 0, 'latin1'); // rewrite the name; checksum is now wrong too
      await failsWith({ archive: evil }, 'seed_invalid');
      expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
    });
  });

  it('does nothing special for a step without a pull-request output', async () => {
    const c = control({}, [{ format: 'markdown' }]);
    const h = new FakeHarness(stateDir, () => undefined, false);
    h.run = async () => ({
      exitCode: 0,
      text: 'plain',
      isError: false,
      turns: 1,
      costUsd: 0,
      tokensIn: 1,
      tokensOut: 1,
      toolCalls: [],
      terminated: 'none',
    });
    expect(await runNode(base(c.fetchImpl, h))).toBe(0);
    expect(c.calls.some((x) => x.path.endsWith('/workspace'))).toBe(false);
    expect(results(c.calls)[0]!.patch).toBeUndefined();
    expect(existsSync(root)).toBe(false);
  });
});

describe('HttpControlPlane.fetchWorkspaceSeed', () => {
  const plane = (res: () => Response) =>
    new HttpControlPlane({
      baseUrl: 'http://api:8080/',
      runToken: 'oaxrt.a.b',
      fetchImpl: async () => res(),
    });

  it('returns the bytes and the announced digest', async () => {
    const out = await plane(
      () => new Response(SEED, { headers: { 'x-oax-seed-sha256': sha(SEED) } }),
    ).fetchWorkspaceSeed(RUN, 'fix', 1024 * 1024);
    expect(out.archive.equals(SEED)).toBe(true);
    expect(out.sha256).toBe(sha(SEED));
  });

  it('stops reading at the limit even without a content-length', async () => {
    const body = new ReadableStream({
      pull(ctl) {
        ctl.enqueue(new Uint8Array(4096));
      },
    });
    await expect(
      plane(
        () => new Response(body, { headers: { 'x-oax-seed-sha256': 'a'.repeat(64) } }),
      ).fetchWorkspaceSeed(RUN, 'fix', 10_000),
    ).rejects.toMatchObject({ code: 'workspace_seed_invalid' });
  });

  it('refuses a missing body and an error status', async () => {
    await expect(
      plane(
        () => new Response(null, { headers: { 'x-oax-seed-sha256': 'a'.repeat(64) } }),
      ).fetchWorkspaceSeed(RUN, 'fix', 10),
    ).rejects.toMatchObject({ code: 'workspace_seed_invalid' });
    await expect(
      plane(() => new Response('{}', { status: 500 })).fetchWorkspaceSeed(RUN, 'fix', 10),
    ).rejects.toMatchObject({ code: 'workspace_seed_unavailable' });
  });
});

// keep the AgentDefinition/AgentSpec imports used by the type checker
export type _Unused = AgentDefinition | AgentSpec;
