import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, call } from '../../api/client';
import { connectionsQuery } from '../../api/queries';
import type { Connection } from '../../api/types';
import { useCan } from '../../auth/auth';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toast';
import {
  Badge,
  Button,
  Code,
  Dialog,
  EmptyState,
  ErrorState,
  JsonBlock,
  Loading,
  PageHeader,
  Section,
  TextAreaField,
  TextField,
  errorMessage,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import { redact } from '../../lib/redact';
import { findInlineSecrets, secretReferences } from './secrets';

const EXAMPLE = `{
  "transport": "streamable-http",
  "url": "https://mcp.example.internal/mcp",
  "headerSecrets": { "authorization": "TICKETS_MCP_TOKEN" },
  "tools": ["get_ticket", "update_ticket"],
  "timeoutMs": 15000
}`;

export function ConnectionsPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('connections.title'));
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const connections = useQuery(connectionsQuery);
  const [editing, setEditing] = useState<Connection | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const remove = async (c: Connection) => {
    await call(api.DELETE('/v1/connections/{id}', { params: { path: { id: c.id } } }));
    await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    toast.success(t('connections.deleted', { name: c.name }));
  };
  return (
    <div className="page">
      <PageHeader
        title={t('connections.title')}
        description={t('connections.subtitle')}
        actions={
          can('connections:write') ? (
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              {t('connections.new')}
            </Button>
          ) : null
        }
      />
      <p className="notice notice-info">
        <Icon name="lock" size={16} />
        {t('connections.secretsNotice')}
      </p>
      {connections.isPending ? (
        <Loading />
      ) : connections.isError ? (
        <ErrorState error={connections.error} onRetry={() => void connections.refetch()} />
      ) : connections.data.items.length === 0 ? (
        <Section>
          <EmptyState icon="connections" title={t('connections.empty')}>
            {t('connections.emptyText')}
          </EmptyState>
        </Section>
      ) : (
        <ul className="cards cards-grid">
          {connections.data.items.map((c) => {
            const refs = secretReferences(c.config);
            return (
              <li key={c.id} className="card source-card">
                <div className="source-head">
                  <span className="strong">{c.name}</span>
                  <Badge tone="accent">{t('connections.kinds.mcp')}</Badge>
                </div>
                {typeof c.config.url === 'string' ? <Code>{c.config.url}</Code> : null}
                <p className="copy-row">
                  <Icon name="lock" size={14} />
                  <span className="muted">{t('connections.secretRefs')}</span>
                  {refs.length ? refs.map((r) => <Code key={r}>{r}</Code>) : <span>–</span>}
                </p>
                <details>
                  <summary>{t('connections.config')}</summary>
                  <JsonBlock value={redact(c.config)} />
                </details>
                <p className="muted">
                  {t('connections.updated', { when: fmt.relative(c.updatedAt) })}
                </p>
                {can('connections:write') ? (
                  <div className="actions">
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => setDeleting(c)}>
                      {t('common.delete')}
                    </Button>
                    <Button size="sm" icon="edit" onClick={() => setEditing(c)}>
                      {t('common.edit')}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <ConnectionDialog editing={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={t('connections.deleteTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('common.delete')}
        danger
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      >
        <p>{t('connections.deleteText')}</p>
      </ConfirmDialog>
    </div>
  );
}

function ConnectionDialog({
  editing,
  onClose,
}: {
  editing: Connection | 'new' | null;
  onClose: () => void;
}) {
  const t = useI18n().t;
  const toast = useToast();
  const queryClient = useQueryClient();
  const existing = editing && editing !== 'new' ? editing : null;
  const [name, setName] = useState('');
  const [config, setConfig] = useState(EXAMPLE);
  const [error, setError] = useState<string | null>(null);
  const [lastOpened, setLastOpened] = useState<typeof editing>(null);
  if (editing !== lastOpened) {
    setLastOpened(editing);
    setName(existing?.name ?? '');
    setConfig(existing ? JSON.stringify(existing.config, null, 2) : EXAMPLE);
    setError(null);
  }
  const save = useMutation({
    mutationFn: async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(config) as Record<string, unknown>;
      } catch {
        throw new Error(t('connections.invalidJson'));
      }
      const inline = findInlineSecrets(parsed);
      if (inline.length)
        throw new Error(t('connections.inlineSecret', { paths: inline.join(', ') }));
      return existing
        ? call(
            api.PUT('/v1/connections/{id}', {
              params: { path: { id: existing.id } },
              body: { config: parsed },
            }),
          )
        : call(
            api.POST('/v1/connections', {
              body: { name: name.trim(), kind: 'mcp', config: parsed },
            }),
          );
    },
    onSuccess: async (c) => {
      await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      toast.success(t('connections.saved', { name: c.name }));
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      wide
      title={existing ? t('connections.editTitle', { name: existing.name }) : t('connections.new')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!existing && !name.trim()}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!existing ? (
          <TextField
            label={t('connections.name')}
            hint={t('connections.nameHint')}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : null}
        <TextAreaField
          label={t('connections.config')}
          hint={t('connections.configHint')}
          className="input textarea mono"
          rows={12}
          spellCheck={false}
          value={config}
          onChange={(e) => setConfig(e.target.value)}
          error={error}
        />
      </div>
    </Dialog>
  );
}
