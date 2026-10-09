import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { agentsQuery, useTeamNames } from '../../api/queries';
import type { AgentSummary } from '../../api/types';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { ResponsiveList, type ListColumn } from '../../components/ResponsiveList';
import { ScopeChip, useActiveTenant } from '../../components/Tenant';
import { Badge, EmptyState, ErrorState, Loading, PageHeader, Section } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { shortId, useDocumentTitle } from '../../lib/hooks';

export function AgentsPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('agents.title'));
  const can = useCan();
  const agents = useQuery(agentsQuery);
  const teamNames = useTeamNames();
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const items = agents.data?.items ?? [];
    return needle
      ? items.filter((a) => `${a.name} ${a.description ?? ''}`.toLowerCase().includes(needle))
      : items;
  }, [agents.data, q]);

  const tenant = useActiveTenant();
  const teamLabel = (a: AgentSummary): string =>
    a.teamId
      ? (teamNames.get(a.teamId) ?? t('tenancy.teamFallback', { id: shortId(a.teamId) }))
      : t('common.global');

  const columns: ListColumn<AgentSummary>[] = [
    {
      key: 'name',
      header: t('agents.name'),
      cell: (a) => (
        <Link to="/agents/$agentId" params={{ agentId: a.id }} search={{}} className="strong">
          {a.name}
        </Link>
      ),
      mobileLine: 1,
    },
    {
      key: 'desc',
      header: t('agents.description'),
      cell: (a) => <span className="truncate">{a.description ?? '–'}</span>,
    },
    {
      key: 'version',
      header: t('agents.latestVersion'),
      cell: (a) =>
        a.latestVersion ? (
          <Badge tone="success">
            <span className="sr-only">{t('tenancy.status.published')} </span>v{a.latestVersion}
          </Badge>
        ) : (
          <Badge>{t('agents.draftOnly')}</Badge>
        ),
      mobileLine: 1,
    },
    {
      key: 'tenant',
      header: t('tenancy.tenant'),
      cell: () => (tenant ? <ScopeChip tenant={tenant} compact /> : null),
      mobileOnly: true,
      mobileLine: 3,
    },
    {
      key: 'team',
      header: t('tenancy.ownerTeam'),
      cell: teamLabel,
      mobileLine: 3,
    },
    {
      key: 'updated',
      header: t('agents.draftUpdated'),
      cell: (a) => fmt.relative(a.draftUpdatedAt),
      mobileLine: 3,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t('agents.title')}
        description={t('agents.subtitle')}
        scope
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
          <ResponsiveList
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
