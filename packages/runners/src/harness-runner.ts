import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ControlAgent,
  OaxError,
  effectiveBudget,
  limitsFromBudget,
  newRunMetrics,
  recordModelCall,
  recordPolicyDenial,
  recordStepResult,
  recordToolCall,
  type AgentSpec,
  type Classification,
  type PolicyDecision,
  type ToolCallRequest,
} from '@openagentix/core';
import { serveGateHttp, type GatewayCallResult, type PolicyGate } from '@openagentix/mcp';
import { buildUserPrompt } from './executor.js';
import { HandoverFailure, StepFlow, buildHandoverPrompt } from './handover-flow.js';
import type { ExternalHarness, HarnessResult, ModelProxyEndpoint } from './harness.js';
import type { AgentOutput, PreparedRun, RunResult, RunnerContext } from './types.js';

const GATE_SERVER = 'oax-gate';

export interface HarnessExecutionOptions {
  /** Parent of the per-run temporary work directory (default: the OS temp dir). */
  workRoot?: string;
  /** Data classification the harness' model endpoint is cleared for (default `internal`). */
  clearance?: Classification;
  /** Keep the work directory (debugging only). */
  keepWorkDir?: boolean;
  /**
   * Run through the model proxy (ADR 0009 section 10): returns the model token and surface of the
   * step. Then the proxy is the only measurer of model calls: no `model_call` step is written and
   * the harness' own cost report is stored in the output step for comparison only.
   */
  modelProxy?: (agent: AgentSpec) => Promise<ModelProxyEndpoint>;
}

/**
 * Executes a prepared run through an external harness. The harness gets the policy gate as its
 * ONLY tool source, so every tool call is decided by the policy engine, approvals are awaited,
 * steps/audit entries are recorded through the control plane and the control agent can stop the
 * run - exactly like in the native step executor. Model cost is taken from the harness report.
 */
