import type { Classification, SimulatedResponse } from '@openagentix/core';
import { estimateTokens } from './http.js';
import type { ChatRequest, ChatResponse, CompleteOptions, ModelProvider } from './types.js';

export interface SimulatedOptions {
  name: string;
  clearance?: Classification;
  /** Default script when the agent file has no `simulation` block. */
  responses?: readonly SimulatedResponse[];
  /** Artificial latency for demos. */
  latencyMs?: number;
  /** Maps `server`+`tool` of a scripted call to the model-facing tool name. */
  toolName?: (server: string, tool: string) => string;
}

export const defaultToolName = (server: string, tool: string): string =>
  `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

function lookup(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Replaces `{{a.b.c}}` with values from `ctx` (objects are JSON-encoded, missing -> empty). */
export function renderTemplate(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(value);
    if (whole?.[1]) {
      const v = lookup(ctx, whole[1]);
      return v === undefined ? '' : v;
    }
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, p: string) => {
      const v = lookup(ctx, p);
      if (v === undefined || v === null) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderTemplate(v, ctx)]));
  }
  return value;
}

/**
 * Deterministic provider for tests and the public demo: no network, no randomness.
 * The n-th model call of a conversation returns the n-th scripted response; templates can use
 * `event.*`, `input` (previous agent output) and `lastToolResult`.
 */
export class SimulatedProvider implements ModelProvider {
  readonly kind = 'simulated' as const;
  readonly family = 'simulated';
  readonly catalogProvider = 'simulated';
  readonly name: string;
  readonly clearance: Classification;

  constructor(private readonly opts: SimulatedOptions) {
    this.name = opts.name;
    this.clearance = opts.clearance ?? 'restricted';
  }

  async complete(req: ChatRequest, opts: CompleteOptions = {}): Promise<ChatResponse> {
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    opts.signal?.throwIfAborted();
    const script = req.hints?.simulation ?? this.opts.responses ?? [];
    const turn = req.messages.filter((m) => m.role === 'assistant').length;
    const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool');
    const ctx: Record<string, unknown> = {
      ...req.hints?.context,
      lastToolResult:
        lastTool && lastTool.role === 'tool' ? parseMaybeJson(lastTool.content) : undefined,
    };
    const scripted = script[turn];
    const toolName = this.opts.toolName ?? defaultToolName;
    const inputText = (req.system ?? '') + req.messages.map((m) => m.content).join('\n');
    if (!scripted) {
      const text = `Simulated response (${req.model}): processed ${req.messages.length} message(s).`;
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: estimateTokens(inputText), outputTokens: estimateTokens(text) },
        stopReason: 'end_turn',
        model: req.model,
      };
    }
    const text = String(renderTemplate(scripted.text ?? '', ctx));
    const toolCalls = (scripted.toolCalls ?? []).map((c, i) => ({
      id: `sim_${turn}_${i}`,
      name: toolName(c.server, c.tool),
      args: renderTemplate(c.args, ctx) as Record<string, unknown>,
    }));
    return {
      text,
      toolCalls,
      usage: scripted.usage ?? {
        inputTokens: estimateTokens(inputText),
        outputTokens: estimateTokens(text + JSON.stringify(toolCalls)),
      },
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      model: req.model,
    };
  }
}

function parseMaybeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
