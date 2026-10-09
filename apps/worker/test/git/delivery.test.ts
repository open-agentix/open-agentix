import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PatchAttachment } from '@openagentix/runners';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PullRequestDelivery,
  parsePullRequestTarget,
  parsePullRequestTargets,
  loadPullRequestTargets,
  neutralizeReferences,
  quoteSummary,
  readIssue,
  type DeliveryAuditEvent,
  type DeliverInput,
  type PullRequestDeliveryOptions,
} from '../../src/git/index.js';
import { parseSeedArchive } from '../../src/seed-unpack.js';
import {
  API_TOKEN,
  GIT_TOKEN,
  diffOf,
  git,
  lookup,
  makeDispatcher,
  makeTls,
  secretsFor,
  seedRepo,
  startFakeServer,
  type FakeServer,
  type Tls,
} from './fixtures.js';

let tmp: string;
let tls: Tls;
let srv: FakeServer;
let baseSha: string;
const audits: DeliveryAuditEvent[] = [];

const PRICE_BEFORE =
  'export function applyDiscount(cents, percent) {\n  return Math.floor((cents * (100 - percent)) / 100);\n}\n';
const PRICE_AFTER =
  'export function applyDiscount(cents, percent) {\n  return Math.round((cents * (100 - percent)) / 100);\n}\n';
const RUN = '12345678-aaaa-4bbb-8ccc-123456789abc';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const targetCfg = (over: Record<string, unknown> = {}) => ({
  name: 'dogfood-sandbox',
  url: srv.url,
  tokenRef: 'git-token',
  extensionTokenRef: 'api-token',
  ...over,
});

function delivery(
  over: Partial<PullRequestDeliveryOptions> = {},
  cfg: Record<string, unknown> = {},
) {
  const t = parsePullRequestTarget(targetCfg(cfg));
  return new PullRequestDelivery({
    dispatcher: makeDispatcher(tls.cert),
    secrets: secretsFor(),
    targets: new Map([[t.name, t]]),
    engine: {
      secretReader: (ref: string) => (ref === 'test-ca' ? tls.cert : undefined),
      privateAllow: ['127.0.0.1'],
      lookup,
      tmpRoot: tmp,
    },
    github: { privateAllow: ['127.0.0.1'], lookup },
    audit: (e) => void audits.push(e),
    ...over,
  });
}

const attachment = (patch: string, over: Partial<PatchAttachment> = {}): PatchAttachment => ({
  patch,
  patchSha256: sha(patch),
  changedFiles: [{ path: 'src/price.js', status: 'modified', additions: 1, deletions: 1 }],
  lastTestRun: { passed: true, exitCode: 0, timedOut: false, durationMs: 120, file: null },
  fullSuitePassed: true,
  treeMatchesLastRun: true,
  testedFinalTree: true,
  ...over,
});

const input = (patch: string, over: Partial<DeliverInput> = {}): DeliverInput => ({
  issue: { number: 7, title: 'applyDiscount rounds down' },
  summary: 'Rounded half up.\nAdded a regression test.',
  patch: attachment(patch),
  model: 'claude-haiku-4-5',
  costMicros: 123_456,
  ...over,
});

const goodPatch = () => diffOf('src/price.js', PRICE_BEFORE, PRICE_AFTER);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'oax-deliv-test-'));
  tls = makeTls(tmp);
  srv = await startFakeServer(tls, { git: GIT_TOKEN, api: API_TOKEN });
  baseSha = seedRepo(srv, {
    'src/price.js': PRICE_BEFORE,
    'test/price.test.js': "import test from 'node:test';\n",
    'README.md': '# sandbox\n',
    '.github/workflows/ci.yml': 'name: ci\n',
  });
});

afterAll(async () => {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  audits.length = 0;
  srv.pulls.length = 0;
  srv.posted.length = 0;
  Object.assign(srv.mode, { apiStatus: undefined, apiNonDraft: false });
});

const remaining = () => readdirSync(tmp).filter((n) => n.startsWith('oax-git-'));

