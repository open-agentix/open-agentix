import { posix as path } from 'node:path';

// ---------------------------------------------------------------------------------------------
// Always-refused programs
// ---------------------------------------------------------------------------------------------

/** Shells and multi-call binaries (a symlink to them becomes any applet, including a shell). */
const SHELLS = [
  'sh',
  'bash',
  'zsh',
  'dash',
  'ash',
  'ksh',
  'mksh',
  'pdksh',
  'csh',
  'tcsh',
  'fish',
  'rbash',
  'rsh',
  'busybox',
  'toybox',
  'coreutils',
  'cmd',
  'powershell',
  'pwsh',
  'wscript',
  'cscript',
  'mshta',
  'eval',
  'exec',
  'command',
  'builtin',
];
/** Programs that execute another program or an expression given in their arguments. */
const WRAPPERS = [
  'env',
  'sudo',
  'su',
  'doas',
  'runuser',
  'setpriv',
  'chroot',
  'nsenter',
  'unshare',
  'xargs',
  'nohup',
  'nice',
  'ionice',
  'timeout',
  'time',
  'stdbuf',
  'setsid',
  'script',
  'flock',
  'watch',
  'parallel',
  'find',
  'strace',
  'ltrace',
  'gdb',
  'lldb',
  'valgrind',
  'taskset',
  'chrt',
  'dbus-launch',
  'dbus-run-session',
  'run-parts',
  'at',
  'batch',
  'systemd-run',
  'tmux',
  'screen',
  'expect',
  'rlwrap',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'sed',
  'ed',
  'ex',
  'vi',
  'vim',
  'nvim',
  'emacs',
  'nano',
  'less',
  'more',
  'man',
  'make',
  'gmake',
  'm4',
  'tar',
  'zip',
  'cpio',
  'rsync',
  'busctl',
  // init and privilege wrappers common in container images: they exec their arguments
  'tini',
  'dumb-init',
  'catatonit',
  'gosu',
  'su-exec',
  'setuidgid',
  'chpst',
  'envdir',
  'envuidgid',
  'softlimit',
  'capsh',
  'prlimit',
  'unbuffer',
  'firejail',
  'bwrap',
  'proot',
  'fakeroot',
  'fakechroot',
  'faketime',
  'perf',
  'torsocks',
  'proxychains',
  'xvfb-run',
  'ssh-agent',
  'pkexec',
  'sg',
  'newgrp',
  'start-stop-daemon',
  'supervisord',
  // process runners that start commands given as arguments or read from the working directory
  'cross-env',
  'dotenv',
  'concurrently',
  'npm-run-all',
  'run-s',
  'run-p',
  'watchexec',
  'entr',
  'nodemon',
  'pm2',
  'forever',
  'direnv',
  'mise',
  'asdf',
  'volta',
  'fnm',
  'nvm',
  'pyenv',
  'rbenv',
  'just',
  'task',
  'ninja',
  'cmake',
  'rake',
  'gulp',
  'grunt',
  'ip',
  // database shells and calculators with a shell escape or an evaluating flag
  'sqlite3',
  'duckdb',
  'psql',
  'mysql',
  'mariadb',
  'mongosh',
  'mongo',
  'redis-cli',
  'dc',
  'gcc',
  'cc',
  'g++',
  'c++',
  'clang',
  'tcc',
  'ld',
];
/** Network, transfer and remote-shell tools. */
const NETWORK = [
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'tftp',
  'aria2c',
  'http',
  'https',
  'xh',
  'openssl',
  'nmap',
  'busybox-httpd',
];
/** Run-time installers and package managers (code is fetched or built at run time). */
const INSTALLERS = [
  'npx',
  'npm',
  'pnpm',
  'pnpx',
  'yarn',
  'yarnpkg',
  'bunx',
  'corepack',
  'uvx',
  'uv',
  'pip',
  'pipx',
  'pipenv',
  'poetry',
  'pdm',
  'hatch',
  'conda',
  'mamba',
  'micromamba',
  'easy_install',
  'gem',
  'bundle',
  'bundler',
  'cargo',
  'rustup',
  'go',
  'composer',
  'apt',
  'apt-get',
  'aptitude',
  'dpkg',
  'yum',
  'dnf',
  'rpm',
  'zypper',
  'apk',
  'pacman',
  'brew',
  'snap',
  'flatpak',
  'nix',
  'nix-shell',
  'nix-env',
  'mvn',
  'gradle',
  'gradlew',
  'sbt',
  'cpan',
  'cpanm',
  'luarocks',
  'nuget',
  'npm-cli',
  // installs missing packages at run time by default (auto-install) and loads bunfig.toml
  'bun',
];
/** Container and cluster tools, version control. */
const PLATFORM_TOOLS = [
  'docker',
  'podman',
  'nerdctl',
  'ctr',
  'crictl',
  'kubectl',
  'oc',
  'helm',
  'buildah',
  'skopeo',
  'runc',
  'crun',
  'lxc',
  'lxc-attach',
  'systemd-nspawn',
  'kind',
  'minikube',
  'git',
  'svn',
  'hg',
  'gh',
];
/** Interpreters and REPLs whose program is part of the command line and cannot be flag-checked. */
const PROGRAM_IN_ARGV = [
  'tclsh',
  'wish',
  'jrunscript',
  'jshell',
  'osascript',
  'rscript',
  'julia',
  'groovy',
  'ghc',
  'runghc',
  'racket',
  'guile',
  'irb',
  'pry',
  'ipython',
  'swift',
  'scala',
  'kotlinc',
  'kotlin',
  'r',
  'octave',
  'erl',
  'escript',
  'elixir',
  'iex',
  'ghci',
  'sbcl',
  'clisp',
  'ocaml',
  'utop',
  'scheme',
  'chez',
  'nu',
  'xonsh',
  'elvish',
  'osh',
  'ysh',
];

