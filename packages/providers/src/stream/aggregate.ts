import { parseToolArgs } from '../http.js';
import type { ChatResponse, StopReason, ToolCall } from '../types.js';
import type { StreamUsage, UpstreamEvent } from './types.js';

export type StreamSurface = 'anthropic' | 'openai';

const ANTHROPIC_STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

const OPENAI_FINISH: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

interface PartialTool {
  id: string;
  name: string;
  json: string;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Folds the events of an upstream stream (Anthropic Messages or Chat Completions chunks, as
 * delivered by `UpstreamStream.events`) into one `ChatResponse` and reports the text deltas for
 * live relaying. Only fields the proxy understands are read; everything else in an event is
 * ignored, so nothing a provider adds can reach a client through this class.
 */
export class ChatStreamAggregator {
  private text = '';
  private model: string;
  private stop: StopReason = 'other';
  private readonly tools = new Map<number, PartialTool>();

  constructor(
    private readonly surface: StreamSurface,
    requestedModel: string,
  ) {
    this.model = requestedModel;
  }

  /** Feeds one event; returns the text delta it carried, if any. */
  push(ev: UpstreamEvent): string | undefined {
    return this.surface === 'anthropic' ? this.anthropic(ev) : this.openai(ev);
  }

  private anthropic(ev: UpstreamEvent): string | undefined {
    const d = ev.data;
    switch (ev.event) {
      case 'message_start': {
        const model = obj(d.message)?.model;
        if (typeof model === 'string' && model) this.model = model;
        return undefined;
      }
      case 'content_block_start': {
        const block = obj(d.content_block);
        const index = typeof d.index === 'number' ? d.index : 0;
        if (block?.type === 'tool_use') {
          this.tools.set(index, {
            id: typeof block.id === 'string' ? block.id : `call_${index}`,
            name: typeof block.name === 'string' ? block.name : '',
            json: '',
          });
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          this.text += block.text;
          return block.text;
        }
        return undefined;
      }
      case 'content_block_delta': {
        const delta = obj(d.delta);
        const index = typeof d.index === 'number' ? d.index : 0;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.text += delta.text;
          return delta.text || undefined;
        }
        if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const t = this.tools.get(index);
          if (t) t.json += delta.partial_json;
        }
        return undefined;
      }
      case 'message_delta': {
        const reason = obj(d.delta)?.stop_reason;
        if (typeof reason === 'string') this.stop = ANTHROPIC_STOP[reason] ?? 'other';
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private openai(ev: UpstreamEvent): string | undefined {
    const d = ev.data;
    if (typeof d.model === 'string' && d.model) this.model = d.model;
    let out: string | undefined;
    if (!Array.isArray(d.choices)) return undefined;
    for (const c of d.choices) {
      const choice = obj(c);
      if (!choice || (typeof choice.index === 'number' && choice.index !== 0)) continue;
      if (typeof choice.finish_reason === 'string') {
        this.stop = OPENAI_FINISH[choice.finish_reason] ?? 'other';
      }
      const delta = obj(choice.delta);
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        this.text += delta.content;
        out = (out ?? '') + delta.content;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          const t = obj(raw);
          if (!t) continue;
          const index = typeof t.index === 'number' ? t.index : this.tools.size;
          const fn = obj(t.function);
          const cur = this.tools.get(index) ?? { id: '', name: '', json: '' };
          if (typeof t.id === 'string' && t.id) cur.id = t.id;
          if (typeof fn?.name === 'string') cur.name += fn.name;
          if (typeof fn?.arguments === 'string') cur.json += fn.arguments;
          this.tools.set(index, cur);
        }
      }
    }
    return out;
  }

  /** The aggregated response. `usage` is the meter's settlement of the stream. */
  finish(usage: StreamUsage): ChatResponse {
    const toolCalls: ToolCall[] = [...this.tools.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, t]) => ({
        id: t.id || `call_${index}`,
        name: t.name,
        args: parseToolArgs(t.json),
      }));
    return {
      text: this.text,
      toolCalls,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      stopReason: toolCalls.length > 0 && this.stop === 'other' ? 'tool_use' : this.stop,
      model: this.model,
    };
  }

  /** Bytes of tool-call arguments seen so far (accounting of the structured output). */
  get toolArgBytes(): number {
    let n = 0;
    for (const t of this.tools.values()) n += Buffer.byteLength(t.json, 'utf8');
    return n;
  }

  get textBytes(): number {
    return Buffer.byteLength(this.text, 'utf8');
  }
}
