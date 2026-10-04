import {
  createAuditEntry,
  evaluateToolCall,
  stepAuditEntry,
  verifyAuditChain,
  type AgentDefinition,
  type AuditEntry,
  type BudgetVerdict,
  type PolicyBundle,
  type PublishedDefinition,
  type PolicyDecision,
  type ToolCallRequest,
  type VerifyResult,
} from '@openagentix/core';
import type { ApprovalOutcome, ControlPlane, RunResult, StepInput } from './types.js';

export interface LocalControlPlaneOptions {
  definition: AgentDefinition;
  policies?: PolicyBundle[];
  /** Approval decision for local runs; defaults to rejecting (safe). */
  approve?: (
    call: ToolCallRequest,
    decision: PolicyDecision,
  ) => ApprovalOutcome | Promise<ApprovalOutcome>;
  onStep?: (runId: string, step: StepInput) => void;
  /** Monthly budget verdict; local runs have no ledger, so the default never blocks. */
  checkBudget?: (runId: string) => BudgetVerdict | Promise<BudgetVerdict>;
  actor?: string;
  /** Tool classes (`server/tool`) for read-only steps; defaults to the definition's own. */
  toolAccess?: Readonly<Record<string, 'read' | 'write'>>;
}

/**
 * In-memory control plane for the local CLI and tests: same policy engine and audit chain as the
 * control node, without a database.
 */
export class LocalControlPlane implements ControlPlane {
  readonly steps: StepInput[] = [];
  readonly audit: AuditEntry[] = [];
  readonly results = new Map<string, RunResult>();
  private readonly cancelled = new Set<string>();
  private readonly callCounts = new Map<string, Map<string, number>>();

  constructor(private readonly opts: LocalControlPlaneOptions) {}

  private append(action: string, runId: string, target: string | null, payload: unknown): void {
    this.audit.push(
      createAuditEntry(this.audit.at(-1) ?? null, {
        actor: this.opts.actor ?? 'local-runner',
        action,
        target,
        runId,
        payload,
      }),
    );
  }

  async decideToolCall(
    runId: string,
    agentId: string,
    call: ToolCallRequest,
  ): Promise<PolicyDecision> {
    const agent = this.opts.definition.agents.find((a) => a.id === agentId) ?? {
      id: agentId,
      tools: [],
    };
    const counts = this.callCounts.get(runId) ?? new Map<string, number>();
    this.callCounts.set(runId, counts);
    const decision = evaluateToolCall(call, {
      definition: this.opts.definition,
      agent,
      toolAccess: this.opts.toolAccess ?? (this.opts.definition as PublishedDefinition).toolAccess,
      bundles: this.opts.policies ?? [],
      callCounts: counts,
    });
    if (decision.effect !== 'deny') {
      const key = `${call.server}/${call.tool}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    this.append('policy.decision', runId, `${call.server}/${call.tool}`, {
      agentId,
      args: call.args,
      effect: decision.effect,
      reasons: decision.reasons,
    });
    return decision;
  }

  async recordStep(runId: string, step: StepInput): Promise<void> {
    this.steps.push(step);
    const special = stepAuditEntry(step);
    this.append(special?.action ?? `step.${step.kind}`, runId, step.name, special?.payload ?? step);
    this.opts.onStep?.(runId, step);
  }

  async awaitApproval(
    runId: string,
    agentId: string,
    call: ToolCallRequest,
    decision: PolicyDecision,
  ): Promise<ApprovalOutcome> {
    const outcome = this.opts.approve ? await this.opts.approve(call, decision) : 'rejected';
    this.append('approval.decided', runId, `${call.server}/${call.tool}`, { agentId, outcome });
    return outcome;
  }

  cancel(runId: string): void {
    this.cancelled.add(runId);
  }

  async isCancelled(runId: string): Promise<boolean> {
    return this.cancelled.has(runId);
  }

  async checkBudget(runId: string): Promise<BudgetVerdict> {
    return (await this.opts.checkBudget?.(runId)) ?? { blocked: false, breaches: [] };
  }

  async completeRun(runId: string, result: RunResult): Promise<void> {
    this.results.set(runId, result);
    this.append('run.completed', runId, runId, {
      status: result.status,
      usage: result.usage,
      error: result.error ?? null,
    });
  }

  verifyAudit(): VerifyResult {
    return verifyAuditChain(this.audit);
  }
}
