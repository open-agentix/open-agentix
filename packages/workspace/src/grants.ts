import { WORKSPACE_TOOL_ACCESS, SERVER_NAME, type WorkspaceToolName } from './server.js';

/** Grant constraint for the path argument of write tools (design D3/D7), repeated by the server. */
export const WRITE_PATH_CONSTRAINT = {
  pattern: '^(src|test)/[A-Za-z0-9._/-]{1,200}$',
  deny: ['\\.\\.', '^\\.'],
} as const;

export interface WorkspaceGrantOptions {
  /** Per-tool call caps (defaults follow the design: 20/40/20/20/10/8/5). */
  caps?: Partial<Record<WorkspaceToolName, number>>;
  /** Test-file argument pattern for `run_tests`. */
  testFilePattern?: string;
}

const DEFAULT_CAPS: Record<WorkspaceToolName, number> = {
  list_files: 20,
  read_file: 40,
  search: 20,
  edit_file: 20,
  write_file: 10,
  run_tests: 8,
  diff: 5,
};

const READ_PATH = { type: 'string', maxLength: 300, deny: ['\\.\\.', '^[/~]', '\\\\'] } as const;

/** Every argument of every tool is listed, so unknown arguments are denied by the gate. */
function argsOf(tool: WorkspaceToolName, testFilePattern: string): Record<string, unknown> {
  switch (tool) {
    case 'list_files':
      return { path: READ_PATH, depth: { type: 'integer', minimum: 1, maximum: 3 } };
    case 'read_file':
      return {
        path: { ...READ_PATH, required: true },
        offset: { type: 'integer', minimum: 0, maximum: 1_000_000 },
        limit: { type: 'integer', minimum: 1, maximum: 5000 },
      };
    case 'search':
      return {
        pattern: { type: 'string', required: true, minLength: 1, maxLength: 200 },
        path: READ_PATH,
        literal: { type: 'boolean' },
        ignoreCase: { type: 'boolean' },
      };
    case 'edit_file':
      return {
        path: { type: 'string', required: true, ...WRITE_PATH_CONSTRAINT },
        old: { type: 'string', required: true, minLength: 1, maxLength: 65_536 },
        new: { type: 'string', required: true, maxLength: 65_536 },
      };
    case 'write_file':
      return {
        path: { type: 'string', required: true, ...WRITE_PATH_CONSTRAINT },
        content: { type: 'string', required: true, maxLength: 65_536 },
      };
    case 'run_tests':
      return { file: { type: 'string', pattern: testFilePattern, deny: ['\\.\\.', '^[.-]'] } };
    case 'diff':
      return {};
  }
}

/**
 * `agents[].tools` entries for the workspace tools (what the agent definition should contain):
 * path arguments are constrained (write tools: `src/` and `test/` only), `run_tests` accepts only
 * a test file path, and no argument outside the list is accepted.
 */
export function workspaceToolGrants(opts: WorkspaceGrantOptions = {}) {
  const caps = { ...DEFAULT_CAPS, ...opts.caps };
  const pattern = opts.testFilePattern ?? '^test/[a-z0-9-]+\\.test\\.js$';
  return (Object.keys(DEFAULT_CAPS) as WorkspaceToolName[]).map((tool) => {
    const args = argsOf(tool, pattern);
    return {
      server: SERVER_NAME,
      tool,
      maxCallsPerRun: caps[tool],
      ...(Object.keys(args).length ? { args } : {}),
    };
  });
}

/** Declared tool classes for the MCP connection (`tools` of the connection config). */
export function workspaceToolDeclarations(): Record<string, { access: 'read' | 'write' }> {
  return Object.fromEntries(
    Object.entries(WORKSPACE_TOOL_ACCESS).map(([k, v]) => [k, { access: v }]),
  );
}
