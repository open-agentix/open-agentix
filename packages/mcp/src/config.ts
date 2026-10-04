import { CLASSIFICATIONS, TOOL_ACCESS } from '@openagentix/core';
import { z } from 'zod';

/** Access class of one tool: `write` is the default for every tool that is not declared. */
export const McpToolAccessSchema = z.strictObject({ access: z.enum(TOOL_ACCESS) });
export type McpToolAccess = z.infer<typeof McpToolAccessSchema>;

const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, 'invalid tool name (no wildcards)');
const profileName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'profile names are lowercase slugs');
const MAX_TOOLS = 500;

/** Declared tool classes and named profiles (ADR 0008); shared by every transport. */
const accessFields = {
  /** Declared access class per tool (`{ get_issue: { access: read } }`). */
  tools: z.record(toolName, McpToolAccessSchema).default({}),
  /** Profile name -> tools; every member must be declared in `tools`. */
  profiles: z.record(profileName, z.array(toolName).min(1).max(MAX_TOOLS)).default({}),
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
