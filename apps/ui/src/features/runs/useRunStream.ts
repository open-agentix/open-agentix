import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { runQuery, runStepsQuery } from '../../api/queries';
import { isTerminal, type Run, type RunStatus, type RunStep } from '../../api/types';
import { streamSse, type SseMessage } from '../../lib/sse';

export type StreamState = 'idle' | 'live' | 'reconnecting' | 'ended' | 'failed';

export function mergeSteps(existing: RunStep[], incoming: RunStep[]): RunStep[] {
  const bySeq = new Map(existing.map((s) => [s.seq, s]));
  for (const s of incoming) bySeq.set(s.seq, s);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Follows a run live over SSE (`step`, `status`, `end`) and writes into the query cache.
 * Resumes with Last-Event-ID after a dropped connection.
 */
export function useRunStream(
  runId: string,
  status: RunStatus | undefined,
  maxRetries = 5,
): StreamState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>('idle');
  const active = status !== undefined && !isTerminal(status);

  useEffect(() => {
    if (!active) {
      setState((s) => (s === 'idle' ? 'idle' : 'ended'));
      return;
    }
    const controller = new AbortController();
    const stepsKey = runStepsQuery(runId).queryKey;
    const runKey = runQuery(runId).queryKey;
    let ended = false;

    const onMessage = (m: SseMessage) => {
      if (m.event === 'step') {
        const step = JSON.parse(m.data) as RunStep;
        queryClient.setQueryData(stepsKey, (old) => ({
          items: mergeSteps(old?.items ?? [], [step]),
          nextCursor: old?.nextCursor ?? null,
        }));
      } else if (m.event === 'status') {
        const { status: next } = JSON.parse(m.data) as { status: RunStatus };
        queryClient.setQueryData<Run>(runKey, (old) => (old ? { ...old, status: next } : old));
        if (next === 'awaiting_approval')
          void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      } else if (m.event === 'end') {
        ended = true;
        queryClient.setQueryData<Run>(runKey, JSON.parse(m.data) as Run);
        void queryClient.invalidateQueries({ queryKey: ['runs', 'list'] });
        void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      }
    };

    void (async () => {
      for (let attempt = 0; attempt <= maxRetries && !controller.signal.aborted; attempt++) {
        setState(attempt === 0 ? 'live' : 'reconnecting');
        const last = queryClient.getQueryData(stepsKey)?.items.at(-1)?.seq;
        try {
          await streamSse(`/v1/runs/${runId}/stream`, onMessage, {
            signal: controller.signal,
            lastEventId: last ? String(last) : undefined,
          });
          if (ended) {
            setState('ended');
            return;
          }
        } catch (e) {
          if (controller.signal.aborted) return;
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) break;
        }
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 10_000)));
      }
      if (!controller.signal.aborted && !ended) setState('failed');
    })();

    return () => controller.abort();
  }, [runId, active, queryClient, maxRetries]);

  return state;
}
