import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { AgentVersion } from '../../api/types';
import { Code, EmptyState, ErrorState, Loading, Section } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { shortId } from '../../lib/hooks';

export function VersionsTab({
  agentId,
  versions,
}: {
  agentId: string;
  versions: UseQueryResult<{ items: AgentVersion[] }>;
}) {
  const { t, fmt } = useI18n();
  if (versions.isPending) return <Loading />;
  if (versions.isError)
    return <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />;
  const items = [...versions.data.items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (!items.length)
    return (
      <Section>
        <EmptyState icon="file" title={t('agents.versions.empty')}>
          {t('agents.versions.emptyText')}
        </EmptyState>
      </Section>
    );
  return (
    <Section>
      <ol className="timeline">
        {items.map((v, i) => {
          const previous = items[i + 1];
          return (
            <li key={v.id} className="timeline-item">
              <div className="timeline-dot" aria-hidden="true" />
              <div className="timeline-body">
                <p>
                  <span className="strong">v{v.version}</span>{' '}
                  {i === 0 ? (
                    <span className="badge badge-success">{t('agents.versions.latest')}</span>
                  ) : null}
                </p>
                <p className="muted">
                  {t('agents.versions.publishedBy', {
                    when: fmt.dateTime(v.publishedAt),
                    who: v.publishedBy ? shortId(v.publishedBy) : t('common.system'),
                  })}
                </p>
                <p>
                  <Code>{v.digest.slice(0, 23)}…</Code>
                </p>
                <p className="link-row">
                  {previous ? (
                    <Link
                      to="/agents/$agentId"
                      params={{ agentId }}
                      search={{ tab: 'diff', from: previous.version, to: v.version }}
                    >
                      {t('agents.versions.comparePrevious', { version: previous.version })}
                    </Link>
                  ) : null}
                  <Link
                    to="/agents/$agentId"
                    params={{ agentId }}
                    search={{ tab: 'diff', from: v.version, to: 'draft' }}
                  >
                    {t('agents.versions.compareDraft')}
                  </Link>
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
