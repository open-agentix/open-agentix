import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { agentsQuery, useTeamNames } from '../../api/queries';
import type { AgentSummary } from '../../api/types';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { VirtualTable, type Column } from '../../components/VirtualTable';
import { Badge, EmptyState, ErrorState, Loading, PageHeader, Section } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';

export function AgentsPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('agents.title'));
  const can = useCan();
  const agents = useQuery(agentsQuery);
  const teamNames = useTeamNames(can('users:read'));
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const items = agents.data?.items ?? [];
    return needle
      ? items.filter((a) => `${a.name} ${a.description ?? ''}`.toLowerCase().includes(needle))
      : items;
  }, [agents.data, q]);

  const columns: Column<AgentSummary>[] = [
    {
      key: 'name',
      header: t('agents.name'),
      cell: (a) => (
        <Link to="/agents/$agentId" params={{ agentId: a.id }} search={{}} className="strong">
          {a.name}
        </Link>
      ),
    },
    {
      key: 'desc',
      header: t('agents.description'),
      cell: (a) => <span className="truncate">{a.description ?? '–'}</span>,
      className: 'hide-sm',
    },
    {
      key: 'version',
      header: t('agents.latestVersion'),
      cell: (a) =>
        a.latestVersion ? (
          <Badge tone="success">v{a.latestVersion}</Badge>
        ) : (
          <Badge>{t('agents.draftOnly')}</Badge>
        ),
    },
    {
      key: 'team',
      header: t('agents.team'),
      cell: (a) => (a.teamId ? (teamNames.get(a.teamId) ?? '–') : t('common.global')),
      className: 'hide-sm',
    },
    {
      key: 'updated',
      header: t('agents.draftUpdated'),
      cell: (a) => fmt.relative(a.draftUpdatedAt),
      className: 'hide-sm',
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t('agents.title')}
        description={t('agents.subtitle')}
        actions={
          can('agents:write') ? (
            <>
              <Link to="/wizard" className="btn btn-secondary btn-md">
                <Icon name="wizard" size={16} />
                {t('agents.useWizard')}
              </Link>
              <Link to="/agents/new" className="btn btn-primary btn-md">
                <Icon name="plus" size={16} />
                {t('agents.new')}
              </Link>
            </>
          ) : null
        }
      />
      <Section>
        <div className="toolbar">
          <label className="search">
            <Icon name="search" size={16} />
            <span className="sr-only">{t('agents.search')}</span>
            <input
              className="input"
              type="search"
              placeholder={t('agents.search')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
        </div>
        {agents.isPending ? (
          <Loading />
        ) : agents.isError ? (
          <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="agents"
            title={q ? t('common.noMatches') : t('agents.empty')}
            action={
              !q && can('agents:write') ? (
                <Link to="/wizard" className="btn btn-primary btn-md">
                  {t('agents.useWizard')}
                </Link>
              ) : undefined
            }
          >
            {q ? undefined : t('agents.emptyText')}
          </EmptyState>
        ) : (
          <VirtualTable
            caption={t('agents.title')}
            columns={columns}
            rows={rows}
            rowKey={(a) => a.id}
            totalLabel={t('common.count', { count: rows.length })}
          />
        )}
      </Section>
    </div>
  );
}
