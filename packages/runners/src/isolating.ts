/**
 * Isolating runner contract (ADR 0008, section 3.2). The types live in `types.ts`; this module
 * only keeps the historical import path of the Kubernetes Job runner working.
 */
export type {
  IsolatingRunner,
  RunNodeExit,
  RunNodeHandle,
  RunNodeSpec,
  RunNodeStopReason,
} from './types.js';
