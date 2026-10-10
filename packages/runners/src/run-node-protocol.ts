import {
  AgentSpecSchema,
  BudgetSchema,
  ClassificationSchema,
  type StepCredentials,
} from '@openagentix/core';
import { McpServerConfigSchema } from '@openagentix/mcp';
import { z } from 'zod';

/**
 * Wire types of the run node protocol (ADR 0008, sections 2 and 3.3): what an untrusted run node
 * may fetch from the control node. Everything is scoped to the node's own step; nothing about
 * other steps, other tenants or the platform leaves the control node.
 */

/** Platform facts the node needs to run its one step (no policy bundles, no other agents). */
export const StepRunInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  classification: ClassificationSchema,
  budget: BudgetSchema,
});

export const StepHandoverSchema = z.strictObject({
  agentId: z.string(),
  agent: AgentSpecSchema,
  /** The validated input of the step. */
  input: z.unknown(),
  /** Output schema with named schemas inlined. */
  outputSchema: z.unknown().optional(),
  attempt: z.number().int().positive(),
  run: StepRunInfoSchema,
  /**
   * MCP connections the step holds grants for, with all secret references stripped; values arrive
   * through the credential broker.
   */
  mcp: z.array(McpServerConfigSchema),
  /**
   * Present only when a tenant defined a stdio server of the step (ADR 0016 S0): the node applies
   * the command rules to the real binaries of its image before it starts one. The control node has
   * already checked the connection; this is the second wall for symlinks, which only the node can
   * resolve. Nodes of an older version reject the field and fail closed.
   */
  stdio: z
    .strictObject({
      tenantServers: z.array(z.string()),
      allowlist: z.array(z.string()),
    })
    .optional(),
});
export type StepHandover = z.infer<typeof StepHandoverSchema>;

export const NODE_FAILURE_STATUSES = ['failed', 'blocked_by_policy', 'cancelled'] as const;

/** Largest workspace seed archive the control node stores and a node accepts (design: 5 MiB). */
export const MAX_WORKSPACE_SEED_BYTES = 5 * 1024 * 1024;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** Largest patch a node may attach (characters; the worker re-checks bytes and policy again). */
export const MAX_PATCH_ATTACHMENT_CHARS = 131_072;

/**
 * The patch a node computed itself from its workspace (DOG-2 `finalize()`), attached to the result
 * of a step with a `pull-request` output (DOG-4, ADR 0008 Amendment 5). The worker treats every
 * field as a claim of an untrusted node: it re-validates the patch against its own policy and
 * digest before anything is pushed. `lastTestRun` and the flags are node-reported.
 */
export const PatchAttachmentSchema = z.strictObject({
  patch: z.string().min(1).max(MAX_PATCH_ATTACHMENT_CHARS),
  patchSha256: Sha256Hex,
  changedFiles: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(300),
        status: z.enum(['added', 'modified', 'deleted']),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      }),
    )
    .max(100),
  lastTestRun: z
    .strictObject({
      passed: z.boolean(),
      exitCode: z.number().int().nullable(),
      timedOut: z.boolean(),
      durationMs: z.number().int().nonnegative(),
      file: z.string().max(300).nullable(),
    })
    .nullable(),
  fullSuitePassed: z.boolean(),
  treeMatchesLastRun: z.boolean(),
  testedFinalTree: z.boolean(),
});
export type PatchAttachment = z.infer<typeof PatchAttachmentSchema>;

export const StepHandoverResultSchema = z.strictObject({
  agentId: z.string(),
  format: z.string().max(64),
  content: z.string().max(1_000_000),
  json: z.unknown().optional(),
  /** Node-computed patch of a step with a `pull-request` output (DOG-4). */
  patch: PatchAttachmentSchema.optional(),
  /**
   * Set instead of an output when the step did not succeed. The orchestrator turns it into the
   * run's failure with the same status and code (a policy block stays a policy block).
   */
  failure: z
    .strictObject({
      status: z.enum(NODE_FAILURE_STATUSES),
      code: z.string().max(100),
      message: z.string().max(2000),
    })
    .optional(),
  /** Usage as measured by the node (W1-3b moves the measurement to the control node). */
  usage: z
    .strictObject({
      tokensIn: z.number().int().nonnegative(),
      tokensOut: z.number().int().nonnegative(),
      costMicros: z.number().int().nonnegative(),
      steps: z.number().int().nonnegative(),
      toolCalls: z.number().int().nonnegative(),
    })
    .optional(),
});
export type StepHandoverResult = z.infer<typeof StepHandoverResultSchema>;

export type { StepCredentials };
