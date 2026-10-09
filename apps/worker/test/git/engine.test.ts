import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GitEngine,
  type GitAuditEvent,
  type GitEngineOptions,
  type GitTarget,
} from '../../src/git/index.js';
import {
  GIT_TOKEN,
  NAME,
  OWNER,
  API_TOKEN,
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
const audits: GitAuditEvent[] = [];
const IDENTITY = { name: 'agentix-zero', email: 'github@openagentix.si' };
const PRICE_BEFORE =
  'export function applyDiscount(cents, percent) {\n  return Math.floor((cents * (100 - percent)) / 100);\n}\n';
const PRICE_AFTER =
  'export function applyDiscount(cents, percent) {\n  return Math.round((cents * (100 - percent)) / 100);\n}\n';

const HOSTILE_NAME = 'src/\u012e\u012e\u012fescape.js';

const target = (over: Partial<GitTarget> = {}): GitTarget => ({
  url: srv.url,
  credential: { tokenRef: 'git-token', username: 'x-access-token' },
  ...over,
});

function engine(over: Partial<GitEngineOptions> = {}): GitEngine {
  return new GitEngine({
    dispatcher: makeDispatcher(tls.cert),
    secrets: secretsFor(),
    secretReader: (ref) => (ref === 'test-ca' ? tls.cert : undefined),
    privateAllow: ['127.0.0.1'],
    lookup,
    tmpRoot: tmp,
    audit: (e) => void audits.push(e),
    ...over,
  });
}

/** Wrapper around git that records argv, environment and where the token ended up. */
function spyGit(log: string): string {
  const bin = path.join(tmp, 'git-spy.sh');
  const b64 = Buffer.from(`x-access-token:${GIT_TOKEN}`).toString('base64');
  writeFileSync(
    bin,
    `#!/bin/sh
{ printf 'ARGV:%s\\n' "$*"; env | sort | sed 's/^/ENV:/'; } >> '${log}'
git "$@"
rc=$?
case "$PWD" in */oax-git-*) for f in $(grep -rIlF -e '${GIT_TOKEN}' -e '${b64}' "$PWD" 2>/dev/null); do printf 'FILE-WITH-TOKEN:%s\\n' "$f" >> '${log}'; done;; esac
exit $rc
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'oax-git-test-'));
  tls = makeTls(tmp);
  srv = await startFakeServer(tls, { git: GIT_TOKEN, api: API_TOKEN });
  baseSha = seedRepo(
    srv,
    {
      'src/price.js': PRICE_BEFORE,
      'src/hours.js': 'export const x = 1;\n',
      'test/price.test.js': "import test from 'node:test';\n",
      // low bytes of these code units spell `../`: a latin1 tar header would escape `src/`
      [HOSTILE_NAME]: 'export const escaped = true;\n',
      'README.md': '# sandbox\n',
      '.gitattributes': '* filter=evil\n',
      'lfs.bin': 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n',
      'big.txt': 'x'.repeat(1_100_000),
      'run.sh': '#!/bin/sh\n',
    },
    {
      symlinks: { link: '/etc/passwd' },
      extra: (work) => {
        git(work, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/sub`);
      },
    },
  );
});

