import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { agentsQuery, approvalsQuery, runsQuery, useAgentNames } from '../../api/queries';
import { RUN_STATUSES, type Run, type RunStatus } from '../../api/types';
import { useCan } from '../../auth/auth';
import { VirtualTable, type Column } from '../../components/VirtualTable';
import {
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Section,
  SelectField,
  StatusBadge,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { shortId, useDocumentTitle } from '../../lib/hooks';
import { ApprovalCard } from './ApprovalCard';

const route = getRouteApi('/_app/runs');

export function RunsPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('runs.title'));
  const can = useCan();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const runs = useInfiniteQuery(runsQuery(search));
  const agents = useQuery({ ...agentsQuery, enabled: can('agents:read') });
  const agentNames = useAgentNames(can('agents:read'));
  const approvals = useQuery(approvalsQuery('pending'));
  const rows = runs.data?.pages.flatMap((p) => p.items) ?? [];
  const setFilter = (patch: { status?: RunStatus | undefined; agentId?: string | undefined }) =>
    void navigate({ search: (s) => ({ ...s, ...patch }), replace: true });

  const columns: Column<Run>[] = [
    {
      key: 'run',
      header: t('runs.run'),
      cell: (r) => (
        <Link to="/runs/$runId" params={{ runId: r.id }} className="mono">
          #{shortId(r.id)}
        </Link>
      ),
    },
    {
      key: 'agent',
      header: t('runs.agent'),
      cell: (r) => agentNames.get(r.agentId) ?? shortId(r.agentId),
    },
    { key: 'status', header: t('runs.status'), cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'started',
      header: t('runs.created'),
      cell: (r) => <time dateTime={r.createdAt}>{fmt.relative(r.createdAt)}</time>,
    },
    {
      key: 'steps',
      header: t('runs.steps'),
      cell: (r) => fmt.number(r.steps),
      className: 'num hide-sm',
    },
    {
      key: 'tokens',
      header: t('runs.tokens'),
      cell: (r) => fmt.number(r.tokensIn + r.tokensOut),
      className: 'num hide-sm',
    },
    { key: 'cost', header: t('runs.cost'), cell: (r) => fmt.usd(r.costUsd), className: 'num' },
  ];

  const pending = approvals.data?.items ?? [];
  return (
    <div className="page">
      <PageHeader title={t('runs.title')} description={t('runs.subtitle')} />
      {pending.length ? (
        <Section
          title={t('runs.pendingApprovals', { count: pending.length })}
          className="card-attention"
        >
          <ul className="cards">
            {pending.map((a) => (
              <ApprovalCard key={a.id} approval={a} agentName={agentNames.get(a.agentId)} showRun />
            ))}
          </ul>
        </Section>
      ) : null}
      <Section>
        <div className="toolbar">
          <SelectField
            label={t('runs.filterStatus')}
            value={search.status ?? ''}
            onChange={(e) =>
              setFilter({ status: (e.target.value || undefined) as RunStatus | undefined })
            }
          >
            <option value="">{t('common.all')}</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </SelectField>
          {agents.data ? (
            <SelectField
              label={t('runs.filterAgent')}
              value={search.agentId ?? ''}
              onChange={(e) => setFilter({ agentId: e.target.value || undefined })}
            >
              <option value="">{t('common.all')}</option>
              {agents.data.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>
        {runs.isPending ? (
          <Loading />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="runs"
            title={search.status || search.agentId ? t('common.noMatches') : t('runs.empty')}
          >
            {t('runs.emptyText')}
          </EmptyState>
        ) : (
          <VirtualTable
            caption={t('runs.title')}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            hasMore={!!runs.hasNextPage}
            loadingMore={runs.isFetchingNextPage}
            onEndReached={() => void runs.fetchNextPage()}
            totalLabel={t('common.loaded', { count: rows.length })}
          />
        )}
      </Section>
    </div>
  );
}
