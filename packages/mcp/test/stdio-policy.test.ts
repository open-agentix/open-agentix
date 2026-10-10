import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StaticSecretResolver } from '@openagentix/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  McpServerConfigSchema,
  ToolGateway,
  checkStdioConfig,
  forbiddenProgram,
  isReservedStdioEnv,
  matchesStdioAllowlist,
  parseStdioAllowlist,
  stdioError,
  type StdioCheckOptions,
  type StdioFields,
} from '../src/index.js';

const ALLOW = ['/opt/mcp/bin/*', '/usr/local/bin/oax-workspace'];
const check = (cfg: StdioFields, opts: Partial<StdioCheckOptions> = {}) =>
  checkStdioConfig(cfg, { allowlist: ALLOW, ...opts });
const cmd = (command: string, args: string[] = []): StdioFields => ({ command, args });
const messages = (cfg: StdioFields, opts: Partial<StdioCheckOptions> = {}) =>
  check(cfg, opts).map((i) => i.message);

describe('OAX_MCP_STDIO_COMMANDS parsing', () => {
  it('accepts files and dir/* entries, ignores blanks', () => {
    expect(parseStdioAllowlist(undefined)).toEqual([]);
    expect(parseStdioAllowlist('')).toEqual([]);
    expect(parseStdioAllowlist(' /opt/mcp/bin/*, /usr/local/bin/oax-workspace ,,')).toEqual([
      '/opt/mcp/bin/*',
      '/usr/local/bin/oax-workspace',
    ]);
  });

  it.each([
    ['relative path', 'bin/server'],
    ['bare name', 'server'],
    ['parent segment', '/opt/mcp/../bin/server'],
    ['dot segment', '/opt/./mcp/server'],
    ['double slash', '/opt//mcp/server'],
    ['trailing slash', '/opt/mcp/'],
    ['glob in the middle', '/opt/*/server'],
    ['glob in the name', '/opt/mcp/serv*'],
    ['recursive glob', '/opt/mcp/**'],
    ['question mark', '/opt/mcp/serv?r'],
    ['brace expansion', '/opt/mcp/{a,b}'],
    ['whitespace', '/opt/mcp/my server'],
    ['root', '/'],
    ['everything', '/*'],
    ['system bin dir', '/usr/bin/*'],
    ['bin dir', '/bin/*'],
    ['tmp dir', '/tmp/*'],
    ['workspace dir', '/workspace/*'],
    ['home', '/home/*'],
  ])('refuses %s (fails start-up instead of opening a hole)', (_label, entry) => {
    expect(() => parseStdioAllowlist(entry)).toThrow(/OAX_MCP_STDIO_COMMANDS entry/);
  });

  it('matches exact files and direct children of a dir/* entry only', () => {
    expect(matchesStdioAllowlist('/opt/mcp/bin/server', ALLOW)).toBe(true);
    expect(matchesStdioAllowlist('/usr/local/bin/oax-workspace', ALLOW)).toBe(true);
    expect(matchesStdioAllowlist('/opt/mcp/bin/sub/server', ALLOW)).toBe(false);
    expect(matchesStdioAllowlist('/opt/mcp/binx/server', ALLOW)).toBe(false);
    expect(matchesStdioAllowlist('/opt/mcp/server', ALLOW)).toBe(false);
    expect(matchesStdioAllowlist('/usr/local/bin/oax-workspace2', ALLOW)).toBe(false);
    expect(matchesStdioAllowlist('/opt/mcp/bin/server', [])).toBe(false);
  });
});

