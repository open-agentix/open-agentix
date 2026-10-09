import { z } from 'zod';

const KIB = 1024;

/** Command that `run_tests` may execute. Fixed by the operator; the model never supplies it. */
export const TestCommandSchema = z.strictObject({
  /** Executable name or absolute path (no shell, no whitespace or metacharacters). */
  command: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/, 'invalid command'),
  /** Fixed arguments, passed as an argv array (never through a shell). */
  args: z.array(z.string().max(500)).max(32).default([]),
  /**
   * Optional test-file argument the model may add (appended after the fixed arguments). Must match
   * this expression; a leading `-` is always refused so the model cannot inject an option.
   */
  filePattern: z.string().max(200).optional(),
  timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
  /** Resident memory cap of the whole process group (polled; the container cap is the hard wall). */
  memoryMb: z.number().int().min(16).max(8192).default(1024),
  /** Number of runs allowed per workspace session. */
  maxRuns: z.number().int().min(1).max(100).default(8),
  /** `PATH` of the child (the parent's environment is never inherited). */
  path: z.string().max(500).default('/usr/local/bin:/usr/bin:/bin'),
  /** Extra fixed variables (for example `NODE_OPTIONS=--max-old-space-size=512`). */
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(500)).default({}),
});
export type TestCommand = z.infer<typeof TestCommandSchema>;

export const WorkspaceConfigSchema = z.strictObject({
  /** Absolute directory of the checkout (the node unpacks the seed here). */
  root: z.string().min(1).max(500),
  /**
   * Paths (relative, `/`-separated) the agent may create or change; the first matching expression
   * wins. Anything else is refused by the tools and by the final patch.
   */
  writable: z
    .array(z.string().min(1).max(300))
    .min(1)
    .max(20)
    .default(['^(src|test)/[A-Za-z0-9._/-]{1,200}$']),
  maxReadFileBytes: z
    .number()
    .int()
    .min(KIB)
    .max(4 * KIB * KIB)
    .default(256 * KIB),
  maxReadBytesPerCall: z
    .number()
    .int()
    .min(KIB)
    .max(1024 * KIB)
    .default(64 * KIB),
  maxWriteBytes: z
    .number()
    .int()
    .min(KIB)
    .max(1024 * KIB)
    .default(64 * KIB),
  maxOutputBytes: z
    .number()
    .int()
    .min(KIB)
    .max(1024 * KIB)
    .default(64 * KIB),
  maxListEntries: z.number().int().min(1).max(5000).default(500),
  maxSearchMatches: z.number().int().min(1).max(2000).default(200),
  /** Largest seed the baseline snapshot accepts (matches the 5 MiB seed cap of the design). */
  maxSeedBytes: z
    .number()
    .int()
    .min(KIB)
    .max(64 * KIB * KIB)
    .default(5 * KIB * KIB),
  /** Largest tree the final walk hashes (guards a test that fills the disk). */
  maxTreeBytes: z
    .number()
    .int()
    .min(KIB)
    .max(512 * KIB * KIB)
    .default(32 * KIB * KIB),
  maxTreeEntries: z.number().int().min(10).max(200_000).default(20_000),
  maxPatchBytes: z
    .number()
    .int()
    .min(KIB)
    .max(4 * KIB * KIB)
    .default(64 * KIB),
  maxPatchFiles: z.number().int().min(1).max(200).default(20),
  maxCreatedFiles: z.number().int().min(1).max(500).default(50),
  /** Second wall behind the gate's `maxToolCalls` (design: 80 per run). */
  maxToolCalls: z.number().int().min(1).max(10_000).default(80),
  /** Second wall behind the platform timeout (design: 20 minutes). */
  maxDurationMs: z
    .number()
    .int()
    .min(1000)
    .max(24 * 3600_000)
    .default(20 * 60_000),
  searchTimeoutMs: z.number().int().min(50).max(30_000).default(2000),
  tests: TestCommandSchema.optional(),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type WorkspaceConfigInput = z.input<typeof WorkspaceConfigSchema>;

/** Parses and validates operator configuration, compiling every expression once. */
export function parseWorkspaceConfig(input: unknown): WorkspaceConfig {
  const cfg = WorkspaceConfigSchema.parse(input);
  for (const src of [...cfg.writable, ...(cfg.tests?.filePattern ? [cfg.tests.filePattern] : [])]) {
    try {
      new RegExp(src, 'u');
    } catch {
      throw new Error(`invalid regular expression in workspace configuration: ${src}`);
    }
  }
  return cfg;
}
