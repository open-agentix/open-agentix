import type {
  AgentDefinition,
  ContextGuard,
  AgentSpec,
  ControlLimits,
  CostModel,
  HarnessKind,
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
import type { ExecutorTelemetry } from './executor-telemetry.js';
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
  /**
   * Trusted in-process `model_call` (or the `error` of a failed call) that settles a reservation
   * from {@link ControlPlane.reserveModelCall}; the control node then computes cost and writes the
   * ledger itself (ADR 0009 section 4.4). Ignored for steps reported by run nodes.
   */
  reservationId?: string;
}

/** What a trusted executor asks to reserve before a model call (ADR 0009 section 4.3). */
export interface ModelReservationRequest {
  agentId: string;
  /** Upper bound of the input tokens. */
  inputTokens: number;
  /** Largest output the call may produce. */
  maxOutputTokens: number;
  /** Shrink the output to what the budgets allow, down to this many tokens, instead of refusing. */
  minOutputTokens?: number;
  /** `cache_control` blocks present: price the input at the cache-write rate. */
  cacheWrite?: boolean;
}

export interface ModelReservationGrant {
  reservationId: string;
  /** The granted output bound: pass it as the provider's max-tokens. */
  maxOutputTokens: number;
  reservedMicros: number;
  priced: boolean;
  /** Time the provider call may take: the reservation expires shortly after this deadline. */
  deadlineMs?: number;
  remaining: { costMicros?: number; tokens?: number; modelCalls?: number };
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
  /**
   * Reserves the worst-case cost of one model call against every applicable budget, or throws a
   * `control_budget_*` / `model_unpriced` / `model_rate_limited` error. Optional so that control
   * planes without a ledger (local CLI) keep working; the executor then calls the model unreserved.
   */
  reserveModelCall?(runId: string, req: ModelReservationRequest): Promise<ModelReservationGrant>;
  completeRun(runId: string, result: RunResult): Promise<void>;
}

export interface RunnerContext {
  /**
   * Where isolated steps run (ADR 0008, section 3). Without a dispatcher every step runs inline in
   * this process, as before. With one, steps whose effective runner is isolating are executed by a
   * short-lived run node and only their validated result comes back.
   */
  dispatcher?: StepDispatcher;
  providers: ProviderRegistry;
  tools: ToolGateway;
  control: ControlPlane;
  costModel: CostModel;
  /**
   * Guard for text that enters the model context (invisible Unicode removed, secrets replaced).
   * Defaults to the tool gateway's guard, which is on unless an operator turned it off.
   */
  guard?: ContextGuard;
  /**
   * Span hooks (ADR 0015 slice S3). Absent when no tracing is configured: the executor then runs
   * exactly as before.
   */
  telemetry?: ExecutorTelemetry;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Executes prepared runs somewhere (in-process, local CLI, container, Kubernetes Job, ...). */
export interface Runner {
  readonly kind: RunnerKind;
  execute(run: PreparedRun, ctx: RunnerContext): Promise<RunResult>;
}

// ---------- isolated steps: run nodes (ADR 0008, section 3) ----------

/** What the orchestrator asks a runner to start for one step (one node per step in v0.2). */
export interface RunNodeSpec {
  runId: string;
  /** Node id; also the worker id claim of the step-scoped run token. */
  nodeId: string;
  /** Agent ids of this session (v0.2: exactly one). */
  steps: string[];
  /** Image pinned by digest (`name@sha256:<64 hex>`). */
  image: string;
  /** Base URL of the control node as seen from the node (internal network). */
  controlUrl: string;
  /** Step-scoped run token. Delivered as a file (`/run/oax/token`), never as environment. */
  runToken: string;
  limits: { cpus: number; memoryMb: number; timeoutSeconds: number; pids: number };
  /** Effective step egress (only ever narrower than the pipeline's `runtime.egress`). */
  egress: string[];
  /** Set for a harness step (`runtime.harness`): selects the harness image and its limits. */
  harness?: HarnessKind;
  /**
   * W3C `traceparent` of the dispatching span, for the node's log correlation only (ADR 0015 6.1).
   * Passed as `TRACEPARENT` when it has exactly the W3C shape; the node has no exporter, and a
   * `traceparent` it sends back is ignored by the control node.
   */
  traceparent?: string;
}

export type RunNodeStopReason = 'step_end' | 'cancelled' | 'timeout' | 'lease_lost';

export interface RunNodeExit {
  exitCode: number | null;
  /** Set when the runner ended the node itself (`timeout`, `cancelled`). */
  reason?: string;
}

export interface RunNodeHandle {
  readonly nodeId: string;
  wait(signal?: AbortSignal): Promise<RunNodeExit>;
  /** Idempotent; removes the node (container) and everything that belongs to it. */
  stop(reason: RunNodeStopReason): Promise<void>;
}

/** A runner that executes steps in a separate, isolated process (container, Kubernetes Job). */
export interface IsolatingRunner extends Runner {
  startNode(spec: RunNodeSpec, ctx: { signal?: AbortSignal }): Promise<RunNodeHandle>;
}

export function isIsolatingRunner(r: Runner): r is IsolatingRunner {
  return typeof (r as Partial<IsolatingRunner>).startNode === 'function';
}

/** Everything the orchestrator hands to the dispatcher for one step. */
export interface StepDispatchRequest {
  runId: string;
  agent: AgentSpec;
  /** The validated input of the step (the orchestrator already ran `when` and input handover). */
  input: unknown;
  /** Resolved output schema (named schemas inlined); the orchestrator validates it again. */
  outputSchema?: unknown;
  signal?: AbortSignal;
}

export interface StepDispatchResult {
  output: AgentOutput;
  /** Usage measured on the control node (the model proxy recorded it); never the node's own numbers. */
  usage: RunUsage;
}

/** The `dispatchStep` seam of the executor (ADR 0008, section 5). */
export interface StepDispatcher {
  /** `true` when the step's effective runner is isolating (per-step `runtime.runner` wins). */
  isolates(agent: AgentSpec): boolean;
  /** Runs the step in a run node and returns its result. Throws (fail closed) on any failure. */
  dispatch(req: StepDispatchRequest): Promise<StepDispatchResult>;
}

/** A run node reported that its step did not succeed (carried over to the run's result). */
export class NodeStepFailure extends Error {
  constructor(
    readonly status: 'failed' | 'blocked_by_policy' | 'cancelled',
    readonly code: string,
    message: string,
    /**
     * The code and message were reported by the (untrusted) run node itself, not decided by the
     * orchestrator. Such a code is never exported to telemetry (ADR 0015 section 6.2).
     */
    readonly claimed: boolean = false,
  ) {
    super(message);
  }
}
