import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { agentsListQuery, teamsQuery } from '../../api/queries';
import type { AgentSummary } from '../../api/types';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { ResponsiveList, type ListColumn, type RowGroup } from '../../components/ResponsiveList';
import { ListSkeleton } from '../../components/Skeleton';
import { ScopeChip, useActiveTenant } from '../../components/Tenant';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Section,
  SelectField,
  StatusBadge,
  TextField,
  type Tone,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useDebounced, useDocumentTitle } from '../../lib/hooks';
import { AGENT_GROUPS, AGENT_STATUSES, type AgentGroupBy } from './filters';

const route = getRouteApi('/_app/agents');

const STATUS_TONE: Record<AgentSummary['status'], Tone> = {
  draft: 'neutral',
  published: 'success',
  changed: 'warning',
};
const STATUS_ICON = { draft: 'edit', published: 'check', changed: 'refresh' } as const;
const BUDGET_WARN_PERCENT = 80;
const CHANGED_STALE_MS = 7 * 86_400_000;

/** Why a row needs attention (section 5.1 of the UX design); empty when it does not. */
export type AttentionReason = 'lastRun' | 'budget' | 'changed';
export function attentionReasons(a: AgentSummary, now = Date.now()): AttentionReason[] {
  const out: AttentionReason[] = [];
  if (a.lastRun?.status === 'failed' || a.lastRun?.status === 'blocked_by_policy')
    out.push('lastRun');
  if (a.budget && a.budget.percentUsed >= BUDGET_WARN_PERCENT) out.push('budget');
  if (a.status === 'changed' && now - Date.parse(a.draftUpdatedAt) > CHANGED_STALE_MS)
    out.push('changed');
  return out;
}

