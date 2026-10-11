import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError, api, call } from '../../api/client';
import { usersQuery } from '../../api/queries';
import type { Connection, OauthStatus } from '../../api/types';
import { useCan } from '../../auth/auth';
import { ConfirmTenantAction } from '../../components/ConfirmTenantAction';
import { useToast } from '../../components/toast';
import {
  Badge,
  Button,
  Code,
  CopyButton,
  Dialog,
  ErrorState,
  KeyValue,
  Loading,
  SelectField,
  errorMessage,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { navigateTo } from '../../lib/navigate';
import { newNonce, rememberConsent } from './consent';

const oauthKey = (id: string) => ['connection-oauth', id] as const;

const STATUS_TONE = {
  not_authorized: 'neutral',
  active: 'success',
  refresh_failed: 'warning',
  reauthorization_required: 'danger',
  revoked: 'neutral',
} as const;

/** Whether a connection config asks for OAuth (the Authorization view only exists for those). */
export function usesOauth(c: Connection): boolean {
  const auth = (c.config as { auth?: { kind?: unknown } }).auth;
  return c.kind === 'mcp' && c.config.transport === 'streamable-http' && auth?.kind === 'oauth';
}

function Scopes({ label, scopes }: { label: string; scopes: string[] }) {
  return (
    <span aria-label={label} className="cluster">
      {scopes.length ? scopes.map((s) => <Code key={s}>{s}</Code>) : <span>–</span>}
    </span>
  );
}

/** The "Authorization" view of an OAuth connection: status, consent, step-up and disconnect. */
export function AuthorizationDialog({
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
  const id = connection?.id ?? '';
  const [issuers, setIssuers] = useState<string[] | null>(null);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [issuer, setIssuer] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  const status = useQuery({
    queryKey: oauthKey(id),
    enabled: !!connection,
    queryFn: () => call(api.GET('/v1/connections/{id}/oauth', { params: { path: { id } } })),
  });
  const users = useQuery({ ...usersQuery, enabled: !!connection && can('users:read') });
  const authorize = useMutation({
    mutationFn: async () => {
      // The nonce stays in this tab; only its hash goes to the control node.
      const { nonce, hash } = await newNonce();
      const r = await call(
        api.POST('/v1/connections/{id}/oauth/authorize', {
          params: { path: { id } },
          body: { ...(issuer ? { issuer } : {}), nonceHash: hash },
        }),
      );
      return { r, nonce };
    },
    onSuccess: async ({ r, nonce }) => {
      setIssuers(null);
      if (r.authorizationUrl) {
        // The consent happens at the authorization server; the callback brings the browser back
        // to this tab, which completes it with the nonce.
        rememberConsent(id, nonce);
        try {
          navigateTo(r.authorizationUrl);
        } catch {
          toast.error(t('connections.authorization.badUrl'));
        }
        return;
      }
      await queryClient.invalidateQueries({ queryKey: oauthKey(id) });
      toast.success(t('connections.authorization.connected'));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'mcp_oauth_issuer_required') {
        const list = (e.details as { issuers?: unknown } | undefined)?.issuers;
        if (Array.isArray(list) && list.every((x) => typeof x === 'string')) {
          setIssuers(list as string[]);
          setIssuer(list[0] as string);
          const scopes = (e.details as { scopes?: unknown }).scopes;
          setSuggested(
            Array.isArray(scopes) ? scopes.filter((x): x is string => typeof x === 'string') : [],
          );
          return;
        }
      }
      toast.error(errorMessage(e));
    },
  });
  const disconnect = async () => {
    await call(api.POST('/v1/connections/{id}/oauth/disconnect', { params: { path: { id } } }));
    await queryClient.invalidateQueries({ queryKey: oauthKey(id) });
    toast.success(t('connections.authorization.disconnected'));
  };
  const s: OauthStatus | undefined = status.data;
  const code = s?.grant === 'authorization_code';
  const by = s?.authorizedBy
    ? (users.data?.items.find((u) => u.id === s.authorizedBy)?.email ?? s.authorizedBy)
    : null;
  const label = s?.reauthorizationNeeded
    ? t('connections.authorization.reauthorize')
    : code
      ? t('connections.authorization.connect')
      : t('connections.authorization.authorize');
  return (
    <>
      <Dialog
        open={!!connection}
        onClose={onClose}
        wide
        title={t('connections.authorization.title', { name: connection?.name ?? '' })}
        footer={
          <>
            {can('connections:write') && s && s.status !== 'not_authorized' ? (
              <Button variant="ghost" icon="trash" onClick={() => setDisconnecting(true)}>
                {t('connections.authorization.disconnect')}
              </Button>
            ) : null}
            {can('connections:write') && s ? (
              <Button
                variant="primary"
                loading={authorize.isPending}
                onClick={() => authorize.mutate()}
              >
                {label}
              </Button>
            ) : null}
            <Button onClick={onClose}>{t('common.close')}</Button>
          </>
        }
      >
        <div className="stack">
          <p className="muted">
            {code
              ? t('connections.authorization.introCode')
              : t('connections.authorization.introClient')}
          </p>
          {status.isPending ? (
            <Loading />
          ) : status.isError ? (
            <ErrorState error={status.error} onRetry={() => void status.refetch()} />
          ) : s ? (
            <>
              {s.reauthorizationNeeded ? (
                <p role="alert" className="notice notice-warning">
                  {s.requiredScopes.length
                    ? t('connections.authorization.stepUp', { scopes: s.requiredScopes.join(' ') })
                    : s.scopesMissing.length
                      ? t('connections.authorization.scopesMissing', {
                          scopes: s.scopesMissing.join(' '),
                        })
                      : t('connections.authorization.reauthorizationText')}
                </p>
              ) : null}
              {code && s.pendingExpiresAt ? (
                <p role="note" className="notice notice-info">
                  {t('connections.authorization.pending', {
                    when: fmt.relative(s.pendingExpiresAt),
                  })}
                </p>
              ) : null}
              {s.scopesWider ? (
                <p role="note" className="notice notice-info">
                  {t('connections.authorization.wider')}
                </p>
              ) : null}
              <KeyValue
                items={[
                  [
                    t('connections.authorization.status'),
                    <Badge key="s" tone={STATUS_TONE[s.status]}>
                      {t(`connections.authorization.statuses.${s.status}`)}
                    </Badge>,
                  ],
                  [
                    t('connections.authorization.grant'),
                    t(
                      `connections.authorization.grants.${code ? 'authorization_code' : 'client_credentials'}`,
                    ),
                  ],
                  ...(s.registration
                    ? ([
                        [
                          t('connections.authorization.registration'),
                          t(`connections.authorization.registrations.${s.registration}`),
                        ],
                      ] as [string, string][])
                    : []),
                  [
                    t('connections.authorization.issuer'),
                    s.issuer ? <Code key="i">{s.issuer}</Code> : <span key="i">–</span>,
                  ],
                  [
                    t('connections.authorization.hosts'),
                    s.endpointHosts.length ? s.endpointHosts.join(', ') : '–',
                  ],
                  [
                    t('connections.authorization.scopes'),
                    <Scopes
                      key="g"
                      label={t('connections.authorization.scopes')}
                      scopes={s.scopes}
                    />,
                  ],
                  ...(s.authorizedAt
                    ? ([
                        [
                          t('connections.authorization.authorizedBy'),
                          t('connections.authorization.authorizedByAt', {
                            who: by ?? '–',
                            when: fmt.dateTime(s.authorizedAt),
                          }),
                        ],
                      ] as [string, string][])
                    : []),
                  ...(s.expiresAt
                    ? ([[t('connections.authorization.expires'), fmt.dateTime(s.expiresAt)]] as [
                        string,
                        string,
                      ][])
                    : []),
                  ...(s.lastError
                    ? ([
                        [
                          t('connections.authorization.lastError'),
                          <Code key="e">{s.lastError}</Code>,
                        ],
                      ] as [string, ReactNode][])
                    : []),
                ]}
              />
              {code && s.redirectUri ? (
                <div>
                  <p className="strong">{t('connections.authorization.redirectUri')}</p>
                  <p className="copy-row">
                    <Code>{s.redirectUri}</Code>
                    <CopyButton value={s.redirectUri} />
                  </p>
                  <p className="muted">{t('connections.authorization.redirectHint')}</p>
                </div>
              ) : null}
              {issuers ? (
                <div className="stack">
                  <p role="note" className="notice notice-warning">
                    {t('connections.authorization.confirmFirst')}
                  </p>
                  <SelectField
                    label={t('connections.authorization.chooseIssuer')}
                    hint={t('connections.authorization.chooseIssuerHint')}
                    value={issuer}
                    onChange={(e) => setIssuer(e.target.value)}
                  >
                    {issuers.map((i) => (
                      <option key={i} value={i}>
                        {i}
                      </option>
                    ))}
                  </SelectField>
                  <div>
                    <p className="strong">{t('connections.authorization.suggestedScopes')}</p>
                    <Scopes
                      label={t('connections.authorization.suggestedScopes')}
                      scopes={suggested}
                    />
                  </div>
                </div>
              ) : null}
              {code ? <p className="muted">{t('connections.authorization.instanceHint')}</p> : null}
            </>
          ) : null}
        </div>
      </Dialog>
      <ConfirmTenantAction
        open={disconnecting}
        onClose={() => setDisconnecting(false)}
        title={t('connections.authorization.disconnectTitle', { name: connection?.name ?? '' })}
        confirmLabel={t('connections.authorization.disconnect')}
        danger
        onConfirm={disconnect}
      >
        <p>{t('connections.authorization.disconnectText')}</p>
      </ConfirmTenantAction>
    </>
  );
}
