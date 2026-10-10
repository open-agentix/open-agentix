import { isReservedCredentialEnv } from '@openagentix/core';

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

/** Hooks of loaders, interpreters, tools and resolvers that execute code or redirect traffic. */
const EXTRA_RESERVED_ENV = new Set([
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'IFS',
  'CDPATH',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'GLIBC_TUNABLES',
  'GCONV_PATH',
  'NLSPATH',
  'LOCPATH',
  'HOSTALIASES',
  'LOCALDOMAIN',
  'RES_OPTIONS',
  'TZDIR',
  'RUBYOPT',
  'RUBYLIB',
  'GEM_HOME',
  'GEM_PATH',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'JAVA_OPTS',
  'CLASSPATH',
  'PHPRC',
  'PHP_INI_SCAN_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'ALL_PROXY',
  'FTP_PROXY',
  'SOCKS_PROXY',
  'GOFLAGS',
  'GOPROXY',
  'CARGO_HOME',
  'COMSPEC',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'MAIL',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'BROWSER',
  'DISPLAY',
  // further loaders and hooks that run code or load libraries named in the value
  'SSLKEYLOGFILE',
  'TCLLIBPATH',
  'TCL_LIBRARY',
  'TK_LIBRARY',
  'ZDOTDIR',
  'INPUTRC',
  'TERMINFO',
  'TERMINFO_DIRS',
  'MANPAGER',
  'GNUPGHOME',
  'SASL_PATH',
  'HISTFILE',
  'R_PROFILE',
  'R_PROFILE_USER',
  'R_ENVIRON',
  'R_ENVIRON_USER',
  'R_LIBS',
  'R_LIBS_USER',
  'MAGIC',
  'ELECTRON_RUN_AS_NODE',
]);
const EXTRA_RESERVED_PREFIXES = [
  'NODE_',
  'NPM_',
  'PYTHON',
  'PIP_',
  'UV_',
  'PERL',
  'LUA_',
  'GIT_',
  'XDG_',
  'BASH_FUNC_',
  'DENO_',
  'BUN_',
  'MALLOC_',
  'GLIBC_',
  'LD_',
  'DYLD_',
  'OAX_',
  // OPENSSL_CONF / OPENSSL_ENGINES / OPENSSL_MODULES load engines and providers (shared objects)
  'OPENSSL_',
  // .NET startup hooks and CLR profilers load assemblies and native libraries
  'DOTNET_',
  'CORECLR_',
  'COMPLUS_',
  'COR_',
  // GUI, media and graphics plugin paths, Kerberos and SSH helpers (SSH_ASKPASS runs a program)
  'QT_',
  'GTK_',
  'GIO_',
  'GST_',
  'GDK_',
  'LIBGL_',
  'KRB5',
  'SSH_',
  'GPG_',
  'ERL_',
  'JULIA_',
  'ELECTRON_',
  'NODEJS_',
];

/** `true` for names an MCP stdio connection must not set (credential rules plus loader hooks). */
export function isReservedStdioEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    isReservedCredentialEnv(name) ||
    isReservedCredentialEnv(upper) ||
    EXTRA_RESERVED_ENV.has(upper) ||
    EXTRA_RESERVED_PREFIXES.some((p) => upper.startsWith(p))
  );
}
