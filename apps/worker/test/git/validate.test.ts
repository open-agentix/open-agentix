import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PATH_ALLOW,
  assertBranchRef,
  assertIdentity,
  assertMessage,
  assertNewBranch,
  assertSha,
  checkPatch,
  packSeed,
  parsePullRequestTarget,
  parseRepoUrl,
  scanForSecrets,
} from '../../src/git/index.js';

describe('parseRepoUrl', () => {
  it('canonicalises a plain https URL', () => {
    expect(parseRepoUrl('https://GitHub.com/open-agentix/dogfood-sandbox')).toMatchObject({
      url: 'https://github.com/open-agentix/dogfood-sandbox',
      host: 'github.com',
      port: 443,
      repoKey: 'open-agentix/dogfood-sandbox',
    });
    expect(parseRepoUrl('https://git.example.org:8443/a/b.git').url).toBe(
      'https://git.example.org:8443/a/b.git',
    );
    expect(parseRepoUrl('https://git.example.org:443/a/b').url).toBe('https://git.example.org/a/b');
  });

  it.each([
    ['http://github.com/a/b'],
    ['git://github.com/a/b'],
    ['file:///etc/passwd'],
    ['ssh://git@github.com/a/b'],
    ['git@github.com:a/b.git'],
    ['ext::sh -c touch% /tmp/x'],
    ['fd::17/foo'],
    ['https://user@github.com/a/b'],
    ['https://user:pw@github.com/a/b'],
    ['https://github.com/a/b?x=1'],
    ['https://github.com/a/b#frag'],
    ['https://127.0.0.1/a/b'],
    ['https://[::1]/a/b'],
    ['https://2130706433/a/b'],
    ['https://0x7f.0.0.1/a/b'],
    ['https://github.com/-a/b'],
    ['https://github.com/a/-b'],
    ['https://github.com/a/../b'],
    ['https://github.com/a/%2e%2e/b'],
    ['https://github.com/a/b c'],
    ['https://github.com/a\\b'],
    ['https://github.com/a/b\n'],
    ['https://github.com/'],
    ['https://github.com/a//b'.replace('//b', '/%2Fb')],
    [''],
    ['https://' + 'a'.repeat(3000)],
  ])('refuses %s', (url) => {
    expect(() => parseRepoUrl(url)).toThrowError(expect.objectContaining({ code: 'url_invalid' }));
  });
});

describe('refs, branches, identity, message', () => {
  it('accepts only full lowercase commit ids', () => {
    expect(assertSha('a'.repeat(40))).toBe('a'.repeat(40));
    for (const s of ['', 'abc', 'A'.repeat(40), '-'.repeat(40), `${'a'.repeat(39)}g`, 'HEAD'])
      expect(() => assertSha(s)).toThrow();
  });

  it('accepts branch refs with a conservative charset', () => {
    expect(assertBranchRef('refs/heads/main')).toBe('refs/heads/main');
    for (const r of [
      'main',
      '-x',
      'refs/heads/-x',
      'refs/heads/a..b',
      'refs/heads/a@{1}',
      'refs/heads/x.lock',
      'refs/heads/a b',
      'refs/heads/',
      'refs/heads/a//b',
      'refs/heads/.hidden',
      'refs/tags/v1',
      'refs/heads/a\nb',
    ])
      expect(() => assertBranchRef(r), r).toThrow();
  });

  it('creates branches only below the prefix', () => {
    expect(assertNewBranch('oax/bug-fix/issue-1-abcd1234', 'oax/')).toBeTruthy();
    for (const b of [
      'main',
      'oax/',
      'oax',
      'x/oax/y',
      'oax/bug-fix/',
      'oax/a..b',
      'oax/a.lock',
      '-oax/x',
    ])
      expect(() => assertNewBranch(b, b === 'oax/bug-fix/' ? 'oax/bug-fix/' : 'oax/'), b).toThrow();
  });

  it('checks identity and message', () => {
    expect(assertIdentity({ name: 'agentix-zero', email: 'github@openagentix.si' })).toBeTruthy();
    for (const id of [
      { name: 'a<b>', email: 'x@y.z' },
      { name: 'a\nb', email: 'x@y.z' },
      { name: 'ok', email: 'not an email' },
      { name: '', email: 'x@y.z' },
    ])
      expect(() => assertIdentity(id)).toThrow();
    expect(assertMessage('fix: x\n\nbody')).toBeTruthy();
    expect(() => assertMessage('')).toThrow();
    expect(() => assertMessage('a\0b')).toThrow();
    expect(() => assertMessage('x'.repeat(5000))).toThrow();
  });
});

