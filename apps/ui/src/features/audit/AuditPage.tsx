import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, call } from '../../api/client';
import { auditQuery, checkpointsQuery, clean } from '../../api/queries';
import type { AuditEntry } from '../../api/types';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toast';
import { VirtualTable, type Column } from '../../components/VirtualTable';
import {
  Button,
  Code,
  Dialog,
  EmptyState,
  ErrorState,
  JsonBlock,
  KeyValue,
  Loading,
  PageHeader,
  Section,
  TextField,
  errorMessage,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { shortId, useDocumentTitle } from '../../lib/hooks';
import { redact } from '../../lib/redact';
import { downloadFile } from './download';

const route = getRouteApi('/_app/audit');

export function AuditPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('audit.title'));
  const can = useCan();
  const toast = useToast();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const entries = useInfiniteQuery(auditQuery(search));
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const [runId, setRunId] = useState(search.runId ?? '');
  const [action, setAction] = useState(search.action ?? '');
  const verify = useMutation({
    mutationFn: () => call(api.POST('/v1/audit/verify', { body: {} })),
  });
  const [exporting, setExporting] = useState(false);
  const rows = entries.data?.pages.flatMap((p) => p.items) ?? [];

  const applyFilters = (e: FormEvent) => {
    e.preventDefault();
    void navigate({
      search: { runId: runId.trim() || undefined, action: action.trim() || undefined },
    });
  };
  const exportNdjson = async () => {
    setExporting(true);
    try {
      const qs = new URLSearchParams(clean(search) as Record<string, string>).toString();
      await downloadFile(`/v1/audit/export${qs ? `?${qs}` : ''}`, 'openagentix-audit.ndjson');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const columns: Column<AuditEntry>[] = [
    {
      key: 'seq',
      header: '#',
      cell: (e) => <span className="mono">{e.seq}</span>,
      className: 'num',
    },
    {
      key: 'ts',
      header: t('audit.time'),
      cell: (e) => <time dateTime={e.ts}>{fmt.dateTime(e.ts)}</time>,
    },
    {
      key: 'action',
      header: t('audit.action'),
      cell: (e) => (
        <button type="button" className="link-btn mono" onClick={() => setSelected(e)}>
          {e.action}
        </button>
      ),
    },
    {
      key: 'actor',
      header: t('audit.actor'),
      cell: (e) => <span className="truncate">{e.actor}</span>,
    },
    {
      key: 'run',
      header: t('audit.run'),
      cell: (e) =>
        e.runId ? (
          <Link to="/runs/$runId" params={{ runId: e.runId }} className="mono">
            #{shortId(e.runId)}
          </Link>
        ) : (
          '–'
        ),
      className: 'hide-sm',
    },
    {
      key: 'hash',
      header: t('audit.hash'),
      cell: (e) => <span className="mono muted">{e.hash.slice(0, 12)}</span>,
      className: 'hide-sm',
    },
  ];

  const result = verify.data;
  return (
    <div className="page">
      <PageHeader
        title={t('audit.title')}
        description={t('audit.subtitle')}
        actions={
          <>
            {can('audit:export') ? (
              <Button icon="download" loading={exporting} onClick={exportNdjson}>
                {t('audit.export')}
              </Button>
            ) : null}
            {can('audit:verify') ? (
              <Button
                variant="primary"
                icon="shield"
                loading={verify.isPending}
                onClick={() => verify.mutate()}
              >
                {t('audit.verify')}
              </Button>
            ) : null}
          </>
        }
      />
      <div aria-live="polite">
        {verify.isError ? (
          <p className="notice notice-danger" role="alert">
            <Icon name="alert" size={16} /> {errorMessage(verify.error)}
          </p>
        ) : result ? (
          result.valid ? (
            <div className="verdict verdict-allow">
              <p className="strong">
                <Icon name="check" /> {t('audit.verifyOk')}
              </p>
              <p>
                {t('audit.verifyDetails', {
                  entries: fmt.number(result.checkedEntries),
                  checkpoints: fmt.number(result.checkedCheckpoints),
                  seq: result.headSeq,
                })}
              </p>
              <p className="mono break">{result.headHash}</p>
            </div>
          ) : (
            <div className="verdict verdict-deny" role="alert">
              <p className="strong">
                <Icon name="alert" /> {t('audit.verifyFailed', { count: result.issues.length })}
              </p>
              <ul>
                {result.issues.map((i, n) => (
                  <li key={n}>
                    #{i.seq} <Code>{i.code}</Code> {i.message}
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : null}
      </div>
      <Section>
        <form className="toolbar" onSubmit={applyFilters} role="search">
          <TextField
            label={t('audit.filterRun')}
            className="input mono"
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
          />
          <TextField
            label={t('audit.filterAction')}
            placeholder="agent.published"
            className="input mono"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
          <Button type="submit" icon="search">
            {t('common.search')}
          </Button>
        </form>
        {entries.isPending ? (
          <Loading />
        ) : entries.isError ? (
          <ErrorState error={entries.error} onRetry={() => void entries.refetch()} />
        ) : rows.length ? (
          <VirtualTable
            caption={t('audit.title')}
            columns={columns}
            rows={rows}
            rowKey={(e) => String(e.seq)}
            hasMore={!!entries.hasNextPage}
            loadingMore={entries.isFetchingNextPage}
            onEndReached={() => void entries.fetchNextPage()}
            totalLabel={t('common.loaded', { count: rows.length })}
          />
        ) : (
          <EmptyState icon="audit" title={t('audit.empty')} />
        )}
      </Section>
      <Checkpoints />
      <Dialog
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `#${selected.seq} ${selected.action}` : ''}
        wide
      >
        {selected ? (
          <div className="stack">
            <KeyValue
              items={[
                [t('audit.time'), fmt.dateTime(selected.ts)],
                [t('audit.actor'), selected.actor],
                [t('audit.target'), selected.target ?? '–'],
                [
                  t('audit.payloadDigest'),
                  <span key="d" className="mono break">
                    {selected.payloadDigest}
                  </span>,
                ],
                [
                  t('audit.prevHash'),
                  <span key="p" className="mono break">
                    {selected.prevHash}
                  </span>,
                ],
                [
                  t('audit.hash'),
                  <span key="h" className="mono break">
                    {selected.hash}
                  </span>,
                ],
              ]}
            />
            <JsonBlock value={redact(selected.payload)} label={t('audit.payload')} />
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function Checkpoints() {
  const { t, fmt } = useI18n();
  const checkpoints = useQuery(checkpointsQuery);
  if (!checkpoints.data?.items.length) return null;
  return (
    <Section title={t('audit.checkpoints')}>
      <ul className="list">
        {checkpoints.data.items.map((c) => (
          <li key={c.seq} className="list-row">
            <span className="list-main">
              #{c.seq} <span className="mono muted">{c.hash.slice(0, 16)}…</span>
            </span>
            <span className="muted">{t('audit.signedBy', { key: c.keyId })}</span>
            <span className="muted">{fmt.relative(c.ts)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