describe('PullRequestDelivery.prepare', () => {
  it('resolves the base branch to one commit and builds a seed the node can unpack', async () => {
    const ws = await delivery().prepare(RUN, 'dogfood-sandbox');
    try {
      expect(ws.commit).toBe(baseSha);
      expect(ws.sha256).toBe(sha256Of(ws.archive));
      const names = parseSeedArchive(ws.archive).map((e) => e.path);
      expect(names).toEqual(
        ['.github/workflows/ci.yml', 'README.md', 'src/price.js', 'test/price.test.js'].sort(),
      );
      expect(ws.files).toBe(4);
    } finally {
      await ws.dispose();
    }
    expect(remaining()).toHaveLength(0);
  });

  it('refuses an unknown target and never contacts the host', async () => {
    srv.seen.length = 0;
    await expect(delivery().prepare(RUN, 'other')).rejects.toMatchObject({
      code: 'target_invalid',
    });
    expect(srv.seen).toHaveLength(0);
  });

  it('stops at the open pull request limit before anything is fetched', async () => {
    srv.pulls.push(
      { number: 1, head: 'oax/bug-fix/issue-1-aaaaaaaa', draft: true },
      { number: 2, head: 'oax/bug-fix/issue-2-bbbbbbbb', draft: true },
    );
    srv.seen.length = 0;
    await expect(delivery().prepare(RUN, 'dogfood-sandbox')).rejects.toMatchObject({
      code: 'pr_limit_reached',
    });
    expect(srv.seen.every((r) => r.url.startsWith('/api/v3/'))).toBe(true);
    expect(audits.find((a) => a.action === 'pull_request.refused')).toMatchObject({
      stage: 'prepare',
      code: 'pr_limit_reached',
    });
    expect(remaining()).toHaveLength(0);
  });

  it('reports a missing base branch and cleans up', async () => {
    await expect(
      delivery({}, { baseBranch: 'does-not-exist' }).prepare(RUN, 'dogfood-sandbox'),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(remaining()).toHaveLength(0);
  });
});

const sha256Of = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('PullRequestDelivery.deliver', () => {
  const prep = (d = delivery()) => d.prepare(RUN, 'dogfood-sandbox');

  it('pushes a new branch from the same commit and opens a DRAFT pull request', async () => {
    const d = delivery({ knownSecrets: async () => ['unrelated-known-secret-value'] });
    const ws = await prep(d);
    const res = await d.deliver(ws, input(goodPatch()));
    expect(res).toMatchObject({
      dryRun: false,
      target: 'dogfood-sandbox',
      branch: 'oax/bug-fix/issue-7-12345678',
      baseSha,
      changedFiles: 1,
    });
    expect(res.pullRequest).toMatchObject({ draft: true });
    expect(res.pullRequest!.url).toContain('/pull/');
    // branch exists on the host with the platform identity, one commit on top of the base
    const remote = git(srv.bare, 'rev-parse', 'refs/heads/oax/bug-fix/issue-7-12345678');
    expect(remote).toBe(res.commit);
    expect(git(srv.bare, 'rev-parse', `${remote}^`)).toBe(baseSha);
    expect(git(srv.bare, 'log', '-1', '--format=%an <%ae>|%s', remote)).toBe(
      'agentix-zero <github@openagentix.si>|fix: applyDiscount rounds down',
    );
    expect(git(srv.bare, 'log', '-1', '--format=%B', remote)).toContain(
      'Signed-off-by: agentix-zero <github@openagentix.si>',
    );
    // the PR is a draft, base main, with the fixed template
    const posted = srv.posted[0] as Record<string, unknown>;
    expect(posted).toMatchObject({
      draft: true,
      base: 'main',
      head: 'oax/bug-fix/issue-7-12345678',
      title: 'fix: applyDiscount rounds down',
    });
    const body = String(posted.body);
    expect(body).toContain('> Rounded half up.\n> Added a regression test.');
    expect(body).toContain(`Issue: ${srv.url}/issues/7`);
    expect(body).toContain('Run: 12345678');
    expect(body).toContain('Model: claude-haiku-4-5');
    expect(body).toContain('$0.1235');
    expect(body).toContain('AI-generated by the openagentix bug-fix agent; review before merging.');
    // audit: digests and codes only
    const actions = audits.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['pull_request.pushed', 'pull_request.opened']));
    const opened = audits.find((a) => a.action === 'pull_request.opened')!;
    expect(opened).toMatchObject({ runId: RUN, patchSha256: sha(goodPatch()), sha: remote });
    const dump = JSON.stringify(audits);
    for (const secret of [GIT_TOKEN, API_TOKEN, 'Math.round']) expect(dump).not.toContain(secret);
    expect(remaining()).toHaveLength(0);
  });

  it('never overwrites an existing branch and opens no pull request', async () => {
    const d = delivery();
    const ws = await prep(d);
    const before = srv.posted.length;
    await expect(d.deliver(ws, input(goodPatch()))).rejects.toMatchObject({
      code: 'branch_exists',
    });
    expect(srv.posted.length).toBe(before);
    expect(audits.at(-1)).toMatchObject({ action: 'pull_request.refused', code: 'branch_exists' });
  });

  it('dry run stops after the local commit: nothing is pushed or opened', async () => {
    srv.pulls.length = 0;
    const d = delivery({ dryRun: true });
    const ws = await prep(d);
    const res = await d.deliver(ws, input(goodPatch(), { issue: { number: 8, title: 'Dry' } }));
    expect(res.dryRun).toBe(true);
    expect(res.pullRequest).toBeUndefined();
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(() => git(srv.bare, 'rev-parse', 'refs/heads/oax/bug-fix/issue-8-12345678')).toThrow();
    expect(srv.posted).toHaveLength(0);
    expect(audits.find((a) => a.action === 'pull_request.pushed')).toMatchObject({ dryRun: true });
  });

  describe('refusals (each one pushes nothing)', () => {
    const refused = async (
      patch: string,
      over: Partial<DeliverInput>,
      code: string,
      d = delivery(),
      issue = 20,
    ) => {
      const ws = await prep(d);
      await expect(
        d.deliver(ws, input(patch, { issue: { number: issue, title: 'T' }, ...over })),
      ).rejects.toMatchObject({ code });
      expect(() =>
        git(srv.bare, 'rev-parse', `refs/heads/oax/bug-fix/issue-${issue}-12345678`),
      ).toThrow();
      expect(srv.posted).toHaveLength(0);
      expect(audits.at(-1)).toMatchObject({
        action: 'pull_request.refused',
        stage: 'deliver',
        code,
      });
      expect(remaining()).toHaveLength(0);
    };

    it('red tests', async () => {
      const p = goodPatch();
      await refused(
        p,
        {
          patch: attachment(p, {
            lastTestRun: { passed: false, exitCode: 1, timedOut: false, durationMs: 1, file: null },
          }),
        },
        'tests_not_green',
      );
    });

    it('tests that did not run on the final tree', async () => {
      const p = goodPatch();
      await refused(p, { patch: attachment(p, { testedFinalTree: false }) }, 'tests_not_green');
      await refused(p, { patch: attachment(p, { lastTestRun: null }) }, 'tests_not_green');
    });

    it('a digest that does not match the patch', async () => {
      const p = goodPatch();
      await refused(
        p,
        { patch: attachment(p, { patchSha256: 'a'.repeat(64) }) },
        'patch_digest_mismatch',
      );
    });

    it('a path outside the allowlist', async () => {
      const bad = diffOf('.github/workflows/ci.yml', 'name: ci\n', 'name: pwned\n');
      await refused(bad, { patch: attachment(bad) }, 'patch_path_refused');
    });

    it('a patch above the size limit of the target', async () => {
      const big = diffOf('src/price.js', PRICE_BEFORE, PRICE_AFTER + `// ${'x'.repeat(2000)}\n`);
      await refused(
        big,
        { patch: attachment(big) },
        'patch_too_large',
        delivery({}, { maxPatchBytes: 1024 }),
      );
    });

    it('a token inside the patch (exact known secret, not just a pattern)', async () => {
      const secret = 'internal-service-passphrase-8812';
      const bad = diffOf('src/price.js', PRICE_BEFORE, PRICE_AFTER + `// ${secret}\n`);
      await refused(
        bad,
        { patch: attachment(bad) },
        'secret_detected',
        delivery({ knownSecrets: async () => [secret] }),
      );
      expect(JSON.stringify(audits)).not.toContain(secret);
    });

    it('a run token passed as extra secret and a token-shaped string in the summary', async () => {
      const runTok = 'oaxrt.eyJhYmNkZWZnaGlqa2xtbg.c2lnbmF0dXJlMDEyMzQ1';
      const bad = diffOf('src/price.js', PRICE_BEFORE, PRICE_AFTER + `// ${runTok}\n`);
      await refused(bad, { patch: attachment(bad), extraSecrets: [runTok] }, 'secret_detected');
      // the summary ends up in the PR body: pushed branch exists then, so use a fresh issue/branch
    });

    it('the open pull request limit (no push)', async () => {
      const d = delivery();
      const ws = await prep(d);
      srv.pulls.push(
        { number: 1, head: 'oax/bug-fix/issue-1-aaaaaaaa', draft: true },
        { number: 2, head: 'oax/bug-fix/issue-2-bbbbbbbb', draft: true },
      );
      await expect(
        d.deliver(ws, input(goodPatch(), { issue: { number: 21, title: 'T' } })),
      ).rejects.toMatchObject({
        code: 'pr_limit_reached',
      });
      expect(() =>
        git(srv.bare, 'rev-parse', 'refs/heads/oax/bug-fix/issue-21-12345678'),
      ).toThrow();
      srv.pulls.length = 0;
    });
  });

  it('a credential-like summary is refused before the push (no branch, no PR)', async () => {
    const d = delivery();
    const ws = await prep(d);
    await expect(
      d.deliver(
        ws,
        input(goodPatch(), {
          issue: { number: 30, title: 'T' },
          summary: `The key is ghp_${'A1b2C3d4E5f6G7h8I9j0'}ZZ here`,
        }),
      ),
    ).rejects.toMatchObject({ code: 'secret_detected' });
    expect(srv.posted).toHaveLength(0);
    expect(() => git(srv.bare, 'rev-parse', 'refs/heads/oax/bug-fix/issue-30-12345678')).toThrow();
    expect(audits.find((a) => a.action === 'pull_request.pushed')).toBeUndefined();
    expect(audits.at(-1)).toMatchObject({
      action: 'pull_request.refused',
      code: 'secret_detected',
    });
  });

  it('a known secret in the summary is refused in a dry run as well', async () => {
    const secret = 'internal-service-passphrase-4471';
    const d = delivery({ dryRun: true, knownSecrets: async () => [secret] });
    const ws = await prep(d);
    await expect(
      d.deliver(
        ws,
        input(goodPatch(), { issue: { number: 32, title: 'T' }, summary: `see ${secret}` }),
      ),
    ).rejects.toMatchObject({ code: 'secret_detected' });
    expect(JSON.stringify(audits)).not.toContain(secret);
  });

  it('an issue title or summary cannot close or reference other issues on merge', async () => {
    const d = delivery();
    const ws = await prep(d);
    const res = await d.deliver(
      ws,
      input(goodPatch(), {
        issue: { number: 33, title: 'Fixes #1 and closes other/repo#2' },
        summary: 'Resolves #3.\nFixed https://github.com/other/repo/issues/4 cc @admin',
      }),
    );
    const posted = srv.posted.at(-1) as { title: string; body: string };
    const subject = git(srv.bare, 'log', '-1', '--format=%s', res.commit);
    const closing = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:\S*#\d|https:\/\/)/i;
    for (const text of [posted.title, posted.body, subject]) {
      expect(text).not.toMatch(closing);
      expect(text).not.toMatch(/#\d/);
      expect(text).not.toMatch(/@[a-z]/);
    }
    expect(posted.body).toContain(`Issue: ${srv.url}/issues/33`);
  });

  it('maps a host failure at pull request creation to a fixed code', async () => {
    const d = delivery();
    const ws = await prep(d);
    srv.mode.apiStatus = 500;
    await expect(
      d.deliver(ws, input(goodPatch(), { issue: { number: 31, title: 'T' } })),
    ).rejects.toMatchObject({ code: 'host_request_failed' });
    expect(JSON.stringify(audits)).not.toContain('ghp_leaky');
  });
});