export function AgentsPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('agents.title'));
  const can = useCan();
  const tenant = useActiveTenant();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { groupBy, ...filters } = search;
  const agents = useInfiniteQuery({
    ...agentsListQuery(filters),
    placeholderData: keepPreviousData,
  });
  const teams = useQuery(teamsQuery);
  const rows = useMemo(() => agents.data?.pages.flatMap((p) => p.items) ?? [], [agents.data]);

  // Search text: local state for typing, debounced into the URL (replace); URL changes made by
  // back/forward flow back into the input.
  const [qInput, setQInput] = useState(search.q ?? '');
  const pushedQ = useRef(search.q ?? '');
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    if ((search.q ?? '') !== pushedQ.current) {
      pushedQ.current = search.q ?? '';
      setQInput(search.q ?? '');
    }
  }, [search.q]);
  const debouncedQ = useDebounced(qInput, 300);
  useEffect(() => {
    const value = debouncedQ.trim();
    if (value === pushedQ.current) return;
    pushedQ.current = value;
    void navigateRef.current({ search: (s) => ({ ...s, q: value || undefined }), replace: true });
  }, [debouncedQ]);

  const setFilter = (patch: Partial<typeof search>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }) });
  const filtered = Boolean(filters.q || filters.status || filters.teamId || filters.useCase);
  const clearFilters = () => {
    pushedQ.current = '';
    setQInput('');
    void navigate({ search: (s) => ({ groupBy: s.groupBy }) });
  };

  // Use case suggestions come from what is loaded, so they never name hidden values.
  const useCases = useMemo(
    () => [...new Set(rows.map((a) => a.useCase).filter((u): u is string => Boolean(u)))].sort(),
    [rows],
  );
  const teamOptions = teams.data?.items ?? [];
  const tenantName = tenant?.name ?? t('tenancy.thisTenantFallback');

  const budgetCell = (a: AgentSummary) => {
    if (!a.budget) {
      return a.monthSpendUsd !== null && a.monthSpendUsd > 0 ? (
        <span title={t('agents.monthSpend')}>{fmt.usd(a.monthSpendUsd)}</span>
      ) : (
        <span aria-label={t('agents.noBudget')}>–</span>
      );
    }
    const pct = Math.round(a.budget.percentUsed);
    const detail = t('tenancy.budgetDetail', {
      source: t(`tenancy.budgetSource.${a.budget.source}`),
      name: a.budget.sourceName,
      spent: fmt.usd(a.budget.spentUsd),
      limit: fmt.usd(a.budget.limitUsd),
    });
    const tone = pct >= 100 ? 'danger' : pct >= BUDGET_WARN_PERCENT ? 'warning' : 'ok';
    return (
      <span className="budget-use" title={detail}>
        <progress
          className={`meter meter-${tone}`}
          max={100}
          value={Math.min(pct, 100)}
          aria-label={`${t('tenancy.budgetUsed')}: ${t('tenancy.percent', { value: pct })}. ${detail}`}
        />
        <span className="budget-pct" aria-hidden="true">
          {t('tenancy.percent', { value: pct })}
        </span>
      </span>
    );
  };

  const columns: ListColumn<AgentSummary>[] = [
    {
      key: 'name',
      header: t('agents.nameVersion'),
      cell: (a) => (
        <span className="agent-name">
          <span>
            <Link to="/agents/$agentId" params={{ agentId: a.id }} search={{}} className="strong">
              {a.name}
            </Link>
            {a.latestVersion ? <span className="muted"> v{a.latestVersion}</span> : null}
          </span>
          {a.description ? <span className="muted truncate">{a.description}</span> : null}
        </span>
      ),
      mobileLine: 1,
    },
    {
      key: 'status',
      header: t('agents.status'),
      cell: (a) => {
        const reasons = attentionReasons(a);
        const text = reasons.map((r) => t(`agents.attention.${r}`)).join(', ');
        return (
          <span className="status-cell">
            <Badge tone={STATUS_TONE[a.status]}>
              <Icon name={STATUS_ICON[a.status]} size={13} />
              {t(`tenancy.status.${a.status}`)}
            </Badge>
            {reasons.length ? (
              <span className="attention" title={text}>
                <Icon name="alert" size={14} />
                <span className="sr-only">
                  {t('agents.needsAttention')}: {text}
                </span>
              </span>
            ) : null}
          </span>
        );
      },
      mobileLine: 1,
      decorative: true,
    },
    {
      key: 'tenant',
      header: t('tenancy.tenant'),
      cell: (a) => <ScopeChip tenant={a.tenant} path={a.tenant.slugPath} compact />,
      mobileLine: 2,
      decorative: true,
    },
    {
      key: 'useCase',
      header: t('tenancy.useCase'),
      cell: (a) => a.useCase ?? <span aria-label={t('agents.noUseCase')}>–</span>,
      mobileLine: 2,
    },
    {
      key: 'ownerTeam',
      header: t('tenancy.ownerTeam'),
      cell: (a) => a.ownerTeam?.name ?? <span aria-label={t('tenancy.teamNoValue')}>–</span>,
      mobileLine: 2,
    },
    {
      key: 'lastRun',
      header: t('agents.lastRun'),
      cell: (a) =>
        a.lastRun ? (
          <Link to="/runs/$runId" params={{ runId: a.lastRun.id }} className="last-run">
            <StatusBadge status={a.lastRun.status} />
            <time dateTime={a.lastRun.createdAt}>{fmt.relative(a.lastRun.createdAt)}</time>
          </Link>
        ) : (
          <span aria-label={t('agents.neverRun')}>–</span>
        ),
      mobileLine: 3,
    },
    {
      key: 'budget',
      header: t('tenancy.budgetUsed'),
      cell: budgetCell,
      mobileLine: 3,
      decorative: true,
    },
  ];

  const groups = useMemo((): RowGroup<AgentSummary>[] | undefined => {
    if (!groupBy) return undefined;
    const none = groupBy === 'useCase' ? t('agents.noUseCase') : t('tenancy.teamNoValue');
    const byKey = new Map<string, RowGroup<AgentSummary>>();
    for (const a of rows) {
      const label = (groupBy === 'useCase' ? a.useCase : a.ownerTeam?.name) || none;
      const key = label === none ? '' : label;
      const g = byKey.get(key) ?? { key: key || '\u0000none', label, rows: [] };
      g.rows.push(a);
      byKey.set(key, g);
    }
    return [...byKey.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([, g]) => g);
  }, [groupBy, rows, t]);

  const hasMore = Boolean(agents.hasNextPage);
  const summary = hasMore
    ? t('common.loaded', { count: rows.length })
    : t('agents.resultCount', { count: rows.length });
  const readOnly = !can('agents:write');

  const empty = filtered ? (
    <EmptyState
      icon="search"
      title={t('agents.noMatch')}
      action={
        <Button onClick={clearFilters} icon="close">
          {t('agents.clearFilters')}
        </Button>
      }
    >
      {t('agents.noMatchText')}
    </EmptyState>
  ) : readOnly ? (
    <EmptyState icon="lock" title={t('agents.noneVisible', { tenant: tenantName })}>
      {t('agents.noneVisibleText', { tenant: tenantName })}
    </EmptyState>
  ) : (
    <EmptyState
      icon="agents"
      title={t('agents.noneInTenant', { tenant: tenantName })}
      action={
        <span className="actions">
          <Link to="/wizard" className="btn btn-primary btn-md">
            {t('agents.useWizard')}
          </Link>
          <Link to="/agents/new" className="btn btn-secondary btn-md">
            {t('agents.new')}
          </Link>
        </span>
      }
    >
      {t('agents.emptyText')}
    </EmptyState>
  );

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
        <div className="toolbar filters" role="search" aria-label={t('agents.filters')}>
          <label className="search">
            <Icon name="search" size={16} />
            <span className="sr-only">{t('agents.search')}</span>
            <input
              className="input"
              type="search"
              placeholder={t('agents.search')}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </label>
          <SelectField
            label={t('agents.status')}
            value={filters.status ?? ''}
            onChange={(e) =>
              setFilter({ status: (e.target.value || undefined) as typeof filters.status })
            }
          >
            <option value="">{t('common.all')}</option>
            {AGENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`tenancy.status.${s}`)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t('tenancy.ownerTeam')}
            value={filters.teamId ?? ''}
            onChange={(e) => setFilter({ teamId: e.target.value || undefined })}
          >
            <option value="">{t('common.all')}</option>
            {filters.teamId && !teamOptions.some((x) => x.id === filters.teamId) ? (
              <option value={filters.teamId}>
                {t('tenancy.teamFallback', { id: filters.teamId.slice(0, 8) })}
              </option>
            ) : null}
            {teamOptions.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </SelectField>
          <UseCaseFilter
            value={filters.useCase ?? ''}
            options={useCases}
            onCommit={(v) => setFilter({ useCase: v || undefined })}
          />
          <SelectField
            label={t('agents.groupBy')}
            value={groupBy ?? ''}
            onChange={(e) => setFilter({ groupBy: (e.target.value || undefined) as AgentGroupBy })}
          >
            <option value="">{t('agents.groupNone')}</option>
            {AGENT_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g === 'useCase' ? t('tenancy.useCase') : t('tenancy.ownerTeam')}
              </option>
            ))}
          </SelectField>
          {filtered ? (
            <Button variant="ghost" onClick={clearFilters}>
              {t('agents.clearFilters')}
            </Button>
          ) : null}
        </div>
        <p className="sr-only" role="status">
          {agents.isSuccess ? summary : ''}
        </p>
        {agents.isPending ? (
          <ListSkeleton />
        ) : agents.isError ? (
          <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
        ) : rows.length === 0 ? (
          empty
        ) : (
          <div
            aria-busy={agents.isPlaceholderData}
            className={agents.isPlaceholderData ? 'is-stale' : undefined}
          >
            {groups && hasMore ? <p className="hint">{t('agents.groupHint')}</p> : null}
            <ResponsiveList
              caption={t('agents.title')}
              columns={columns}
              rows={rows}
              groups={groups}
              rowKey={(a) => a.id}
              rowHeight={56}
              totalLabel={summary}
              hasMore={hasMore}
              loadingMore={agents.isFetchingNextPage}
              onEndReached={() => void agents.fetchNextPage()}
            />
          </div>
        )}
      </Section>
    </div>
  );
}

/** Free-text use case filter with suggestions; commits on Enter or blur (a URL entry per change). */
function UseCaseFilter({
  value,
  options,
  onCommit,
}: {
  value: string;
  options: string[];
  onCommit: (value: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };
  return (
    <>
      <TextField
        label={t('tenancy.useCase')}
        value={draft}
        list="agents-use-cases"
        onChange={(e) => {
          setDraft(e.target.value);
          // Picking a suggestion fires `change` with an exact option: apply it right away.
          if (options.includes(e.target.value)) onCommit(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        maxLength={200}
      />
      <datalist id="agents-use-cases">
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}