afterAll(async () => {
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('GitEngine read side', () => {
  it('lists a ref, fetches one commit shallowly and exports a clean seed', async () => {
    audits.length = 0;
    const eng = engine();
    const s = await eng.openSession(target());
    try {
      expect(await s.lsRemote('refs/heads/main')).toBe(baseSha);
      expect(await s.lsRemote('refs/heads/nope')).toBeNull();
      const rep = await s.fetchCommit(baseSha);
      expect(rep.sha).toBe(baseSha);
      expect(rep.receivedBytes).toBeGreaterThan(0);
      const seed = await s.exportSeed(baseSha);
      const names = seed.snapshot.files.map((f) => f.path);
      expect(names).toEqual(
        [
          '.gitattributes',
          'README.md',
          'run.sh',
          'src/hours.js',
          'src/price.js',
          HOSTILE_NAME,
          'test/price.test.js',
        ].sort(),
      );
      const reasons = Object.fromEntries(seed.snapshot.skipped.map((k) => [k.path, k.reason]));
      expect(reasons).toMatchObject({
        link: 'symlink',
        'vendor/sub': 'gitlink',
        'lfs.bin': 'lfs_pointer',
        'big.txt': 'too_large',
      });
      expect(seed.snapshot.files.find((f) => f.path === 'run.sh')?.mode).toBe('100755');
      expect(seed.sha256).toBe(createHash('sha256').update(seed.archive).digest('hex'));
      // deterministic
      const again = await s.exportSeed(baseSha);
      expect(again.sha256).toBe(seed.sha256);
      // the archive is a valid tar with the expected members
      const f = path.join(tmp, 'seed.tar');
      writeFileSync(f, seed.archive);
      const listing = execFileSync('tar', ['-tf', f], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .sort();
      expect(listing).toEqual(names);
      const dest = path.join(tmp, 'seed-out');
      mkdirSync(dest, { recursive: true });
      execFileSync('tar', ['-xf', f, '-C', dest]);
      expect(readFileSync(path.join(dest, 'src/price.js'), 'utf8')).toBe(PRICE_BEFORE);
      // the hostile name stays one file inside src/, nothing lands next to src/
      expect(readFileSync(path.join(dest, HOSTILE_NAME), 'utf8')).toContain('escaped');
      expect(existsSync(path.join(dest, 'escape.js'))).toBe(false);
    } finally {
      await s.dispose();
    }
    const clone = audits.find((a) => a.action === 'git.clone');
    expect(clone).toMatchObject({ ok: true, sha: baseSha });
  });

  it('keeps the token out of argv, files, audit entries and the environment of other variables', async () => {
    const log = path.join(tmp, 'spy.log');
    writeFileSync(log, '');
    audits.length = 0;
    const eng = engine({ gitBinary: spyGit(log) });
    const s = await eng.openSession(target());
    try {
      await s.lsRemote('refs/heads/main');
      await s.fetchCommit(baseSha);
      await s.snapshot(baseSha);
    } finally {
      await s.dispose();
    }
    const text = readFileSync(log, 'utf8');
    const b64 = Buffer.from(`x-access-token:${GIT_TOKEN}`).toString('base64');
    expect(text).toContain('ARGV:');
    for (const line of text.split('\n')) {
      if (line.startsWith('ARGV:')) {
        expect(line).not.toContain(GIT_TOKEN);
        expect(line).not.toContain(b64);
        expect(line).not.toMatch(/https:\/\/[^/ ]*@/); // no userinfo in any URL
      }
      if (line.startsWith('ENV:') && (line.includes(GIT_TOKEN) || line.includes(b64)))
        expect(line).toMatch(/^ENV:GIT_CONFIG_VALUE_0=Authorization: Basic /);
    }
    expect(text).not.toContain('FILE-WITH-TOKEN');
    // the child environment is an allowlist: no inherited variables
    const envNames = new Set([...text.matchAll(/^ENV:([A-Z_0-9]+)=/gm)].map((m) => m[1]));
    for (const n of envNames)
      expect(
        ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(n!) ||
          /^(GIT_|LC_|LANG)/.test(n!),
        n,
      ).toBe(true);
    expect(text).toContain('ENV:GIT_CONFIG_NOSYSTEM=1');
    expect(text).toContain('ENV:GIT_TERMINAL_PROMPT=0');
    expect(text).toMatch(/core\.hooksPath=\/dev\/null/);
    expect(text).toMatch(/protocol\.allow=never/);
    expect(text).toMatch(/http\.followRedirects=false/);
    expect(JSON.stringify(audits)).not.toContain(GIT_TOKEN);
  });

  it('never runs hooks, filters or inherited configuration, whatever the parent has', async () => {
    const home = path.join(tmp, 'poison-home');
    const tpl = path.join(tmp, 'poison-tpl');
    const marker = path.join(tmp, 'POISON-RAN');
    mkdirSync(path.join(tpl, 'hooks'), { recursive: true });
    mkdirSync(home, { recursive: true });
    for (const h of [
      'pre-push',
      'post-checkout',
      'reference-transaction',
      'post-commit',
      'pre-commit',
      'post-merge',
      'update',
      'pre-receive',
    ]) {
      writeFileSync(path.join(tpl, 'hooks', h), `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(path.join(tpl, 'hooks', h), 0o755);
    }
    writeFileSync(
      path.join(home, '.gitconfig'),
      `[core]\n\thooksPath = ${tpl}/hooks\n\tfsmonitor = ${marker}\n[filter "evil"]\n\tsmudge = touch ${marker}\n\tclean = touch ${marker}\n\trequired = true\n[protocol]\n\tallow = always\n[http]\n\tsslVerify = false\n[init]\n\ttemplateDir = ${tpl}\n`,
    );
    const patch = diffOf('src/price.js', PRICE_BEFORE, PRICE_AFTER);
    const saved = { ...process.env };
    Object.assign(process.env, {
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_TEMPLATE_DIR: tpl,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: `${tpl}/hooks`,
      GIT_CONFIG_KEY_1: 'http.sslVerify',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_SSL_NO_VERIFY: '1',
      GIT_DIR: path.join(tmp, 'nonexistent'),
      HTTPS_PROXY: 'http://127.0.0.1:9',
    });
    try {
      const s = await engine().openSession(target({ branchPrefix: 'oax/' }));
      try {
        await s.fetchCommit(baseSha);
        await s.applyAndPushBranch({
          sha: baseSha,
          patch,
          patchSha256: createHash('sha256').update(patch).digest('hex'),
          branch: 'oax/hooks/test-1',
          message: 'fix: round half up',
          identity: IDENTITY,
        });
      } finally {
        await s.dispose();
      }
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses redirects and does not follow them', async () => {
    srv.mode.redirect = true;
    srv.seen.length = 0;
    const s = await engine().openSession(target());
    try {
      await expect(s.lsRemote('refs/heads/main')).rejects.toMatchObject({
        code: 'redirect_refused',
      });
    } finally {
      srv.mode.redirect = false;
      await s.dispose();
    }
    expect(srv.seen.some((r) => r.url.startsWith('/elsewhere'))).toBe(false);
  });

  it('classifies a wrong token as auth_failed', async () => {
    const eng = engine({ secrets: { resolve: async () => 'wrong-token-value-1234' } });
    const s = await eng.openSession(target());
    try {
      await expect(s.lsRemote('refs/heads/main')).rejects.toMatchObject({ code: 'auth_failed' });
    } finally {
      await s.dispose();
    }
  });

  it('refuses oversize transfers', async () => {
    const big = seedRepo(
      srv,
      {
        'src/a.txt': 'x',
        blob: randomBytes(200_000),
      },
      { branch: 'bigbranch' },
    );
    const s = await engine({ limits: { maxReceiveBytes: 20_000 } }).openSession(target());
    try {
      await expect(s.fetchCommit(big)).rejects.toMatchObject({ code: 'transfer_limit' });
    } finally {
      await s.dispose();
    }
  });

  it('refuses a tree above the seed limits', async () => {
    const s = await engine({ limits: { maxSeedBytes: 100 } }).openSession(target());
    try {
      await s.fetchCommit(baseSha);
      await expect(s.snapshot(baseSha)).rejects.toMatchObject({ code: 'sync_limit' });
    } finally {
      await s.dispose();
    }
  });

  it('times out a hanging host and kills the git process', async () => {
    srv.mode.hang = true;
    const s = await engine({ limits: { timeoutMs: 600 } }).openSession(target());
    try {
      await expect(s.lsRemote('refs/heads/main')).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      srv.mode.hang = false;
      await s.dispose();
    }
  });

  it('fails TLS when the host certificate is not the pinned one', async () => {
    const other = makeTls(mkdtempSync(path.join(tmp, 'other-')));
    const s = await engine({
      dispatcher: makeDispatcher(other.cert),
      secretReader: (ref) => (ref === 'test-ca' ? other.cert : undefined),
    }).openSession(target());
    try {
      await expect(s.lsRemote('refs/heads/main')).rejects.toMatchObject({ code: 'tls_failed' });
    } finally {
      await s.dispose();
    }
  });

  it('is denied by the resolver for a private address the operator did not allow', async () => {
    const s = await engine({ privateAllow: [] }).openSession(target());
    try {
      await expect(s.lsRemote('refs/heads/main')).rejects.toMatchObject({ code: 'egress_denied' });
    } finally {
      await s.dispose();
    }
  });

  it('is denied by a deny route before git starts', async () => {
    const eng = engine({
      dispatcher: makeDispatcher(tls.cert, {
        routes: [{ match: { hosts: ['localhost'] }, via: 'deny' }],
      }),
    });
    const s = await eng.openSession(target());
    try {
      await expect(s.lsRemote('refs/heads/main')).rejects.toMatchObject({ code: 'egress_denied' });
    } finally {
      await s.dispose();
    }
  });

  it('rejects hostile inputs before any process or connection', async () => {
    const eng = engine();
    for (const url of [
      'http://localhost/x/y',
      'file:///etc/passwd',
      'ext::sh -c id',
      'ssh://git@localhost/x/y',
      `https://user:pw@localhost:${srv.port}/x/y`,
      'https://localhost/-evil/y',
      'https://localhost/x/../y',
    ])
      await expect(eng.openSession(target({ url })), url).rejects.toMatchObject({
        code: 'url_invalid',
      });
    const s = await eng.openSession(target());
    try {
      for (const ref of [
        '-x',
        '--upload-pack=touch /tmp/x',
        'refs/heads/-x',
        'refs/heads/a..b',
        'refs/tags/x',
        'main',
        'refs/heads/a b',
      ])
        await expect(s.lsRemote(ref), ref).rejects.toMatchObject({ code: 'ref_invalid' });
      await expect(s.fetchCommit('--upload-pack=x')).rejects.toMatchObject({ code: 'sha_invalid' });
      await expect(s.fetchCommit('abc')).rejects.toMatchObject({ code: 'sha_invalid' });
    } finally {
      await s.dispose();
    }
  });

  it('refuses an unsupported git version', async () => {
    await expect(engine({ minGitVersion: '99.0.0' }).openSession(target())).rejects.toMatchObject({
      code: 'git_version_unsupported',
    });
  });

  it('serialises git calls under a concurrency limit and cleans up its directories', async () => {
    const before = readdirSync(tmp).filter((n) => n.startsWith('oax-git-')).length;
    const eng = engine({ maxConcurrent: 1 });
    const sessions = await Promise.all([1, 2, 3].map(() => eng.openSession(target())));
    const res = await Promise.all(sessions.map((s) => s.lsRemote('refs/heads/main')));
    expect(res).toEqual([baseSha, baseSha, baseSha]);
    await Promise.all(sessions.map((s) => s.dispose()));
    expect(readdirSync(tmp).filter((n) => n.startsWith('oax-git-')).length).toBe(before);
  });
});

describe('GitEngine write side', () => {
  const prep = async (over: Partial<GitEngineOptions> = {}, t: Partial<GitTarget> = {}) => {
    const s = await engine(over).openSession(target(t));
    await s.fetchCommit(baseSha);
    return s;
  };
  const input = (patch: string, branch: string, extra: Record<string, unknown> = {}) => ({
    sha: baseSha,
    patch,
    patchSha256: createHash('sha256').update(patch).digest('hex'),
    branch,
    message:
      'fix(price): round half up\n\nProposed by the openagentix bug-fix agent (run 12345678).',
    identity: IDENTITY,
    ...extra,
  });

  it('applies the patch, commits with the platform identity and pushes a new branch', async () => {
    audits.length = 0;
    const patch = diffOf('src/price.js', PRICE_BEFORE, PRICE_AFTER);
    const s = await prep();
    try {
      const rep = await s.applyAndPushBranch(input(patch, 'oax/bug-fix/issue-1-abcd1234'));
      expect(rep.pushed).toBe(true);
      expect(rep.changedFiles).toBe(1);
      const remote = git(srv.bare, 'rev-parse', 'refs/heads/oax/bug-fix/issue-1-abcd1234');
      expect(remote).toBe(rep.commit);
      expect(git(srv.bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', remote)).toBe(
        'agentix-zero <github@openagentix.si>|agentix-zero <github@openagentix.si>',
      );
      const msg = git(srv.bare, 'log', '-1', '--format=%B', remote);
      expect(msg).toContain('Signed-off-by: agentix-zero <github@openagentix.si>');
      expect(git(srv.bare, 'rev-parse', `${remote}^`)).toBe(baseSha);
      expect(git(srv.bare, 'show', `${remote}:src/price.js`)).toBe(PRICE_AFTER.trimEnd());
      expect(git(srv.bare, 'diff', '--name-only', baseSha, remote)).toBe('src/price.js');
      // main is untouched
      expect(git(srv.bare, 'rev-parse', 'refs/heads/main')).toBe(baseSha);
    } finally {
      await s.dispose();
    }
    const kinds = audits.map((a) => a.action);
    expect(kinds).toEqual(expect.arrayContaining(['git.apply', 'git.push']));
    const push = audits.find((a) => a.action === 'git.push');
    expect(push).toMatchObject({ ok: true, branch: 'oax/bug-fix/issue-1-abcd1234' });
    expect(JSON.stringify(audits)).not.toContain(GIT_TOKEN);
    expect(JSON.stringify(audits)).not.toContain('Math.round');
  });

  it('never overwrites an existing branch', async () => {
    const patch = diffOf('src/price.js', PRICE_BEFORE, PRICE_AFTER);
    const before = git(srv.bare, 'rev-parse', 'refs/heads/oax/bug-fix/issue-1-abcd1234');
    const s = await prep();
    try {
      await expect(
        s.applyAndPushBranch(input(patch, 'oax/bug-fix/issue-1-abcd1234')),
      ).rejects.toMatchObject({
        code: 'branch_exists',
      });
    } finally {
      await s.dispose();
    }
    expect(git(srv.bare, 'rev-parse', 'refs/heads/oax/bug-fix/issue-1-abcd1234')).toBe(before);
  });

  it('stops before the push in dry-run mode', async () => {
    const patch = diffOf('src/price.js', PRICE_BEFORE, PRICE_AFTER);
    const s = await prep();
    try {
      const rep = await s.applyAndPushBranch({
        ...input(patch, 'oax/bug-fix/dry-run'),
        dryRun: true,
      });
      expect(rep.pushed).toBe(false);
      expect(rep.commit).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await s.dispose();
    }
    expect(() =>
      git(srv.bare, 'rev-parse', '--verify', 'refs/heads/oax/bug-fix/dry-run'),
    ).toThrow();
  });

  it('refuses branches outside the prefix and option-like names', async () => {
    const patch = diffOf('src/price.js', PRICE_BEFORE, PRICE_AFTER);
    const s = await prep();
    try {
      for (const b of [
        'main',
        'oax/',
        '-oax/x',
        'oax/../main',
        'refs/heads/oax/x',
        'oax/a b',
        'feature/x',
        'oax/x.lock',
        'oax//x',
      ])
        await expect(s.applyAndPushBranch(input(patch, b)), b).rejects.toMatchObject({
          code: expect.stringMatching(/^(branch_invalid|branch_prefix_refused)$/),
        });
    } finally {
      await s.dispose();
    }
  });

  it('refuses a digest mismatch, forbidden paths and renames, modes, binaries and links on the worker side', async () => {
    const good = diffOf('src/price.js', PRICE_BEFORE, PRICE_AFTER);
    const s = await prep();
    try {
      await expect(
        s.applyAndPushBranch({ ...input(good, 'oax/bug-fix/a1'), patchSha256: '0'.repeat(64) }),
      ).rejects.toMatchObject({ code: 'patch_digest_mismatch' });
      const bad: [string, string, string][] = [
        ['outside area', diffOf('.github/workflows/x.yml', 'a\n', 'b\n'), 'patch_path_refused'],
        [
          'rename',
          'diff --git a/src/a.js b/src/b.js\nsimilarity index 100%\nrename from src/a.js\nrename to src/b.js\n',
          'patch_invalid',
        ],
        [
          'mode',
          'diff --git a/src/a.js b/src/a.js\nold mode 100644\nnew mode 100755\n',
          'patch_invalid',
        ],
        [
          'symlink',
          'diff --git a/src/l b/src/l\nnew file mode 120000\n--- /dev/null\n+++ b/src/l\n@@ -0,0 +1 @@\n+/etc/passwd\n',
          'patch_invalid',
        ],
        [
          'binary',
          'diff --git a/src/b.bin b/src/b.bin\nnew file mode 100644\nGIT binary patch\nliteral 3\nKcmZP\n\n',
          'patch_invalid',
        ],
        [
          'traversal',
          'diff --git a/src/../x b/src/../x\nnew file mode 100644\n--- /dev/null\n+++ b/src/../x\n@@ -0,0 +1 @@\n+x\n',
          'patch_path_refused',
        ],
      ];
      for (const [label, patch, code] of bad)
        await expect(
          s.applyAndPushBranch(input(patch, 'oax/bug-fix/a2')),
          label,
        ).rejects.toMatchObject({ code });
    } finally {
      await s.dispose();
    }
    expect(() => git(srv.bare, 'rev-parse', '--verify', 'refs/heads/oax/bug-fix/a2')).toThrow();
  });

  it('refuses a patch that does not apply to the base commit', async () => {
    const patch = diffOf('src/price.js', 'something else\n', 'other\n');
    const s = await prep();
    try {
      await expect(s.applyAndPushBranch(input(patch, 'oax/bug-fix/noapply'))).rejects.toMatchObject(
        {
          code: 'patch_apply_failed',
        },
      );
    } finally {
      await s.dispose();
    }
  });

  it('blocks delivery when the patch contains credential-like text (issue #140) and pushes nothing', async () => {
    audits.length = 0;
    const leaked = `ghp_${'Q'.repeat(36)}`;
    const variants = [
      diffOf('src/price.js', PRICE_BEFORE, `${PRICE_AFTER}// ${leaked}\n`),
      diffOf(
        'src/price.js',
        PRICE_BEFORE,
        `${PRICE_AFTER}// ${Buffer.from(leaked).toString('base64')}\n`,
      ),
      diffOf('src/price.js', PRICE_BEFORE, `${PRICE_AFTER}// ${GIT_TOKEN}\n`),
      diffOf(
        'src/price.js',
        PRICE_BEFORE,
        `${PRICE_AFTER}const k = "${'a1'.repeat(16)}";\nconst password = "hunter2hunter2hunter2xx";\n`,
      ),
    ];
    const s = await prep();
    try {
      for (const [i, patch] of variants.entries())
        await expect(
          s.applyAndPushBranch(input(patch, `oax/bug-fix/leak-${i}`)),
          `variant ${i}`,
        ).rejects.toMatchObject({
          code: 'secret_detected',
        });
    } finally {
      await s.dispose();
    }
    expect(git(srv.bare, 'branch', '--list', 'oax/bug-fix/leak-*')).toBe('');
    const refused = audits.filter((a) => a.action === 'git.refused');
    expect(refused).toHaveLength(variants.length);
    expect(JSON.stringify(audits)).not.toContain(leaked);
    expect(JSON.stringify(audits)).not.toContain(GIT_TOKEN);
  });

  it('does not leak the token in thrown errors', async () => {
    const eng = engine({ secrets: { resolve: async () => 'tok-that-is-wrong-9999' } });
    const s = await eng.openSession(target());
    try {
      const e = await s.lsRemote('refs/heads/main').catch((x: unknown) => x as Error);
      expect(String((e as Error).message)).not.toContain('tok-that-is-wrong-9999');
    } finally {
      await s.dispose();
    }
  });

  it('keeps the API credential reference away from the Git engine', async () => {
    // the engine only ever resolves the reference in its own target
    const seen: string[] = [];
    const eng = engine({
      secrets: {
        resolve: async (ref: string) => (seen.push(ref), ref === 'git-token' ? GIT_TOKEN : 'x'),
      },
    });
    const s = await eng.openSession(target());
    try {
      await s.lsRemote('refs/heads/main');
    } finally {
      await s.dispose();
    }
    expect(new Set(seen)).toEqual(new Set(['git-token']));
    void OWNER;
    void NAME;
  });
});
