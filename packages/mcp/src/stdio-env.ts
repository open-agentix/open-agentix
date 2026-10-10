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