const FORBIDDEN = new Map<string, string>();
for (const [list, why] of [
  [SHELLS, 'a shell or multi-call binary'],
  [WRAPPERS, 'a program that executes arguments as code or another program'],
  [NETWORK, 'a network or remote-access tool'],
  [INSTALLERS, 'a run-time installer or package manager'],
  [PLATFORM_TOOLS, 'a container, cluster or version-control tool'],
  [PROGRAM_IN_ARGV, 'an interpreter that takes its program on the command line'],
] as const)
  for (const name of list) FORBIDDEN.set(name, why);

/** Interpreters that are allowed, but only without code-injecting flags. */
export interface InterpreterRule {
  /** Short option letters that inject code or load code (any occurrence in a `-xyz` cluster). */
  short: string;
  /** Long option names (without `--`, `_` read as `-`); a trailing `*` matches a prefix. */
  long?: string[];
  /** Arguments (before `--`) that start with one of these are refused. */
  prefixes?: string[];
  /** Arguments that equal one of these are refused (sub-commands that install or evaluate). */
  words?: string[];
  /** Refuse arguments that look like URLs (the interpreter would fetch the program). */
  urls?: boolean;
  /** Python `-m` modules that install packages or run an interactive/debug facility. */
  modules?: string[];
  /**
   * What may stand before the program file (ADR 0016 S0, strict default): the interpreter must run
   * a file that is itself allowlisted, so only options that cannot consume the next argument are
   * accepted in front of it. Long options in the `--name=value` form are always accepted there
   * (the deny rules above still apply to them).
   */
  before?: {
    /** Options accepted as the whole argument. */
    flags?: string[];
    /** Options accepted when the argument starts with one of these (`--allow-` of deno). */
    flagPrefixes?: string[];
    /** Options whose value must be attached (`-Xmx64m`, `-Dk=v`, `-Wignore`). */
    attached?: string[];
    /** A short-option cluster made only of these letters (`-uB` for python). */
    cluster?: string;
    /** Leading sub-commands (`deno run`). */
    subcommands?: string[];
    /** The option that names the program file (`java -jar <file>`); required when set. */
    programFlag?: string;
  };
}

