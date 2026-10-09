import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, call } from '../../api/client';
import {
  agentsQuery,
  agentVersionQuery,
  eventSourcesQuery,
  eventsQuery,
  useAgentNames,
} from '../../api/queries';
import type { EventSource, EventSourceInput, IngestedEvent } from '../../api/types';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toast';
import { ResponsiveList, type ListColumn } from '../../components/ResponsiveList';
import {
  Badge,
  Button,
  Code,
  CopyButton,
  Dialog,
  EmptyState,
  ErrorState,
  JsonBlock,
  Loading,
  PageHeader,
  Section,
  SelectField,
  TextField,
  errorMessage,
} from '../../components/ui';
import { useI18n, useT } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import { redact } from '../../lib/redact';
import { readDefinition } from '../agents/definition';
import { describeCron } from './cron';

export function EventsPage() {
  const { t } = useI18n();
  useDocumentTitle(t('events.title'));
  const can = useCan();
  const sources = useQuery(eventSourcesQuery);
  const [creating, setCreating] = useState(false);
  const items = sources.data?.items ?? [];
  const inbound = items.filter((s) => s.kind !== 'kafka');
  const kafka = items.filter((s) => s.kind === 'kafka');
  return (
    <div className="page">
      <PageHeader
        title={t('events.title')}
        description={t('events.subtitle')}
        scope
        actions={
          can('sources:write') ? (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              {t('events.new')}
            </Button>
          ) : null
        }
      />
      {sources.isPending ? (
        <Loading />
      ) : sources.isError ? (
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      ) : (
        <>
          <Section title={t('events.inbound')}>
            {inbound.length ? (
              <ul className="cards">
                {inbound.map((s) => (
                  <SourceCard key={s.id} source={s} />
                ))}
              </ul>
            ) : (
              <EmptyState icon="events" title={t('events.noInbound')}>
                {t('events.noInboundText')}
              </EmptyState>
            )}
            <details className="help">
              <summary>{t('events.howToSign')}</summary>
              <p>{t('events.signText')}</p>
              <pre className="code-block" tabIndex={0}>{`BODY='{"hello":"world"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)
curl -X POST "$INGEST_URL" -H 'content-type: application/json' \\
  -H "x-oax-signature: sha256=$SIG" -d "$BODY"`}</pre>
            </details>
          </Section>
          <Section title={t('events.kafka')}>
            {kafka.length ? (
              <ul className="cards">
                {kafka.map((s) => (
                  <SourceCard key={s.id} source={s} />
                ))}
              </ul>
            ) : (
              <EmptyState icon="model" title={t('events.noKafka')}>
                {t('events.noKafkaText')}
              </EmptyState>
            )}
          </Section>
        </>
      )}
      {can('agents:read') ? <CronSection /> : null}
      {can('events:read') ? <RecentEvents /> : null}
      <CreateSourceDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function SourceCard({ source }: { source: EventSource }) {
  const { t } = useI18n();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const agentNames = useAgentNames(can('agents:read'));
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      call(
        api.PATCH('/v1/event-sources/{id}', {
          params: { path: { id: source.id } },
          body: { enabled },
        }),
      ),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: eventSourcesQuery.queryKey });
      const previous = queryClient.getQueryData(eventSourcesQuery.queryKey);
      queryClient.setQueryData(eventSourcesQuery.queryKey, (old) =>
        old ? { items: old.items.map((s) => (s.id === source.id ? { ...s, enabled } : s)) } : old,
      );
      return { previous };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(eventSourcesQuery.queryKey, ctx.previous);
      toast.error(errorMessage(e));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: eventSourcesQuery.queryKey }),
  });
  const topic = typeof source.config.topic === 'string' ? source.config.topic : null;
  return (
    <li className="source-card">
      <div className="source-head">
        <span className="strong">{source.name}</span>
        <Badge tone="accent">{t(`events.kinds.${source.kind}`)}</Badge>
        <Badge tone={source.enabled ? 'success' : 'neutral'}>
          {source.enabled ? t('common.enabled') : t('common.disabled')}
        </Badge>
      </div>
      {source.ingestUrl ? (
        <p className="copy-row">
          <span className="muted">{t('events.ingestUrl')}</span>
          <Code>{source.ingestUrl}</Code>
          <CopyButton value={source.ingestUrl} label={t('events.copyUrl')} />
        </p>
      ) : null}
      {topic ? (
        <p className="copy-row">
          <span className="muted">{t('events.topic')}</span>
          <Code>{topic}</Code>
        </p>
      ) : null}
      <p className="copy-row">
        <Icon name="lock" size={14} />
        <span className="muted">{t('events.secretRefs')}</span>
        {source.secretRefs.length ? (
          source.secretRefs.map((r) => <Code key={r}>{r}</Code>)
        ) : (
          <span>{t('events.noSecret')}</span>
        )}
        <span className="muted">· {t('events.scheme', { scheme: source.scheme })}</span>
      </p>
      <p className="muted">
        {t('events.routesTo')}{' '}
        {source.agentId ? (
          <Link to="/agents/$agentId" params={{ agentId: source.agentId }} search={{}}>
            {agentNames.get(source.agentId) ?? source.agentId.slice(0, 8)}
          </Link>
        ) : (
          t('events.matchingTriggers')
        )}
      </p>
      {can('sources:write') ? (
        <label className="check">
          <input
            type="checkbox"
            checked={source.enabled}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
          <span>{t('events.enabledToggle', { name: source.name })}</span>
        </label>
      ) : null}
    </li>
  );
}

