import { CLASSIFICATIONS, TOOL_ACCESS } from '@openagentix/core';
import { z } from 'zod';

/** Access class of one tool: `write` is the default for every tool that is not declared. */
export const McpToolAccessSchema = z.strictObject({ access: z.enum(TOOL_ACCESS) });
export type McpToolAccess = z.infer<typeof McpToolAccessSchema>;

const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, 'invalid tool name (no wildcards)');
const profileName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'profile names are lowercase slugs');
const MAX_TOOLS = 500;

/**
 * Telemetry settings of an MCP instance (ADR 0015 section 6.4). `propagate` is off unless set: the
 * run's `traceparent` is then sent in `params._meta` of `tools/call`, and only if the platform allows
 * it too (`OAX_OTEL_MCP_PROPAGATION=allow`). Strict: there is nothing else to configure, so no header
 * name, `tracestate` or `baggage` can be supplied here.
 */
export const McpTelemetrySchema = z.strictObject({ propagate: z.boolean().default(false) });
export type McpTelemetry = z.infer<typeof McpTelemetrySchema>;

/** Declared tool classes and named profiles (ADR 0008); shared by every transport. */
const accessFields = {
  /** Declared access class per tool (`{ get_issue: { access: read } }`). */
  tools: z.record(toolName, McpToolAccessSchema).default({}),
  /** Profile name -> tools; every member must be declared in `tools`. */
  profiles: z.record(profileName, z.array(toolName).min(1).max(MAX_TOOLS)).default({}),
  /** Opt-in trace context propagation; absent means off. */
  telemetry: McpTelemetrySchema.optional(),
};

/** An MCP server connection (stored as a "connection" in the control node). */
/**
 * Profile rules: members must be declared tools (unknown tools are refused when the connection is
 * saved), no duplicates, and a profile named `read` may only hold `read` tools.
 */
export function profileIssues(cfg: {
  tools: Record<string, McpToolAccess>;
  profiles: Record<string, string[]>;
}): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  if (Object.keys(cfg.tools).length > MAX_TOOLS)
    issues.push({ path: ['tools'], message: `more than ${MAX_TOOLS} declared tools` });
  for (const [name, members] of Object.entries(cfg.profiles)) {
    const seen = new Set<string>();
    members.forEach((tool, i) => {
      const path = ['profiles', name, i];
      if (!Object.hasOwn(cfg.tools, tool))
        issues.push({ path, message: `profile "${name}" lists unknown tool "${tool}"` });
      else if (name === 'read' && cfg.tools[tool]!.access !== 'read')
        issues.push({ path, message: `profile "read" must not contain write tool "${tool}"` });
      if (seen.has(tool)) issues.push({ path, message: `duplicate tool "${tool}" in "${name}"` });
      seen.add(tool);
    });
  }
  return issues;
}

export const McpServerConfigSchema = z
  .discriminatedUnion('transport', [
    z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
      transport: z.literal('stdio'),
      /** Executable inside the worker/toolbox image (pinned binary, never `npx <latest>`). */
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      /** Plain environment variables. */
      env: z.record(z.string(), z.string()).default({}),
      /** Environment variable name -> secret reference. */
      envSecrets: z.record(z.string(), z.string()).default({}),
      /**
       * Hosts this server itself needs (ADR 0016 section 4.1), in the grammar of `runtime.egress`.
       * Empty or absent means NO network: the child gets no proxy variables. The container runner
       * mints one egress grant per (node, connection) from it; it is bounded by the operator's
       * per-program grant (`OAX_MCP_STDIO_EGRESS`, tenants), the runner ceiling and the air-gapped
       * allowlist. Checked by the API when saved and again by the control node before each step.
       */
      egress: z.array(z.string().min(1).max(255)).max(16).optional(),
      timeoutMs: z.number().int().positive().default(30_000),
      maxResultBytes: z
        .number()
        .int()
        .positive()
        .default(256 * 1024),
      clearance: z.enum(CLASSIFICATIONS).optional(),
      ...accessFields,
    }),
    z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
      transport: z.literal('streamable-http'),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).default({}),
      /** Header name -> secret reference (e.g. `authorization`). */
      headerSecrets: z.record(z.string(), z.string()).default({}),
      /**
       * Hosts the server needs. An HTTP server is contacted at its `url` only, so this may list
       * the host of the url and nothing else (ADR 0016 section 4.1); `checkHttpConfig` enforces it.
       */
      egress: z.array(z.string().min(1).max(255)).max(16).optional(),
      timeoutMs: z.number().int().positive().default(30_000),
      maxResultBytes: z
        .number()
        .int()
        .positive()
        .default(256 * 1024),
      clearance: z.enum(CLASSIFICATIONS).optional(),
      ...accessFields,
    }),
    z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
      /** In-process server registered by the host (tests, demo, built-in tools). */
      transport: z.literal('in-memory'),
      timeoutMs: z.number().int().positive().default(30_000),
      maxResultBytes: z
        .number()
        .int()
        .positive()
        .default(256 * 1024),
      clearance: z.enum(CLASSIFICATIONS).optional(),
      ...accessFields,
    }),
  ])
  .superRefine((cfg, ctx) => {
    for (const issue of profileIssues(cfg)) ctx.addIssue({ code: 'custom', ...issue });
  });
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerConfigInput = z.input<typeof McpServerConfigSchema>;

/** `server/tool` -> class for every declared tool of the given connections (policy gate input). */
export function toolAccessOfConfigs(
  configs: readonly Pick<McpServerConfig, 'name' | 'tools'>[],
): Record<string, 'read' | 'write'> {
  const out: Record<string, 'read' | 'write'> = {};
  for (const c of configs)
    for (const [tool, v] of Object.entries(c.tools)) out[`${c.name}/${tool}`] = v.access;
  return out;
}