const NODE_RULE: InterpreterRule = {
  short: 'epri',
  long: [
    'interactive',
    'openssl-config',
    'snapshot-blob',
    'build-snapshot*',
    'experimental-config-file',
    'experimental-default-config-file',
    'experimental-sea-config',
    'redirect-warnings',
    'tls-keylog',
    'eval',
    'print',
    'require',
    'import',
    'loader',
    'experimental-loader',
    'env-file',
    'env-file-if-exists',
    'inspect*',
    'run',
    'input-type',
    'preload',
    'watch*',
    'test*',
    'experimental-default-type',
    'experimental-network-imports',
  ],
  before: {
    flags: [
      '--enable-source-maps',
      '--no-warnings',
      '--no-deprecation',
      '--trace-warnings',
      '--trace-deprecation',
      '--trace-uncaught',
      '--throw-deprecation',
      '--pending-deprecation',
      '--experimental-strip-types',
      '--no-experimental-strip-types',
      '--experimental-transform-types',
      '--expose-gc',
      '--frozen-intrinsics',
      '--use-openssl-ca',
      '--use-bundled-ca',
      '--abort-on-uncaught-exception',
      '--no-addons',
      '--disallow-code-generation-from-strings',
      '--permission',
      '--experimental-permission',
    ],
  },
};
/** Python: only flag clusters without a value, and `-W`/`-X` with an attached value. */
const PYTHON_BEFORE: InterpreterRule['before'] = { cluster: 'uBEIsSOPqbR', attached: ['-W', '-X'] };
const INTERPRETERS = new Map<string, InterpreterRule>([
  ['node', NODE_RULE],
  ['nodejs', NODE_RULE],
  [
    'deno',
    {
      short: 'er',
      long: ['eval', 'import-map', 'config', 'inspect*', 'unstable*', 'preload', 'env-file', 'env'],
      words: [
        'eval',
        'repl',
        'install',
        'add',
        'x',
        'upgrade',
        'jupyter',
        'task',
        'init',
        'publish',
        'compile',
        'bundle',
        'serve',
        'remove',
        'outdated',
        'update',
        'cache',
        'test',
        'bench',
      ],
      urls: true,
      before: {
        subcommands: ['run'],
        flags: [
          '-A',
          '-q',
          '--quiet',
          '--no-prompt',
          '--no-config',
          '--no-remote',
          '--no-npm',
          '--cached-only',
          '--frozen',
          '--no-lock',
          '--check',
          '--no-check',
        ],
        flagPrefixes: ['--allow-', '--deny-'],
      },
    },
  ],
  [
    'python',
    {
      short: 'c',
      before: PYTHON_BEFORE,
      modules: [
        'pip',
        'ensurepip',
        'venv',
        'virtualenv',
        'pipx',
        'uv',
        'build',
        'wheel',
        'setuptools',
        'poetry',
        'conda',
        'code',
        'codeop',
        'pdb',
        'runpy',
        'timeit',
        'cprofile',
        'profile',
        'trace',
        'pydoc',
        'http',
        'ftplib',
        'smtplib',
        'webbrowser',
        'idlelib',
        'cgi',
        'compileall',
      ],
    },
  ],
  [
    'pypy',
    {
      short: 'c',
      modules: ['pip', 'ensurepip', 'venv', 'virtualenv', 'code', 'pdb', 'runpy'],
      before: PYTHON_BEFORE,
    },
  ],
  ['perl', { short: 'eEMmxIdDS', before: { cluster: 'wWXTt' } }],
  [
    'ruby',
    { short: 'erIxSC', before: { cluster: 'wv', attached: ['-W'], flags: ['--jit', '--yjit'] } },
  ],
  [
    'php',
    {
      short: 'rRBEFaSdncz',
      long: [
        'php-ini',
        'define',
        'zend-extension',
        'run',
        'process-begin',
        'process-code',
        'process-end',
        'process-file',
        'server',
        'docroot',
      ],
      before: { flags: ['-q'] },
    },
  ],
  ['lua', { short: 'eli', before: { cluster: 'WE' } }],
  ['luajit', { short: 'eli', before: { cluster: 'WE' } }],
  [
    'java',
    {
      short: '',
      prefixes: [
        '-javaagent',
        '-agentlib',
        '-agentpath',
        '-Xrun',
        '-Xdebug',
        '-Xbootclasspath',
        '-XX:OnError',
        '-XX:OnOutOfMemoryError',
        '-XX:Flags',
        '-XX:VMOptionsFile',
        '-XX:SharedArchiveFile',
        '-XX:+AutoCreateSharedArchive',
        '-XX:ArchiveClassesAtExit',
        '-Djava.system.class.loader',
        '-Djava.security.manager',
        '-Djava.class.path',
        '--class-path=',
        '--module-path=',
        '--upgrade-module-path=',
        '--patch-module=',
        '--add-modules=',
        '--module=',
        '--source=',
        '-splash:',
        '@',
      ],
      before: {
        flags: [
          '-ea',
          '-da',
          '-esa',
          '-dsa',
          '-server',
          '-client',
          '-enableassertions',
          '-disableassertions',
          '--enable-preview',
          '-showversion',
        ],
        attached: ['-X', '-D', '-verbose:'],
        programFlag: '-jar',
      },
    },
  ],
  [
    'dotnet',
    {
      short: '',
      words: [
        'tool',
        'new',
        'add',
        'restore',
        'publish',
        'build',
        'run',
        'workload',
        'nuget',
        'msbuild',
        'fsi',
        'script',
        'install',
        'pack',
        'test',
        'exec',
      ],
      before: {},
    },
  ],
  // TypeScript and script runners on top of node: same flags, plus their own sub-commands.
  ...(['tsx', 'ts-node', 'ts-node-esm', 'esno', 'esr', 'vite-node', 'jiti', 'zx'] as const).map(
    (n): [string, InterpreterRule] => [n, { ...NODE_RULE, words: ['watch', 'repl', 'eval'] }],
  ),
]);

const WINDOWS_SUFFIX = /\.(?:exe|cmd|bat|com|ps1)$/u;
/** `python3.11` -> `python`, `node22` -> `node`, `pip3` -> `pip`. */
const VERSION_SUFFIX = /[-_.]?\d+(?:\.\d+)*[a-z]?$/u;