export async function executeWithHarness(
  run: PreparedRun,
  ctx: RunnerContext,
  harness: ExternalHarness,
  options: HarnessExecutionOptions = {},
): Promise<RunResult> {
  const now = ctx.now ?? Date.now;
  const def = run.definition;
  const limits = limitsFromBudget(def.budget, run.limits);
  const controller = new ControlAgent(limits);
  const metrics = newRunMetrics(now());
  const outputs: AgentOutput[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  const usage = () => ({
    tokensIn,
    tokensOut,
    costMicros: metrics.costMicros,
    steps: metrics.steps,
    toolCalls: metrics.toolCalls,
  });
  const step = (s: Parameters<typeof ctx.control.recordStep>[1]) =>
    ctx.control.recordStep(run.runId, s);
  const fail = (
    code: string,
    message: string,
    status: RunResult['status'] = 'failed',
  ): RunResult => ({
    status,
    outputs,
    usage: usage(),
    error: { code, message },
  });

  let previous: AgentOutput | null = null;
  const flow = new StepFlow(run, step);
  for (const agentId of def.pipeline) {
    const agent = def.agents.find((a) => a.id === agentId);
    if (!agent) return fail('agent_unknown', `agent "${agentId}" not found`);
    if (await ctx.control.isCancelled(run.runId))
      return fail('cancelled', 'run was cancelled', 'cancelled');
    let start;
    try {
      start = await flow.begin(agent, previous);
    } catch (e) {
      if (e instanceof HandoverFailure) return fail(e.code, e.message);
      throw e;
    }
    if (start.skipped) continue;
    // Behind the proxy the control node checks the classification against the real provider.
    const clearance = options.modelProxy
      ? 'restricted'
      : ctx.providers.has(agent.provider)
        ? ctx.providers.get(agent.provider).clearance
        : (options.clearance ?? 'internal');
    const dataFlow = controller.checkDataFlow(def.classification, clearance);
    if (dataFlow.action === 'kill') {
      await step({ kind: 'control', agentId, name: 'kill', status: 'error', output: dataFlow });
      return fail(
        'control_classification',
        dataFlow.reasons[0]?.message ?? '',
        'blocked_by_policy',
      );
    }

    // Remaining run budget -> limits of this harness invocation.
    const agentBudget = effectiveBudget(def.budget, agent.budget);
    const remainingUsd =
      limits.maxCostMicros === undefined
        ? undefined
        : Math.max(0, limits.maxCostMicros - metrics.costMicros) / 1_000_000;
    const remainingS =
      limits.timeoutMs === undefined
        ? undefined
        : Math.max(1, Math.ceil((limits.timeoutMs - (now() - metrics.startedAt)) / 1000));
    const scoped: AgentSpec = {
      ...agent,
      budget: {
        ...agentBudget,
        ...(remainingUsd !== undefined && remainingUsd > 0
          ? { maxCostUsd: Math.min(agentBudget.maxCostUsd ?? remainingUsd, remainingUsd) }
          : {}),
        ...(remainingS !== undefined
          ? { timeoutSeconds: Math.min(agentBudget.timeoutSeconds ?? remainingS, remainingS) }
          : {}),
      },
    };

    const exposed = await ctx.tools.exposedTools(agent);
    const abort = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
    let killed: { code: string; message: string; status: RunResult['status'] } | null = null;
    const killRun = (code: string, message: string, status: RunResult['status'] = 'failed') => {
      killed ??= { code, message, status };
      abort.abort();
    };

    // Policy gate seen by the harness: decision (audited) -> approval -> control agent.
    const gate: PolicyGate = {
      async decide(call: ToolCallRequest): Promise<PolicyDecision> {
        recordToolCall(metrics, call, now());
        const decision = await ctx.control.decideToolCall(run.runId, agentId, call);
        await step({
          kind: 'policy_decision',
          agentId,
          name: `${call.server}/${call.tool}`,
          status:
            decision.effect === 'deny'
              ? 'denied'
              : decision.effect === 'require_approval'
                ? 'pending'
                : 'ok',
          input: call.args,
          output: { effect: decision.effect, reasons: decision.reasons },
        });
        let result = decision;
        if (decision.effect === 'deny') {
          recordPolicyDenial(
            metrics,
            decision.reasons.some((r) => r.code === 'tool_forbidden'),
          );
          recordStepResult(metrics, false);
        } else if (decision.effect === 'require_approval') {
          const outcome = await ctx.control.awaitApproval(
            run.runId,
            agentId,
            call,
            decision,
            signal,
          );
          await step({
            kind: 'approval',
            agentId,
            name: `${call.server}/${call.tool}`,
            status: outcome === 'approved' ? 'approved' : 'rejected',
            output: { outcome },
          });
          if (outcome === 'timeout') {
            killRun('approval_timeout', `approval for ${call.server}/${call.tool} timed out`);
            result = { ...decision, effect: 'deny' };
          } else if (outcome === 'rejected') {
            recordStepResult(metrics, false);
            result = {
              ...decision,
              effect: 'deny',
              reasons: [
                {
                  code: 'approval_required',
                  message: 'Rejected by a human approver. Do not retry this action.',
                },
              ],
            };
          } else result = { ...decision, effect: 'allow' };
        }
        const verdict = await controller.check(metrics, now());
        if (verdict.action === 'kill') {
          await step({ kind: 'control', agentId, name: 'kill', status: 'error', output: verdict });
          killRun(
            `control_${verdict.reasons[0]?.rule ?? 'kill'}`,
            verdict.reasons.map((r) => r.message).join('; '),
            verdict.reasons.some((r) =>
              ['forbidden_action', 'classification', 'policy_denials'].includes(r.rule),
            )
              ? 'blocked_by_policy'
              : 'failed',
          );
          return { ...result, effect: 'deny' };
        }
        return result;
      },
    };

    const onCall = async (call: ToolCallRequest, res: GatewayCallResult) => {
      if (res.status !== 'ok') return;
      const toolCost = ctx.costModel.toolCall(agent.provider, agent.model);
      metrics.costMicros += toolCost;
      recordStepResult(metrics, !res.result.isError);
      await step({
        kind: 'tool_call',
        agentId,
        name: `${call.server}/${call.tool}`,
        status: res.result.isError ? 'error' : 'ok',
        input: call.args,
        output: {
          text: res.result.text,
          truncated: res.result.truncated,
          bytes: res.result.bytes,
        },
        costMicros: toolCost,
      });
    };

    const handle = await serveGateHttp({ gateway: ctx.tools, gate, tools: exposed, onCall });
    const workDir = await mkdtemp(join(options.workRoot ?? tmpdir(), 'oax-harness-'));
    let res: HarnessResult;
    const started = now();
    try {
      const endpoint = options.modelProxy ? await options.modelProxy(scoped) : undefined;
      const invocation = harness.buildInvocation(
        def,
        scoped,
        start.explicit ? buildHandoverPrompt(start.value) : buildUserPrompt(run, previous),
        { serverName: GATE_SERVER, url: handle.url, runToken: handle.token },
        exposed,
        endpoint,
      );
      res = await harness.run(invocation, { cwd: workDir, signal });
    } catch (e) {
      await step({
        kind: 'error',
        agentId,
        name: 'harness',
        status: 'error',
        output: { message: (e as Error).message },
        provider: harness.name,
        model: agent.model,
        durationMs: now() - started,
      });
      return fail(e instanceof OaxError ? e.code : 'harness_error', (e as Error).message);
    } finally {
      await handle.close();
      if (!options.keepWorkDir) await rm(workDir, { recursive: true, force: true });
    }

    const costMicros = Math.round(res.costUsd * 1_000_000);
    if (!options.modelProxy) {
      recordModelCall(metrics, res.tokensIn + res.tokensOut, costMicros);
      tokensIn += res.tokensIn;
      tokensOut += res.tokensOut;
      await step({
        kind: 'model_call',
        agentId,
        name: `${harness.name}/${res.model ?? agent.model}`,
        status: res.isError ? 'error' : 'ok',
        input: { turns: res.turns, tools: exposed.map((t) => t.modelName) },
        output: {
          text: res.text,
          harnessToolCalls: res.toolCalls.map((t) => t.name),
          terminated: res.terminated,
        },
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        costMicros,
        durationMs: now() - started,
        provider: harness.name,
        model: res.model ?? agent.model,
      });
    }
    // Through the proxy the harness' numbers are a report to compare against the ledger, never
    // the books. They travel in the output step (a node may report `output` and `error` steps).
    const report = options.modelProxy
      ? {
          name: harness.name,
          turns: res.turns,
          terminated: res.terminated,
          reported: { costUsd: res.costUsd, tokensIn: res.tokensIn, tokensOut: res.tokensOut },
          toolCalls: res.toolCalls.map((t) => ({ name: t.name, isError: t.isError })),
        }
      : undefined;

    // Integrity: the harness may only have used the gate. Anything else is a boundary violation.
    const unmanaged = res.toolCalls.filter((t) => !t.name.startsWith(`mcp__${GATE_SERVER}__`));
    if (report && (res.isError || unmanaged.length > 0)) {
      // A failed proxied run keeps its report: nodes can only report `output` and `error` steps.
      await step({
        kind: 'error',
        agentId,
        name: 'harness',
        status: 'error',
        output: {
          message: res.errorMessage ?? 'the harness used tools outside the policy gate',
          harness: report,
        },
      });
    }
    if (unmanaged.length > 0) {
      await step({
        kind: 'control',
        agentId,
        name: 'kill',
        status: 'error',
        output: { rule: 'forbidden_action', unmanaged: unmanaged.map((t) => t.name) },
      });
      return fail(
        'harness_unmanaged_tool',
        `the harness used tools outside the policy gate: ${unmanaged.map((t) => t.name).join(', ')}`,
        'blocked_by_policy',
      );
    }
    if (killed !== null) {
      const k: { code: string; message: string; status: RunResult['status'] } = killed;
      return fail(k.code, k.message, k.status);
    }
    if (res.isError) {
      const cancelled = res.terminated === 'cancelled';
      const code = cancelled
        ? 'cancelled'
        : res.terminated === 'turns'
          ? 'control_budget_steps'
          : res.terminated === 'budget'
            ? 'control_budget_cost'
            : res.terminated === 'timeout'
              ? 'control_timeout'
              : 'harness_error';
      return fail(code, res.errorMessage ?? 'harness failed', cancelled ? 'cancelled' : 'failed');
    }
    const verdict = await controller.check(metrics, now());
    if (verdict.action === 'kill') {
      await step({ kind: 'control', agentId, name: 'kill', status: 'error', output: verdict });
      return fail(
        `control_${verdict.reasons[0]?.rule ?? 'kill'}`,
        verdict.reasons.map((r) => r.message).join('; '),
      );
    }

    // An external harness cannot be asked again mid-run: `onInvalid: retry` fails like `fail`.
    const invalid = flow.checkOutput(agent, res.text);
    if (invalid) {
      await flow.recordInvalid(agentId, 'output', 1, invalid.schemaDigest, invalid.errors);
      return fail(
        'handover_invalid',
        `output of agent "${agentId}" does not match its output schema`,
      );
    }
    const format = agent.outputs[0]?.format ?? 'markdown';
    const out: AgentOutput = { agentId, format, content: res.text };
    if (format === 'json') {
      try {
        out.json = JSON.parse(res.text);
      } catch {
        // keep as text
      }
    }
    outputs.push(out);
    flow.complete(out);
    await step({
      kind: 'output',
      agentId,
      name: format,
      status: 'ok',
      output: report ? { ...out, harness: report } : out,
    });
    previous = out;
  }
  return { status: 'succeeded', outputs, usage: usage() };
}