describe('readIssue and quoteSummary', () => {
  it('reads the issue from the input or from event data', () => {
    expect(readIssue({ issue: { number: 3, title: 'A  bug' } })).toEqual({
      number: 3,
      title: 'A bug',
    });
    expect(readIssue({ data: { issue: { number: 4, title: 'B' } } })).toEqual({
      number: 4,
      title: 'B',
    });
  });

  it.each([
    undefined,
    null,
    'text',
    {},
    { issue: { number: 0, title: 'x' } },
    { issue: { number: 1.5, title: 'x' } },
    { issue: { number: '7', title: 'x' } },
    { issue: { number: 7, title: '   ' } },
    { issue: { number: 7 } },
    { issue: { number: 10_000_000_000, title: 'x' } },
  ])('refuses %j', (v) => {
    expect(() => readIssue(v)).toThrowError(expect.objectContaining({ code: 'issue_invalid' }));
  });

  it('neutralizes mentions, issue references and closing keywords', () => {
    const z = '\u200b';
    expect(
      neutralizeReferences('Fixes #12, closes o/r#3, Resolved GH-4 and fixed https://x/issues/5'),
    ).toBe(
      `F${z}ixes #${z}12, c${z}loses o/r#${z}3, R${z}esolved GH${z}-4 and f${z}ixed https://x/issues/5`,
    );
    // words that only contain a keyword stay as they are
    expect(neutralizeReferences('prefix fixture closet unresolved #a')).toBe(
      'prefix fixture closet unresolved #a',
    );
    expect(quoteSummary('FIXES: #1')).toBe(`> F${z}IXES: #${z}1`);
  });

  it('quotes the model text: capped, no mentions, no HTML, no control characters', () => {
    const q = quoteSummary('Hi @everyone <script>x</script>\u0000\u0007\nline2');
    expect(q).toBe('> Hi @\u200beveryone \u2039script\u203ax\u2039/script\u203a\n> line2');
    expect(quoteSummary('')).toBe('> (no summary)');
    expect(quoteSummary('a'.repeat(5000)).length).toBe(2 + 2000);
  });
});

