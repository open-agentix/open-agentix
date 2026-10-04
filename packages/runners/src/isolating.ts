/**
 * Isolating runner contract (ADR 0008, section 3.2).
 *
 * INTEGRATION POINT (W1-3a): these types are declared here exactly as documented in the ADR so
 * that the Kubernetes Job runner (W1-4) can be built and tested independently. When the run
 * node / credential broker lands, `packages/runners/src/types.ts` becomes the single owner and
 * this file is reduced to a re-export (or removed); the shapes must not diverge.
 */
import type { Runner } from './types.js';

export type RunNodeStopReason = 'step_end' | 'cancelled' | 'timeout' | 'lease_lost';

export interface RunNodeSpec {
  runId: string;
  /** uuid, also the token's workerId. */
  nodeId: string;
  /** Agent ids of this session (v0.2: exactly one). */
  steps: string[];
  /** Toolbox/worker image pinned by digest. */
  image: string;
  controlUrl: string;
  /** Step-scoped run token; delivered as a file, never as environment. */
  runToken: string;
  limits: { cpus: number; memoryMb: number; timeoutSeconds: number; pids: number };
  /** Effective step egress (already narrowed by the orchestrator). */
  egress: string[];
}

export interface RunNodeExit {
  exitCode: number | null;
  reason?: string;
}

export interface RunNodeHandle {
  readonly nodeId: string;
  wait(signal?: AbortSignal): Promise<RunNodeExit>;
  /** Idempotent; removes the node and everything created for it. */
  stop(reason: RunNodeStopReason): Promise<void>;
}

export interface IsolatingRunner extends Runner {
  startNode(spec: RunNodeSpec, ctx: { signal?: AbortSignal }): Promise<RunNodeHandle>;
}
