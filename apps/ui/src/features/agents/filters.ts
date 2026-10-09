import type { AgentFilters } from '../../api/queries';

export const AGENT_STATUSES = ['draft', 'published', 'changed', 'disabled'] as const;
export const AGENT_GROUPS = ['useCase', 'ownerTeam'] as const;
export type AgentGroupBy = (typeof AGENT_GROUPS)[number];

/** Search params of `/agents`: the API filters plus the purely client-side group-by. */
export interface AgentsSearch extends AgentFilters {
  groupBy?: AgentGroupBy | undefined;
}
