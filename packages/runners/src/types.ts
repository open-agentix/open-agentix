import type {
  AgentDefinition,
  ControlLimits,
  CostModel,
  OaxEvent,
  PolicyBundle,
  PolicyDecision,
  RunStatus,
  RunnerKind,
  StepKind,
  ToolCallRequest,
  BudgetVerdict,
} from '@openagentix/core';
import type { ToolGateway } from '@openagentix/mcp';
import type { ProviderRegistry } from '@openagentix/providers';

/** Everything a runner needs to execute one run (handed over by the control node). */
export interface PreparedRun {
  runId: string;
  definition: AgentDefinition;
  event: OaxEvent;
  /** Global/team policy bundles applied in addition to the agent file. */
  policies: PolicyBundle[];
  /** Platform defaults for guardrails not set in the agent file. */
  limits?: Partial<ControlLimits>;
}

export type StepStatus =
  'ok' | 'error' | 'denied' | 'pending' | 'approved' | 'rejected' | 'skipped';

export interface StepInput {
  kind: StepKind;
  agentId: string | null;
  name: string;
  status: StepStatus;
  input?: unknown;
  output?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  costMicros?: number;
  durationMs?: number;
  provider?: string;
  model?: string;
}

export interface AgentOutput {
  agentId: string;
  format: string;
  content: string;
  /** Parsed value when the format is `json` and the content parsed. */
  json?: unknown;
}

export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  steps: number;
  toolCalls: number;
}

export interface RunResult {
  status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled' | 'blocked_by_policy'>;
  outputs: AgentOutput[];
  usage: RunUsage;
  error?: { code: string; message: string };
}

export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout';

/**
 * The control node API a worker uses for one run. In-process workers call the services directly;
 * remote worker nodes use {@link HttpControlPlane} with a run token - same contract.
 */
export interface ControlPlane {
  /** Policy gate: decides (and audits) a tool call BEFORE it is executed. */
  decideToolCall(runId: string, agentId: string, call: ToolCallRequest): Promise<PolicyDecision>;
  /** Persists a step, its cost and an audit entry. */
  recordStep(runId: string, step: StepInput): Promise<void>;
  /** Blocks until a human decided (or the approval timed out). */
  awaitApproval(
    runId: string,
    agentId: string,
    call: ToolCallRequest,
    decision: PolicyDecision,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome>;
  isCancelled(runId: string): Promise<boolean>;
  /**
   * Monthly tenant/use-case/team budgets of the run (hard stop). Optional so that control planes
   * without a ledger (local CLI) keep working; the executor asks before every step.
   */
  checkBudget?(runId: string): Promise<BudgetVerdict>;
  completeRun(runId: string, result: RunResult): Promise<void>;
}

export interface RunnerContext {
  providers: ProviderRegistry;
  tools: ToolGateway;
  control: ControlPlane;
  costModel: CostModel;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Executes prepared runs somewhere (in-process, local CLI, container, Kubernetes Job, ...). */
export interface Runner {
  readonly kind: RunnerKind;
  execute(run: PreparedRun, ctx: RunnerContext): Promise<RunResult>;
}
