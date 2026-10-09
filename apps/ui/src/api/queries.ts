import { infiniteQueryOptions, queryOptions, useQuery } from '@tanstack/react-query';
import { api, call } from './client';
import type { CostGroupBy, RunStatus } from './types';

const PAGE = 50;

export const agentsQuery = queryOptions({
  queryKey: ['agents'],
  queryFn: () => call(api.GET('/v1/agents', { params: { query: { limit: 200 } } })),
});

export type AgentStatus = 'draft' | 'published' | 'changed';

export interface AgentFilters {
  q?: string | undefined;
  status?: AgentStatus | undefined;
  teamId?: string | undefined;
  useCase?: string | undefined;
}

/** Filtered agent list with keyset paging (`nextCursor`); filters are applied by the API. */
export const agentsListQuery = (filters: AgentFilters) =>
  infiniteQueryOptions({
    queryKey: ['agents', 'list', filters],
    queryFn: ({ pageParam, signal }) =>
      call(
        api.GET('/v1/agents', {
          params: { query: { limit: PAGE, cursor: pageParam, ...clean(filters) } },
          signal,
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const agentQuery = (id: string) =>
  queryOptions({
    queryKey: ['agents', id],
    queryFn: () => call(api.GET('/v1/agents/{id}', { params: { path: { id } } })),
  });

export const agentVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: ['agents', id, 'versions'],
    queryFn: () => call(api.GET('/v1/agents/{id}/versions', { params: { path: { id } } })),
  });

export const agentVersionQuery = (id: string, version: string) =>
  queryOptions({
    queryKey: ['agents', id, 'versions', version],
    queryFn: () =>
      call(api.GET('/v1/agents/{id}/versions/{version}', { params: { path: { id, version } } })),
    // Published versions are immutable.
    staleTime: Infinity,
  });

export interface RunFilters {
  status?: RunStatus | undefined;
  agentId?: string | undefined;
  teamId?: string | undefined;
}

export const runsQuery = (filters: RunFilters) =>
  infiniteQueryOptions({
    queryKey: ['runs', 'list', filters],
    queryFn: ({ pageParam, signal }) =>
      call(
        api.GET('/v1/runs', {
          params: { query: { limit: PAGE, cursor: pageParam, ...clean(filters) } },
          signal,
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const runQuery = (id: string) =>
  queryOptions({
    queryKey: ['runs', id],
    queryFn: () => call(api.GET('/v1/runs/{id}', { params: { path: { id } } })),
  });

export const runStepsQuery = (id: string) =>
  queryOptions({
    queryKey: ['runs', id, 'steps'],
    queryFn: () =>
      call(api.GET('/v1/runs/{id}/steps', { params: { path: { id }, query: { limit: 200 } } })),
  });

export const approvalsQuery = (
  status: 'pending' | 'approved' | 'rejected' | 'timeout' = 'pending',
) =>
  queryOptions({
    queryKey: ['approvals', status],
    queryFn: () => call(api.GET('/v1/approvals', { params: { query: { status, limit: 100 } } })),
    refetchInterval: 15_000,
  });

export const eventSourcesQuery = queryOptions({
  queryKey: ['event-sources'],
  queryFn: () => call(api.GET('/v1/event-sources')),
});

export const eventsQuery = (sourceId?: string) =>
  infiniteQueryOptions({
    queryKey: ['events', sourceId ?? null],
    queryFn: ({ pageParam, signal }) =>
      call(
        api.GET('/v1/events', {
          params: { query: { limit: PAGE, cursor: pageParam, ...(sourceId ? { sourceId } : {}) } },
          signal,
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const costsQuery = (groupBy: CostGroupBy, from?: string, to?: string) =>
  queryOptions({
    queryKey: ['costs', groupBy, from ?? null, to ?? null],
    queryFn: () =>
      call(
        api.GET('/v1/costs/summary', {
          params: { query: { groupBy, limit: 200, ...clean({ from, to }) } },
        }),
      ),
  });

export const budgetsQuery = queryOptions({
  queryKey: ['budgets'],
  queryFn: () => call(api.GET('/v1/budgets')),
});

export const connectionsQuery = queryOptions({
  queryKey: ['connections'],
  queryFn: () => call(api.GET('/v1/connections')),
});

export const policiesQuery = queryOptions({
  queryKey: ['policies'],
  queryFn: () => call(api.GET('/v1/policies')),
});

export interface AuditFilters {
  runId?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export const auditQuery = (filters: AuditFilters) =>
  infiniteQueryOptions({
    queryKey: ['audit', filters],
    queryFn: ({ pageParam, signal }) =>
      call(
        api.GET('/v1/audit', {
          params: { query: { limit: PAGE, cursor: pageParam, ...clean(filters) } },
          signal,
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const checkpointsQuery = queryOptions({
  queryKey: ['audit', 'checkpoints'],
  queryFn: () => call(api.GET('/v1/audit/checkpoints')),
});

export const usersQuery = queryOptions({
  queryKey: ['users'],
  queryFn: () => call(api.GET('/v1/users')),
});

export const teamsQuery = queryOptions({
  queryKey: ['teams'],
  queryFn: () => call(api.GET('/v1/teams')),
});

export const tokensQuery = (all = false) =>
  queryOptions({
    queryKey: ['tokens', all],
    queryFn: () => call(api.GET('/v1/tokens', { params: { query: { all } } })),
  });

/** Drops undefined/empty values so they are not sent as query parameters. */
export function clean<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj) as [keyof T, T[keyof T]][]) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/** id -> name lookup for agents (runs only carry the agent id). */
export function useAgentNames(enabled = true): Map<string, string> {
  const { data } = useQuery({ ...agentsQuery, enabled });
  return new Map((data?.items ?? []).map((a) => [a.id, a.name]));
}

/** id -> name lookup for teams. */
export function useTeamNames(enabled = true): Map<string, string> {
  const { data } = useQuery({ ...teamsQuery, enabled });
  return new Map((data?.items ?? []).map((t) => [t.id, t.name]));
}
