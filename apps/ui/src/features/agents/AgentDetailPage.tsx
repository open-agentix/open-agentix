import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ApiError } from '../../api/client';
import {
  agentQuery,
  agentReviewsQuery,
  agentVersionQuery,
  agentVersionsQuery,
  useTeamNames,
} from '../../api/queries';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { ItemNotFound } from '../../components/ItemNotFound';
import { Badge, ErrorState, Loading, PageHeader, TabPanel, Tabs } from '../../components/ui';
import { LifecycleBadge } from '../reviews/LifecycleBadge';
import { openReviewOf } from '../reviews/lifecycleStatus';
import { useI18n } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import type { AgentTab } from '../../router';
import { DiffTab } from './DiffTab';
import { EditorTab } from './EditorTab';
import { OverviewTab } from './OverviewTab';
import { TestRunTab } from './TestRunTab';
import { VersionsTab } from './VersionsTab';

const route = getRouteApi('/_app/agents/$agentId');

// The review tab brings its own parser and components: load them when somebody opens it.
const ReviewTab = lazy(() =>
  import('../reviews/ReviewTab').then((m) => ({ default: m.ReviewTab })),
);

export function AgentDetailPage() {
  const { t, fmt } = useI18n();
  const can = useCan();
  const { agentId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const agent = useQuery(agentQuery(agentId));
  const versions = useQuery(agentVersionsQuery(agentId));
  const latestVersion = agent.data?.latestVersion ?? null;
  const latest = useQuery({
    ...agentVersionQuery(agentId, latestVersion ?? ''),
    enabled: !!latestVersion,
  });
  const reviews = useQuery(agentReviewsQuery(agentId));
  const openReview = openReviewOf(reviews.data?.items ?? []);
  const teamNames = useTeamNames();
  useDocumentTitle(agent.data?.name ?? t('agents.title'));
  const tab: AgentTab = search.tab ?? 'overview';
  const setTab = (next: AgentTab) =>
    void navigate({ search: (s) => ({ ...s, tab: next }), replace: true });

  if (agent.isPending) return <Loading />;
  if (agent.isError)
    return (
      <div className="page">
        {agent.error instanceof ApiError && agent.error.status === 404 ? (
          <ItemNotFound kind="agent" />
        ) : (
          <ErrorState error={agent.error} onRetry={() => void agent.refetch()} />
        )}
      </div>
    );
  const a = agent.data;
  const tabs = [
    { key: 'overview' as const, label: t('agents.tabs.overview') },
    { key: 'editor' as const, label: t('agents.tabs.editor') },
    { key: 'versions' as const, label: t('agents.tabs.versions') },
    { key: 'diff' as const, label: t('agents.tabs.diff') },
    { key: 'review' as const, label: t('agents.tabs.review') },
    ...(can('runs:execute') ? [{ key: 'test' as const, label: t('agents.tabs.test') }] : []),
  ];
  return (
    <div className="page">
      <PageHeader
        back={
          <Link to="/agents" className="back">
            <Icon name="chevronLeft" size={16} /> {t('agents.title')}
          </Link>
        }
        title={
          <>
            {a.name}{' '}
            {a.latestVersion ? (
              <Badge tone="success">v{a.latestVersion}</Badge>
            ) : (
              <Badge>{t('agents.draftOnly')}</Badge>
            )}{' '}
            <LifecycleBadge agent={a} review={openReview} />
          </>
        }
        description={
          <>
            {a.description ?? t('agents.noDescription')}
            <span className="muted">
              {' · '}
              {a.teamId ? (teamNames.get(a.teamId) ?? t('agents.team')) : t('common.global')}
              {' · '}
              {t('agents.draftUpdatedAt', { when: fmt.relative(a.draftUpdatedAt) })}
            </span>
          </>
        }
      />
      <Tabs
        items={tabs}
        value={tab}
        onChange={setTab}
        label={t('agents.tabs.label')}
        idPrefix="agent"
      />
      <TabPanel idPrefix="agent" active={tab}>
        {tab === 'overview' ? (
          <OverviewTab agent={a} latest={latest.data} />
        ) : tab === 'editor' ? (
          <EditorTab agent={a} latestSource={latest.data?.source ?? null} />
        ) : tab === 'versions' ? (
          <VersionsTab agentId={agentId} versions={versions} latestVersion={latestVersion} />
        ) : tab === 'diff' ? (
          <DiffTab
            agent={a}
            versions={versions.data?.items ?? []}
            from={search.from}
            to={search.to}
            onChange={(from, to) =>
              void navigate({ search: (s) => ({ ...s, from, to }), replace: true })
            }
          />
        ) : tab === 'review' ? (
          <Suspense fallback={<Loading />}>
            <ReviewTab agent={a} />
          </Suspense>
        ) : (
          <TestRunTab agent={a} versions={versions.data?.items ?? []} latest={latest.data} />
        )}
      </TabPanel>
    </div>
  );
}
