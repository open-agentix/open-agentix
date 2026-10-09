import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError, api, call } from '../../api/client';
import { approvalsQuery, runQuery, runStepsQuery, useAgentNames } from '../../api/queries';
import { isTerminal, type Run } from '../../api/types';
import { useCan } from '../../auth/auth';
import { ConfirmTenantAction } from '../../components/ConfirmTenantAction';
import { Icon } from '../../components/Icon';
import { ItemNotFound } from '../../components/ItemNotFound';
import { useToast } from '../../components/toast';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  KeyValue,
  Loading,
  PageHeader,
  Section,
  Stat,
  StatusBadge,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { shortId, useDocumentTitle } from '../../lib/hooks';
import { redact, redactString } from '../../lib/redact';
import { ApprovalCard } from './ApprovalCard';
import { StepTimeline } from './StepTimeline';
import { useRunStream, type StreamState } from './useRunStream';

const route = getRouteApi('/_app/runs/$runId');

interface RunOutput {
  agentId?: string;
  format?: string;
  content?: string;
}

export function runDurationMs(run: Run, now = Date.now()): number | null {
  if (!run.startedAt) return null;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return end - Date.parse(run.startedAt);
}

export function RunDetailPage() {
  const { t, fmt } = useI18n();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { runId } = route.useParams();
  const run = useQuery(runQuery(runId));
  const steps = useQuery(runStepsQuery(runId));
  const approvals = useQuery(approvalsQuery('pending'));
  const agentNames = useAgentNames(can('agents:read'));
  const stream = useRunStream(runId, run.data?.status);
  const [cancelling, setCancelling] = useState(false);
  useDocumentTitle(t('runs.detailTitle', { id: shortId(runId) }));
  const cancel = useMutation({
    mutationFn: () => call(api.POST('/v1/runs/{id}/cancel', { params: { path: { id: runId } } })),
    onSuccess: (r) => {
      queryClient.setQueryData(runQuery(runId).queryKey, r);
      toast.success(t('runs.cancelled'));
    },
  });

  if (run.isPending) return <Loading />;
  if (run.isError)
    return (
      <div className="page">
        {run.error instanceof ApiError && run.error.status === 404 ? (
          <ItemNotFound kind="run" />
        ) : (
          <ErrorState error={run.error} onRetry={() => void run.refetch()} />
        )}
      </div>
    );
  const r = run.data;
  const pending = (approvals.data?.items ?? []).filter((a) => a.runId === runId);
  const outputs = (Array.isArray(r.outputs) ? r.outputs : []) as RunOutput[];
  const agentName = agentNames.get(r.agentId) ?? shortId(r.agentId);
  return (
    <div className="page">
      <PageHeader
        back={
          <Link to="/runs" search={{}} className="back">
            <Icon name="chevronLeft" size={16} /> {t('runs.title')}
          </Link>
        }
        title={
          <>
            {agentName} <span className="muted mono">#{shortId(r.id)}</span>
          </>
        }
        description={
          <span className="inline-row">
            <StatusBadge status={r.status} />
            <StreamBadge state={stream} />
            <span className="muted">
              {t('runs.triggeredBy', { who: r.triggeredBy, when: fmt.relative(r.createdAt) })}
            </span>
          </span>
        }
        actions={
          can('runs:cancel') && !isTerminal(r.status) ? (
            <Button variant="danger" icon="stop" onClick={() => setCancelling(true)}>
              {t('runs.cancel')}
            </Button>
          ) : null
        }
      />
      <div className="stats">
        <Stat label={t('runs.duration')} value={fmt.duration(runDurationMs(r))} />
        <Stat
          label={t('runs.steps')}
          value={fmt.number(r.steps)}
          sub={t('runs.toolCalls', { count: r.toolCalls })}
        />
        <Stat
          label={t('runs.tokens')}
          value={fmt.number(r.tokensIn + r.tokensOut)}
          sub={t('steps.tokens', { in: fmt.number(r.tokensIn), out: fmt.number(r.tokensOut) })}
        />
        <Stat label={t('runs.cost')} value={fmt.usd(r.costUsd)} />
      </div>
      {r.errorCode || r.errorMessage ? (
        <p className="notice notice-danger" role="alert">
          <Icon name="alert" size={16} />
          <span>
            <span className="mono">{r.errorCode}</span>{' '}
            {r.errorMessage ? redactString(r.errorMessage) : ''}
          </span>
        </p>
      ) : null}
      {pending.length ? (
        <Section title={t('runs.waitingForYou')} className="card-attention">
          <ul className="cards">
            {pending.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </ul>
        </Section>
      ) : null}
      <div className="grid-main">
        <Section title={t('runs.timeline')}>
          {steps.isPending ? (
            <Loading />
          ) : steps.isError ? (
            <ErrorState error={steps.error} onRetry={() => void steps.refetch()} />
          ) : steps.data.items.length ? (
            <div aria-live="polite" aria-relevant="additions">
              <StepTimeline steps={steps.data.items} />
            </div>
          ) : (
            <EmptyState icon="clock" title={t('runs.noSteps')} />
          )}
        </Section>
        <div className="stack">
          <Section title={t('runs.details')}>
            <KeyValue
              items={[
                [
                  t('runs.agent'),
                  <Link key="a" to="/agents/$agentId" params={{ agentId: r.agentId }} search={{}}>
                    {agentName}
                  </Link>,
                ],
                [
                  t('runs.version'),
                  <span key="v" className="mono">
                    {shortId(r.agentVersionId)}
                  </span>,
                ],
                [
                  t('runs.event'),
                  r.eventId ? (
                    <span key="e" className="mono">
                      {shortId(r.eventId)}
                    </span>
                  ) : (
                    '–'
                  ),
                ],
                [t('runs.started'), fmt.dateTime(r.startedAt)],
                [t('runs.finished'), fmt.dateTime(r.finishedAt)],
                [t('runs.attempts'), fmt.number(r.attempts)],
              ]}
            />
            {can('audit:read') ? (
              <Link to="/audit" search={{ runId: r.id }} className="inline-link">
                <Icon name="audit" size={16} /> {t('runs.auditTrail')}
              </Link>
            ) : null}
          </Section>
          <Section title={t('runs.outputs')}>
            {outputs.length ? (
              outputs.map((o, i) => (
                <figure key={i} className="output">
                  <figcaption>
                    <Badge tone="accent">{o.format ?? '?'}</Badge>{' '}
                    <span className="muted">{o.agentId}</span>
                  </figcaption>
                  <pre className="code-block" tabIndex={0}>
                    {redactString(o.content ?? JSON.stringify(redact(o), null, 2))}
                  </pre>
                </figure>
              ))
            ) : (
              <p className="muted">
                {isTerminal(r.status) ? t('runs.noOutputs') : t('runs.outputsPending')}
              </p>
            )}
          </Section>
        </div>
      </div>
      <ConfirmTenantAction
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={t('runs.cancelTitle')}
        confirmLabel={t('runs.cancel')}
        danger
        onConfirm={() => cancel.mutateAsync()}
      >
        <p>{t('runs.cancelText')}</p>
      </ConfirmTenantAction>
    </div>
  );
}

function StreamBadge({ state }: { state: StreamState }) {
  const t = useI18n().t;
  if (state === 'live')
    return (
      <Badge tone="info">
        <span className="live-dot" aria-hidden="true" />
        {t('runs.stream.live')}
      </Badge>
    );
  if (state === 'reconnecting')
    return <Badge tone="warning">{t('runs.stream.reconnecting')}</Badge>;
  if (state === 'failed') return <Badge tone="danger">{t('runs.stream.failed')}</Badge>;
  return null;
}
