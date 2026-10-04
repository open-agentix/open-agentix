import {
  OaxError,
  type BudgetVerdict,
  type PolicyDecision,
  type ToolCallRequest,
} from '@openagentix/core';
import type { ApprovalOutcome, ControlPlane, RunResult, StepInput } from './types.js';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpControlPlaneOptions {
  /** Base URL of the control node, e.g. `https://openagentix.example.com`. */
  baseUrl: string;
  /** Signed run token issued by the control node for this run. */
  runToken: string;
  fetchImpl?: FetchFn;
  approvalPollMs?: number;
}

/**
 * Control plane client for remote worker nodes (container, Kubernetes Job, Lambda, CI): the same
 * contract as the in-process worker, over HTTPS with a run token.
 */
export class HttpControlPlane implements ControlPlane {
  private readonly fetch: FetchFn;

  constructor(private readonly opts: HttpControlPlaneOptions) {
    this.fetch = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetch(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.runToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new OaxError(
        'control_plane_error',
        `control node returned HTTP ${res.status} for ${method} ${path}`,
      );
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  decideToolCall(runId: string, agentId: string, call: ToolCallRequest): Promise<PolicyDecision> {
    return this.request('POST', `/v1/worker/runs/${runId}/gate`, { agentId, call });
  }

  async recordStep(runId: string, step: StepInput): Promise<void> {
    await this.request('POST', `/v1/worker/runs/${runId}/steps`, step);
  }

  async awaitApproval(
    runId: string,
    agentId: string,
    call: ToolCallRequest,
    decision: PolicyDecision,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome> {
    const { approvalId } = await this.request<{ approvalId: string }>(
      'POST',
      `/v1/worker/runs/${runId}/approvals`,
      { agentId, call, reasons: decision.reasons },
      signal,
    );
    for (;;) {
      const a = await this.request<{ status: 'pending' | ApprovalOutcome }>(
        'GET',
        `/v1/worker/runs/${runId}/approvals/${approvalId}`,
        undefined,
        signal,
      );
      if (a.status !== 'pending') return a.status;
      await new Promise((r) => setTimeout(r, this.opts.approvalPollMs ?? 2000));
      signal?.throwIfAborted();
    }
  }

  async isCancelled(runId: string): Promise<boolean> {
    return (await this.request<{ cancelled: boolean }>('GET', `/v1/worker/runs/${runId}/status`))
      .cancelled;
  }

  checkBudget(runId: string): Promise<BudgetVerdict> {
    return this.request('GET', `/v1/worker/runs/${runId}/budget`);
  }

  async completeRun(runId: string, result: RunResult): Promise<void> {
    await this.request('POST', `/v1/worker/runs/${runId}/complete`, result);
  }
}