describe('scanForSecrets', () => {
  const hit = (t: string, known: string[] = []) => scanForSecrets(t, known).length > 0;

  it('finds well-known credential shapes without echoing them', () => {
    const samples = [
      `ghp_${'a'.repeat(36)}`,
      `github_pat_${'A1'.repeat(15)}`,
      `glpat-${'x'.repeat(20)}`,
      'AKIAABCDEFGHIJKLMNOP',
      `sk-ant-${'a'.repeat(30)}`,
      `xoxb-${'1'.repeat(12)}-abc`,
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`,
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
      'https://user:hunter2pw@example.org/x',
      'export OAX_MODEL_PROXY_TOKEN=abcdefghijklmnop',
      'const password = "correct-horse-battery-staple"',
    ];
    for (const s of samples) {
      const r = scanForSecrets(`line\n${s}\n`);
      expect(r.length, s).toBeGreaterThan(0);
      expect(JSON.stringify(r)).not.toContain(s);
    }
  });

  it('decodes one level of base64, hex and reversal', () => {
    const t = `ghp_${'b'.repeat(36)}`;
    expect(hit(Buffer.from(t).toString('base64'))).toBe(true);
    expect(hit(Buffer.from(t).toString('hex'))).toBe(true);
    expect(hit([...t].reverse().join(''))).toBe(true);
  });

  it('finds exact known secrets in many forms', () => {
    const k = 'my-very-private-value-123456';
    expect(hit(`x ${k} y`, [k])).toBe(true);
    expect(hit(Buffer.from(k).toString('base64'), [k])).toBe(true);
    expect(hit(Buffer.from(`x-access-token:${k}`).toString('base64'), [k])).toBe(true);
    expect(hit([...k].reverse().join(''), [k])).toBe(true);
    expect(hit(encodeURIComponent(`${k}&`), [k])).toBe(true);
    expect(hit('"my-very-" + "private-value-" + "123456"', [k])).toBe(true);
  });

  it('lets ordinary code and commit ids through', () => {
    const ok = [
      `export function applyDiscount(cents, percent) { return Math.round((cents * (100 - percent)) / 100); }`,
      `commit ${'a1b2c3d4e5'.repeat(4)}`,
      'const slug = "creme-brulee-deluxe";',
      'Fixes #12. Proposed by the openagentix bug-fix agent (run 12345678).',
    ];
    for (const s of ok) expect(hit(s), s).toBe(false);
  });

  it('stays linear on hostile input (no catastrophic backtracking)', () => {
    for (const t of ['a.'.repeat(32_768), 'A.'.repeat(32_768), 'A_TOKEN'.repeat(9_000)]) {
      const started = performance.now();
      scanForSecrets(t, ['my-very-private-value-123456']);
      expect(performance.now() - started, t.slice(0, 8)).toBeLessThan(1_000);
    }
  });
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const policy = { pathAllow: DEFAULT_PATH_ALLOW, maxBytes: 4096, maxFiles: 3 };
const GOOD =
  'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n export {};\n';

describe('checkPatch', () => {
  it('accepts the node format and git diff output', () => {
    const r = checkPatch(GOOD, sha(GOOD), policy);
    expect(r.files).toEqual([{ path: 'src/a.js', status: 'modified', additions: 1, deletions: 1 }]);
    const added =
      'diff --git a/test/new.test.js b/test/new.test.js\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/test/new.test.js\n@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n';
    expect(checkPatch(added, sha(added), policy).files[0]?.status).toBe('added');
    const emptyFile = 'diff --git a/test/empty.js b/test/empty.js\nnew file mode 100644\n';
    expect(checkPatch(emptyFile, sha(emptyFile), policy).files[0]?.path).toBe('test/empty.js');
    const del =
      'diff --git a/src/a.js b/src/a.js\ndeleted file mode 100644\n--- a/src/a.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';
    expect(checkPatch(del, sha(del), policy).files[0]?.status).toBe('deleted');
  });

  const refused: [string, string, string][] = [
    ['empty', '', 'patch_invalid'],
    ['no final newline', GOOD.slice(0, -1), 'patch_invalid'],
    ['NUL', GOOD.replace('const a = 2', 'const a\0 = 2'), 'patch_invalid'],
    ['CR', GOOD.replace('const a = 2;', 'const a = 2;\r'), 'patch_invalid'],
    ['garbage', 'hello\n', 'patch_invalid'],
    [
      'rename',
      'diff --git a/src/a.js b/src/b.js\nrename from src/a.js\nrename to src/b.js\n',
      'patch_invalid',
    ],
    [
      'copy',
      'diff --git a/src/a.js b/src/b.js\ncopy from src/a.js\ncopy to src/b.js\n',
      'patch_invalid',
    ],
    [
      'mode change',
      'diff --git a/src/a.js b/src/a.js\nold mode 100644\nnew mode 100755\n',
      'patch_invalid',
    ],
    [
      'symlink',
      'diff --git a/src/l b/src/l\nnew file mode 120000\n--- /dev/null\n+++ b/src/l\n@@ -0,0 +1 @@\n+/etc/passwd\n',
      'patch_invalid',
    ],
    ['gitlink', 'diff --git a/src/l b/src/l\nnew file mode 160000\n', 'patch_invalid'],
    [
      'binary',
      'diff --git a/src/b b/src/b\nnew file mode 100644\nGIT binary patch\nliteral 1\n',
      'patch_invalid',
    ],
    [
      'binary notice',
      'diff --git a/src/b b/src/b\nBinary files a/src/b and b/src/b differ\n',
      'patch_invalid',
    ],
    [
      'modified without hunks',
      'diff --git a/src/a.js b/src/a.js\nindex 1234567..89abcde 100644\n',
      'patch_invalid',
    ],
    ['header mismatch', GOOD.replace('+++ b/src/a.js', '+++ b/src/other.js'), 'patch_invalid'],
    ['truncated hunk', GOOD.replace('-1,2 +1,2', '-1,9 +1,9'), 'patch_invalid'],
    ['bad hunk body', GOOD.replace(' export {};', 'export {};'), 'patch_invalid'],
    ['outside area', GOOD.replaceAll('src/a.js', '.github/a.yml'), 'patch_path_refused'],
    ['root file', GOOD.replaceAll('src/a.js', 'package.json'), 'patch_path_refused'],
    ['dot dot', GOOD.replaceAll('src/a.js', 'src/../x.js'), 'patch_path_refused'],
    ['hidden', GOOD.replaceAll('src/a.js', 'src/.env'), 'patch_path_refused'],
    ['listed twice', GOOD + GOOD, 'patch_invalid'],
  ];
  it.each(refused)('refuses %s', (_label, patch, code) => {
    expect(() => checkPatch(patch, sha(patch), policy)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it('checks the digest, the size and the number of files', () => {
    expect(() => checkPatch(GOOD, '0'.repeat(64), policy)).toThrowError(
      expect.objectContaining({ code: 'patch_digest_mismatch' }),
    );
    expect(() => checkPatch(GOOD, 'zz', policy)).toThrowError(
      expect.objectContaining({ code: 'patch_digest_mismatch' }),
    );
    expect(() => checkPatch(GOOD, sha(GOOD), { ...policy, maxBytes: 10 })).toThrowError(
      expect.objectContaining({ code: 'patch_too_large' }),
    );
    const four = ['a', 'b', 'c', 'd']
      .map((n) => GOOD.replaceAll('src/a.js', `src/${n}.js`))
      .join('');
    expect(() => checkPatch(four, sha(four), policy)).toThrowError(
      expect.objectContaining({ code: 'patch_too_large' }),
    );
  });

  it('does not let a content line that looks like a header hide a second file', () => {
    // the removed line "-- a/src/x" renders as "--- a/src/x" and the added line "++ b/..." as "+++ b/..."
    const trick =
      'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n--- a/package.json\n+++ b/package.json\n x\n';
    expect(checkPatch(trick, sha(trick), policy).files.map((f) => f.path)).toEqual(['src/a.js']);
    const smuggle = `${trick}diff --git a/.github/x b/.github/x\nnew file mode 100644\n`;
    expect(() => checkPatch(smuggle, sha(smuggle), policy)).toThrowError(
      expect.objectContaining({ code: 'patch_path_refused' }),
    );
  });

  it('limits deletions to the delete allowlist', () => {
    const del =
      'diff --git a/src/a.js b/src/a.js\ndeleted file mode 100644\n--- a/src/a.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';
    expect(() => checkPatch(del, sha(del), { ...policy, deleteAllow: [/^test\//] })).toThrowError(
      expect.objectContaining({ code: 'patch_path_refused' }),
    );
  });
});

describe('packSeed', () => {
  it('writes a deterministic ustar archive with long paths split by prefix', () => {
    const long = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.txt`;
    const files = [
      { path: long, mode: '100644' as const, content: Buffer.from('b') },
      { path: 'a.txt', mode: '100755' as const, content: Buffer.from('a') },
    ];
    const a = packSeed(files);
    expect(a.equals(packSeed([...files].reverse()))).toBe(true);
    expect(a.length % 512).toBe(0);
    expect(() =>
      packSeed([{ path: 'x'.repeat(400), mode: '100644', content: Buffer.alloc(0) }]),
    ).toThrow();
  });

  it('writes names as UTF-8 and refuses paths that could leave the unpack directory', () => {
    const name = 'src/ĮĮįx.js';
    const a = packSeed([{ path: name, mode: '100644', content: Buffer.from('x') }]);
    expect(a.subarray(0, Buffer.byteLength(name)).toString('utf8')).toBe(name);
    expect(a.subarray(0, 100).includes(Buffer.from('../'))).toBe(false);
    for (const bad of ['../x', 'a/../x', '/etc/x', 'a//b', './a', 'a\\b', 'a\u0000b', 'a�b'])
      expect(
        () => packSeed([{ path: bad, mode: '100644', content: Buffer.alloc(0) }]),
        JSON.stringify(bad),
      ).toThrow();
  });
});

describe('parsePullRequestTarget', () => {
  const ok = {
    name: 'dogfood-sandbox',
    url: 'https://github.com/open-agentix/dogfood-sandbox',
    tokenRef: 'dogfood.github.pr',
  };
  it('applies the defaults of the dogfooding plan', () => {
    const t = parsePullRequestTarget(ok);
    expect(t).toMatchObject({
      baseBranch: 'main',
      branchPrefix: 'oax/bug-fix/',
      extension: 'github',
      maxOpenPullRequests: 2,
      maxPatchBytes: 65536,
      maxFiles: 20,
      extensionTokenRef: 'dogfood.github.pr',
      repoKey: 'open-agentix/dogfood-sandbox',
    });
    expect(t.pathAllow.some((re) => re.test('src/x.js'))).toBe(true);
    expect(t.pathAllow.some((re) => re.test('.github/x.yml'))).toBe(false);
  });

  it('refuses unknown keys, loose patterns, wrong prefixes and bad URLs', () => {
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, url: 'http://github.com/a/b' },
      { ...ok, pathAllow: ['.*'] },
      { ...ok, pathAllow: ['src/'] },
      { ...ok, pathAllow: ['^('] },
      { ...ok, branchPrefix: 'feature/' },
      { ...ok, maxOpenPullRequests: 99 },
      { ...ok, tokenRef: 'ghp_realvalue with space' },
      { ...ok, extension: 'gitlab' },
      null,
      [],
    ])
      expect(() => parsePullRequestTarget(bad)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/target_invalid|url_invalid/) }),
      );
  });
});
