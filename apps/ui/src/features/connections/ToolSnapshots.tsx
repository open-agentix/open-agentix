import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, call } from '../../api/client';
import type { Connection, ToolSnapshotDetail, ToolSnapshotSummary } from '../../api/types';
import { useCan } from '../../auth/auth';
import { useToast } from '../../components/toast';
import {
  Badge,
  Button,
  Code,
  Dialog,
  EmptyState,
  ErrorState,
  Loading,
  SelectField,
  errorMessage,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { diffTools, hasInvisible, visibleText, type ToolChange } from './toolDiff';

const listKey = (id: string) => ['connection-tools', id] as const;
const detailKey = (id: string, digest: string) => ['connection-tools', id, digest] as const;

const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'neutral' } as const;

/** Text from a server, shown as data: invisible characters are made visible and flagged. */
function Untrusted({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <>
      {hasInvisible(text) ? <Badge tone="danger">{t('connections.tools.invisible')}</Badge> : null}
      <pre className="code-block" tabIndex={0}>
        {visibleText(text)}
      </pre>
    </>
  );
}

function ChangeList({ changes }: { changes: ToolChange[] }) {
  const { t } = useI18n();
  if (changes.length === 0) return <p className="muted">{t('connections.tools.noChanges')}</p>;
  return (
    <ul className="stack">
      {changes.map((c) => (
        <li key={c.name} className="card">
          <p>
            <Code>{visibleText(c.name)}</Code>{' '}
            <Badge tone={c.kind === 'removed' ? 'danger' : c.kind === 'added' ? 'warning' : 'info'}>
              {t(`connections.tools.change.${c.kind}`)}
            </Badge>
          </p>
          {c.fields.map((f) => (
            <div key={f.field}>
              <p className="strong">{t(`connections.tools.field.${f.field}`)}</p>
              {f.before !== null ? (
                <div>
                  <span className="muted">{t('connections.tools.before')}</span>
                  <Untrusted text={f.before} />
                </div>
              ) : null}
              {f.after !== null ? (
                <div>
                  <span className="muted">{t('connections.tools.after')}</span>
                  <Untrusted text={f.after} />
                </div>
              ) : null}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

function SnapshotDetail({ connection, digest }: { connection: Connection; digest: string }) {
  const { t } = useI18n();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<'new-versions' | 'existing-versions'>('new-versions');
  const [error, setError] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: detailKey(connection.id, digest),
    queryFn: () =>
      call(
        api.GET('/v1/connections/{id}/tool-snapshots/{digest}', {
          params: { path: { id: connection.id, digest } },
        }),
      ),
  });
  const done = async (message: string) => {
    await queryClient.invalidateQueries({ queryKey: ['connection-tools', connection.id] });
    toast.success(message);
    setError(null);
  };
  const approve = useMutation({
    mutationFn: () =>
      call(
        api.POST('/v1/connections/{id}/tool-snapshots/{digest}/approve', {
          params: { path: { id: connection.id, digest } },
          body: { scope },
        }),
      ),
    onSuccess: () => done(t('connections.tools.approved')),
    onError: (e) => setError(errorMessage(e)),
  });
  const reject = useMutation({
    mutationFn: () =>
      call(
        api.POST('/v1/connections/{id}/tool-snapshots/{digest}/reject', {
          params: { path: { id: connection.id, digest } },
        }),
      ),
    onSuccess: () => done(t('connections.tools.rejected')),
    onError: (e) => setError(errorMessage(e)),
  });
  if (detail.isPending) return <Loading />;
  if (detail.isError)
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  const d: ToolSnapshotDetail = detail.data;
  const changes = d.base ? diffTools(d.base.tools, d.tools) : null;
  return (
    <div className="stack">
      <p className="muted">
        {d.base
          ? t('connections.tools.diffTitle', { base: d.base.digest.slice(0, 12) })
          : t('connections.tools.noBase')}
      </p>
      {changes ? <ChangeList changes={changes} /> : <ChangeList changes={diffTools([], d.tools)} />}
      {d.pinnedBy.length > 0 ? (
        <div>
          <p className="strong">{t('connections.tools.pinnedBy')}</p>
          <ul>
            {d.pinnedBy.map((p) => (
              <li key={`${p.agentId}-${p.version}`}>
                {p.agent} <Code>{p.version}</Code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.status === 'pending' && can('connections:write') ? (
        <div className="stack">
          <SelectField
            label={t('connections.tools.scope')}
            hint={t('connections.tools.scopeHint')}
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="new-versions">{t('connections.tools.scopes.new-versions')}</option>
            <option value="existing-versions">
              {t('connections.tools.scopes.existing-versions')}
            </option>
          </SelectField>
          {error ? (
            <p role="alert" className="field-error">
              {error}
            </p>
          ) : null}
          <div className="actions">
            <Button variant="ghost" loading={reject.isPending} onClick={() => reject.mutate()}>
              {t('connections.tools.reject')}
            </Button>
            <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>
              {t('connections.tools.approve')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The "Tools" view of an HTTP MCP connection: snapshots, diff to the approved one, review. */
export function ToolsDialog({
  connection,
  onClose,
}: {
  connection: Connection | null;
  onClose: () => void;
}) {
  const { t, fmt } = useI18n();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const id = connection?.id ?? '';
  const list = useQuery({
    queryKey: listKey(id),
    enabled: !!connection,
    queryFn: () =>
      call(api.GET('/v1/connections/{id}/tool-snapshots', { params: { path: { id } } })),
  });
  const refresh = useMutation({
    mutationFn: () =>
      call(api.POST('/v1/connections/{id}/tools/refresh', { params: { path: { id } } })),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: listKey(id) });
      if (r.ok && r.snapshot) {
        setSelected(r.snapshot.digest);
        toast.success(
          t(r.created ? 'connections.tools.fetchedNew' : 'connections.tools.fetchedSame'),
        );
      } else toast.error(t('connections.tools.fetchFailed', { category: r.category }));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const items: ToolSnapshotSummary[] = list.data?.items ?? [];
  const shown = selected ?? items.find((s) => s.status === 'pending')?.digest ?? items[0]?.digest;
  return (
    <Dialog
      open={!!connection}
      onClose={onClose}
      wide
      title={t('connections.tools.title', { name: connection?.name ?? '' })}
      footer={
        <>
          {can('connections:write') ? (
            <Button icon="refresh" loading={refresh.isPending} onClick={() => refresh.mutate()}>
              {t('connections.tools.refresh')}
            </Button>
          ) : null}
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted">{t('connections.tools.intro')}</p>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon="info" title={t('connections.tools.empty')}>
            {t('connections.tools.emptyText')}
          </EmptyState>
        ) : (
          <table className="table">
            <caption className="sr-only">{t('connections.tools.snapshots')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('connections.tools.digest')}</th>
                <th scope="col">{t('connections.tools.status')}</th>
                <th scope="col">{t('connections.tools.count')}</th>
                <th scope="col">{t('connections.tools.pinned')}</th>
                <th scope="col">
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.digest} aria-selected={s.digest === shown}>
                  <td className="mono">{s.digest.slice(0, 12)}</td>
                  <td>
                    <Badge tone={STATUS_TONE[s.status]}>
                      {t(`connections.tools.statuses.${s.status}`)}
                    </Badge>{' '}
                    {s.current ? (
                      <Badge tone="success">{t('connections.tools.current')}</Badge>
                    ) : null}{' '}
                    {s.source === 'run' ? (
                      <Badge tone="danger">{t('connections.tools.fromRun')}</Badge>
                    ) : null}
                    <span className="muted"> {fmt.relative(s.fetchedAt)}</span>
                  </td>
                  <td>{s.toolCount}</td>
                  <td>{s.pinnedVersions}</td>
                  <td>
                    <Button size="sm" onClick={() => setSelected(s.digest)}>
                      {t('connections.tools.review')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {connection && shown ? (
          <SnapshotDetail key={shown} connection={connection} digest={shown} />
        ) : null}
      </div>
    </Dialog>
  );
}
