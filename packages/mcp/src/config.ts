import { CLASSIFICATIONS } from '@openagentix/core';
import { z } from 'zod';

/** An MCP server connection (stored as a "connection" in the control node). */
export const McpServerConfigSchema = z.discriminatedUnion('transport', [
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
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServerConfigInput = z.input<typeof McpServerConfigSchema>;