describe('pull request targets', () => {
  it('parses a file with one or several targets and refuses everything else', () => {
    expect(parsePullRequestTargets([targetCfg()]).get('dogfood-sandbox')).toMatchObject({
      baseBranch: 'main',
      branchPrefix: 'oax/bug-fix/',
      maxOpenPullRequests: 2,
    });
    expect(parsePullRequestTargets({ targets: [targetCfg()] }).size).toBe(1);
    for (const bad of [
      [],
      {},
      null,
      'x',
      [targetCfg(), targetCfg()],
      [targetCfg(), targetCfg({ name: 'second' })], // same repository twice
      [targetCfg({ extra: 1 })],
      [targetCfg({ pathAllow: ['.*'] })],
      [targetCfg({ branchPrefix: 'feature/' })],
    ])
      expect(() => parsePullRequestTargets(bad)).toThrowError(
        expect.objectContaining({ code: 'target_invalid' }),
      );
  });

  it('loads from a file and reports unreadable files with a fixed message', () => {
    const f = path.join(tmp, 'targets.json');
    writeFileSync(f, JSON.stringify([targetCfg()]));
    expect(loadPullRequestTargets(f).size).toBe(1);
    writeFileSync(f, '{not json');
    expect(() => loadPullRequestTargets(f)).toThrowError(
      expect.objectContaining({ code: 'target_invalid' }),
    );
    expect(() => loadPullRequestTargets(path.join(tmp, 'missing.json'))).toThrow(/cannot be read/);
  });
});