describe('command allowlist', () => {
  it('accepts an allowlisted absolute path, with arguments', () => {
    expect(
      check(cmd('/opt/mcp/bin/jira-mcp', ['--readonly', '--url=https://j.example.org'])),
    ).toEqual([]);
    expect(check(cmd('/usr/local/bin/oax-workspace'))).toEqual([]);
  });

  it.each([
    ['not listed', '/opt/other/server', /not in OAX_MCP_STDIO_COMMANDS/],
    ['below a listed dir', '/opt/mcp/bin/sub/server', /not in OAX_MCP_STDIO_COMMANDS/],
    ['sibling of a listed file', '/usr/local/bin/oax-workspace-x', /not in OAX_MCP_STDIO_COMMANDS/],
    ['relative name (PATH lookup)', 'jira-mcp', /must be an absolute path/],
    ['relative path', './bin/server', /must be an absolute path/],
    ['home expansion', '~/server', /must be an absolute path/],
    ['windows path', 'C:\\tools\\server.exe', /must be an absolute path/],
    ['parent traversal out of the dir', '/opt/mcp/bin/../../../bin/true', /normalized absolute/],
    ['dot segment', '/opt/mcp/bin/./server', /normalized absolute/],
    ['double slash', '/opt/mcp/bin//server', /normalized absolute/],
    ['trailing slash', '/opt/mcp/bin/server/', /normalized absolute/],
    ['NUL byte', '/opt/mcp/bin/server\u0000.sh', /plain path/],
    ['newline', '/opt/mcp/bin/server\n/bin/true', /plain path/],
  ])('refuses a command that is %s', (_label, command, re) => {
    const issues = check(cmd(command));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'mcp_command_forbidden')).toBe(true);
    expect(issues.map((i) => i.message).join('\n')).toMatch(re);
  });

  it('allows nothing when the allowlist is empty (the default)', () => {
    const issues = checkStdioConfig(cmd('/opt/mcp/bin/jira-mcp'), { allowlist: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/no stdio commands are allowed/);
  });

  it('caps the number and size of arguments', () => {
    expect(messages(cmd('/opt/mcp/bin/s', Array(65).fill('a'))).join()).toMatch(/at most 64/);
    expect(messages(cmd('/opt/mcp/bin/s', ['a'.repeat(5000)])).join()).toMatch(/too long/);
    expect(messages(cmd('/opt/mcp/bin/s', ['a\u0000b'])).join()).toMatch(/NUL/);
  });
});

describe('programs that are refused even when allowlisted', () => {
  // The allowlist below contains every one of them: the refusal does not depend on it.
  const names = [
    // shells and multi-call binaries
    'sh',
    'bash',
    'zsh',
    'dash',
    'ash',
    'ksh',
    'fish',
    'csh',
    'tcsh',
    'busybox',
    'toybox',
    'coreutils',
    'env',
    'cmd',
    'cmd.exe',
    'powershell',
    'powershell.exe',
    'pwsh',
    'BASH',
    'Sh',
    // wrappers that execute their arguments
    'sudo',
    'su',
    'doas',
    'xargs',
    'nohup',
    'timeout',
    'nice',
    'setsid',
    'chroot',
    'nsenter',
    'strace',
    'gdb',
    'find',
    'awk',
    'gawk',
    'sed',
    'make',
    'tar',
    'rsync',
    'vim',
    'less',
    'man',
    // run-time installers
    'npx',
    'npm',
    'pnpm',
    'pnpx',
    'yarn',
    'bunx',
    'uvx',
    'uv',
    'pip',
    'pip3',
    'pip3.11',
    'pipx',
    'poetry',
    'conda',
    'gem',
    'cargo',
    'go',
    'composer',
    'apt',
    'apt-get',
    'apk',
    'dpkg',
    'brew',
    'corepack',
    'mvn',
    'gradle',
    // containers, network, vcs
    'docker',
    'podman',
    'nerdctl',
    'kubectl',
    'helm',
    'curl',
    'wget',
    'nc',
    'ncat',
    'socat',
    'ssh',
    'scp',
    'telnet',
    'openssl',
    'git',
    'svn',
    // interpreters whose program is the command line
    'tclsh',
    'irb',
    'jshell',
    'Rscript',
    // dynamic loaders run any program given as argument
    'ld-linux-x86-64.so.2',
    'ld.so',
    'ld-musl-x86_64.so.1',
  ];

  it.each(names)('refuses %s', (name) => {
    const issues = checkStdioConfig(cmd(`/opt/mcp/bin/${name}`), {
      allowlist: [`/opt/mcp/bin/${name}`, '/opt/mcp/bin/*'],
    });
    expect(issues.map((i) => i.message).join('\n')).toMatch(/refused even if allowlisted/);
    expect(issues[0]!.code).toBe('mcp_command_forbidden');
  });

  it('matches the name without version suffix and extension', () => {
    expect(forbiddenProgram('/x/bash5')).not.toBeNull();
    expect(forbiddenProgram('/x/dash.exe')).not.toBeNull();
    expect(forbiddenProgram('/x/pip3.12')).not.toBeNull();
    expect(forbiddenProgram('/x/shell-server')).toBeNull();
    expect(forbiddenProgram('/x/jira-mcp')).toBeNull();
    expect(forbiddenProgram('/x/oax-workspace')).toBeNull();
    expect(forbiddenProgram('/x/mcp-server-git')).toBeNull();
  });
});

