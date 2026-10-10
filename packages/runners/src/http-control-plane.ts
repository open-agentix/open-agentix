import {
  OaxError,
  type BudgetVerdict,
  type HarnessKind,
  type StepCredentials,
  type PolicyDecision,
  type ToolCallRequest,
} from '@openagentix/core';
import {
  ModelTokenResponseSchema,
  type CompleteOptions,
  type ModelTokenResponse,
  type WorkerModelRequest,
  type WorkerModelResponse,
} from '@openagentix/providers';
import type { ModelProxyClient } from './model-proxy.js';
import {
  StepHandoverSchema,
  type StepHandover,
  type StepHandoverResult,
  type ToolsChangedReport,
} from './run-node-protocol.js';
import type {
  ApprovalOutcome,
  ControlPlane,
  ModelReservationGrant,
  ModelReservationRequest,
  RunResult,
  StepInput,
} from './types.js';

/** Largest relay answer a node reads (the control node caps results far below this). */
const MAX_RELAY_ANSWER_CHARS = 8 * 1024 * 1024;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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
export class HttpControlPlane implements ControlPlane, ModelProxyClient {
  private readonly fetch: FetchFn;

  constructor(private readonly opts: HttpControlPlaneOptions) {
    this.fetch = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    /** Model routes answer with `{ error: { code } }`: surface that code (ADR 0009 section 2.5). */
    keepCode = false,
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
      if (keepCode) {
        const e = (await res.json().catch(() => null)) as {
          error?: { code?: unknown; message?: unknown };
        } | null;
        const code = e?.error?.code;
        if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code))
          throw new OaxError(code, String(e?.error?.message ?? code).slice(0, 300), {
            status: res.status,
          });
      }
      throw new OaxError(
        'control_plane_error',
        `control node returned HTTP ${res.status} for ${method} ${path}`,
        { status: res.status },
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

  // ---------- run node protocol (step-scoped run token only) ----------

  /** The step's own agent spec, input and output schema (nothing about other steps). */
  async fetchHandover(runId: string, agentId: string): Promise<StepHandover> {
    const raw = await this.request<unknown>(
      'GET',
      `/v1/worker/runs/${runId}/handover?agentId=${encodeURIComponent(agentId)}`,
    );
    return StepHandoverSchema.parse(raw);
  }

  /** Step credentials from the broker: issued once per step and session. */
  fetchCredentials(runId: string, agentId: string): Promise<StepCredentials> {
    return this.request('POST', `/v1/worker/runs/${runId}/credentials`, { agentId });
  }

  /** Tells the control node that the tools of a pinned server differ from the pin (never throws). */
  async postToolsChanged(runId: string, report: ToolsChangedReport): Promise<void> {
    await this.request('POST', `/v1/worker/runs/${runId}/mcp-tools-changed`, report);
  }

  /**
   * One JSON-RPC message of the node's MCP client for an HTTP MCP server, relayed by the control
   * node (ADR 0016 section 6). Resolves with the JSON-RPC answer, `undefined` for a notification
   * (HTTP 202). A refusal rejects with the platform error code the control node named; the answer
   * is size-capped because the control node is the only party that can have produced it.
   */
  async relayMcp(
    runId: string,
    server: string,
    message: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const res = await this.fetch(
      `${this.opts.baseUrl.replace(/\/$/, '')}/v1/worker/runs/${encodeURIComponent(runId)}/mcp/${encodeURIComponent(server)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.runToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(message),
        ...(signal ? { signal } : {}),
      },
    );
    if (res.status === 202) return undefined;
    const text = await res.text();
    if (text.length > MAX_RELAY_ANSWER_CHARS)
      throw new OaxError('mcp_relay_failed', 'the MCP relay answer is too large');
    if (!res.ok) {
      const e = safeJson(text) as { error?: unknown; message?: unknown } | null;
      const code =
        typeof e?.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e.error)
          ? e.error
          : 'mcp_relay_failed';
      throw new OaxError(
        code,
        String(e?.message ?? `the MCP relay answered HTTP ${res.status}`).slice(0, 300),
        {
          status: res.status,
        },
      );
    }
    return safeJson(text);
  }

  async postHandoverResult(runId: string, result: StepHandoverResult): Promise<void> {
    await this.request('POST', `/v1/worker/runs/${runId}/handover/result`, result);
  }

  /**
   * The workspace seed of the step (once per step and session): the archive bytes and the SHA-256
   * the control node announced. The caller verifies the digest before it unpacks anything.
   */
  async fetchWorkspaceSeed(
    runId: string,
    agentId: string,
    maxBytes: number,
  ): Promise<{ archive: Buffer; sha256: string }> {
    const res = await this.fetch(
      `${this.opts.baseUrl.replace(/\/$/, '')}/v1/worker/runs/${runId}/workspace?agentId=${encodeURIComponent(agentId)}`,
      { method: 'GET', headers: { authorization: `Bearer ${this.opts.runToken}` } },
    );
    if (!res.ok)
      throw new OaxError(
        'workspace_seed_unavailable',
        `control node returned HTTP ${res.status} for the workspace seed`,
        { status: res.status },
      );
    const sha256 = res.headers.get('x-oax-seed-sha256') ?? '';
    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new OaxError('workspace_seed_invalid', 'the seed response carries no valid digest');
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes)
      throw new OaxError('workspace_seed_invalid', 'the seed is larger than the node accepts');
    const reader = res.body?.getReader();
    if (!reader) throw new OaxError('workspace_seed_invalid', 'the seed response has no body');
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new OaxError('workspace_seed_invalid', 'the seed is larger than the node accepts');
      }
      chunks.push(value);
    }
    return { archive: Buffer.concat(chunks), sha256 };
  }

  checkBudget(runId: string): Promise<BudgetVerdict> {
    return this.request('GET', `/v1/worker/runs/${runId}/budget`);
  }

  // ---------- model proxy (ADR 0009) ----------

  /** One model call through the control node's proxy (native, non-streaming). */
  modelCall(
    runId: string,
    req: WorkerModelRequest,
    opts: CompleteOptions = {},
  ): Promise<WorkerModelResponse> {
    return this.request('POST', `/v1/worker/runs/${runId}/model`, req, opts.signal, true);
  }

  /**
   * The model token of a harness step (once per step and session): the credential the harness
   * child gets instead of any provider key. The answer names the pass-through surface to use.
   */
  async issueHarnessModelToken(
    runId: string,
    agentId: string,
    harness: HarnessKind,
  ): Promise<ModelTokenResponse> {
    const raw = await this.request<unknown>(
      'POST',
      `/v1/worker/runs/${runId}/model-token`,
      { agentId, harness },
      undefined,
      true,
    );
    // Never surface the ZodError: its message quotes the offending values, which may be (parts of)
    // the token. Only the field names are reported.
    const parsed = ModelTokenResponseSchema.safeParse(raw);
    if (!parsed.success)
      throw new OaxError(
        'model_token_response_invalid',
        `the control node answered with an invalid model token response (fields: ${[
          ...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)')),
        ].join(', ')})`,
      );
    return parsed.data;
  }

  /** Reservation of an in-process model call (orchestrator token only). */
  async reserveModelCall(
    runId: string,
    req: ModelReservationRequest,
  ): Promise<ModelReservationGrant> {
    return this.request(
      'POST',
      `/v1/worker/runs/${runId}/model-reservations`,
      req,
      undefined,
      true,
    );
  }

  async completeRun(runId: string, result: RunResult): Promise<void> {
    await this.request('POST', `/v1/worker/runs/${runId}/complete`, result);
  }
}
