import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useState } from 'react';
import { costsQuery, teamsQuery, useAgentNames, useTeamNames } from '../../api/queries';
import type { CostGroupBy, CostRow } from '../../api/types';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
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
import { shortId, startOfMonth, useDocumentTitle } from '../../lib/hooks';
import { BudgetsSection } from './BudgetsSection';

const route = getRouteApi('/_app/costs');
const GROUPS: CostGroupBy[] = ['agent', 'team', 'month', 'model', 'provider', 'run'];
type Period = 'month' | '30d' | 'all';

export function periodStart(period: Period, now = new Date()): string | undefined {
  if (period === 'month') return startOfMonth(now);
  if (period === '30d') return new Date(now.getTime() - 30 * 86_400_000).toISOString();
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
  const teamNames = useTeamNames(can('users:read'));
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
  return (
    <div className="page">
      <PageHeader
        title={t('costs.title')}
        description={t('costs.subtitle')}
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
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">
                  {t('costs.tableCaption', { group: t(`costs.groups.${groupBy}`) })}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t(`costs.groups.${groupBy}`)}</th>
                    <th scope="col" className="num">
                      {t('costs.tokensIn')}
                    </th>
                    <th scope="col" className="num">
                      {t('costs.tokensOut')}
                    </th>
                    <th scope="col" className="num">
                      {t('costs.cost')}
                    </th>
                    <th scope="col" className="hide-sm">
                      <span className="sr-only">{t('costs.share')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.key ?? 'none'}>
                      <td>{label(r)}</td>
                      <td className="num">{fmt.number(r.tokensIn)}</td>
                      <td className="num">{fmt.number(r.tokensOut)}</td>
                      <td className="num strong">{fmt.usd(r.costUsd)}</td>
                      <td className="hide-sm bar-cell" aria-hidden="true">
                        <span
                          className="bar"
                          style={{ width: `${max ? Math.max(2, (r.costUsd / max) * 100) : 0}%` }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </TabPanel>
    </div>
  );
}

function TeamBudgets() {
  const { t, fmt } = useI18n();
  const teams = useQuery(teamsQuery);
  const spend = useQuery(costsQuery('team', startOfMonth()));
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
