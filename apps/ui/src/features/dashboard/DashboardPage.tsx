import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, call } from '../../api/client';
import {
  approvalsQuery,
  costsQuery,
  policiesQuery,
  teamsQuery,
  useAgentNames,
} from '../../api/queries';
import type { Run } from '../../api/types';
import { meQuery, settingsQuery, useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import {
  Badge,
  EmptyState,
  ErrorState,
  Loading,
  Meter,
  PageHeader,
  Section,
  Stat,
  StatusBadge,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { shortId, startOfMonth, startOfToday, useDocumentTitle } from '../../lib/hooks';

const recentRunsQuery = queryOptions({
  queryKey: ['runs', 'recent'],
  queryFn: () => call(api.GET('/v1/runs', { params: { query: { limit: 200 } } })),
  refetchInterval: 30_000,
});

const recentAuditQuery = queryOptions({
  queryKey: ['audit', 'recent'],
  queryFn: () => call(api.GET('/v1/audit', { params: { query: { limit: 8 } } })),
});

export interface TodayStats {
  total: number;
  succeeded: number;
  failed: number;
  active: number;
  /** True when more runs exist than were loaded (count is a lower bound). */
  partial: boolean;
}

export function todayStats(runs: Run[], hasMore: boolean, since: string): TodayStats {
  const today = runs.filter((r) => r.createdAt >= since);
  return {
    total: today.length,
    succeeded: today.filter((r) => r.status === 'succeeded').length,
    failed: today.filter((r) => r.status === 'failed' || r.status === 'blocked_by_policy').length,
    active: today.filter((r) => ['queued', 'running', 'awaiting_approval'].includes(r.status))
      .length,
    partial: hasMore && today.length === runs.length,
  };
}

export function DashboardPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('dashboard.title'));
  const can = useCan();
  const { data: me } = useQuery(meQuery);
  const runs = useQuery({ ...recentRunsQuery, enabled: can('runs:read') });
  const month = startOfMonth();
  const costs = useQuery({ ...costsQuery('month', month), enabled: can('costs:read') });
  const teams = useQuery({ ...teamsQuery, enabled: can('users:read') });
  const policies = useQuery({ ...policiesQuery, enabled: can('policies:read') });
  const approvals = useQuery({ ...approvalsQuery('pending'), enabled: can('runs:read') });
  const audit = useQuery({ ...recentAuditQuery, enabled: can('audit:read') });
  const settings = useQuery(settingsQuery);
  const agentNames = useAgentNames(can('agents:read'));

  const stats = runs.data
    ? todayStats(runs.data.items, !!runs.data.nextCursor, startOfToday())
    : null;
  const spent = (costs.data?.items ?? []).reduce((sum, r) => sum + r.costUsd, 0);
  const budget = (teams.data?.items ?? []).reduce((sum, tm) => sum + (tm.monthlyBudgetUsd ?? 0), 0);
  const activePolicies = (policies.data?.items ?? []).filter((p) => p.enabled).length;
  const pending = approvals.data?.items.length ?? 0;

  return (
    <div className="page">
      <PageHeader
        title={t('dashboard.greeting', { name: me?.user.displayName ?? '' })}
        description={t('dashboard.subtitle')}
      />
      <div className="stats">
        {can('runs:read') ? (
          <>
            <Stat
              label={t('dashboard.runsToday')}
              value={stats ? `${fmt.number(stats.total)}${stats.partial ? '+' : ''}` : '…'}
              sub={stats ? t('dashboard.active', { count: stats.active }) : undefined}
            />
            <Stat
              label={t('dashboard.succeeded')}
              value={stats ? fmt.number(stats.succeeded) : '…'}
              tone="success"
            />
            <Stat
              label={t('dashboard.failed')}
              value={stats ? fmt.number(stats.failed) : '…'}
              tone={stats && stats.failed > 0 ? 'danger' : undefined}
            />
          </>
        ) : null}
        {can('costs:read') ? (
          <div className="stat">
            <p className="stat-label">{t('dashboard.costsMonth')}</p>
            <p className="stat-value">{costs.data ? fmt.usd(spent) : '…'}</p>
            {budget > 0 ? (
              <>
                <Meter value={spent} max={budget} label={t('dashboard.budgetUsage')} />
                <p className="stat-sub">{t('dashboard.ofBudget', { budget: fmt.usd(budget) })}</p>
              </>
            ) : (
              <p className="stat-sub">{t('dashboard.noBudget')}</p>
            )}
          </div>
        ) : null}
      </div>

      <div className="grid-2">
        {can('runs:read') ? (
          <Section
            title={t('dashboard.recentRuns')}
            actions={<Link to="/runs">{t('common.viewAll')}</Link>}
          >
            {runs.isPending ? (
              <Loading />
            ) : runs.isError ? (
              <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
            ) : runs.data.items.length === 0 ? (
              <EmptyState icon="runs" title={t('dashboard.noRuns')}>
                {t('dashboard.noRunsText')}
              </EmptyState>
            ) : (
              <ul className="list">
                {runs.data.items.slice(0, 8).map((r) => (
                  <li key={r.id} className="list-row">
                    <Link to="/runs/$runId" params={{ runId: r.id }} className="list-main">
                      <span className="strong">
                        {agentNames.get(r.agentId) ?? shortId(r.agentId)}
                      </span>
                      <span className="muted mono">#{shortId(r.id)}</span>
                    </Link>
                    <span className="muted">{fmt.relative(r.createdAt)}</span>
                    <StatusBadge status={r.status} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ) : null}

        <div className="stack">
          {can('runs:read') ? (
            <Section title={t('dashboard.attention')}>
              {pending > 0 ? (
                <Link to="/runs" className="attention">
                  <Icon name="hand" />
                  <span>{t('dashboard.pendingApprovals', { count: pending })}</span>
                  <Icon name="chevronRight" />
                </Link>
              ) : (
                <p className="muted">{t('dashboard.nothingPending')}</p>
              )}
              {can('policies:read') ? (
                <p className="kv-inline">
                  <Icon name="policies" size={16} />
                  {t('dashboard.activePolicies', { count: activePolicies })}
                </p>
              ) : null}
            </Section>
          ) : null}

          <Section title={t('dashboard.workers')}>
            {settings.data ? (
              <ul className="list">
                {settings.data.runners.map((r) => (
                  <li key={r.kind} className="list-row">
                    <span className="list-main mono">{r.kind}</span>
                    <Badge tone={r.available ? 'success' : 'neutral'}>
                      {r.available ? t('dashboard.available') : t('dashboard.planned')}
                    </Badge>
                  </li>
                ))}
                {settings.data.providers.map((p) => (
                  <li key={p.name} className="list-row">
                    <span className="list-main">
                      {p.name} <span className="muted mono">{p.kind}</span>
                    </span>
                    <Badge tone="info">{t('dashboard.provider')}</Badge>
                  </li>
                ))}
              </ul>
            ) : settings.isError ? (
              <ErrorState error={settings.error} />
            ) : (
              <Loading />
            )}
          </Section>
        </div>
      </div>

      {can('audit:read') ? (
        <Section
          title={t('dashboard.recentAudit')}
          actions={<Link to="/audit">{t('common.viewAll')}</Link>}
        >
          {audit.data ? (
            audit.data.items.length ? (
              <ul className="list">
                {audit.data.items.map((e) => (
                  <li key={e.seq} className="list-row">
                    <span className="list-main">
                      <span className="mono">{e.action}</span>{' '}
                      <span className="muted">{e.actor}</span>
                    </span>
                    <span className="muted">{fmt.relative(e.ts)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="audit" title={t('audit.empty')} />
            )
          ) : audit.isError ? (
            <ErrorState error={audit.error} />
          ) : (
            <Loading />
          )}
        </Section>
      ) : null}
    </div>
  );
}