function programNames(file: string): string[] {
  const base = path.basename(file).toLowerCase().replace(WINDOWS_SUFFIX, '');
  const stripped = base.replace(VERSION_SUFFIX, '');
  return stripped && stripped !== base ? [base, stripped] : [base];
}

/** Why a program may never be started as a stdio MCP server, or `null`. */
export function forbiddenProgram(file: string): string | null {
  const base = path.basename(file).toLowerCase();
  // The dynamic loader (`ld-linux-x86-64.so.2 /bin/sh`) executes any program given as argument.
  // musl's libc (`libc.musl-x86_64.so.1`) is its loader too and runs a program given as argument.
  if (
    /^ld(?:[-.][a-z0-9_.+-]*)?\.so(?:\.\d+)*$/u.test(base) ||
    /^ld[-.]linux/u.test(base) ||
    /^libc\.musl/u.test(base)
  )
    return 'the dynamic loader, which executes any program given in its arguments';
  for (const n of programNames(file)) {
    const why = FORBIDDEN.get(n);
    if (why) return why;
  }
  return null;
}

export function interpreterRule(file: string): InterpreterRule | undefined {
  for (const n of programNames(file)) {
    const r = INTERPRETERS.get(n);
    if (r) return r;
  }
  return undefined;
}

const normLong = (s: string): string => s.replace(/_/gu, '-').toLowerCase();

/** Arguments that make an allowed interpreter run code from the command line. */
export function interpreterArgIssues(rule: InterpreterRule, args: readonly string[]): string[] {
  const out: string[] = [];
  let afterDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (afterDashDash) continue;
    if (a === '--') {
      afterDashDash = true;
      continue;
    }
    if (a === '-') {
      out.push(`args.${i}: "-" reads the program from standard input`);
      continue;
    }
    if (rule.urls && !a.startsWith('-') && /^[a-z][a-z0-9+.-]*:/iu.test(a))
      out.push(
        `args.${i}: the interpreter would fetch or evaluate its program from a URL or specifier (https:, npm:, jsr:, data:)`,
      );
    if (rule.words?.includes(a))
      out.push(`args.${i}: sub-command "${a}" installs or evaluates code`);
    if (rule.prefixes?.some((p) => a.startsWith(p)))
      out.push(`args.${i}: option "${a}" loads code or opens a debug port`);
    if (a.startsWith('--')) {
      const name = normLong(a.slice(2).split('=')[0]!);
      if (rule.long?.some((l) => (l.endsWith('*') ? name.startsWith(l.slice(0, -1)) : name === l)))
        out.push(`args.${i}: option "--${name}" runs or loads code from the command line`);
    } else if (a.startsWith('-') && a.length > 1) {
      // `-xyz` clusters and attached values (`-cprint(1)`, `-eCODE`): any code letter refuses.
      const letters = a.slice(1);
      const hit = [...letters].find((ch) => rule.short.includes(ch));
      if (hit) out.push(`args.${i}: option "-${hit}" runs or loads code from the command line`);
      if (rule.modules && letters.includes('m')) {
        const at = letters.indexOf('m');
        const attached = letters.slice(at + 1);
        const mod = (attached || args[i + 1] || '').toLowerCase().split('.')[0]!;
        if (rule.modules.includes(mod))
          out.push(`args.${i}: module "${mod}" installs packages or opens a debug facility`);
      }
    }
  }
  return out;
}

/**
 * Where the program file of an interpreter command stands in `args` (ADR 0016 S0, strict
 * default). Returns the index of the program argument, or a message when something other than an
 * option without a separate value stands in front of it: an option that consumes the next
 * argument (`python -W x /allowed.py /tmp/evil.py`) could otherwise make the allowlisted file a
 * mere option value while the interpreter runs another file.
 */
export function interpreterProgram(
  rule: InterpreterRule,
  args: readonly string[],
): { index: number; message?: string } {
  const b = rule.before ?? {};
  let i = 0;
  if (b.subcommands && args[0] !== undefined && b.subcommands.includes(args[0])) i = 1;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return { index: i + 1 };
    if (b.programFlag && a === b.programFlag) return { index: i + 1 };
    if (!a.startsWith('-') || a === '-') break;
    if (a.startsWith('--') && a.includes('=')) continue;
    if (b.flags?.includes(a)) continue;
    if (b.flagPrefixes?.some((p) => a.startsWith(p))) continue;
    if (b.attached?.some((p) => a.startsWith(p) && a.length > p.length)) continue;
    if (
      b.cluster &&
      /^-[A-Za-z]+$/u.test(a) &&
      [...a.slice(1)].every((c) => b.cluster!.includes(c))
    )
      continue;
    return {
      index: i,
      message: `option "${a}" may not stand before the program file (only options that cannot take the next argument as their value, and "--name=value")`,
    };
  }
  if (b.programFlag)
    return { index: i, message: `the program file must be named with "${b.programFlag} <file>"` };
  return { index: i };
}
