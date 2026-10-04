import { estimateOutputTokensFromBytes, outputFloorFromBytes } from '@openagentix/core';
import type { MeterSnapshot, StreamSettlement, StreamUsage } from './types.js';

export interface UsageUpdate {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/**
 * Collects provider-reported usage (latest value per field wins; Anthropic reports cumulative
 * counters) and the size of streamed output, and settles both into one accounting record.
 * The node, the client and the stream's own content never decide the numbers: only provider
 * usage fields and byte counts of the deltas do.
 */
export class UsageMeter {
  private reported: Partial<Record<keyof StreamUsage, number>> = {};
  private anyReported = false;
  private bytes = 0;

  /** Records reported counters; non-integers and negative values are ignored. */
  report(update: UsageUpdate): void {
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    ] as const) {
      const n = count(update[key]);
      if (n !== undefined) {
        this.reported[key] = n;
        this.anyReported = true;
      }
    }
  }

  /** Adds streamed output (text, thinking and tool-input deltas). */
  addOutput(text: string): void {
    if (text.length > 0) this.bytes += Buffer.byteLength(text, 'utf8');
  }

  /** True when the provider reported this counter at least once (zero counts as reported). */
  has(key: keyof StreamUsage): boolean {
    return this.reported[key] !== undefined;
  }

  get outputBytes(): number {
    return this.bytes;
  }

  snapshot(): MeterSnapshot {
    return {
      outputBytes: this.bytes,
      usage: {
        inputTokens: this.reported.inputTokens ?? 0,
        outputTokens: this.reported.outputTokens ?? 0,
        cacheReadTokens: this.reported.cacheReadTokens ?? 0,
        cacheWriteTokens: this.reported.cacheWriteTokens ?? 0,
      },
      usageReported: this.anyReported,
    };
  }

  /**
   * Final accounting. `complete` is true when the protocol's terminal event arrived.
   * - Complete stream with reported output: the reported value, raised to the floor when lower.
   * - Anything else (nothing reported, stream cut): at least the estimate, so an aborted stream is
   *   never settled below what was streamed. Input falls back to `inputEstimate`.
   */
  settle(complete: boolean, inputEstimate = 0): StreamSettlement {
    const est = estimateOutputTokensFromBytes(this.bytes);
    const floor = outputFloorFromBytes(this.bytes);
    const reportedOut = this.reported.outputTokens;
    const inputReported = this.reported.inputTokens !== undefined;
    let output: number;
    let source: StreamSettlement['source'] = 'provider';
    let floorApplied = false;
    if (complete && reportedOut !== undefined) {
      output = reportedOut;
      if (output < floor) {
        output = floor;
        floorApplied = true;
        source = 'floor';
      }
    } else {
      output = Math.max(reportedOut ?? 0, est);
      source = 'estimated';
    }
    if (source === 'provider' && !inputReported) source = 'estimated';
    return {
      usage: {
        inputTokens: this.reported.inputTokens ?? Math.max(0, Math.floor(inputEstimate)),
        outputTokens: output,
        cacheReadTokens: this.reported.cacheReadTokens ?? 0,
        cacheWriteTokens: this.reported.cacheWriteTokens ?? 0,
      },
      source,
      usageReported: this.anyReported && complete && reportedOut !== undefined,
      floorApplied,
      outputBytes: this.bytes,
    };
  }
}
