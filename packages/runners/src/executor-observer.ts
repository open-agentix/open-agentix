/**
 * Metric hooks of the step executor (ADR 0015 slice S5). Like the span hooks, the runners package
 * knows nothing about Prometheus: the host (the worker) hands in an implementation. Every value
 * passed here comes from a closed set (decision, result and outcome names, runner kinds) or is a
 * duration; never a name from a definition, an argument, a result or a message.
 */
export interface ExecutorObserver {
  /** A tool call that ended: the policy decision and what became of the call. */
  toolCall(
    decision: 'allow' | 'deny' | 'require_approval',
    result: 'ok' | 'error' | 'not_executed',
  ): void;
  /** An approval wait that ended (`cancelled`: the run was aborted while it waited). */
  approval(outcome: 'approved' | 'rejected' | 'timeout' | 'cancelled', waitSeconds: number): void;
  /** One executed agent step: runner kind, outcome and duration. */
  step(runner: string, ok: boolean, seconds: number, errorCode?: string): void;
}
