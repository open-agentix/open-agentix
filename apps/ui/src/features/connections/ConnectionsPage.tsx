import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, call } from '../../api/client';
import { connectionsQuery } from '../../api/queries';
import type { Connection, ModelProposal } from '../../api/types';
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
  SelectField,
  TextAreaField,
  TextField,
  errorMessage,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import { redact } from '../../lib/redact';
import { findInlineSecrets, secretReferences } from './secrets';
import { ToolAccessSummary, ToolProfilesEditor } from './ToolProfiles';

const EXAMPLE = `{
  "transport": "streamable-http",
  "url": "https://mcp.example.internal/mcp",
  "headerSecrets": { "authorization": "TICKETS_MCP_TOKEN" },
  "tools": {
    "get_ticket": { "access": "read" },
    "update_ticket": { "access": "write" }
  },
  "profiles": { "read": ["get_ticket"], "write": ["update_ticket"] },
  "timeoutMs": 15000
}`;

const MODEL_PROVIDERS = [
  'anthropic',
  'bedrock',
  'openai',
  'azure-openai',
  'openrouter',
  'vllm',
  'lmstudio',
  'ollama',
  'openai-compatible',
] as const;

const MODEL_EXAMPLES: Record<(typeof MODEL_PROVIDERS)[number], Record<string, unknown>> = {
  anthropic: { kind: 'anthropic', apiKeySecret: 'ANTHROPIC_API_KEY' },
  bedrock: { kind: 'bedrock', region: 'eu-central-1' },
  openai: { kind: 'openai', apiKeySecret: 'OPENAI_API_KEY' },
  'azure-openai': {
    kind: 'azure-openai',
    endpoint: 'https://example.openai.azure.com',
    apiKeySecret: 'AZURE_OPENAI_KEY',
  },
  openrouter: { kind: 'openrouter', apiKeySecret: 'OPENROUTER_API_KEY' },
  vllm: { kind: 'vllm', baseUrl: 'http://vllm.internal:8000/v1' },
  lmstudio: { kind: 'lmstudio' },
  ollama: { kind: 'ollama', baseUrl: 'http://ollama.internal:11434' },
  'openai-compatible': { kind: 'openai-compatible', baseUrl: 'https://llm.example.internal/v1' },
};

const modelExample = (provider: (typeof MODEL_PROVIDERS)[number]) =>
  JSON.stringify(MODEL_EXAMPLES[provider], null, 2);

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
        scope
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
                  <span className="cluster">
                    {c.scope !== 'tenant' ? (
                      <Badge>{t(`connections.scopes.${c.scope}`)}</Badge>
                    ) : null}
                    <Badge tone="accent">{t(`connections.kinds.${c.kind}`)}</Badge>
                  </span>
                </div>
                {c.kind === 'model' ? <Code>{String(c.config.kind ?? '')}</Code> : null}
                {typeof c.config.url === 'string' ? <Code>{c.config.url}</Code> : null}
                {c.kind === 'model' && Array.isArray(c.config.models) && c.config.models.length ? (
                  <p className="muted">
                    {t('connections.modelsCount', { count: c.config.models.length })}
                  </p>
                ) : null}
                <p className="copy-row">
                  <Icon name="lock" size={14} />
                  <span className="muted">{t('connections.secretRefs')}</span>
                  {refs.length ? refs.map((r) => <Code key={r}>{r}</Code>) : <span>–</span>}
                </p>
                {c.kind === 'mcp' ? <ToolAccessSummary config={c.config} /> : null}
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
  const can = useCan();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'mcp' | 'model'>('mcp');
  const [provider, setProvider] = useState<(typeof MODEL_PROVIDERS)[number]>('anthropic');
  const [scope, setScope] = useState<'tenant' | 'platform'>('tenant');
  const [config, setConfig] = useState(EXAMPLE);
  const [proposals, setProposals] = useState<ModelProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOpened, setLastOpened] = useState<typeof editing>(null);
  if (editing !== lastOpened) {
    setLastOpened(editing);
    setName(existing?.name ?? '');
    setKind(existing?.kind ?? 'mcp');
    setScope('tenant');
    setProposals(null);
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
              body: { name: name.trim(), kind, scope, config: parsed },
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
  const propose = useMutation({
    mutationFn: async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(config) as Record<string, unknown>;
      } catch {
        throw new Error(t('connections.invalidJson'));
      }
      return call(
        api.POST('/v1/models/proposals', {
          body: { provider: (parsed.kind as typeof provider | undefined) ?? provider },
        }),
      );
    },
    onSuccess: (r) => {
      setProposals(r.items.slice(0, 40));
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const parsedConfig = (() => {
    try {
      const v: unknown = JSON.parse(config);
      return v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  })();
  /** Adds a catalog model to `models`; the control node fills the proposed price on save. */
  const addModel = (id: string) => {
    try {
      const parsed = JSON.parse(config) as { models?: { id: string }[] };
      const models = parsed.models ?? [];
      if (!models.some((m) => m.id === id)) models.push({ id });
      setConfig(JSON.stringify({ ...parsed, models }, null, 2));
    } catch {
      setError(t('connections.invalidJson'));
    }
  };
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
          <SelectField
            label={t('connections.kind')}
            value={kind}
            onChange={(e) => {
              const next = e.target.value as 'mcp' | 'model';
              setKind(next);
              setProposals(null);
              setConfig(next === 'mcp' ? EXAMPLE : modelExample(provider));
            }}
          >
            <option value="mcp">{t('connections.kinds.mcp')}</option>
            <option value="model">{t('connections.kinds.model')}</option>
          </SelectField>
        ) : null}
        {!existing && kind === 'model' ? (
          <SelectField
            label={t('connections.provider')}
            value={provider}
            onChange={(e) => {
              const next = e.target.value as typeof provider;
              setProvider(next);
              setProposals(null);
              setConfig(modelExample(next));
            }}
          >
            {MODEL_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {t(`connections.providers.${p}`)}
              </option>
            ))}
          </SelectField>
        ) : null}
        {!existing && can('settings:write') ? (
          <SelectField
            label={t('connections.scope')}
            hint={t('connections.scopeHint')}
            value={scope}
            onChange={(e) => setScope(e.target.value as 'tenant' | 'platform')}
          >
            <option value="tenant">{t('connections.scopes.tenant')}</option>
            <option value="platform">{t('connections.scopes.platform')}</option>
          </SelectField>
        ) : null}
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
        {kind === 'mcp' && parsedConfig ? (
          <ToolProfilesEditor
            config={parsedConfig}
            onChange={(next) => setConfig(JSON.stringify(next, null, 2))}
          />
        ) : null}
        {kind === 'model' ? (
          <div className="stack">
            <p className="muted">{t('connections.proposeHint')}</p>
            <div className="actions">
              <Button size="sm" loading={propose.isPending} onClick={() => propose.mutate()}>
                {t('connections.propose')}
              </Button>
            </div>
            {proposals ? (
              <table className="table" aria-label={t('connections.proposals')}>
                <thead>
                  <tr>
                    <th>{t('connections.model')}</th>
                    <th>{t('connections.inputPrice')}</th>
                    <th>{t('connections.outputPrice')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {proposals.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <Code>{m.id}</Code>
                      </td>
                      <td>{m.inputPerMTok === null ? '–' : `$${m.inputPerMTok}`}</td>
                      <td>{m.outputPerMTok === null ? '–' : `$${m.outputPerMTok}`}</td>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => addModel(m.id)}>
                          {t('connections.addModel')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
