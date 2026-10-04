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
});
export type StepHandover = z.infer<typeof StepHandoverSchema>;

export const NODE_FAILURE_STATUSES = ['failed', 'blocked_by_policy', 'cancelled'] as const;

export const StepHandoverResultSchema = z.strictObject({
  agentId: z.string(),
  format: z.string().max(64),
  content: z.string().max(1_000_000),
  json: z.unknown().optional(),
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
