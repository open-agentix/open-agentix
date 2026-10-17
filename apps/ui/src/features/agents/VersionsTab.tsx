import type { UseQueryResult } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, call } from '../../api/client';
import type { AgentVersion } from '../../api/types';
import { useCan } from '../../auth/auth';
import { ConfirmTenantAction } from '../../components/ConfirmTenantAction';
import { useToast } from '../../components/toast';
import { Badge, Button, Code, EmptyState, ErrorState, Loading, Section } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { shortId } from '../../lib/hooks';
import { publishFailureText } from './publishErrors';

/** Deprecating the latest version rolls the agent back (ADR 0017 section 3.1): say so in the dialog. */
function DeprecateDialog({
  agentId,
  version,
  isLatest,
  onClose,
}: {
  agentId: string;
  version: AgentVersion | null;
  isLatest: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const deprecate = async () => {
    if (!version) return;
    const res = await call(
      api.POST('/v1/agents/{id}/versions/{version}/deprecate', {
        params: { path: { id: agentId, version: version.version } },
        body: null,
      }),
    ).catch((e: unknown) => {
      throw new Error(publishFailureText(e, t));
    });
    await queryClient.invalidateQueries({ queryKey: ['agents'] });
    toast.success(
      res.rollbackTo
        ? t('agents.versions.deprecate.doneRollback', {
            version: res.version,
            to: res.rollbackTo.version,
          })
        : t('agents.versions.deprecate.done', { version: res.version }),
    );
  };
  return (
    <ConfirmTenantAction
      open={version !== null}
      onClose={onClose}
      title={t('agents.versions.deprecate.title', { version: version?.version ?? '' })}
      confirmLabel={t('agents.versions.deprecate.confirm')}
      danger
      onConfirm={deprecate}
    >
      <p>{t('agents.versions.deprecate.text')}</p>
      {isLatest ? <p>{t('agents.versions.deprecate.rollbackText')}</p> : null}
    </ConfirmTenantAction>
  );
}

export function VersionsTab({
  agentId,
  versions,
  latestVersion,
}: {
  agentId: string;
  versions: UseQueryResult<{ items: AgentVersion[] }>;
  latestVersion: string | null;
}) {
  const { t, fmt } = useI18n();
  const can = useCan();
  const [deprecating, setDeprecating] = useState<AgentVersion | null>(null);
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
                  {v.version === latestVersion ? (
                    <span className="badge badge-success">{t('agents.versions.latest')}</span>
                  ) : null}{' '}
                  {v.deprecated ? (
                    <Badge tone="warning">{t('agents.versions.deprecated')}</Badge>
                  ) : v.reviewId ? (
                    <Badge tone="info">{t('agents.versions.approved')}</Badge>
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
                  {can('agents:publish') && !v.deprecated ? (
                    <Button variant="ghost" onClick={() => setDeprecating(v)}>
                      {t('agents.versions.deprecate.button')}
                    </Button>
                  ) : null}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      <DeprecateDialog
        agentId={agentId}
        version={deprecating}
        isLatest={deprecating?.version === latestVersion}
        onClose={() => setDeprecating(null)}
      />
    </Section>
  );
}
