import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, call } from '../../api/client';
import { tokensQuery } from '../../api/queries';
import type { ApiToken, CreatedApiToken, TokenScope } from '../../api/types';
import { useCan } from '../../auth/auth';
import { ConfirmTenantAction } from '../../components/ConfirmTenantAction';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toast';
import {
  Badge,
  Button,
  Code,
  CopyButton,
  Dialog,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Section,
  TextField,
  errorMessage,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';

export const SCOPES: TokenScope[] = [
  'agents:read',
  'agents:write',
  'agents:publish',
  'runs:read',
  'runs:execute',
  'runs:cancel',
  'runs:approve',
  'events:read',
  'sources:read',
  'sources:write',
  'connections:read',
  'connections:write',
  'policies:read',
  'policies:write',
  'audit:read',
  'audit:verify',
  'audit:export',
  'costs:read',
  'users:read',
  'users:write',
  'tokens:read',
  'tokens:write',
  'settings:read',
  'settings:write',
];

export function groupScopes(scopes: readonly TokenScope[]): [string, TokenScope[]][] {
  const groups = new Map<string, TokenScope[]>();
  for (const s of scopes) {
    const [resource = s] = s.split(':');
    groups.set(resource, [...(groups.get(resource) ?? []), s]);
  }
  return [...groups.entries()];
}

export function isExpired(token: ApiToken, now = Date.now()): boolean {
  return Date.parse(token.expiresAt) <= now;
}

export function TokensPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('tokens.title'));
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [all, setAll] = useState(false);
  const tokens = useQuery(tokensQuery(all));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const revoke = async (tk: ApiToken) => {
    await call(api.DELETE('/v1/tokens/{id}', { params: { path: { id: tk.id } } }));
    await queryClient.invalidateQueries({ queryKey: ['tokens'] });
    toast.success(t('tokens.revoked', { name: tk.name }));
  };
  return (
    <div className="page">
      <PageHeader
        title={t('tokens.title')}
        description={t('tokens.subtitle')}
        actions={
          can('tokens:write') ? (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              {t('tokens.new')}
            </Button>
          ) : null
        }
      />
      <Section>
        {can('users:read') ? (
          <label className="check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>{t('tokens.showAll')}</span>
          </label>
        ) : null}
        {tokens.isPending ? (
          <Loading />
        ) : tokens.isError ? (
          <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
        ) : tokens.data.items.length === 0 ? (
          <EmptyState icon="tokens" title={t('tokens.empty')}>
            {t('tokens.emptyText')}
          </EmptyState>
        ) : (
          <ul className="list">
            {tokens.data.items.map((tk) => (
              <li key={tk.id} className="list-row token-row">
                <span className="list-main">
                  <span className="strong">{tk.name}</span>{' '}
                  {isExpired(tk) ? <Badge tone="danger">{t('tokens.expired')}</Badge> : null}
                  <br />
                  <span className="muted">
                    {tk.scopes?.length ? tk.scopes.join(', ') : t('tokens.allPermissions')}
                  </span>
                </span>
                <span className="muted">
                  {t('tokens.expires', { when: fmt.date(tk.expiresAt) })}
                  <br />
                  {t('tokens.lastUsed', { when: fmt.relative(tk.lastUsedAt) })}
                </span>
                {can('tokens:write') ? (
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setRevoking(tk)}>
                    {t('tokens.revoke')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <CreateTokenDialog open={creating} onClose={() => setCreating(false)} />
      <ConfirmTenantAction
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={t('tokens.revokeTitle', { name: revoking?.name ?? '' })}
        confirmLabel={t('tokens.revoke')}
        danger
        onConfirm={() => (revoking ? revoke(revoking) : undefined)}
      >
        <p>{t('tokens.revokeText')}</p>
      </ConfirmTenantAction>
    </div>
  );
}

function CreateTokenDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useI18n().t;
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [days, setDays] = useState(30);
  const [scopes, setScopes] = useState<TokenScope[]>(['runs:read']);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const create = useMutation({
    mutationFn: () =>
      call(api.POST('/v1/tokens', { body: { name: name.trim(), scopes, expiresInDays: days } })),
    onSuccess: async (tk) => {
      setCreated(tk);
      await queryClient.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
  const close = () => {
    setCreated(null);
    setName('');
    setScopes(['runs:read']);
    create.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={created ? t('tokens.createdTitle') : t('tokens.new')}
      footer={
        created ? (
          <Button variant="primary" onClick={close}>
            {t('tokens.done')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!name.trim() || scopes.length === 0}
              onClick={() => create.mutate()}
            >
              {t('common.create')}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="stack">
          <p className="notice notice-warning">
            <Icon name="alert" size={16} /> {t('tokens.showOnce')}
          </p>
          <p className="copy-row token-value">
            <Code>{created.token}</Code>
            <CopyButton value={created.token} label={t('tokens.copy')} />
          </p>
        </div>
      ) : (
        <div className="stack">
          <TextField
            label={t('tokens.name')}
            required
            hint={t('tokens.nameHint')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label={t('tokens.expiresIn')}
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
          <fieldset className="scope-grid">
            <legend>{t('tokens.scopes')}</legend>
            {groupScopes(SCOPES).map(([resource, list]) => (
              <div key={resource} className="scope-group">
                <p className="strong">{resource}</p>
                {list.map((s) => (
                  <label key={s} className="check">
                    <input
                      type="checkbox"
                      checked={scopes.includes(s)}
                      onChange={(e) =>
                        setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))
                      }
                    />
                    <span className="mono">{s.split(':')[1]}</span>
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
          <p className="hint">{t('tokens.scopeHint')}</p>
          {create.isError ? (
            <p className="error-text" role="alert">
              {errorMessage(create.error)}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
