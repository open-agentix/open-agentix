import {
  OaxError,
  type AgentDefinition,
  type AgentSpec,
  type HarnessKind,
  type RunnerKind,
} from '@openagentix/core';
import type { Services } from '@openagentix/api';
import { GitError } from './git/errors.js';
import { readIssue, type PreparedWorkspace, type PullRequestDelivery } from './git/delivery.js';
import {
  NodeStepFailure,
  type AgentOutput,
  type IsolatingRunner,
  type RunNodeExit,
  type PatchAttachment,
  type RunNodeHandle,
  type StepDispatchRequest,
  type StepDispatchResult,
  type StepDispatcher,
} from '@openagentix/runners';

/** Runner kinds that execute steps in the orchestrator's own process. */
const INLINE: readonly RunnerKind[] = ['in-process', 'local'];

export interface NodeDispatcherOptions {
  services: Pick<Services, 'runNodes' | 'control'>;
  /** Isolating runners that are enabled, by kind. */
  runners: Partial<
    Record<
      RunnerKind,
      IsolatingRunner & { imageFor(toolbox?: string, harness?: HarnessKind): string }
    >
  >;
  /** Id of the orchestrating worker (holds the run's lease). */
  workerId: string;
  /** Control node base URL as seen from run nodes. */
  controlUrl: string;
  /** Per-runner override of `controlUrl` (e.g. an https URL for Kubernetes, an internal one for containers). */
  controlUrls?: Partial<Record<RunnerKind, string>>;
  /** Upper bounds handed to the runner (it clamps to its own maxima). */
  limits: { cpus: number; memoryMb: number; pids: number };
  /** Step timeout when neither the step nor the pipeline budget sets one. */
  defaultTimeoutSeconds?: number;
  cancelPollMs?: number;
  now?: () => number;
  /**
   * Pull request delivery (DOG-4). Without it a step with a `pull-request` output fails closed
   * (`pull_request_unavailable`) before anything starts.
   */
  delivery?: PullRequestDelivery;
}

/** A Git/delivery refusal becomes a failed step with its fixed, client-safe code. */
function deliveryFailure(e: unknown): NodeStepFailure {
  if (e instanceof GitError) return new NodeStepFailure('failed', e.code, e.message);
  if (e instanceof OaxError) return new NodeStepFailure('failed', e.code, e.message);
  return new NodeStepFailure('failed', 'pull_request_failed', 'the pull request delivery failed');
}

/**
 * The orchestrator side of an isolated step (ADR 0008, section 3.3): creates the session and the
 * step-scoped token, starts the node, waits, then always revokes the session and removes the node.
 * It fails closed: a step whose effective runner is not inline NEVER runs inline, and a step
 * without an accepted result from its node fails the run.
 */
export class NodeDispatcher implements StepDispatcher {
  constructor(
    private readonly opts: NodeDispatcherOptions,
    private readonly definition: AgentDefinition,
  ) {}

  private effectiveRunner(agent: AgentSpec): RunnerKind {
    return agent.runtime?.runner ?? this.definition.runtime.runner;
  }

  isolates(agent: AgentSpec): boolean {
    return !INLINE.includes(this.effectiveRunner(agent));
  }

  async dispatch(req: StepDispatchRequest): Promise<StepDispatchResult> {
    const prOutput = req.agent.outputs?.find((o) => o.format === 'pull-request');
    if (!prOutput) return this.dispatchNode(req);
    // The seed is built by the worker BEFORE the node exists (and before any model money is spent):
    // the node itself never gets a route to the Git host (dogfooding D4-A).
    const delivery = this.opts.delivery;
    if (!delivery || !prOutput.target || !delivery.has(prOutput.target))
      throw new NodeStepFailure(
        'failed',
        'pull_request_unavailable',
        `step "${req.agent.id}" has a pull-request output but no configured delivery target`,
      );
    let issue;
    try {
      issue = readIssue(req.input);
    } catch (e) {
      throw deliveryFailure(e);
    }
    const workspace = await delivery.prepare(req.runId, prOutput.target).catch((e: unknown) => {
      throw deliveryFailure(e);
    });
    try {
      const res = await this.dispatchNode(req, workspace);
      const patch = res.patch;
      if (!patch)
        throw new NodeStepFailure('failed', 'patch_missing', 'the run node attached no patch');
      const delivered = await delivery
        .deliver(workspace, {
          issue,
          summary: res.output.content,
          patch,
          model: req.agent.model,
          costMicros: res.usage.costMicros,
          extraSecrets: [res.sessionToken],
        })
        .catch((e: unknown) => {
          throw deliveryFailure(e);
        });
      return {
        output: {
          agentId: req.agent.id,
          format: 'pull-request',
          content: JSON.stringify(delivered),
          json: delivered,
        },
        usage: res.usage,
      };
    } finally {
      await workspace.dispose().catch(() => undefined);
    }
  }

