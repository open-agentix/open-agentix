import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { session } from '../../auth/session';
import { EmptyState, Loading } from '../../components/ui';
import { useT } from '../../i18n/i18n';

/** Session lifetime assumed until /v1/me confirms the token (the redirect carries no expiry). */
const ASSUMED_TTL_MS = 8 * 60 * 60 * 1000;

export function readTokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('token');
  return token && token.length > 10 ? token : null;
}

export function OidcCallback() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const token = readTokenFromHash(window.location.hash);
    // Never keep the token in the address bar or history.
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setFailed(true);
      return;
    }
    session.set(token, new Date(Date.now() + ASSUMED_TTL_MS).toISOString());
    queryClient.removeQueries({ queryKey: ['me'] });
    void navigate({ to: '/' });
  }, [navigate, queryClient]);
  if (failed) {
    return (
      <main className="login">
        <EmptyState
          icon="alert"
          title={t('login.callbackFailed')}
          action={
            <Link to="/login" search={{ redirect: undefined, expired: undefined }}>
              {t('login.backToLogin')}
            </Link>
          }
        />
      </main>
    );
  }
  return <Loading />;
}
