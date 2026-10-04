import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { apiBase, ApiError } from '../../api/client';
import { login, oidcLoginUrl } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { Button, TextField } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { Logo } from '../../layout/AppShell';
import { PreferencesControls } from '../../layout/PreferencesControls';
import { useDocumentTitle } from '../../lib/hooks';
import { TourHint, isDemoBuild } from '../tour/TourHint';

const route = getRouteApi('/login');
type Method = 'auto' | 'ldap' | 'local';

/** Only same-origin paths are accepted as redirect targets (no open redirects). */
export function safeRedirect(target: string | undefined): string {
  if (!target) return '/';
  try {
    const url = new URL(target, window.location.origin);
    if (url.origin !== window.location.origin) return '/';
    if (url.pathname.startsWith('/login')) return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

export function LoginPage() {
  const { t } = useI18n();
  useDocumentTitle(t('login.title'));
  const search = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [method, setMethod] = useState<Method>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError(t('login.missing'));
      return;
    }
    setBusy(true);
    try {
      await login(queryClient, { username: username.trim(), password, method });
      await navigate({ href: safeRedirect(search.redirect) });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401 ? t('login.invalid') : t('login.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-card">
        <div className="login-brand">
          <Logo />
          <span>open-agentix</span>
        </div>
        <h1>{t('login.title')}</h1>
        <p className="muted">{t('login.subtitle')}</p>
        {isDemoBuild() ? (
          <TourHint
            onFill={(u, p) => {
              setUsername(u);
              setPassword(p);
            }}
          />
        ) : null}
        {search.expired ? (
          <p className="notice notice-warning" role="status">
            <Icon name="clock" size={16} /> {t('login.expired')}
          </p>
        ) : null}
        <a className="btn btn-secondary btn-md btn-block" href={oidcLoginUrl(apiBase())}>
          <Icon name="shield" size={16} />
          {t('login.sso')}
        </a>
        <div className="divider" role="separator">
          <span>{t('login.or')}</span>
        </div>
        <form onSubmit={submit} noValidate className="stack">
          <fieldset className="radio-row">
            <legend>{t('login.method')}</legend>
            {(['auto', 'ldap', 'local'] as const).map((m) => (
              <label key={m} className="radio">
                <input
                  type="radio"
                  name="method"
                  value={m}
                  checked={method === m}
                  onChange={() => setMethod(m)}
                />
                <span>{t(`login.methods.${m}`)}</span>
              </label>
            ))}
          </fieldset>
          <TextField
            label={t('login.username')}
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <TextField
            label={t('login.password')}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error ? (
            <p className="error-text" role="alert">
              <Icon name="alert" size={14} /> {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" loading={busy} className="btn-block">
            {t('login.submit')}
          </Button>
        </form>
        <div className="login-prefs">
          <PreferencesControls />
        </div>
      </div>
      <p className="tagline">{t('tagline')}</p>
    </main>
  );
}