  private async dispatchNode(
    req: StepDispatchRequest,
    workspace?: PreparedWorkspace,
  ): Promise<StepDispatchResult & { patch?: PatchAttachment; sessionToken: string }> {
    const { agent, runId } = req;
    const kind = this.effectiveRunner(agent);
    const runner = this.opts.runners[kind];
    if (!runner)
      throw new OaxError(
        'runner_unavailable',
        `step "${agent.id}" needs runner "${kind}", which is not enabled on this worker`,
      );
    const now = this.opts.now ?? Date.now;
    const timeoutSeconds =
      agent.budget?.timeoutSeconds ??
      this.definition.budget.timeoutSeconds ??
      this.opts.defaultTimeoutSeconds ??
      900;
    // Step egress can only narrow the pipeline's (publish enforces it; this is the last check).
    const pipelineEgress = this.definition.runtime.egress;
    const egress = agent.runtime?.egress ?? pipelineEgress;
    if (!egress.every((h) => pipelineEgress.includes(h)))
      throw new OaxError('egress_denied', `step "${agent.id}" widens the pipeline's egress`);
    const harness = agent.runtime?.harness;
    // A harness step runs on the image of its harness (pinned binary); unknown harness fails closed.
    const image = runner.imageFor(agent.toolbox ?? this.definition.runtime.toolbox, harness);
    const { runNodes, control } = this.opts.services;
    // The run's ledger counters before the node starts: what the model proxy adds while it runs is
    // this step's measured usage (ADR 0009 section 5). Steps of a run are sequential.
    const before = await control.runUsage(runId);
    const session = await runNodes.createSession(runId, this.opts.workerId, {
      agentId: agent.id,
      input: req.input,
      timeoutSeconds,
      runner: kind,
      image,
    });
    const started = now();
    const cancel = new AbortController();
    const outer = req.signal;
    const onOuter = () => cancel.abort(outer?.reason);
    outer?.addEventListener('abort', onOuter, { once: true });
    const poll = setInterval(() => {
      void control
        .isCancelled(runId)
        .then((c) => c && cancel.abort(new Error('cancelled')))
        // A control node that cannot answer must not let the node run on: fail closed.
        .catch(() => cancel.abort(new Error('cancel check failed')));
    }, this.opts.cancelPollMs ?? 2000);
    let handle: RunNodeHandle | undefined;
    let exit: RunNodeExit = { exitCode: null };
    let reason: 'step_end' | 'cancelled' | 'timeout' | 'lease_lost' = 'step_end';
    try {
      if (workspace)
        await runNodes.storeSeed(session.sessionId, this.opts.workerId, {
          archive: workspace.archive,
          target: workspace.target.name,
          commit: workspace.commit,
          files: workspace.files,
          agentId: agent.id,
        });
      handle = await runner.startNode(
        {
          runId,
          nodeId: session.nodeId,
          steps: [agent.id],
          image,
          controlUrl: this.opts.controlUrls?.[kind] ?? this.opts.controlUrl,
          runToken: session.token,
          limits: { ...this.opts.limits, timeoutSeconds },
          egress,
          ...(harness ? { harness } : {}),
        },
        { signal: cancel.signal },
      );
      exit = await handle.wait(cancel.signal);
      if (exit.reason === 'timeout') reason = 'timeout';
      else if (exit.reason === 'cancelled' || cancel.signal.aborted) reason = 'cancelled';
    } catch (e) {
      reason = cancel.signal.aborted ? 'cancelled' : 'step_end';
      if (!cancel.signal.aborted) throw e;
    } finally {
      clearInterval(poll);
      outer?.removeEventListener('abort', onOuter);
      // The token dies first, then the node is destroyed; both even when waiting threw.
      await runNodes.revoke(session.sessionId, reason).catch(() => undefined);
      await handle?.stop(reason).catch(() => undefined);
      await runNodes
        .recordStopped(session.sessionId, {
          exitCode: exit.exitCode,
          durationMs: now() - started,
          ...(exit.reason ? { reason: exit.reason } : {}),
        })
        .catch(() => undefined);
    }
    if (reason === 'cancelled') throw new OaxError('cancelled', 'run was cancelled');
    if (reason === 'timeout')
      throw new NodeStepFailure(
        'failed',
        'control_timeout',
        `step "${agent.id}" exceeded its timeout`,
      );
    const result = await runNodes.resultOf(session.sessionId);
    if (result?.failure)
      throw new NodeStepFailure(
        result.failure.status,
        result.failure.code,
        result.failure.message,
        true,
      );
    if (!result || exit.exitCode !== 0 || result.agentId !== agent.id)
      throw new NodeStepFailure(
        'failed',
        'run_node_failed',
        `run node of step "${agent.id}" ended without an accepted result (exit code ${String(exit.exitCode)})`,
      );
    const output: AgentOutput = {
      agentId: agent.id,
      format: result.format,
      content: result.content,
      ...(Object.hasOwn(result, 'json') ? { json: result.json } : {}),
    };
    // Cost and tokens of a node are NOT taken from its report: an untrusted node must not steer
    // the run's budget accounting. The model proxy measured and recorded every model call of the
    // node on the control node (ledger and run counters), so the authoritative usage is what the
    // counters gained while the node ran. Steps and tool calls are bounded reports of the node
    // (enforced against its REMAINING budget inside the node).
    const cap = (n: number | undefined) => Math.min(Math.max(0, n ?? 0), 1000);
    const after = await control.runUsage(runId);
    return {
      output,
      ...(result.patch ? { patch: result.patch } : {}),
      sessionToken: session.token,
      usage: {
        tokensIn: Math.max(0, after.tokensIn - before.tokensIn),
        tokensOut: Math.max(0, after.tokensOut - before.tokensOut),
        costMicros: Math.max(0, after.costMicros - before.costMicros),
        steps: cap(result.usage?.steps),
        toolCalls: cap(result.usage?.toolCalls),
      },
    };
  }
}
