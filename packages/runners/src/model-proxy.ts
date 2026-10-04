import { OaxError, type Classification } from '@openagentix/core';
import type {
  ChatRequest,
  ChatResponse,
  CompleteOptions,
  ModelProvider,
  ProviderKind,
} from '@openagentix/providers';

/**
 * Interface for W1-3b (NOT implemented in W1-3a): run nodes call models only through the control
 * node, `POST /v1/worker/runs/{id}/model` (ADR 0008, section 3.4). Provider keys, egress and
 * air-gapped rules, token usage and cost then stay on the control node; an untrusted node can
 * neither read a provider key nor misreport usage.
 *
 * Until W1-3b lands, run nodes have no model access at all: every provider other than the keyless
 * `simulated` provider (tests, demos) resolves to {@link ModelProxyUnavailableProvider}, which fails
 * the step closed. TODO(W1-3b): implement `ModelProxyProvider` against the endpoint below, add the
 * endpoint with usage measured server side, and delete the placeholder.
 */
export interface WorkerModelRequest {
  agentId: string;
  request: ChatRequest;
}

export type WorkerModelResponse = ChatResponse;

/** Client side of the model proxy endpoint (W1-3b). */
export interface ModelProxyClient {
  complete(
    runId: string,
    req: WorkerModelRequest,
    opts?: CompleteOptions,
  ): Promise<WorkerModelResponse>;
}

/** Placeholder provider of a run node: always fails closed (see above). */
export class ModelProxyUnavailableProvider implements ModelProvider {
  readonly clearance: Classification = 'restricted';

  constructor(
    readonly name: string,
    readonly kind: ProviderKind = 'openai',
  ) {}

  complete(): Promise<ChatResponse> {
    return Promise.reject(
      new OaxError(
        'model_proxy_unavailable',
        `run nodes cannot call provider "${this.name}" yet: the control node model proxy (W1-3b) is not implemented`,
      ),
    );
  }
}