function CronSection() {
  const { t } = useI18n();
  const agents = useQuery(agentsQuery);
  const published = (agents.data?.items ?? []).filter((a) => a.latestVersion).slice(0, 50);
  const versions = useQueries({
    queries: published.map((a) => agentVersionQuery(a.id, a.latestVersion ?? '')),
  });
  const schedules = published.flatMap((a, i) => {
    const def = versions[i]?.data ? readDefinition(versions[i].data.definition) : null;
    return (def?.triggers ?? [])
      .filter((tr) => tr.type === 'cron')
      .map((tr) => ({ agent: a, schedule: tr.detail }));
  });
  const loading = agents.isPending || versions.some((v) => v.isPending);
  return (
    <Section title={t('events.cron')}>
      <p className="muted">{t('events.cronText')}</p>
      {loading ? (
        <Loading />
      ) : schedules.length ? (
        <ul className="list">
          {schedules.map((s, i) => (
            <li key={i} className="list-row">
              <Icon name="clock" size={16} />
              <span className="list-main">
                <span className="strong">{describeCron(s.schedule, t)}</span>{' '}
                <Code>{s.schedule}</Code>
              </span>
              <Link to="/agents/$agentId" params={{ agentId: s.agent.id }} search={{}}>
                {s.agent.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="clock" title={t('events.noCron')} />
      )}
    </Section>
  );
}

function RecentEvents() {
  const { t, fmt } = useI18n();
  const events = useInfiniteQuery(eventsQuery());
  const [selected, setSelected] = useState<IngestedEvent | null>(null);
  const rows = events.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: ListColumn<IngestedEvent>[] = [
    {
      key: 'type',
      header: t('events.type'),
      cell: (e) => (
        <button type="button" className="link-btn mono" onClick={() => setSelected(e)}>
          {e.type}
        </button>
      ),
      mobileLine: 1,
    },
    { key: 'subject', header: t('events.subject'), cell: (e) => e.subject ?? '–', mobileLine: 2 },
    {
      key: 'received',
      header: t('events.received'),
      cell: (e) => fmt.relative(e.receivedAt),
      mobileLine: 3,
    },
  ];
  return (
    <Section title={t('events.recent')}>
      {events.isPending ? (
        <Loading />
      ) : events.isError ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} />
      ) : rows.length ? (
        <ResponsiveList
          caption={t('events.recent')}
          columns={columns}
          rows={rows}
          rowKey={(e) => e.id}
          maxHeight={420}
          hasMore={!!events.hasNextPage}
          loadingMore={events.isFetchingNextPage}
          onEndReached={() => void events.fetchNextPage()}
        />
      ) : (
        <EmptyState icon="events" title={t('events.noEvents')}>
          {t('events.noEventsText')}
        </EmptyState>
      )}
      <Dialog open={!!selected} onClose={() => setSelected(null)} title={selected?.type ?? ''} wide>
        {selected ? (
          <>
            <p className="muted">
              {selected.cloudEventId} · {fmt.dateTime(selected.receivedAt)}
            </p>
            <JsonBlock value={redact(selected.payload)} label={t('events.payload')} />
          </>
        ) : null}
      </Dialog>
    </Section>
  );
}

function CreateSourceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const agents = useQuery(agentsQuery);
  const [form, setForm] = useState({
    name: '',
    kind: 'webhook' as EventSourceInput['kind'],
    scheme: 'oax-v1' as NonNullable<EventSourceInput['scheme']>,
    secretRef: '',
    agentId: '',
    topic: '',
  });
  const create = useMutation({
    mutationFn: () => {
      const body: EventSourceInput = {
        name: form.name.trim(),
        kind: form.kind,
        scheme: form.scheme,
        secretRefs: form.secretRef.trim() ? [form.secretRef.trim()] : [],
        agentId: form.agentId || null,
        enabled: true,
        ...(form.kind === 'kafka' ? { config: { topic: form.topic.trim() } } : {}),
      };
      return call(api.POST('/v1/event-sources', { body }));
    },
    onSuccess: async (s) => {
      await queryClient.invalidateQueries({ queryKey: eventSourcesQuery.queryKey });
      toast.success(t('events.created', { name: s.name }));
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('events.new')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!form.name.trim()}
            onClick={() => create.mutate()}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label={t('events.form.name')}
          required
          hint={t('events.form.nameHint')}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <SelectField
          label={t('events.form.kind')}
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value as EventSourceInput['kind'] })}
        >
          {(['webhook', 'mail', 'kafka'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`events.kinds.${k}`)}
            </option>
          ))}
        </SelectField>
        {form.kind === 'kafka' ? (
          <TextField
            label={t('events.topic')}
            value={form.topic}
            onChange={(e) => setForm({ ...form, topic: e.target.value })}
          />
        ) : (
          <SelectField
            label={t('events.form.scheme')}
            value={form.scheme}
            onChange={(e) => setForm({ ...form, scheme: e.target.value as typeof form.scheme })}
          >
            <option value="oax-v1">oax-v1 (HMAC-SHA256)</option>
            <option value="github">GitHub (X-Hub-Signature-256)</option>
          </SelectField>
        )}
        <TextField
          label={t('events.form.secretRef')}
          hint={t('events.form.secretRefHint')}
          className="input mono"
          value={form.secretRef}
          onChange={(e) => setForm({ ...form, secretRef: e.target.value })}
        />
        <SelectField
          label={t('events.form.agent')}
          value={form.agentId}
          onChange={(e) => setForm({ ...form, agentId: e.target.value })}
        >
          <option value="">{t('events.matchingTriggers')}</option>
          {(agents.data?.items ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
        {create.isError ? (
          <p className="error-text" role="alert">
            {errorMessage(create.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
