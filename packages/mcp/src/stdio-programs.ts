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
}

const NODE_RULE: InterpreterRule = {
  short: 'epr',
  long: [
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
};
const INTERPRETERS = new Map<string, InterpreterRule>([
  ['node', NODE_RULE],
  ['nodejs', NODE_RULE],
  [
    'bun',
    {
      ...NODE_RULE,
      words: [
        'x',
        'add',
        'install',
        'i',
        'create',
        'pm',
        'upgrade',
        'repl',
        'exec',
        'init',
        'link',
        'update',
        'remove',
        'rm',
        'outdated',
        'publish',
        'patch',
      ],
      urls: true,
    },
  ],
  [
    'deno',
    {
      short: 'er',
      long: ['eval', 'import-map', 'config', 'inspect*', 'unstable*'],
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
      ],
      urls: true,
    },
  ],
  [
    'python',
    {
      short: 'c',
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
    { short: 'c', modules: ['pip', 'ensurepip', 'venv', 'virtualenv', 'code', 'pdb', 'runpy'] },
  ],
  ['perl', { short: 'eEMmxIdD' }],
  ['ruby', { short: 'erIx' }],
  ['php', { short: 'rRBEFaSdn' }],
  ['lua', { short: 'el' }],
  ['luajit', { short: 'el' }],
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
        '@',
      ],
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
      ],
    },
  ],
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
  if (/^ld(?:[-.][a-z0-9_.+-]*)?\.so(?:\.\d+)*$/u.test(base) || /^ld[-.]linux/u.test(base))
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
    if (rule.urls && /^[a-z][a-z0-9+.-]*:\/\//iu.test(a))
      out.push(`args.${i}: the interpreter would fetch its program from a URL`);
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
