import { z } from 'zod';
import { CLASSIFICATIONS } from './classification.js';

/** Run state machine: queued -> running -> (awaiting_approval) -> terminal. */
export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'blocked_by_policy',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'blocked_by_policy',
];

const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['awaiting_approval', 'succeeded', 'failed', 'cancelled', 'blocked_by_policy', 'queued'],
  awaiting_approval: ['running', 'failed', 'cancelled', 'blocked_by_policy'],
  succeeded: [],
  failed: [],
  cancelled: [],
  blocked_by_policy: [],
};

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const STEP_KINDS = [
  'model_call',
  'tool_call',
  'policy_decision',
  'approval',
  'control',
  'output',
  'error',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Normalised event envelope, compatible with CloudEvents 1.0 (structured JSON mode). */
export const OaxEventSchema = z.looseObject({
  specversion: z.literal('1.0'),
  id: z.string().min(1),
  source: z.string().min(1),
  type: z.string().min(1),
  time: z.string().optional(),
  subject: z.string().optional(),
  datacontenttype: z.string().optional(),
  dataschema: z.string().optional(),
  data: z.unknown().optional(),
  /** Extension attribute: data classification of the payload. */
  oaxclassification: z.enum(CLASSIFICATIONS).optional(),
});
export type OaxEvent = z.infer<typeof OaxEventSchema>;
