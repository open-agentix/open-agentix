import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useState } from 'react';
import { costsQuery, teamsQuery, useAgentNames, useTeamNames } from '../../api/queries';
import type { CostGroupBy, CostRow } from '../../api/types';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { ResponsiveList, type ListColumn } from '../../components/ResponsiveList';
import {
  Badge,
  EmptyState,
  ErrorState,
  Loading,
  Meter,
  PageHeader,
  Section,
  SelectField,
  Stat,
  TabPanel,
  Tabs,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { localDate, monthStartDate, shortId, useDocumentTitle } from '../../lib/hooks';
import { BudgetsSection } from './BudgetsSection';

const route = getRouteApi('/_app/costs');
const GROUPS: CostGroupBy[] = ['agent', 'team', 'month', 'model', 'provider', 'run'];
type Period = 'month' | '30d' | 'all';

export function periodStart(period: Period, now = new Date()): string | undefined {
  if (period === 'month') return monthStartDate(now);
  if (period === '30d') return localDate(new Date(now.getTime() - 30 * 86_400_000));
  return undefined;
}

export function budgetAlert(
  spent: number,
  budget: number | null,
): 'ok' | 'warning' | 'exceeded' | 'none' {
  if (!budget) return 'none';
  const ratio = spent / budget;
  return ratio >= 1 ? 'exceeded' : ratio >= 0.8 ? 'warning' : 'ok';
}

export function CostsPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('costs.title'));
  const can = useCan();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const groupBy = search.groupBy ?? 'agent';
  const [period, setPeriod] = useState<Period>('month');
  const from = periodStart(period);
  const costs = useQuery(costsQuery(groupBy, from));
  const agentNames = useAgentNames(can('agents:read'));
  const teamNames = useTeamNames();
  const label = (row: CostRow) => {
    if (row.key === null) return t('costs.unassigned');
    if (groupBy === 'agent') return agentNames.get(row.key) ?? shortId(row.key);
    if (groupBy === 'team') return teamNames.get(row.key) ?? shortId(row.key);
    if (groupBy === 'run') return `#${shortId(row.key)}`;
    return row.key;
  };
  const items = [...(costs.data?.items ?? [])].sort((a, b) => b.costUsd - a.costUsd);
  const total = items.reduce((s, r) => s + r.costUsd, 0);
  const tokens = items.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0);
  const max = items[0]?.costUsd ?? 0;
  const costColumns: ListColumn<CostRow>[] = [
    {
      key: 'group',
      header: t(`costs.groups.${groupBy}`),
      cell: (r) => label(r),
      mobileLine: 1,
    },
    {
      key: 'cost',
      header: t('costs.cost'),
      cell: (r) => <span className="strong">{fmt.usd(r.costUsd)}</span>,
      className: 'num',
      mobileLine: 1,
    },
    {
      key: 'in',
      header: t('costs.tokensIn'),
      cell: (r) => fmt.number(r.tokensIn),
      className: 'num',
      mobileLine: 2,
    },
    {
      key: 'out',
      header: t('costs.tokensOut'),
      cell: (r) => fmt.number(r.tokensOut),
      className: 'num',
      mobileLine: 2,
    },
    {
      key: 'share',
      header: <span className="sr-only">{t('costs.share')}</span>,
      cell: (r) => (
        <span className="bar-cell" aria-hidden="true">
          <span
            className="bar"
            style={{ width: `${max ? Math.max(2, (r.costUsd / max) * 100) : 0}%` }}
          />
        </span>
      ),
      decorative: true,
      className: 'bar-col',
      mobileLine: 3,
    },
  ];
  return (
    <div className="page">
      <PageHeader
        title={t('costs.title')}
        description={t('costs.subtitle')}
        scope
        actions={
          <SelectField
            label={t('costs.period')}
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
          >
            <option value="month">{t('costs.periods.month')}</option>
            <option value="30d">{t('costs.periods.30d')}</option>
            <option value="all">{t('costs.periods.all')}</option>
          </SelectField>
        }
      />
      <div className="stats">
        <Stat label={t('costs.total')} value={costs.data ? fmt.usd(total) : '…'} />
        <Stat label={t('costs.tokens')} value={costs.data ? fmt.number(tokens) : '…'} />
      </div>
      {can('users:read') ? <TeamBudgets /> : null}
      <BudgetsSection />
      <Tabs
        items={GROUPS.map((g) => ({ key: g, label: t(`costs.groups.${g}`) }))}
        value={groupBy}
        onChange={(g) => void navigate({ search: { groupBy: g }, replace: true })}
        label={t('costs.groupBy')}
        idPrefix="costs"
      />
      <TabPanel idPrefix="costs" active={groupBy}>
        <Section>
          {costs.isPending ? (
            <Loading />
          ) : costs.isError ? (
            <ErrorState error={costs.error} onRetry={() => void costs.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon="costs" title={t('costs.empty')}>
              {t('costs.emptyText')}
            </EmptyState>
          ) : (
            <ResponsiveList
              caption={t('costs.tableCaption', { group: t(`costs.groups.${groupBy}`) })}
              columns={costColumns}
              rows={items}
              rowKey={(r) => r.key ?? 'none'}
              maxHeight={900}
            />
          )}
        </Section>
      </TabPanel>
    </div>
  );
}

function TeamBudgets() {
  const { t, fmt } = useI18n();
  const teams = useQuery(teamsQuery);
  const spend = useQuery(costsQuery('team', monthStartDate()));
  const budgeted = (teams.data?.items ?? []).filter((tm) => tm.monthlyBudgetUsd);
  if (!budgeted.length) return null;
  const spentBy = new Map((spend.data?.items ?? []).map((r) => [r.key, r.costUsd]));
  return (
    <Section title={t('costs.budgets')}>
      <ul className="list">
        {budgeted.map((tm) => {
          const spent = spentBy.get(tm.id) ?? 0;
          const alert = budgetAlert(spent, tm.monthlyBudgetUsd);
          return (
            <li key={tm.id} className="budget-row">
              <span className="strong">{tm.name}</span>
              <Meter
                value={spent}
                max={tm.monthlyBudgetUsd ?? 0}
                label={t('costs.budgetOf', { team: tm.name })}
              />
              <span>
                {fmt.usd(spent)} / {fmt.usd(tm.monthlyBudgetUsd ?? 0)}
              </span>
              {alert === 'exceeded' ? (
                <Badge tone="danger">
                  <Icon name="alert" size={13} /> {t('costs.exceeded')}
                </Badge>
              ) : alert === 'warning' ? (
                <Badge tone="warning">
                  <Icon name="alert" size={13} /> {t('costs.nearLimit')}
                </Badge>
              ) : (
                <Badge tone="success">{t('costs.onTrack')}</Badge>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