describe('interpreters: allowed without code-injecting flags', () => {
  const interp = (name: string, args: string[]) =>
    check(cmd(`/opt/mcp/bin/${name}`, args)).map((i) => `${i.path}: ${i.message}`);

  it.each([
    ['node', ['server.js']],
    ['node', ['--max-old-space-size=256', 'server.js', '--port', '3000']],
    ['node', ['--', 'server.js', '-e', 'x']],
    ['nodejs', ['/opt/mcp/app/server.mjs']],
    ['python3', ['-u', 'server.py']],
    ['python3.11', ['-m', 'mcp_server_time']],
    ['python', ['server.py', '--config', 'a.json']],
    ['perl', ['server.pl']],
    ['ruby', ['server.rb']],
    ['php', ['server.php']],
    ['java', ['-Xmx64m', '-jar', 'server.jar']],
    ['deno', ['run', '--allow-net=api.example.org', 'server.ts']],
    ['bun', ['run', 'server.ts']],
  ])('accepts %s %j', (name, args) => {
    expect(interp(name, args)).toEqual([]);
  });

  it.each([
    ['node', ['-e', 'process.exit()']],
    ['node', ['-pe', '1']],
    ['node', ['-p', '1']],
    ['node', ['--eval', '1']],
    ['node', ['--eval=1']],
    ['node', ['-ecode']],
    ['node', ['-r', './preload.js', 'server.js']],
    ['node', ['--require=./x.js', 'server.js']],
    ['node', ['--import', 'data:text/javascript,1', 'server.js']],
    ['node', ['--loader', 'x', 'server.js']],
    ['node', ['--experimental-loader=x', 'server.js']],
    ['node', ['--env-file=.env', 'server.js']],
    ['node', ['--env_file=.env', 'server.js']],
    ['node', ['--inspect=0.0.0.0:9229', 'server.js']],
    ['node', ['--inspect-brk', 'server.js']],
    ['node', ['--run', 'start']],
    ['node', ['--input-type=module', '-']],
    ['node', ['-']],
    ['node', ['server.js', '-e', 'x']],
    ['node', ['--stack-size=1', '-e', '1']],
    ['nodejs22', ['-e', '1']],
    ['python3', ['-c', 'import os']],
    ['python3', ['-Sc', 'import os']],
    ['python3', ['-Bsc', 'import os']],
    ['python3', ['-cimport os']],
    ['python3.11', ['-c', 'x']],
    ['python', ['-X', 'dev', '-c', 'x']],
    ['python', ['-m', 'pip', 'install', 'x']],
    ['python', ['-mpip', 'install', 'x']],
    ['python', ['-m', 'ensurepip']],
    ['python', ['-m', 'venv', 'x']],
    ['python', ['-m', 'http.server']],
    ['python', ['-m', 'code']],
    ['python', ['-']],
    ['pypy3', ['-c', 'x']],
    ['perl', ['-e', 'system("id")']],
    ['perl', ['-E', 'say 1']],
    ['perl', ['-MOS', 'x.pl']],
    ['perl', ['-Mstrict;system("id")', 'x.pl']],
    ['perl', ['-I/tmp', 'x.pl']],
    ['perl', ['-ne', 'print']],
    ['ruby', ['-e', 'system("id")']],
    ['ruby', ['-rfoo', 'x.rb']],
    ['ruby', ['-I.', 'x.rb']],
    ['php', ['-r', 'system("id");']],
    ['php', ['-d', 'auto_prepend_file=/tmp/x', 'x.php']],
    ['php', ['-S', '0.0.0.0:80']],
    ['lua', ['-e', 'os.execute("id")']],
    ['java', ['-javaagent:/tmp/a.jar', '-jar', 'x.jar']],
    ['java', ['-agentlib:jdwp=transport=dt_socket,server=y', '-jar', 'x.jar']],
    ['java', ['@/tmp/args', '-jar', 'x.jar']],
    ['deno', ['eval', '1']],
    ['deno', ['run', 'https://example.org/x.ts']],
    ['deno', ['install', 'x']],
    ['bun', ['x', 'pkg']],
    ['bun', ['add', 'pkg']],
    ['bun', ['run', 'https://example.org/x.ts']],
    ['bun', ['-e', '1']],
    ['dotnet', ['tool', 'run', 'x']],
  ])('refuses %s %j', (name, args) => {
    const issues = interp(name, args);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('environment', () => {
  const env = (e: Record<string, string>, field: 'env' | 'envSecrets' = 'env') =>
    check({ command: '/opt/mcp/bin/s', [field]: e });

  it('accepts ordinary variables', () => {
    expect(env({ JIRA_URL: 'https://j.example.org', API_TIMEOUT: '30', _X: '1' })).toEqual([]);
    expect(env({ JIRA_TOKEN: 'ref' }, 'envSecrets')).toEqual([]);
  });

  it.each([
    // the reserved names of agents[].credentials
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'PWD',
    'TMPDIR',
    'LANG',
    'NODE_OPTIONS',
    'NODE_PATH',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'OAX_RUN_TOKEN',
    'OAX_SECRET_X',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'DYLD_INSERT_LIBRARIES',
    // case variants and further loader / interpreter hooks
    'path',
    'Path',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'ld_preload',
    'node_options',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'PYTHONPATH',
    'PYTHONHOME',
    'PYTHONSTARTUP',
    'PYTHONINSPECT',
    'PYTHONUSERBASE',
    'BASH_ENV',
    'ENV',
    'PROMPT_COMMAND',
    'IFS',
    'PERL5OPT',
    'PERL5LIB',
    'PERLLIB',
    'RUBYOPT',
    'RUBYLIB',
    'JAVA_TOOL_OPTIONS',
    '_JAVA_OPTIONS',
    'JDK_JAVA_OPTIONS',
    'CLASSPATH',
    'GCONV_PATH',
    'GLIBC_TUNABLES',
    'HOSTALIASES',
    'LOCALDOMAIN',
    'RES_OPTIONS',
    'MALLOC_PERTURB_',
    'GIT_SSH_COMMAND',
    'GIT_ASKPASS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'NPM_CONFIG_REGISTRY',
    'npm_config_registry',
    'PIP_INDEX_URL',
    'UV_INDEX_URL',
    'XDG_CONFIG_HOME',
    'LUA_INIT',
    'PHPRC',
    'PHP_INI_SCAN_DIR',
    'DENO_DIR',
    'BASH_FUNC_x%%',
  ])('refuses the name %s', (name) => {
    const issues = env({ [name]: 'x' });
    expect(issues.length, name).toBeGreaterThan(0);
    expect(issues[0]!.code).toBe('mcp_env_forbidden');
    expect(isReservedStdioEnv(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).toBe(true);
  });

  it('applies to secret-backed variables as well', () => {
    for (const name of ['LD_PRELOAD', 'NODE_OPTIONS', 'PYTHONPATH', 'BASH_ENV', 'https_proxy']) {
      const issues = env({ [name]: 'some.ref' }, 'envSecrets');
      expect(issues[0]?.code, name).toBe('mcp_env_forbidden');
      expect(issues[0]!.path).toBe(`envSecrets.${name}`);
    }
  });

  it.each(['1BAD', 'A-B', 'A B', 'A=B', '', 'A.B', 'A\u0000'])(
    'refuses the invalid name %j',
    (name) => {
      expect(env({ [name]: 'x' })[0]?.code).toBe('mcp_env_forbidden');
    },
  );

  it('refuses NUL bytes and huge values', () => {
    expect(env({ A: 'a\u0000b' })[0]?.code).toBe('mcp_env_forbidden');
    expect(env({ A: 'a'.repeat(9000) })[0]?.code).toBe('mcp_env_forbidden');
  });

  it('reports command and environment problems together with their paths', () => {
    const issues = check({ command: 'sh', args: [], env: { PATH: '/tmp' } });
    expect(issues.map((i) => `${i.code}@${i.path}`)).toEqual([
      'mcp_command_forbidden@command',
      'mcp_env_forbidden@env.PATH',
    ]);
  });
});

describe('the schema leaves no room for a working directory', () => {
  it('rejects cwd and other unknown keys (the child starts in the process directory)', () => {
    const base = { name: 's', transport: 'stdio', command: '/opt/mcp/bin/s' };
    expect(McpServerConfigSchema.safeParse(base).success).toBe(true);
    for (const extra of [{ cwd: '/' }, { shell: true }, { detached: true }, { uid: 0 }])
      expect(
        McpServerConfigSchema.safeParse({ ...base, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
  });
});

describe('symlinks and real paths', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oax-stdio-')));
  const bin = join(root, 'bin');
  const outside = join(root, 'outside');
  mkdirSync(bin);
  mkdirSync(outside);
  const allow = [`${bin}/*`];
  const real = (p: string) => realpathSync(p);
  writeFileSync(join(bin, 'ok-server'), '#!/bin/true\n', { mode: 0o755 });
  writeFileSync(join(outside, 'planted'), '#!/bin/true\n', { mode: 0o755 });
  symlinkSync(join(bin, 'ok-server'), join(bin, 'alias-ok'));
  symlinkSync(join(outside, 'planted'), join(bin, 'escape'));
  symlinkSync(real('/bin/sh'), join(bin, 'innocent-shell'));
  symlinkSync(process.execPath, join(bin, 'innocent-node'));
  symlinkSync(join(root, 'nowhere'), join(bin, 'dangling'));
  symlinkSync(bin, join(root, 'bin-link'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const run = (command: string, args: string[], realpath: StdioCheckOptions['realpath']) =>
    checkStdioConfig({ command, args }, { allowlist: allow, realpath: realpath! });

  it('accepts a file and a symlink that stays inside the allowlist', () => {
    expect(run(join(bin, 'ok-server'), [], 'require')).toEqual([]);
    expect(run(join(bin, 'alias-ok'), [], 'require')).toEqual([]);
  });

  it('refuses a symlink that leads out of the allowlist', () => {
    const msg = run(join(bin, 'escape'), [], 'if-exists')
      .map((i) => i.message)
      .join('\n');
    expect(msg).toMatch(/real path .* is not in OAX_MCP_STDIO_COMMANDS/);
  });

  it('refuses a harmless-looking name that is a symlink to a shell', () => {
    const msg = run(join(bin, 'innocent-shell'), [], 'if-exists')
      .map((i) => i.message)
      .join('\n');
    expect(msg).toMatch(/refused even if allowlisted/);
  });

  it('applies the interpreter flag rules to the real binary behind a symlink', () => {
    expect(
      run(join(bin, 'innocent-node'), ['-e', '1'], 'if-exists')
        .map((i) => i.message)
        .join(),
    ).toMatch(/interpreter/);
  });

  it('a directory symlink in the path is resolved too', () => {
    // the literal path (through a directory symlink) is not the listed directory
    expect(run(join(root, 'bin-link', 'ok-server'), [], 'require').length).toBeGreaterThan(0);
  });

  it('treats a missing file per mode: skip and if-exists accept, require refuses', () => {
    const missing = join(bin, 'not-there');
    expect(run(missing, [], 'skip')).toEqual([]);
    expect(run(missing, [], 'if-exists')).toEqual([]);
    expect(
      run(missing, [], 'require')
        .map((i) => i.message)
        .join(),
    ).toMatch(/does not exist/);
    expect(run(join(bin, 'dangling'), [], 'require').length).toBeGreaterThan(0);
  });

  it('skip mode does not look at the file system (the control node cannot see node images)', () => {
    expect(run(join(bin, 'innocent-shell'), [], 'skip')).toEqual([]);
  });

  it('uses the injected resolver (run node tests)', () => {
    const issues = checkStdioConfig(
      { command: join(bin, 'ok-server') },
      { allowlist: allow, realpath: 'require', resolve: () => '/bin/dash' },
    );
    expect(issues.map((i) => i.message).join('\n')).toMatch(/refused even if allowlisted/);
  });
});

describe('error and gateway guard', () => {
  it('builds an error with the first code and all issues as details', () => {
    const issues = check({ command: 'sh', env: { PATH: 'x' } });
    const e = stdioError('srv', issues);
    expect(e.code).toBe('mcp_command_forbidden');
    expect(e.message).toContain('MCP server "srv" is refused');
    expect(e.message).toContain('(+1 more)');
    expect(e.details).toEqual(issues);
  });

  it('the gateway calls the guard before a stdio server is started, and a refusal starts nothing', async () => {
    const marker = join(root(), 'started');
    const script = join(root(), 'server.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');\n`,
    );
    const cfg = McpServerConfigSchema.parse({
      name: 'srv',
      transport: 'stdio',
      command: process.execPath,
      args: [script],
      timeoutMs: 3000,
    });
    const seen: string[] = [];
    const gateway = new ToolGateway([cfg], {
      secrets: new StaticSecretResolver({}),
      stdioGuard: (c) => {
        seen.push(c.name);
        throw stdioError(c.name, [
          { code: 'mcp_command_forbidden', path: 'command', message: 'no' },
        ]);
      },
    });
    await expect(
      gateway.exposedTools({ id: 'a', tools: [{ server: 'srv', tool: '*' }] } as never),
    ).rejects.toMatchObject({ code: 'mcp_command_forbidden' });
    expect(seen).toEqual(['srv']);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => realpathSync(marker)).toThrow();
    await gateway.close();
  });

  it('a guard that allows lets a real stdio server start', async () => {
    const script = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));
    const gateway = new ToolGateway(
      [
        McpServerConfigSchema.parse({
          name: 'srv',
          transport: 'stdio',
          command: process.execPath,
          args: [script],
          tools: { echo: { access: 'read' } },
        }),
      ],
      { secrets: new StaticSecretResolver({}), stdioGuard: () => undefined },
    );
    const tools = await gateway.exposedTools({
      id: 'a',
      tools: [{ server: 'srv', tool: '*' }],
    } as never);
    expect(tools.map((t) => t.tool)).toEqual(['echo']);
    await gateway.close();
  });
});

let cached: string | undefined;
function root(): string {
  cached ??= realpathSync(mkdtempSync(join(tmpdir(), 'oax-stdio-gw-')));
  return cached;
}
afterAll(() => cached && rmSync(cached, { recursive: true, force: true }));
